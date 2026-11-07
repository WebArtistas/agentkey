import { DatePipe } from '@angular/common';
import { Component, computed, DestroyRef, inject, linkedSignal, signal } from '@angular/core';
import { disabled, form, FormField, maxLength, required } from '@angular/forms/signals';
import { TuiButton, TuiCheckbox, TuiInput, TuiRoot } from '@taiga-ui/core';
import { TuiDataListWrapper, TuiSelect } from '@taiga-ui/kit';
import type {
  ApprovalDuration,
  DesktopApi,
  DatabaseInput,
  SQLiteSelection,
  SQLiteSetupInput,
  ItemInput,
  ItemSummary,
  OperationInput,
  Result,
  VaultSnapshot,
} from '../../shared/contracts';
import { ItemEditor } from './item-editor';
import { OperationEditor } from './operation-editor';
import { PasswordToggle } from './password-toggle';
import { DatabaseEditor } from './database-editor';
import { SQLiteEditor } from './sqlite-editor';

declare global {
  interface Window {
    agentkey?: DesktopApi;
  }
}
type Page = 'vault' | 'operations' | 'databases' | 'access' | 'activity' | 'connect';

@Component({
  selector: 'app-root',
  imports: [
    DatePipe,
    FormField,
    TuiRoot,
    TuiButton,
    TuiCheckbox,
    TuiInput,
    TuiSelect,
    TuiDataListWrapper,
    ItemEditor,
    OperationEditor,
    PasswordToggle,
    DatabaseEditor,
    SQLiteEditor,
  ],
  templateUrl: './app.html',
  host: { '(window:focus)': 'focused()', '(window:keydown.escape)': 'dismiss($event)' },
})
export class App {
  private readonly api = window.agentkey;
  protected readonly compact =
    new URLSearchParams(window.location.search).get('view') === 'compact';
  protected readonly snapshot = signal<VaultSnapshot | null>(null);
  protected readonly page = signal<Page>(this.compact ? 'access' : 'vault');
  protected readonly busy = signal(false);
  protected readonly message = signal('');
  protected readonly failure = signal('');
  protected readonly editingItem = signal(false);
  protected readonly initialItem = signal<ItemSummary | null>(null);
  protected readonly editingOperation = signal(false);
  protected readonly editingDatabase = signal(false);
  protected readonly initialDatabase = signal<DatabaseInput | null>(null);
  protected readonly sqliteSelection = signal<SQLiteSelection | null>(null);
  protected readonly deleting = signal('');
  protected readonly connection = signal('');
  protected readonly authModel = signal({ password: '', confirmation: '' });
  protected readonly authForm = form(this.authModel, (path) => {
    required(path.password);
    maxLength(path.password, 1024);
    maxLength(path.confirmation, 1024);
  });
  protected readonly approvalModel = signal<{ duration: ApprovalDuration }>({ duration: 'once' });
  protected readonly approvalForm = form(this.approvalModel);
  private readonly databaseReviews = computed(
    () => this.snapshot()?.databases.map((database) => database.revision) ?? [],
    { equal: (a, b) => a.length === b.length && a.every((revision, i) => revision === b[i]) },
  );
  protected readonly sharingModel = linkedSignal(() => {
    this.approvalModel(); // Changing duration or policy requires a new acknowledgement.
    return { reviews: this.databaseReviews().map((revision) => ({ revision, accepted: false })) };
  });
  protected readonly sharingForm = form(this.sharingModel, (path) => {
    disabled(path, () => this.busy());
  });
  protected readonly durations = ['once', 'hour', 'day', 'until-revoked'];
  protected readonly pages: { id: Page; label: string; number: string }[] = [
    { id: 'vault', label: 'Vault', number: '01' },
    { id: 'operations', label: 'API operations', number: '02' },
    { id: 'databases', label: 'Databases', number: '03' },
    { id: 'access', label: 'Approvals', number: '04' },
    { id: 'activity', label: 'Activity', number: '05' },
    { id: 'connect', label: 'Connect an agent', number: '06' },
  ];
  private refreshId = 0;

  constructor() {
    if (!this.api) {
      this.failure.set(
        'Open AgentKey as a desktop app. The vault is intentionally unavailable in a normal browser.',
      );
      return;
    }
    void this.refresh();
    void this.api
      .connection()
      .then((result) => {
        if (result.ok) {
          this.connection.set(
            JSON.stringify(
              {
                mcpServers: {
                  agentkey: {
                    command: result.value.command,
                    args: result.value.args,
                    ...(result.value.env ? { env: result.value.env } : {}),
                  },
                },
              },
              null,
              2,
            ),
          );
        }
      })
      .catch(() => this.failure.set('Agent connection details are unavailable.'));
    const timer = setInterval(() => {
      if (!this.busy()) void this.refresh();
    }, 2000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
  protected focused(): void {
    if (this.api && !this.busy()) void this.refresh();
  }
  protected dismiss(event?: Event): void {
    // Escape first belongs to an open choice list, not its surrounding tray panel.
    if (event && document.querySelector('[role="listbox"]')) return;
    if (this.compact && !event?.defaultPrevented) {
      event?.preventDefault();
      void this.api?.hidePanel().catch(() => this.failure.set('Unable to hide quick access.'));
    }
  }
  protected async showWindow(view: 'full' | 'compact'): Promise<void> {
    await this.act(() => this.api!.showWindow(view), '');
  }
  protected navigate(page: Page): void {
    this.clearSharingConsent();
    void this.cancelSQLite();
    this.page.set(page);
    this.editingItem.set(false);
    this.editingOperation.set(false);
    this.editingDatabase.set(false);
    this.sqliteSelection.set(null);
    this.deleting.set('');
    this.failure.set('');
    this.message.set('');
  }
  protected async authenticate(): Promise<void> {
    const { password, confirmation } = this.authModel();
    if (!this.snapshot()?.initialized && password !== confirmation) {
      this.failure.set('The passphrases do not match.');
      return;
    }
    await this.act(
      () =>
        this.snapshot()?.initialized ? this.api!.unlock(password) : this.api!.initialize(password),
      'Vault unlocked.',
    );
    this.authModel.set({ password: '', confirmation: '' });
  }
  protected async lock(): Promise<void> {
    this.clearSharingConsent();
    await this.act(() => this.api!.lock(), 'Vault locked.');
  }
  protected newItem(item: ItemSummary | null = null): void {
    this.initialItem.set(item);
    this.editingItem.set(true);
  }
  protected async saveItem(item: ItemInput): Promise<void> {
    if (
      await this.act(
        () => this.api!.saveItem(item),
        'Item encrypted and saved. Related approvals were revoked.',
      )
    )
      this.editingItem.set(false);
  }
  protected async saveOperation(operation: OperationInput): Promise<void> {
    if (
      await this.act(
        () => this.api!.saveOperation(operation),
        'Operation saved. Approval is required before an agent can run it.',
      )
    )
      this.editingOperation.set(false);
  }
  protected async prepareSQLite(source: 'demo' | 'file'): Promise<void> {
    this.sqliteSelection.set(null);
    this.editingDatabase.set(false);
    await this.act(async () => {
      const result = await this.api!.prepareSQLite(source);
      if (!result.ok) return result;
      this.sqliteSelection.set(result.value);
      return { ok: true, value: undefined };
    }, '');
  }
  protected async cancelSQLite(): Promise<void> {
    const selection = this.sqliteSelection();
    if (!selection) return;
    this.sqliteSelection.set(null);
    try {
      const result = await this.api?.cancelSQLite(selection.token);
      if (result && !result.ok) this.failure.set(result.error);
    } catch {
      this.failure.set('Unable to clear the SQLite selection. Lock the vault to discard it.');
    }
  }
  protected async saveSQLite(input: SQLiteSetupInput): Promise<void> {
    if (
      await this.act(
        () => this.api!.saveSQLite(input),
        'Encrypted SQLite snapshot saved. Consent and approval are required before an agent reads rows.',
      )
    )
      this.sqliteSelection.set(null);
  }
  protected newDatabase(database: DatabaseInput | null = null): void {
    this.sqliteSelection.set(null);
    this.initialDatabase.set(database);
    this.editingDatabase.set(true);
  }
  protected async saveDatabase(database: DatabaseInput): Promise<void> {
    if (
      await this.act(
        () => this.api!.saveDatabase(database),
        'Database policy saved. Related approvals were revoked.',
      )
    )
      this.editingDatabase.set(false);
  }
  protected async removeItem(name: string): Promise<void> {
    await this.act(() => this.api!.deleteItem(name), 'Item and its operations deleted.');
    this.deleting.set('');
  }
  protected async removeOperation(name: string): Promise<void> {
    await this.act(() => this.api!.deleteOperation(name), 'Operation deleted.');
    this.deleting.set('');
  }
  protected sharingAccepted(revision: string): boolean {
    return this.sharingModel().reviews.some(
      (review) => review.revision === revision && review.accepted,
    );
  }
  private clearSharingConsent(): void {
    this.sharingModel.update((model) => ({
      reviews: model.reviews.map((review) => ({ ...review, accepted: false })),
    }));
  }
  protected acceptDataSharing(revision: string, event: Event): void {
    const checked = event.target instanceof HTMLInputElement && event.target.checked;
    this.sharingModel.update((model) => ({
      reviews: model.reviews.map((review) => ({
        ...review,
        accepted: review.revision === revision && checked,
      })),
    }));
  }
  protected async approve(name: string, revision: string): Promise<void> {
    const accepted = this.sharingAccepted(revision);
    this.clearSharingConsent();
    await this.act(
      () => this.api!.approve(name, this.approvalModel().duration, revision, accepted),
      'Approval saved for local clients.',
    );
  }
  protected async revoke(name: string): Promise<void> {
    await this.act(
      () => this.api!.revoke(name),
      'Access revoked. In-flight requests were cancelled where possible.',
    );
  }
  protected grant(name: string) {
    return this.snapshot()?.grants.find((grant) => grant.operation === name);
  }
  private async refresh(): Promise<void> {
    const id = ++this.refreshId;
    try {
      const result = await this.api!.snapshot();
      if (id !== this.refreshId) return;
      if (result.ok) {
        this.snapshot.set(result.value);
      } else this.failure.set(result.error);
    } catch {
      this.failure.set('The desktop connection is unavailable.');
    }
  }
  private async act(action: () => Promise<Result<void>>, success: string): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true);
    this.failure.set('');
    this.message.set('');
    ++this.refreshId;
    try {
      const result = await action();
      if (!result.ok) {
        this.failure.set(result.error);
        return false;
      }
      await this.refresh();
      this.message.set(success);
      return true;
    } catch {
      this.failure.set('The operation could not be completed.');
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
