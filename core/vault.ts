import { randomUUID } from 'node:crypto';
import type {
  AgentCommand,
  AuditEntry,
  DatabaseResult,
  DatabaseTable,
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
  parseInput,
  SafeError,
  type VaultData,
} from './schema';
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
  #revisions = new Map<string, string>();
  #active = new Map<AbortController, string>();
  readonly storage: VaultStorage;

  constructor(
    directory: string,
    private readonly send: SendOperation = sendOperation,
    private readonly read: ReadDatabase = readDatabase,
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
    this.#sessionRevision++;
    for (const controller of this.#active.keys()) controller.abort();
    this.#pending.clear();
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
    }
  }
  deleteItem(input: unknown): void {
    const name = parseInput(nameSchema, input);
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
    }
  }
  saveOperation(input: unknown): void {
    const operation = parseInput(operationSchema, input);
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
  }
  deleteOperation(input: unknown): void {
    const name = parseInput(nameSchema, input);
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
    const database = this.data().databases.some((entry) => entry.name === operation);
    if (database && dataSharingAccepted !== true)
      throw new SafeError(
        'Explicit data-sharing consent is required before approving database access.',
      );
    this.mutate(
      (next) => {
        next.grants = [
          ...next.grants.filter((grant) => grant.operation !== operation),
          {
            operation,
            expiresAt:
              duration === 'hour'
                ? Date.now() + 3_600_000
                : duration === 'day'
                  ? Date.now() + 86_400_000
                  : null,
            remainingUses: duration === 'once' ? 1 : null,
            ...(database ? { dataSharingAccepted: true as const } : {}),
          },
        ];
      },
      'approved',
      operation,
    );
    this.#pending.delete(operation);
    this.#revisions.delete(operation);
  }
  revoke(input: unknown): void {
    const operation = parseInput(nameSchema, input);
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
  }
  private policyRevision(name: string): string {
    // Random review tokens reveal nothing about a credential, unlike hashes of secret values.
    const revision = this.#revisions.get(name) ?? randomUUID();
    this.#revisions.set(name, revision);
    return revision;
  }
  async run(input: unknown): Promise<RunResult> {
    const name = parseInput(nameSchema, input);
    const operation = this.data().operations.find((entry) => entry.name === name);
    if (!operation) throw new SafeError('Unknown operation.');
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
      const status = await this.send(structuredClone(operation), headers, controller.signal);
      if (controller.signal.aborted || !this.#data)
        throw new SafeError(
          'Access ended during the request. The API may already have processed it.',
        );
      this.mutate(() => {}, 'finished', name, status);
      return { operation: name, status, successful: status >= 200 && status < 300 };
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
  }
  saveDatabase(input: unknown): void {
    const database = parseInput(databaseSchema, input);
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
  async dispatch(input: unknown): Promise<unknown> {
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
      case 'run':
        return this.run(command.operation);
      case 'list-databases':
        this.data();
        return this.snapshot().databases;
      case 'read-database':
        return this.readRows(command.query);
    }
  }
  private data(): VaultData {
    if (!this.#data) throw new SafeError('Unlock AgentKey in the desktop app first.');
    return this.#data;
  }
  private hasGrant(operation: string): boolean {
    const data = this.data();
    const database = data.databases.some((entry) => entry.name === operation);
    return data.grants.some(
      (grant) =>
        grant.operation === operation &&
        (grant.expiresAt === null || grant.expiresAt > Date.now()) &&
        (!database || grant.dataSharingAccepted === true),
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
