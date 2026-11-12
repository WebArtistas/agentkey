import { Component, computed, input, linkedSignal, output, untracked } from '@angular/core';
import { disabled, form, FormField } from '@angular/forms/signals';
import { TuiButton, TuiCheckbox, TuiInput } from '@taiga-ui/core';
import { TuiDataListWrapper, TuiSelect, TuiTextarea } from '@taiga-ui/kit';
import { APPROVAL_DURATIONS, ApprovalDurationOptions } from './approval-duration';
import type {
  ApprovalDuration,
  HttpMethod,
  HttpProposal,
  ProposalApproval,
} from '../../shared/contracts';

@Component({
  selector: 'app-http-review',
  imports: [
    FormField,
    TuiButton,
    TuiCheckbox,
    TuiInput,
    TuiSelect,
    TuiDataListWrapper,
    TuiTextarea,
    ApprovalDurationOptions,
  ],
  template: `
    <article class="operation-row http-review">
      <p class="eyebrow">New API request · Not authorized</p>
      <h2>{{ destination().hostname }}</h2>
      <p>
        <strong>{{ action() }}</strong> · {{ review().operation.name }}
      </p>
      <p class="endpoint">
        <strong [attr.data-method]="review().operation.method">{{
          review().operation.method
        }}</strong>
        {{ review().operation.url }}
      </p>
      <p>
        Use saved secret <code>{{ review().operation.item }}</code
        >. Its value is inserted only inside AgentKey.
      </p>
      <p>
        <strong>Return to the agent:</strong>
        {{ review().operation.responseFields?.join(', ') || 'HTTP status only' }}
      </p>
      <form (submit)="$event.preventDefault(); submit()" class="editor">
        <tui-textfield appApprovalDuration [tuiTextfieldCleaner]="false">
          <label tuiLabel>Allow this request</label>
          <input tuiSelect [formField]="fields.duration" />
          <tui-data-list-wrapper *tuiDropdown [items]="durations" />
        </tui-textfield>
        <p class="hint">
          Once means one attempt, even on failure. Approval does not send the request; the agent
          runs it afterward.
        </p>
        <label class="sharing-consent">
          <input tuiCheckbox type="checkbox" [formField]="consentForm.accepted" />
          I trust this destination and approve the displayed action{{
            draft().reusable ? ' and reusable permissions' : ''
          }}.
          @if (review().operation.responseFields?.length) {
            I consent to sharing the selected data with agents and their providers. Secret redaction
            is best-effort; an API can return encoded secrets or sensitive data.
          }
        </label>
        <div class="field-row review-actions">
          <button tuiButton type="submit" [disabled]="busy() || !consent().accepted">
            Approve request
          </button>
          <button
            tuiButton
            type="button"
            appearance="secondary"
            [disabled]="busy()"
            (click)="dismiss.emit(review().revision)"
          >
            Dismiss request
          </button>
        </div>
        <details>
          <summary>Advanced: reusable API permissions</summary>
          <label class="sharing-consent">
            <input tuiCheckbox type="checkbox" [formField]="fields.reusable" />
            Let agents change requests within explicit rules
          </label>
          @if (draft().reusable) {
            <p class="notice">
              Origin stays {{ destination().origin }}. Agents can change query parameters and
              request bodies without another review. Secret mapping, body format and returned fields
              stay fixed. These permissions can authorize destructive actions.
            </p>
            <tui-textfield [tuiTextfieldCleaner]="false">
              <label tuiLabel>Allowed paths (one per line)</label>
              <textarea tuiTextarea [formField]="fields.paths" spellcheck="false"></textarea>
            </tui-textfield>
            <p class="hint">
              Exact paths by default. A trailing /* permits descendants. No other wildcards.
            </p>
            <fieldset>
              <legend>Allowed methods</legend>
              @for (method of methods; track method) {
                <label class="sharing-consent"
                  ><input tuiCheckbox type="checkbox" [formField]="fields.methods[method]" />{{
                    method
                  }}</label
                >
              }
            </fieldset>
          }
        </details>
      </form>
      <details>
        <summary>Exact request and secret mapping</summary>
        <p>
          Authentication:
          {{
            review().operation.auth === 'basic'
              ? 'HTTP Basic (saved username and password)'
              : 'Secret headers'
          }}
        </p>
        @for (binding of review().operation.bindings; track binding.header) {
          <p class="mono">
            {{ binding.header }} ← {{ binding.prefix }}[{{ review().operation.item }}.{{
              binding.field
            }}]
          </p>
        }
        <p>Body format: {{ review().operation.bodyFormat || 'json' }}</p>
        <pre>{{ review().operation.body || '(no request body)' }}</pre>
      </details>
    </article>
  `,
})
export class HttpReview {
  readonly proposal = input.required<HttpProposal>();
  readonly busy = input(false);
  readonly defaultDuration = input<ApprovalDuration>('once');
  readonly approve = output<ProposalApproval>();
  readonly dismiss = output<string>();
  protected readonly review = computed(() => this.proposal(), {
    equal: (a, b) => a.revision === b.revision,
  });
  protected readonly destination = computed(() => new URL(this.review().operation.url));
  protected readonly action = computed(
    () =>
      ({
        GET: 'Read API data',
        POST: 'Send or create data',
        PUT: 'Replace data',
        PATCH: 'Update data',
        DELETE: 'Delete data',
      })[this.review().operation.method],
  );
  protected readonly methods: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  protected readonly durations = APPROVAL_DURATIONS;
  protected readonly draft = linkedSignal(() => ({
    duration: untracked(this.defaultDuration),
    reusable: false,
    paths: this.destination().pathname,
    methods: {
      GET: this.review().operation.method === 'GET',
      POST: this.review().operation.method === 'POST',
      PUT: this.review().operation.method === 'PUT',
      PATCH: this.review().operation.method === 'PATCH',
      DELETE: this.review().operation.method === 'DELETE',
    },
  }));
  protected readonly fields = form(this.draft, (path) => disabled(path, () => this.busy()));
  protected readonly consent = linkedSignal(() => {
    this.draft();
    return { accepted: false };
  });
  protected readonly consentForm = form(this.consent, (path) => disabled(path, () => this.busy()));
  protected submit(): void {
    if (!this.consent().accepted || this.busy()) return;
    const draft = this.draft();
    this.approve.emit({
      revision: this.review().revision,
      duration: draft.duration,
      dataSharingAccepted: true,
      ...(draft.reusable
        ? {
            scope: {
              paths: draft.paths
                .split('\n')
                .map((p) => p.trim())
                .filter(Boolean),
              methods: this.methods.filter((method) => draft.methods[method]),
            },
          }
        : {}),
    });
    this.consent.set({ accepted: false });
  }
}
