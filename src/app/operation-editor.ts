import { Component, computed, input, output, signal } from '@angular/core';
import { applyEach, form, FormField, maxLength, required } from '@angular/forms/signals';
import { TuiButton, TuiInput } from '@taiga-ui/core';
import { TuiDataListWrapper, TuiSelect, TuiTextarea } from '@taiga-ui/kit';
import type { ItemSummary, OperationInput } from '../../shared/contracts';

@Component({
  selector: 'app-operation-editor',
  imports: [FormField, TuiButton, TuiInput, TuiSelect, TuiDataListWrapper, TuiTextarea],
  template: `
    <form class="editor" (submit)="$event.preventDefault(); submit()" autocomplete="off">
      <div class="section-heading">
        <h2>Define an API operation</h2>
        <button tuiButton appearance="flat" size="s" type="button" (click)="cancel.emit()">
          Cancel
        </button>
      </div>
      <p class="hint">
        An agent can run this exact request after approval. It cannot change the URL, method,
        headers or body.
      </p>
      <div class="field-row">
        <tui-textfield [tuiTextfieldCleaner]="false"
          ><label tuiLabel>Operation name</label
          ><input tuiInput [formField]="fields.name" placeholder="trigger-backup"
        /></tui-textfield>
        <tui-textfield [tuiTextfieldCleaner]="false"
          ><label tuiLabel>Vault item</label
          ><input tuiSelect [formField]="fields.item" /><tui-data-list-wrapper
            *tuiDropdown
            [items]="itemNames()"
        /></tui-textfield>
      </div>
      <div class="field-row">
        <tui-textfield [tuiTextfieldCleaner]="false"
          ><label tuiLabel>Method</label
          ><input tuiSelect [formField]="fields.method" /><tui-data-list-wrapper
            *tuiDropdown
            [items]="methods"
        /></tui-textfield>
        <tui-textfield [tuiTextfieldCleaner]="false"
          ><label tuiLabel>Exact HTTPS URL</label
          ><input
            tuiInput
            [formField]="fields.url"
            type="url"
            placeholder="https://api.example.com/v1/jobs"
        /></tui-textfield>
      </div>
      <tui-textfield [tuiTextfieldCleaner]="false"
        ><label tuiLabel>Authentication</label
        ><input tuiSelect [formField]="fields.auth" /><tui-data-list-wrapper
          *tuiDropdown
          [items]="authTypes"
      /></tui-textfield>
      @if (draft().auth === 'headers') {
        <p class="hint">
          Bind one or more field names to request headers. Only the trusted helper inserts their
          values.
        </p>
        @for (binding of fields.bindings; track $index; let index = $index) {
          <div class="field-row">
            <tui-textfield [tuiTextfieldCleaner]="false"
              ><label tuiLabel>Header {{ index + 1 }}</label
              ><input tuiInput [formField]="binding.header"
            /></tui-textfield>
            <tui-textfield [tuiTextfieldCleaner]="false"
              ><label tuiLabel>Field {{ index + 1 }}</label
              ><input tuiSelect [formField]="binding.field" /><tui-data-list-wrapper
                *tuiDropdown
                [items]="fieldNames()"
            /></tui-textfield>
            <tui-textfield [tuiTextfieldCleaner]="false"
              ><label tuiLabel>Prefix {{ index + 1 }}</label
              ><input tuiInput [formField]="binding.prefix" placeholder="Bearer "
            /></tui-textfield>
            @if (draft().bindings.length > 1) {
              <button tuiButton appearance="flat" size="s" type="button" (click)="remove(index)">
                Remove
              </button>
            }
          </div>
        }
        <button
          tuiButton
          appearance="secondary"
          type="button"
          [disabled]="draft().bindings.length >= 16"
          (click)="add()"
        >
          Add header binding
        </button>
      } @else {
        <p class="hint">Basic authentication uses the username and password of a Login item.</p>
      }
      @if (draft().method !== 'GET') {
        <tui-textfield [tuiTextfieldCleaner]="false"
          ><label tuiLabel>Fixed request body (optional)</label
          ><textarea tuiTextarea [formField]="fields.body" spellcheck="false"></textarea>
        </tui-textfield>
      }
      <tui-textfield [tuiTextfieldCleaner]="false">
        <label tuiLabel>Body format</label><input tuiSelect [formField]="optionsForm.bodyFormat" />
        <tui-data-list-wrapper *tuiDropdown [items]="bodyFormats" />
      </tui-textfield>
      <tui-textfield [tuiTextfieldCleaner]="false">
        <label tuiLabel>Returned JSON fields (optional)</label>
        <input tuiInput [formField]="optionsForm.responseFields" placeholder="id, data[].name" />
      </tui-textfield>
      <p class="hint">
        Comma-separated scalar fields, not entire objects. Leave empty for status only. Data sharing
        requires consent at approval.
      </p>
      <p class="notice">
        Only public HTTPS destinations on port 443. No redirects. Put secrets in the vault, not the
        URL, prefix or request body. Only selected JSON fields may be returned. Reusing a name
        replaces the operation and revokes its approval.
      </p>
      <button tuiButton type="submit" [disabled]="busy()">
        {{ busy() ? 'Saving…' : 'Save operation' }}
      </button>
    </form>
  `,
})
export class OperationEditor {
  readonly items = input.required<ItemSummary[]>();
  readonly busy = input(false);
  readonly save = output<OperationInput>();
  readonly cancel = output<void>();
  protected readonly methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  protected readonly authTypes = ['headers', 'basic'];
  protected readonly bodyFormats = ['json', 'form'];
  protected readonly options = signal<{ bodyFormat: 'json' | 'form'; responseFields: string }>({
    bodyFormat: 'json',
    responseFields: '',
  });
  protected readonly optionsForm = form(this.options, (path) =>
    maxLength(path.responseFields, 4096),
  );
  protected readonly draft = signal<OperationInput>({
    name: '',
    item: '',
    url: '',
    method: 'GET',
    auth: 'headers',
    bindings: [{ header: 'Authorization', field: '', prefix: 'Bearer ' }],
    body: '',
  });
  protected readonly fields = form(this.draft, (path) => {
    required(path.name);
    maxLength(path.name, 64);
    required(path.item);
    required(path.url);
    maxLength(path.url, 2048);
    maxLength(path.body, 32768);
    applyEach(path.bindings, (binding) => {
      maxLength(binding.header, 64);
      maxLength(binding.prefix, 64);
    });
  });
  protected readonly itemNames = computed(() => this.items().map((item) => item.name));
  protected readonly fieldNames = computed(
    () => this.items().find((item) => item.name === this.draft().item)?.fields ?? [],
  );
  protected add(): void {
    this.draft.update((operation) => ({
      ...operation,
      bindings: [...operation.bindings, { header: '', field: '', prefix: '' }],
    }));
  }
  protected remove(index: number): void {
    this.draft.update((operation) => ({
      ...operation,
      bindings: operation.bindings.filter((_binding, i) => i !== index),
    }));
  }
  protected submit(): void {
    const operation = this.draft();
    this.save.emit({
      ...operation,
      bodyFormat: this.options().bodyFormat,
      responseFields: this.options()
        .responseFields.split(',')
        .map((field) => field.trim())
        .filter(Boolean),
      bindings: operation.auth === 'basic' ? [] : operation.bindings,
      body: operation.method === 'GET' ? '' : operation.body,
    });
  }
}
