import { randomUUID } from 'node:crypto';
import type {
  AgentCommand,
  CommandInput,
  CommandRequest,
  CommandResult,
  ApprovalWaitResult,
  ApprovalWaitState,
  AuditEntry,
  DatabaseResult,
  DatabaseTable,
  HttpProposal,
  OperationInput,
  OperationSummary,
  PendingSummary,
  RunResult,
  VaultSnapshot,
} from '../shared/contracts';
import {
  agentCommandSchema,
  durationSchema,
  itemSchema,
  nameSchema,
  operationSchema,
  proposalSchema,
  proposalApprovalSchema,
  httpRequestSchema,
  waitOptionsSchema,
  parseInput,
  SafeError,
  type VaultData,
} from './schema';
import { projectResponse, resolveHttpRequest } from './http-policy';
import { commandProposalSchema, commandApprovalSchema, commandRunSchema } from './command-schema';
import { executeCommand, type ExecuteCommand } from './command';
import { VaultStorage } from './storage';
import { databaseReadSchema, databaseSchema, databaseTablesSchema } from './database-schema';
import { loadSQLiteSnapshot, saveSQLiteSnapshot } from './sqlite-snapshots';
import { readSQLiteBytes } from './sqlite';
import { databaseSecret, readDatabase, readStatement, type ReadDatabase } from './database';
import { secretHeaders, sendOperation, validateOperation, type SendOperation } from './transport';

export class Vault {
  #data: VaultData | undefined;
  #sessionRevision = 0;
  get sessionRevision(): number {
    this.data();
    return this.#sessionRevision;
  }
  #pending = new Map<string, number>();
  #proposals = new Map<string, HttpProposal>();
  #commands = new Map<string, CommandRequest>();
  #revisions = new Map<string, string>();
  #active = new Map<AbortController, string>();
  #waiters = new Map<(state: ApprovalWaitState) => void, string>();
  readonly storage: VaultStorage;

  constructor(
    directory: string,
    private readonly send: SendOperation = sendOperation,
    private readonly read: ReadDatabase = readDatabase,
    private readonly execute: ExecuteCommand = executeCommand,
  ) {
    this.storage = new VaultStorage(directory);
  }
  initialize(password: string): void {
    const data: VaultData = {
      items: [],
      operations: [],
      databases: [],
      snapshots: [],
      grants: [],
      audit: [],
    };
    this.storage.initialize(password, data);
    this.#data = data;
  }
  unlock(password: string): void {
    this.lock();
    this.#data = this.storage.unlock(password);
  }
  lock(): void {
    for (const finish of this.#waiters.keys()) finish('locked');
    this.#sessionRevision++;
    for (const controller of this.#active.keys()) controller.abort();
    this.#pending.clear();
    this.#proposals.clear();
    this.#commands.clear();
    this.#revisions.clear();
    this.#data = undefined;
    this.storage.lock();
  }
  snapshot(): VaultSnapshot {
    const data = this.#data;
    return {
      initialized: this.storage.initialized,
      unlocked: !!data,
      items:
        data?.items.map(({ name, kind, fields }) => ({
          name,
          kind,
          fields: fields.map((field) => field.name),
        })) ?? [],
      operations:
        data?.operations.map(({ body, ...operation }): OperationSummary => ({
          ...structuredClone(operation),
          hasBody: !!body,
          revision: this.policyRevision(operation.name),
        })) ?? [],
      proposals: structuredClone(this.proposals()),
      commands: structuredClone(this.commandRequests()),
      databases: (data?.databases ?? []).map((database) => ({
        ...structuredClone(database),
        revision: this.policyRevision(database.name),
      })),
      grants: structuredClone(data?.grants.filter((grant) => this.hasGrant(grant.operation)) ?? []),
      pending: Array.from(this.#pending, ([operation, requestedAt]): PendingSummary => ({
        operation,
        requestedAt,
      })),
      audit: structuredClone(data?.audit ?? []),
    };
  }
  saveItem(input: unknown): void {
    const item = parseInput(itemSchema, input);
    const data = this.data();
    this.discardItemCommands(item.name);
    this.discardItemProposals(item.name);
    // Rotation invalidates grants, even if an operation keeps its name.
    const affected = new Set(
      [...data.operations, ...data.databases]
        .filter((operation) => 'item' in operation && operation.item === item.name)
        .map((operation) => operation.name),
    );
    for (const operation of data.operations.filter((operation) => affected.has(operation.name)))
      validateOperation(operation, item);
    for (const database of data.databases.filter((entry) => affected.has(entry.name)))
      databaseSecret(database, item);
    this.abortOperations(affected);
    this.mutate(
      (next) => {
        next.items = [...next.items.filter((existing) => existing.name !== item.name), item];
        next.grants = next.grants.filter((grant) => !affected.has(grant.operation));
      },
      'saved-item',
      item.name,
    );
    for (const name of affected) {
      this.#pending.delete(name);
      this.#revisions.delete(name);
      this.settleWaiters(name, 'changed');
    }
  }
  deleteItem(input: unknown): void {
    const name = parseInput(nameSchema, input);
    this.discardItemCommands(name);
    this.discardItemProposals(name);
    const affected = new Set(
      [...this.data().operations, ...this.data().databases]
        .filter((operation) => 'item' in operation && operation.item === name)
        .map((operation) => operation.name),
    );
    this.abortOperations(affected);
    this.mutate(
      (next) => {
        next.items = next.items.filter((item) => item.name !== name);
        next.operations = next.operations.filter((operation) => operation.item !== name);
        next.databases = next.databases.filter(
          (database) => database.source === 'snapshot' || database.item !== name,
        );
        next.grants = next.grants.filter((grant) => !affected.has(grant.operation));
      },
      'deleted',
      name,
    );
    for (const operation of affected) {
      this.#pending.delete(operation);
      this.#revisions.delete(operation);
      this.settleWaiters(operation, 'changed');
    }
  }
  saveOperation(input: unknown): void {
    const operation = parseInput(operationSchema, input);
    this.assertNoCommand(operation.name);
    if (this.data().databases.some((entry) => entry.name === operation.name))
      throw new SafeError('API operations and database connections must have different names.');
    const item = this.data().items.find((entry) => entry.name === operation.item);
    if (!item) throw new SafeError('Choose an existing vault item.');
    validateOperation(operation, item);
    this.abortOperations(new Set([operation.name]));
    this.mutate(
      (next) => {
        next.operations = [
          ...next.operations.filter((existing) => existing.name !== operation.name),
          operation,
        ];
        next.grants = next.grants.filter((grant) => grant.operation !== operation.name);
      },
      'saved-operation',
      operation.name,
    );
    this.#pending.delete(operation.name);
    this.#revisions.delete(operation.name);
    this.settleWaiters(operation.name, 'changed');
  }
  private proposals(): HttpProposal[] {
    for (const [revision, proposal] of this.#proposals) {
      if (Date.now() - proposal.requestedAt >= 600_000) {
        this.#proposals.delete(revision);
        this.settleWaiters(proposal.operation.name, 'expired');
      }
    }
    return [...this.#proposals.values()];
  }
  private discardItemProposals(item: string): void {
    for (const [revision, proposal] of this.#proposals) {
      if (proposal.operation.item === item) {
        this.#proposals.delete(revision);
        this.settleWaiters(proposal.operation.name, 'changed');
      }
    }
  }
  proposeOperation(input: unknown): { state: 'awaiting-approval' | 'approved'; operation: string } {
    const operation = parseInput(proposalSchema, input);
    this.assertNoCommand(operation.name);
    const data = this.data();
    const item = data.items.find((entry) => entry.name === operation.item);
    if (!item) throw new SafeError('Choose an existing vault item.');
    validateOperation(operation, item);
    const existing = data.operations.find((entry) => entry.name === operation.name);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(operation))
        throw new SafeError(
          'That name already has a policy. Use a new name; agents cannot replace policies.',
        );
      return this.requestAccess(operation.name);
    }
    if (data.databases.some((entry) => entry.name === operation.name))
      throw new SafeError('That name is already used.');
    if (data.operations.length >= 256)
      throw new SafeError('The saved API operation limit has been reached.');
    const proposals = this.proposals();
    const pending = proposals.find((entry) => entry.operation.name === operation.name);
    if (pending) {
      if (JSON.stringify(pending.operation) !== JSON.stringify(operation))
        throw new SafeError(
          'A different request with that name is awaiting review. Use a new name.',
        );
    } else {
      if (proposals.length >= 32)
        throw new SafeError(
          'Too many proposals. Ask the user to review or dismiss pending requests.',
        );
      const revision = randomUUID();
      this.#proposals.set(revision, { revision, requestedAt: Date.now(), operation });
    }
    return { state: 'awaiting-approval', operation: operation.name };
  }
  approveProposal(input: unknown): void {
    const approval = parseInput(proposalApprovalSchema, input);
    const proposal = this.proposals().find((entry) => entry.revision === approval.revision);
    if (!proposal)
      throw new SafeError('Request expired or changed. Ask the agent to propose it again.');
    const operation: OperationInput = {
      ...proposal.operation,
      ...(approval.scope ? { scope: approval.scope } : {}),
    };
    const data = this.data();
    if ([...data.operations, ...data.databases].some((entry) => entry.name === operation.name))
      throw new SafeError(
        'That name now has a policy. Dismiss this request and review the saved policy.',
      );
    if (data.operations.length >= 256)
      throw new SafeError('The saved API operation limit has been reached.');
    const item = data.items.find((entry) => entry.name === operation.item);
    if (!item) throw new SafeError('The saved item is no longer available.');
    validateOperation(operation, item);
    if (operation.responseFields?.length && !approval.dataSharingAccepted)
      throw new SafeError(
        'Consent is required to share selected API data with agents and their providers.',
      );
    // Save policy and grant in a single durable transaction. No partially approved proposal.
    this.mutate(
      (next) => {
        next.operations.push(operation);
        next.grants.push(
          this.newGrant(operation.name, approval.duration, !!operation.responseFields?.length),
        );
      },
      'approved',
      operation.name,
    );
    this.#proposals.delete(approval.revision);
    this.settleWaiters(operation.name, 'approved');
  }
  dismissProposal(input: unknown): void {
    this.data();
    const revision = parseInput(proposalApprovalSchema.shape.revision, input);
    const proposal = this.#proposals.get(revision);
    this.#proposals.delete(revision);
    if (proposal) this.settleWaiters(proposal.operation.name, 'dismissed');
  }
  reviewOperation(input: unknown): OperationInput {
    const name = parseInput(nameSchema, input);
    const operation = this.data().operations.find((entry) => entry.name === name);
    if (!operation) throw new SafeError('Unknown operation.');
    return structuredClone(operation);
  }
  private newGrant(
    operation: string,
    duration: 'once' | 'hour' | 'day' | 'until-revoked',
    sharing: boolean,
  ) {
    return {
      operation,
      expiresAt:
        duration === 'hour'
          ? Date.now() + 3_600_000
          : duration === 'day'
            ? Date.now() + 86_400_000
            : null,
      remainingUses: duration === 'once' ? (1 as const) : null,
      ...(sharing ? { dataSharingAccepted: true as const } : {}),
    };
  }
  deleteOperation(input: unknown): void {
    const name = parseInput(nameSchema, input);
    for (const request of this.commandRequests()) {
      if (request.command.name === name) this.dismissCommand(request.revision);
    }
    this.abortOperations(new Set([name]));
    this.mutate(
      (next) => {
        next.operations = next.operations.filter((operation) => operation.name !== name);
        next.databases = next.databases.filter((database) => database.name !== name);
        next.grants = next.grants.filter((grant) => grant.operation !== name);
      },
      'deleted',
      name,
    );
    this.#pending.delete(name);
    this.#revisions.delete(name);
    this.settleWaiters(name, 'changed');
  }
  requestAccess(input: unknown): { state: 'approved' | 'awaiting-approval'; operation: string } {
    const operation = parseInput(nameSchema, input);
    if (
      ![...this.data().operations, ...this.data().databases].some(
        (entry) => entry.name === operation,
      )
    )
      throw new SafeError('Unknown operation or database connection.');
    if (this.hasGrant(operation)) return { state: 'approved', operation };
    if (!this.#pending.has(operation)) this.#pending.set(operation, Date.now());
    return { state: 'awaiting-approval', operation };
  }
  waitForApproval(input: unknown, signal?: AbortSignal): Promise<ApprovalWaitResult> {
    const { operation, timeoutMs } = parseInput(waitOptionsSchema, input);
    this.data();
    if (signal?.aborted) return Promise.resolve({ operation, state: 'cancelled' });
    const request = this.commandRequests().find((entry) => entry.command.name === operation);
    if (this.hasGrant(operation) || request?.state === 'approved')
      return Promise.resolve({ operation, state: 'approved' });
    const proposal =
      this.proposals().find((entry) => entry.operation.name === operation) ?? request;
    if (!proposal && !this.#pending.has(operation))
      throw new SafeError(
        'No pending request. Propose a request or request access before waiting.',
      );
    if (this.#waiters.size >= 16)
      throw new SafeError(
        'Too many approval waits. Stop and ask the user to review pending requests.',
      );
    const remaining = proposal
      ? Math.max(1, proposal.requestedAt + 600_000 - Date.now())
      : Infinity;
    return new Promise((resolve) => {
      const finish = (state: ApprovalWaitState): void => {
        if (!this.#waiters.delete(finish)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        resolve({ operation, state });
      };
      const cancel = (): void => finish('cancelled');
      const timer = setTimeout(
        () => finish(remaining <= timeoutMs ? 'expired' : 'timeout'),
        Math.min(remaining, timeoutMs),
      );
      this.#waiters.set(finish, operation);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }
  private settleWaiters(operation: string, state: ApprovalWaitState): void {
    for (const [finish, name] of this.#waiters) if (name === operation) finish(state);
  }
  // Desktop IPC requires the displayed revision. Direct in-process callers are trusted.
  approve(
    input: unknown,
    durationInput: unknown,
    reviewedRevision?: string,
    dataSharingAccepted?: unknown,
  ): void {
    const operation = parseInput(nameSchema, input);
    const duration = parseInput(durationSchema, durationInput);
    if (
      ![...this.data().operations, ...this.data().databases].some(
        (entry) => entry.name === operation,
      )
    )
      throw new SafeError('Unknown operation or database connection.');
    if (reviewedRevision !== undefined && reviewedRevision !== this.policyRevision(operation))
      throw new SafeError('Access settings changed. Review the updated policy before approving.');
    const sharing =
      this.data().databases.some((entry) => entry.name === operation) ||
      !!this.data().operations.find((entry) => entry.name === operation)?.responseFields?.length;
    if (sharing && dataSharingAccepted !== true)
      throw new SafeError(
        'Explicit data-sharing consent is required before approving database or API data access.',
      );
    this.mutate(
      (next) => {
        next.grants = [
          ...next.grants.filter((grant) => grant.operation !== operation),
          this.newGrant(operation, duration, sharing),
        ];
      },
      'approved',
      operation,
    );
    this.#pending.delete(operation);
    this.#revisions.delete(operation);
    this.settleWaiters(operation, 'approved');
  }
  revoke(input: unknown): void {
    const operation = parseInput(nameSchema, input);
    for (const request of this.commandRequests()) {
      if (request.command.name === operation) this.dismissCommand(request.revision);
    }
    this.abortOperations(new Set([operation]));
    this.mutate(
      (next) => {
        next.grants = next.grants.filter((grant) => grant.operation !== operation);
      },
      'revoked',
      operation,
    );
    this.#pending.delete(operation);
    this.#revisions.delete(operation);
    this.settleWaiters(operation, 'revoked');
  }
  private policyRevision(name: string): string {
    // Random review tokens reveal nothing about a credential, unlike hashes of secret values.
    const revision = this.#revisions.get(name) ?? randomUUID();
    this.#revisions.set(name, revision);
    return revision;
  }
  async run(input: unknown, requestInput?: unknown): Promise<RunResult> {
    const name = parseInput(nameSchema, input);
    const policy = this.data().operations.find((entry) => entry.name === name);
    if (!policy) throw new SafeError('Unknown operation.');
    const operation = resolveHttpRequest(
      policy,
      requestInput === undefined ? undefined : parseInput(httpRequestSchema, requestInput),
    );
    if (!this.hasGrant(name))
      throw new SafeError(
        'Approval required. Request access, then ask the user to approve in AgentKey.',
      );
    if (this.#active.size >= 8) throw new SafeError('Too many active requests.');
    const item = this.data().items.find((entry) => entry.name === operation.item)!;
    const headers = secretHeaders(operation, item);
    // Persist consumption before I/O: concurrent calls and restarts cannot reuse a one-shot approval.
    this.mutate(
      (next) => {
        next.grants = next.grants.filter(
          (grant) => grant.operation !== name || grant.remainingUses === null,
        );
      },
      'attempted',
      name,
    );
    const controller = new AbortController();
    this.#active.set(controller, name);
    try {
      const result = await this.send(structuredClone(operation), headers, controller.signal);
      const status = typeof result === 'number' ? result : result.status;
      if (controller.signal.aborted || !this.#data)
        throw new SafeError(
          'Access ended during the request. The API may already have processed it.',
        );
      const selected =
        operation.responseFields?.length &&
        typeof result !== 'number' &&
        status >= 200 &&
        status < 300
          ? projectResponse(result.body, operation.responseFields, [
              ...item.fields.map((field) => field.value),
              ...Object.values(headers),
            ])
          : undefined;
      this.mutate(() => {}, 'finished', name, status);
      return {
        operation: name,
        status,
        successful: status >= 200 && status < 300,
        ...(selected ? { data: selected } : {}),
      };
    } catch (error) {
      if (this.#data) this.mutate(() => {}, 'failed', name);
      // Transport/library errors are never serialized: they can contain headers and request options.
      throw error instanceof SafeError
        ? error
        : new SafeError(
            'Request failed. Check the API before retrying; it may already have processed the request.',
          );
    } finally {
      for (const key of Object.keys(headers)) delete headers[key];
      this.#active.delete(controller);
    }
  }
  registerSQLite(name: string, bytes: Buffer, tables: DatabaseTable[]): void {
    const parsedName = parseInput(nameSchema, name);
    this.assertNoCommand(parsedName);
    const parsedTables = parseInput(databaseTablesSchema, tables);
    const data = this.data();
    if (data.operations.some((operation) => operation.name === parsedName))
      throw new SafeError('API operations and database connections must have different names.');
    if (data.databases.length >= 64 && !data.databases.some((entry) => entry.name === parsedName))
      throw new SafeError('The database connection limit has been reached.');
    // Write ciphertext first. An interrupted/ambiguous vault commit may leave an encrypted orphan,
    // never a live reference to unwritten data or a decrypted database on disk.
    const snapshot = saveSQLiteSnapshot(this.storage.directory, bytes);
    const database = parseInput(databaseSchema, {
      source: 'snapshot',
      engine: 'sqlite',
      snapshot: snapshot.id,
      name: parsedName,
      tables: parsedTables,
    });
    this.abortOperations(new Set([database.name]));
    this.mutate(
      (next) => {
        next.snapshots.push(snapshot);
        next.databases = [
          ...next.databases.filter((entry) => entry.name !== database.name),
          database,
        ];
        next.grants = next.grants.filter((grant) => grant.operation !== database.name);
      },
      'saved-operation',
      database.name,
    );
    this.#pending.delete(database.name);
    this.#revisions.delete(database.name);
    this.settleWaiters(database.name, 'changed');
  }
  saveDatabase(input: unknown): void {
    const database = parseInput(databaseSchema, input);
    this.assertNoCommand(database.name);
    const data = this.data();
    if (data.operations.some((entry) => entry.name === database.name))
      throw new SafeError('API operations and database connections must have different names.');
    if (database.source === 'snapshot') {
      const existing = data.databases.find((entry) => entry.name === database.name);
      if (existing?.source !== 'snapshot' || existing.snapshot !== database.snapshot)
        throw new SafeError('Import a SQLite snapshot through the desktop setup.');
      if (
        database.tables.some((table) => {
          const previous = existing.tables.find(
            (entry) => entry.schema === table.schema && entry.table === table.table,
          );
          return !previous || table.columns.some((column) => !previous.columns.includes(column));
        })
      )
        throw new SafeError('Re-import the SQLite file to allow additional tables or columns.');
    } else {
      const item = data.items.find((entry) => entry.name === database.item);
      if (!item) throw new SafeError('Choose an existing vault item.');
      databaseSecret(database, item);
    }
    this.abortOperations(new Set([database.name]));
    this.mutate(
      (next) => {
        next.databases = [
          ...next.databases.filter((entry) => entry.name !== database.name),
          database,
        ];
        next.grants = next.grants.filter((grant) => grant.operation !== database.name);
      },
      'saved-operation',
      database.name,
    );
    this.#pending.delete(database.name);
    this.#revisions.delete(database.name);
    this.settleWaiters(database.name, 'changed');
  }
  async readRows(input: unknown): Promise<DatabaseResult> {
    const query = parseInput(databaseReadSchema, input);
    const database = this.data().databases.find((entry) => entry.name === query.connection);
    if (!database) throw new SafeError('Unknown database connection.');
    if (!this.hasGrant(database.name))
      throw new SafeError(
        'Approval required. Request access, then ask the user to approve in AgentKey.',
      );
    if (this.#active.size >= 8) throw new SafeError('Too many active requests.');
    readStatement(database, query);
    const snapshot =
      database.source === 'snapshot'
        ? this.data().snapshots.find((entry) => entry.id === database.snapshot)
        : undefined;
    const secret =
      database.source === 'snapshot'
        ? undefined
        : databaseSecret(
            database,
            this.data().items.find((entry) => entry.name === database.item)!,
          );
    this.mutate(
      (next) => {
        next.grants = next.grants.filter(
          (grant) => grant.operation !== database.name || grant.remainingUses === null,
        );
      },
      'attempted',
      database.name,
    );
    const controller = new AbortController();
    this.#active.set(controller, database.name);
    let bytes: Buffer | undefined;
    try {
      let result: DatabaseResult;
      if (database.source === 'snapshot') {
        if (!snapshot) throw new SafeError('Missing SQLite import.');
        bytes = await loadSQLiteSnapshot(this.storage.directory, snapshot, controller.signal);
        result = await readSQLiteBytes(bytes, database, query, controller.signal);
      } else {
        if (!secret) throw new SafeError('Missing database source.');
        result = await this.read(structuredClone(database), secret, query, controller.signal);
      }
      if (controller.signal.aborted || !this.#data)
        throw new SafeError('Database access ended during the read. No rows were returned.');
      this.mutate(() => {}, 'finished', database.name);
      return result;
    } catch {
      if (this.#data) this.mutate(() => {}, 'failed', database.name);
      throw new SafeError(
        'Database read failed or access ended. No database error details were returned.',
      );
    } finally {
      bytes?.fill(0);
      this.#active.delete(controller);
    }
  }
  async dispatch(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const command: AgentCommand = parseInput(agentCommandSchema, input);
    switch (command.action) {
      case 'status':
        return { initialized: this.storage.initialized, unlocked: !!this.#data };
      case 'list-items':
        this.data();
        return this.snapshot().items;
      case 'list-operations':
        this.data();
        return this.snapshot().operations;
      case 'request-access':
        return this.requestAccess(command.operation);
      case 'wait-for-approval':
        return this.waitForApproval(
          { operation: command.operation, timeoutMs: command.timeoutMs },
          signal,
        );
      case 'propose-operation':
        return this.proposeOperation(command.operation);
      case 'run':
        return this.run(command.operation, command.request);
      case 'propose-command':
        return this.proposeCommand(command.command);
      case 'run-command':
        return this.runCommand(
          { operation: command.operation, revision: command.revision },
          signal,
        );
      case 'list-databases':
        this.data();
        return this.snapshot().databases;
      case 'read-database':
        return this.readRows(command.query);
    }
  }
  private commandRequests(): CommandRequest[] {
    for (const [revision, request] of this.#commands) {
      if (request.state !== 'running' && Date.now() - request.requestedAt >= 600_000) {
        this.#commands.delete(revision);
        this.settleWaiters(request.command.name, 'expired');
      }
    }
    return [...this.#commands.values()];
  }
  private assertNoCommand(name: string): void {
    if (this.commandRequests().some((request) => request.command.name === name))
      throw new SafeError('That name belongs to a command request. Use a different name.');
  }
  private discardItemCommands(item: string): void {
    for (const request of this.commandRequests()) {
      if (request.command.bindings.some((binding) => binding.item === item)) {
        this.abortOperations(new Set([request.command.name]));
        this.#commands.delete(request.revision);
        this.settleWaiters(request.command.name, 'changed');
      }
    }
  }
  private commandSecrets(command: CommandInput): {
    env: Record<string, string>;
    secrets: string[];
  } {
    const env: Record<string, string> = Object.create(null);
    const secrets = new Set<string>();
    for (const binding of command.bindings) {
      const item = this.data().items.find((entry) => entry.name === binding.item);
      const field = item?.fields.find((entry) => entry.name === binding.field);
      if (!item || !field) throw new SafeError('Choose existing saved items and fields.');
      if (field.value.includes('\u0000'))
        throw new SafeError('This field cannot be used in a process environment.');
      env[binding.env] = field.value;
      for (const entry of item.fields) secrets.add(entry.value);
    }
    return { env, secrets: [...secrets] };
  }
  proposeCommand(input: unknown): {
    operation: string;
    revision: string;
    state: 'awaiting-approval' | 'approved';
  } {
    const command = parseInput(commandProposalSchema, input);
    const data = this.data();
    this.commandSecrets(command);
    if (
      [...data.operations, ...data.databases].some((entry) => entry.name === command.name) ||
      this.proposals().some((entry) => entry.operation.name === command.name)
    )
      throw new SafeError('That name is already used. Choose a different command name.');
    const requests = this.commandRequests();
    const existing = requests.find((entry) => entry.command.name === command.name);
    if (existing) {
      if (
        JSON.stringify(existing.command) !== JSON.stringify(command) ||
        existing.state === 'running'
      )
        throw new SafeError('That name has a different or running command. Use a new name.');
      return {
        operation: command.name,
        revision: existing.revision,
        state: existing.state === 'approved' ? 'approved' : 'awaiting-approval',
      };
    }
    if (requests.length >= 32)
      throw new SafeError('Too many command requests. Review or dismiss pending requests first.');
    const revision = randomUUID();
    this.#commands.set(revision, { command, revision, requestedAt: Date.now(), state: 'pending' });
    return { operation: command.name, revision, state: 'awaiting-approval' };
  }
  approveCommand(input: unknown): void {
    const approval = parseInput(commandApprovalSchema, input);
    this.data();
    const request = this.commandRequests().find((entry) => entry.revision === approval.revision);
    if (!request || request.state !== 'pending')
      throw new SafeError('Command request expired or changed. Review a fresh request.');
    this.commandSecrets(request.command);
    this.mutate(() => {}, 'approved', request.command.name);
    request.state = 'approved';
    this.settleWaiters(request.command.name, 'approved');
  }
  dismissCommand(input: unknown): void {
    this.data();
    const revision = parseInput(commandApprovalSchema.shape.revision, input);
    const request = this.#commands.get(revision);
    if (!request) return;
    this.abortOperations(new Set([request.command.name]));
    this.#commands.delete(revision);
    this.settleWaiters(request.command.name, 'dismissed');
    this.mutate(() => {}, 'revoked', request.command.name);
  }
  async runCommand(input: unknown, signal?: AbortSignal): Promise<CommandResult> {
    const { operation, revision } = parseInput(commandRunSchema, input);
    this.data();
    const request = this.commandRequests().find(
      (entry) => entry.revision === revision && entry.command.name === operation,
    );
    if (!request || request.state !== 'approved')
      throw new SafeError('Fresh command approval is required for this attempt.');
    if (signal?.aborted) throw new SafeError('Command cancelled before launch.');
    if (this.#active.size >= 8) throw new SafeError('Too many active requests.');
    const { env, secrets } = this.commandSecrets(request.command);
    // Consumption is synchronous and audited before spawning. No command grants survive restart.
    this.mutate(() => {}, 'attempted', operation);
    request.state = 'running';
    const controller = new AbortController();
    this.#active.set(controller, operation);
    const cancel = (): void => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const result = await this.execute(
        structuredClone(request.command),
        env,
        secrets,
        controller.signal,
      );
      if (controller.signal.aborted || !this.#data)
        throw new SafeError(
          'Command access ended. Effects may already have occurred; output was discarded.',
        );
      this.mutate(() => {}, result.successful ? 'finished' : 'failed', operation);
      return result;
    } catch (error) {
      if (this.#data) this.mutate(() => {}, 'failed', operation);
      throw error instanceof SafeError
        ? error
        : new SafeError(
            'Command failed. Effects may already have occurred; do not retry automatically.',
          );
    } finally {
      this.#commands.delete(revision);
      this.#active.delete(controller);
      signal?.removeEventListener('abort', cancel);
      for (const key of Object.keys(env)) delete env[key];
      secrets.fill('');
    }
  }
  private data(): VaultData {
    if (!this.#data) throw new SafeError('Unlock AgentKey in the desktop app first.');
    return this.#data;
  }
  private hasGrant(operation: string): boolean {
    const data = this.data();
    const sharing =
      data.databases.some((entry) => entry.name === operation) ||
      !!data.operations.find((entry) => entry.name === operation)?.responseFields?.length;
    return data.grants.some(
      (grant) =>
        grant.operation === operation &&
        (grant.expiresAt === null || grant.expiresAt > Date.now()) &&
        (!sharing || grant.dataSharingAccepted === true),
    );
  }
  private abortOperations(names: Set<string>): void {
    for (const [controller, name] of this.#active) if (names.has(name)) controller.abort();
  }
  private mutate(
    change: (next: VaultData) => void,
    event: AuditEntry['event'],
    name: string,
    status?: number,
  ): void {
    const next = structuredClone(this.data());
    change(next);
    next.snapshots = next.snapshots.filter((snapshot) =>
      next.databases.some(
        (database) => database.source === 'snapshot' && database.snapshot === snapshot.id,
      ),
    );
    next.audit = [
      { at: Date.now(), event, name, ...(status === undefined ? {} : { status }) },
      ...next.audit,
    ].slice(0, 200);
    try {
      this.storage.save(next);
    } catch {
      this.lock();
      throw new SafeError(
        'Could not persist the change. The vault was locked. Check disk access, unlock, and review approvals before continuing.',
      );
    }
    this.#data = next;
  }
}
