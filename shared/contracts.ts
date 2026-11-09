export type ItemKind = 'secret' | 'login' | 'group';
export interface SecretField {
  name: string;
  value: string;
}
export interface ItemInput {
  name: string;
  kind: ItemKind;
  fields: SecretField[];
}
export interface ItemSummary {
  name: string;
  kind: ItemKind;
  fields: string[];
}
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface HeaderBinding {
  header: string;
  field: string;
  prefix: string;
}
export interface HttpScope {
  paths: string[];
  methods: HttpMethod[];
}
export interface HttpRequest {
  url: string;
  method: HttpMethod;
  body: string;
}
export interface OperationInput {
  name: string;
  item: string;
  url: string;
  method: HttpMethod;
  auth: 'headers' | 'basic';
  bindings: HeaderBinding[];
  body: string;
  bodyFormat?: 'json' | 'form';
  responseFields?: string[];
  scope?: HttpScope;
}
export interface HttpProposal {
  revision: string;
  requestedAt: number;
  operation: OperationInput;
}
export interface ProposalApproval {
  revision: string;
  duration: ApprovalDuration;
  dataSharingAccepted: boolean;
  scope?: HttpScope;
}
export interface OperationSummary {
  revision: string;
  name: string;
  item: string;
  url: string;
  method: HttpMethod;
  auth: 'headers' | 'basic';
  bindings: HeaderBinding[];
  hasBody: boolean;
  bodyFormat?: 'json' | 'form';
  responseFields?: string[];
  scope?: HttpScope;
}
export interface CommandInput {
  name: string;
  executable: string;
  cwd: string;
  args: string[];
  bindings: { env: string; item: string; field: string }[];
  timeoutMs: number;
}
export interface CommandRequest {
  revision: string;
  requestedAt: number;
  state: 'pending' | 'approved' | 'running';
  command: CommandInput;
}
export interface CommandApproval {
  revision: string;
  executionAccepted: true;
  dataSharingAccepted: true;
}
export interface CommandResult {
  operation: string;
  exitCode: number | null;
  successful: boolean;
  stdout: string;
  stderr: string;
}
export interface DatabaseTable {
  schema: string;
  table: string;
  columns: string[];
}
export type DatabaseInput = { name: string; tables: DatabaseTable[] } & (
  | { source: 'snapshot'; engine: 'sqlite'; snapshot: string }
  | { source?: 'item'; engine?: 'postgres' | 'sqlite'; item: string; field: string }
);
export type DatabaseSummary = DatabaseInput & { revision: string };
// Desktop-only setup metadata. The agent never receives the selection token or file path.
export interface SQLiteSelection {
  token: string;
  label: string;
  demo: boolean;
  tables: DatabaseTable[];
}
export interface SQLiteSetupInput {
  token: string;
  name: string;
  tables: DatabaseTable[];
}
export interface DatabaseRead {
  connection: string;
  schema: string;
  table: string;
  columns: string[];
  filters: { column: string; value: string | number | boolean | null }[];
  limit: number;
}
export interface DatabaseResult {
  connection: string;
  columns: string[];
  rows: (string | null)[][];
  limit: number;
}
export type ApprovalDuration = 'once' | 'hour' | 'day' | 'until-revoked';
export type ApprovalWaitState =
  'approved' | 'dismissed' | 'revoked' | 'changed' | 'locked' | 'expired' | 'timeout' | 'cancelled';
export interface ApprovalWaitResult {
  operation: string;
  state: ApprovalWaitState;
}
export interface GrantSummary {
  operation: string;
  expiresAt: number | null;
  remainingUses: number | null;
  dataSharingAccepted?: true;
}
export interface PendingSummary {
  operation: string;
  requestedAt: number;
}
export interface AuditEntry {
  at: number;
  event:
    | 'saved-item'
    | 'saved-operation'
    | 'approved'
    | 'revoked'
    | 'attempted'
    | 'finished'
    | 'failed'
    | 'deleted';
  name: string;
  status?: number;
}
export interface VaultSnapshot {
  initialized: boolean;
  unlocked: boolean;
  items: ItemSummary[];
  operations: OperationSummary[];
  proposals: HttpProposal[];
  commands: CommandRequest[];
  databases: DatabaseSummary[];
  grants: GrantSummary[];
  pending: PendingSummary[];
  audit: AuditEntry[];
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export interface DesktopApi {
  snapshot(): Promise<Result<VaultSnapshot>>;
  initialize(password: string): Promise<Result<void>>;
  unlock(password: string): Promise<Result<void>>;
  lock(): Promise<Result<void>>;
  saveItem(item: ItemInput): Promise<Result<void>>;
  deleteItem(name: string): Promise<Result<void>>;
  saveOperation(operation: OperationInput): Promise<Result<void>>;
  approveProposal(input: ProposalApproval): Promise<Result<void>>;
  approveCommand(input: CommandApproval): Promise<Result<void>>;
  dismissCommand(revision: string): Promise<Result<void>>;
  dismissProposal(revision: string): Promise<Result<void>>;
  reviewOperation(name: string): Promise<Result<OperationInput>>;
  deleteOperation(name: string): Promise<Result<void>>;
  saveDatabase(database: DatabaseInput): Promise<Result<void>>;
  prepareSQLite(source: 'demo' | 'file'): Promise<Result<SQLiteSelection | null>>;
  saveSQLite(input: SQLiteSetupInput): Promise<Result<void>>;
  cancelSQLite(token: string): Promise<Result<void>>;
  approve(
    operation: string,
    duration: ApprovalDuration,
    revision: string,
    dataSharingAccepted?: boolean,
  ): Promise<Result<void>>;
  showWindow(view: 'full' | 'compact'): Promise<Result<void>>;
  hidePanel(): Promise<Result<void>>;
  revoke(operation: string): Promise<Result<void>>;
  connection(): Promise<
    Result<{
      dataDirectory: string;
      command: string;
      args: string[];
      env?: Record<string, string>;
    }>
  >;
}
export interface RunResult {
  operation: string;
  status: number;
  successful: boolean;
  data?: Record<string, string | number | boolean | null | (string | number | boolean | null)[]>;
}
export type AgentCommand =
  | { action: 'status' }
  | { action: 'list-items' }
  | { action: 'list-operations' }
  | { action: 'request-access'; operation: string }
  | { action: 'wait-for-approval'; operation: string; timeoutMs?: number }
  | { action: 'propose-operation'; operation: Omit<OperationInput, 'scope'> }
  | { action: 'run'; operation: string; request?: HttpRequest }
  | { action: 'propose-command'; command: CommandInput }
  | { action: 'run-command'; operation: string; revision: string }
  | { action: 'list-databases' }
  | { action: 'read-database'; query: DatabaseRead };
