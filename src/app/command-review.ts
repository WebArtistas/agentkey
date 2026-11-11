import { Component, computed, input, linkedSignal, output } from '@angular/core';
import { disabled, form, FormField } from '@angular/forms/signals';
import { TuiButton, TuiCheckbox } from '@taiga-ui/core';
import type { CommandApproval, CommandRequest } from '../../shared/contracts';

@Component({
  selector: 'app-command-review',
  imports: [FormField, TuiButton, TuiCheckbox],
  template: `
    <article class="operation-row http-review">
      <p class="eyebrow">Local command · {{ review().state }}</p>
      <h2>{{ review().command.name }}</h2>
      <p class="notice">
        This program receives real credentials and runs with your OS account's permissions. It can
        modify files, contact services and change databases. This is not a sandbox. Trust the
        executable, scripts and dependencies—not just the command name.
      </p>
      @if (review().state === 'pending') {
        <form class="editor" (submit)="$event.preventDefault(); submit()">
          <label class="sharing-consent"
            ><input tuiCheckbox type="checkbox" [formField]="fields.execution" />I trust this
            program and approve the exact action and secret bindings shown in this request.</label
          >
          <label class="sharing-consent"
            ><input tuiCheckbox type="checkbox" [formField]="fields.sharing" />I accept best-effort
            redaction and sharing command output with agents and their providers.</label
          >
          <div class="actions">
            <button
              tuiButton
              type="submit"
              [disabled]="busy() || !consent().execution || !consent().sharing"
            >
              Approve one attempt
            </button>
            <button
              tuiButton
              type="button"
              appearance="secondary"
              [disabled]="busy()"
              (click)="dismiss.emit(review().revision)"
            >
              Dismiss command
            </button>
          </div>
        </form>
      } @else {
        <p>
          {{
            review().state === 'running'
              ? 'Execution started. Cancellation is best-effort and cannot roll back effects.'
              : 'Approved for one attempt. The agent may launch it before expiry.'
          }}
        </p>
        <button
          tuiButton
          type="button"
          appearance="secondary"
          [disabled]="busy()"
          (click)="dismiss.emit(review().revision)"
        >
          {{ review().state === 'running' ? 'Cancel command' : 'Revoke command' }}
        </button>
      }
      <p><strong>Executable</strong></p>
      <pre>{{ review().command.executable }}</pre>
      <p><strong>Working directory</strong></p>
      <pre>{{ review().command.cwd }}</pre>
      <p><strong>Exact arguments (JSON array)</strong></p>
      <pre>{{ argumentsText() }}</pre>
      <p><strong>Child-process secret bindings</strong></p>
      @for (binding of review().command.bindings; track binding.env) {
        <p class="mono">{{ binding.env }} ← [{{ binding.item }}.{{ binding.field }}]</p>
      }
      <p>
        No automatic shell or interactive input. The desktop environment is not inherited (except
        Windows SystemRoot). Credentials are not exported into the agent's shell.
      </p>
      <p>
        Timeout: {{ review().command.timeoutMs / 1000 }} seconds. Return: exit status and up to 64
        KiB combined stdout/stderr. Secret redaction is best-effort; transformed secrets and other
        sensitive data may reach the agent/provider.
      </p>
      <p>
        One attempt only, even on failure. This request expires ten minutes after submission or on
        lock. Approval does not launch it. Code changes are not tracked; do not change the program
        between review and execution.
      </p>
    </article>
  `,
})
export class CommandReview {
  readonly review = input.required<CommandRequest>();
  readonly busy = input(false);
  readonly approve = output<CommandApproval>();
  readonly dismiss = output<string>();
  protected readonly argumentsText = computed(() =>
    JSON.stringify(this.review().command.args, null, 2),
  );
  private readonly consentKey = computed(() => `${this.review().revision}:${this.review().state}`);
  protected readonly consent = linkedSignal(() => {
    this.consentKey();
    return { execution: false, sharing: false };
  });
  protected readonly fields = form(this.consent, (path) => {
    disabled(path.execution, () => this.busy());
    disabled(path.sharing, () => this.busy());
  });
  protected submit(): void {
    if (
      this.busy() ||
      this.review().state !== 'pending' ||
      !this.consent().execution ||
      !this.consent().sharing
    )
      return;
    this.approve.emit({
      revision: this.review().revision,
      executionAccepted: true,
      dataSharingAccepted: true,
    });
  }
}
