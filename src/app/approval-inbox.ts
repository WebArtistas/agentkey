import { DatePipe } from '@angular/common';
import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { form, FormField } from '@angular/forms/signals';
import { TuiButton, TuiInput } from '@taiga-ui/core';
import type { VaultSnapshot } from '../../shared/contracts';
import { approvalEntries, type ApprovalCategory } from './approval-model';

@Component({
  selector: 'app-approval-inbox',
  imports: [DatePipe, FormField, TuiButton, TuiInput],
  template: `
    <div #statuses class="approval-statuses" role="group" aria-label="Approval status">
      @for (tab of categories; track tab.id) {
        <button
          tuiButton
          type="button"
          size="m"
          [appearance]="category() === tab.id ? 'secondary' : 'flat'"
          [attr.aria-pressed]="category() === tab.id"
          [disabled]="busy()"
          (click)="setCategory(tab.id)"
        >
          {{ tab.label }} <span class="count-badge">{{ counts()[tab.id] }}</span>
        </button>
      }
    </div>
    <details class="inbox-options" [open]="!compact()">
      <summary>
        Search, filters &amp; duration
        @if (searchModel().query.trim() || kind() !== 'all') {
          <span class="hint"> · Filters active</span>
        }
      </summary>
      <div class="inbox-tools">
        <tui-textfield
          ><label tuiLabel>Search approvals</label
          ><input tuiInput type="search" [formField]="searchForm.query"
        /></tui-textfield>
        <div class="choices" role="group" aria-label="Request type">
          @for (filter of kinds; track filter.id) {
            <button
              tuiButton
              type="button"
              size="s"
              [appearance]="kind() === filter.id ? 'secondary' : 'flat'"
              [attr.aria-pressed]="kind() === filter.id"
              [disabled]="busy()"
              (click)="kind.set(filter.id)"
            >
              {{ filter.label }}
            </button>
          }
        </div>
      </div>
      <ng-content select="[inbox-settings]" />
    </details>
    <p class="hint inbox-caption">{{ descriptions[category()] }}</p>
    <div class="inbox-layout" [class.inbox-empty]="!filtered().length">
      <section class="inbox-list" aria-label="Approval requests">
        <ul>
          @for (entry of filtered(); track entry.key) {
            <li>
              <button
                tuiButton
                type="button"
                appearance="flat"
                class="request-summary"
                [class.selected]="active()?.key === entry.key"
                [attr.aria-pressed]="active()?.key === entry.key"
                aria-controls="approval-review"
                [disabled]="busy()"
                (click)="select(entry.key)"
              >
                <span class="request-name">{{ entry.name }}</span>
                <span class="request-destination">{{ entry.destination }}</span>
                <span class="hint">{{ entry.summary }}</span>
                @if (entry.category === 'active' && entry.grant; as grant) {
                  <span class="request-state">{{
                    grant.remainingUses
                      ? 'One attempt remaining'
                      : grant.expiresAt
                        ? 'Until ' + (grant.expiresAt | date: 'short')
                        : 'Until revoked'
                  }}</span>
                } @else if (entry.requestedAt) {
                  <span class="hint">Requested {{ entry.requestedAt | date: 'shortTime' }}</span>
                }
              </button>
            </li>
          }
        </ul>
      </section>
      <section
        #detail
        id="approval-review"
        class="approval-detail"
        aria-label="Request review"
        tabindex="-1"
        [hidden]="!active()"
      >
        <ng-content />
      </section>
      @if (!filtered().length) {
        <div class="empty-state" role="status">
          <h2>
            {{
              entries().length === 0
                ? 'Nothing to approve yet.'
                : searchModel().query.trim() || kind() !== 'all'
                  ? 'No matching approvals.'
                  : category() === 'pending'
                    ? 'You’re all caught up.'
                    : category() === 'active'
                      ? 'No active access.'
                      : 'No inactive permissions.'
            }}
          </h2>
          <p>
            {{
              entries().length === 0
                ? 'Ask your agent to propose a request, or add an API operation or database connection.'
                : category() === 'pending'
                  ? 'New requests appear here. Saved permissions are under Active access or Inactive.'
                  : 'Choose another status or adjust your filters.'
            }}
          </p>
          @if (searchModel().query || kind() !== 'all') {
            <button
              tuiButton
              type="button"
              appearance="secondary"
              size="s"
              (click)="resetFilters()"
            >
              Clear filters
            </button>
          }
        </div>
      }
    </div>
  `,
})
export class ApprovalInbox {
  readonly snapshot = input.required<VaultSnapshot>();
  readonly busy = input(false);
  readonly compact = input(false);
  protected readonly category = signal<ApprovalCategory>('pending');
  protected readonly kind = signal<'all' | 'api' | 'database' | 'command'>('all');
  protected readonly searchModel = signal({ query: '' });
  protected readonly searchForm = form(this.searchModel);
  protected readonly selected = signal('');
  protected readonly categories: { id: ApprovalCategory; label: string }[] = [
    { id: 'pending', label: 'Needs review' },
    { id: 'active', label: 'Active access' },
    { id: 'inactive', label: 'Inactive' },
  ];
  protected readonly kinds = [
    { id: 'all', label: 'All types' },
    { id: 'api', label: 'API' },
    { id: 'database', label: 'Database' },
    { id: 'command', label: 'Command' },
  ] as const;
  protected readonly descriptions = {
    pending: 'Review one request at a time. Approval grants access; it does not run the request.',
    active: 'Permissions currently available to local clients. Revoke access at any time.',
    inactive: 'Saved permissions without an active grant. No request is waiting for these.',
  };
  protected readonly entries = computed(() => approvalEntries(this.snapshot()));
  protected readonly counts = computed(() => ({
    pending: this.entries().filter((entry) => entry.category === 'pending').length,
    active: this.entries().filter((entry) => entry.category === 'active').length,
    inactive: this.entries().filter((entry) => entry.category === 'inactive').length,
  }));
  protected readonly filtered = computed(() => {
    const query = this.searchModel().query.trim().toLowerCase();
    return this.entries().filter(
      (entry) =>
        entry.category === this.category() &&
        (this.kind() === 'all' || entry.kind === this.kind()) &&
        entry.search.includes(query),
    );
  });
  readonly active = computed(
    () =>
      this.filtered().find((entry) => entry.key === this.selected()) ??
      this.filtered().at(0) ??
      null,
  );
  private readonly injector = inject(Injector);
  private readonly detail = viewChild<ElementRef<HTMLElement>>('detail');
  private readonly statuses = viewChild<ElementRef<HTMLElement>>('statuses');
  showPending(): void {
    this.setCategory('pending');
    this.resetFilters();
  }
  focusAfterDecision(): void {
    afterNextRender(
      () =>
        this.statuses()
          ?.nativeElement.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
          ?.focus(),
      { injector: this.injector },
    );
  }
  protected select(key: string): void {
    this.selected.set(key);
    afterNextRender(
      () => {
        this.detail()?.nativeElement.focus({ preventScroll: true });
        this.detail()?.nativeElement.scrollIntoView({ block: 'nearest' });
      },
      { injector: this.injector },
    );
  }
  protected setCategory(category: ApprovalCategory): void {
    this.category.set(category);
    this.selected.set('');
  }
  protected resetFilters(): void {
    this.searchModel.set({ query: '' });
    this.kind.set('all');
  }
}
