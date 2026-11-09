import type { GrantSummary, VaultSnapshot } from '../../shared/contracts';

export type ApprovalCategory = 'pending' | 'active' | 'inactive';
export interface ApprovalEntry {
  key: string;
  name: string;
  kind: 'api' | 'database' | 'command';
  category: ApprovalCategory;
  destination: string;
  summary: string;
  search: string;
  requestedAt: number | null;
  grant: GrantSummary | null;
}

/** Presentation only: the vault remains the authority for grants, expiry and execution. */
export function approvalEntries(snapshot: VaultSnapshot): ApprovalEntry[] {
  const grants = new Map(snapshot.grants.map((grant) => [grant.operation, grant]));
  const pending = new Map(
    snapshot.pending.map((request) => [request.operation, request.requestedAt]),
  );
  const state = (name: string): ApprovalCategory =>
    grants.has(name) ? 'active' : pending.has(name) ? 'pending' : 'inactive';
  return [
    ...snapshot.commands.map((request): ApprovalEntry => ({
      key: `command:${request.revision}`,
      name: request.command.name,
      kind: 'command',
      category: request.state === 'pending' ? 'pending' : 'active',
      destination: request.command.executable,
      summary:
        request.state === 'running'
          ? 'Running · Cancellation is not rollback'
          : 'Local command · One attempt only',
      search:
        `${request.command.name} ${request.command.executable} ${request.command.cwd} ${request.command.bindings.map((binding) => `${binding.item} ${binding.field} ${binding.env}`).join(' ')}`.toLowerCase(),
      requestedAt: request.requestedAt,
      grant:
        request.state === 'approved'
          ? {
              operation: request.command.name,
              expiresAt: request.requestedAt + 600_000,
              remainingUses: 1,
            }
          : null,
    })),
    ...snapshot.proposals.map((proposal): ApprovalEntry => ({
      key: `proposal:${proposal.revision}`,
      name: proposal.operation.name,
      kind: 'api',
      category: 'pending',
      destination: new URL(proposal.operation.url).hostname,
      summary: `${proposal.operation.method} · New request`,
      search:
        `${proposal.operation.name} ${proposal.operation.url} ${proposal.operation.item}`.toLowerCase(),
      requestedAt: proposal.requestedAt,
      grant: null,
    })),
    ...snapshot.operations.map((operation): ApprovalEntry => ({
      key: `api:${operation.name}`,
      name: operation.name,
      kind: 'api',
      category: state(operation.name),
      destination: new URL(operation.url).hostname,
      summary: `${operation.method} · ${operation.scope ? 'Reusable permissions' : 'Exact request'}`,
      search: `${operation.name} ${operation.url} ${operation.item}`.toLowerCase(),
      requestedAt: pending.get(operation.name) ?? null,
      grant: grants.get(operation.name) ?? null,
    })),
    ...snapshot.databases.map((database): ApprovalEntry => ({
      key: `database:${database.name}`,
      name: database.name,
      kind: 'database',
      category: state(database.name),
      destination: database.engine === 'sqlite' ? 'SQLite' : 'PostgreSQL',
      summary: `Read-only · ${database.tables.length} ${database.tables.length === 1 ? 'table' : 'tables'}`,
      search:
        `${database.name} ${database.engine === 'sqlite' ? 'SQLite' : 'PostgreSQL'} ${database.source === 'snapshot' ? '' : database.item} ${database.tables.map((table) => `${table.schema}.${table.table} ${table.columns.join(' ')}`).join(' ')}`.toLowerCase(),
      requestedAt: pending.get(database.name) ?? null,
      grant: grants.get(database.name) ?? null,
    })),
  ].sort(
    (a, b) =>
      (a.requestedAt ?? Infinity) - (b.requestedAt ?? Infinity) || a.name.localeCompare(b.name),
  );
}
