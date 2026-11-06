import { Component, input, linkedSignal, output } from '@angular/core';
import { applyEach, form, FormField, maxLength, pattern, required } from '@angular/forms/signals';
import { TuiButton, TuiInput } from '@taiga-ui/core';
import type { ItemInput, ItemKind, ItemSummary } from '../../shared/contracts';
import { PasswordToggle } from './password-toggle';

@Component({
  selector: 'app-item-editor',
  imports: [FormField, TuiButton, TuiInput, PasswordToggle],
  template: `
    <form class="editor" (submit)="$event.preventDefault(); save.emit(draft())" autocomplete="off">
      <div class="section-heading">
        <h2>{{ initial() ? 'Replace secret values' : 'New vault item' }}</h2>
        <button tuiButton appearance="flat" size="s" type="button" (click)="cancel.emit()">
          Cancel
        </button>
      </div>
      @if (!initial()) {
        <div class="choices" aria-label="Item type">
          @for (kind of kinds; track kind.value) {
            <button
              tuiButton
              type="button"
              [appearance]="draft().kind === kind.value ? 'primary' : 'secondary'"
              [attr.aria-pressed]="draft().kind === kind.value"
              (click)="changeKind(kind.value)"
            >
              {{ kind.label }}
            </button>
          }
        </div>
      }
      <tui-textfield [tuiTextfieldCleaner]="false"
        ><label tuiLabel>Item name</label
        ><input tuiInput [formField]="fields.name" placeholder="work-api"
      /></tui-textfield>
      @for (field of fields.fields; track $index; let index = $index) {
        <div class="field-row">
          @if (draft().kind === 'group') {
            <tui-textfield [tuiTextfieldCleaner]="false"
              ><label tuiLabel>Variable name {{ index + 1 }}</label
              ><input tuiInput [formField]="field.name"
            /></tui-textfield>
          }
          <tui-textfield [tuiTextfieldCleaner]="false">
            <label tuiLabel>{{
              draft().kind === 'group'
                ? 'Secret value ' + (index + 1)
                : draft().kind === 'secret'
                  ? 'Secret value'
                  : index === 0
                    ? 'Username'
                    : 'Password'
            }}</label>
            <input
              tuiInput
              [formField]="field.value"
              [type]="
                (draft().kind === 'login' && index === 0) || visibility.visible()
                  ? 'text'
                  : 'password'
              "
              autocomplete="off"
              spellcheck="false"
            />
            <button
              tuiButton
              appPasswordToggle
              #visibility
              appearance="flat"
              size="s"
              [style.display]="draft().kind === 'login' && index === 0 ? 'none' : null"
              [fieldName]="
                draft().kind === 'group'
                  ? 'secret value ' + field.name().value()
                  : draft().kind === 'login'
                    ? 'password'
                    : 'secret value'
              "
            ></button>
          </tui-textfield>
          @if (draft().kind === 'group' && draft().fields.length > 1) {
            <button
              tuiButton
              appearance="flat"
              size="s"
              type="button"
              [attr.aria-label]="'Remove variable ' + (index + 1)"
              (click)="remove(index)"
            >
              Remove
            </button>
          }
        </div>
      }
      @if (draft().kind === 'group') {
        <button
          tuiButton
          appearance="secondary"
          type="button"
          [disabled]="draft().fields.length >= 32"
          (click)="add()"
        >
          Add variable
        </button>
      }
      <p class="hint">
        Agents see names, never these values. Saving an existing name replaces its fields and
        revokes related approvals. Keep names non-sensitive.
      </p>
      <button tuiButton type="submit" [disabled]="busy()">
        {{ busy() ? 'Saving…' : 'Save encrypted item' }}
      </button>
    </form>
  `,
})
export class ItemEditor {
  readonly initial = input<ItemSummary | null>(null);
  readonly busy = input(false);
  readonly save = output<ItemInput>();
  readonly cancel = output<void>();
  protected readonly kinds: { value: ItemKind; label: string }[] = [
    { value: 'secret', label: 'Single secret' },
    { value: 'login', label: 'Login' },
    { value: 'group', label: 'Variable group' },
  ];
  protected readonly draft = linkedSignal<ItemInput>(() => {
    const item = this.initial();
    return item
      ? {
          name: item.name,
          kind: item.kind,
          fields: item.fields.map((name) => ({ name, value: '' })),
        }
      : { name: '', kind: 'secret', fields: [{ name: 'value', value: '' }] };
  });
  protected readonly fields = form(this.draft, (path) => {
    required(path.name);
    pattern(path.name, /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/);
    maxLength(path.name, 64);
    applyEach(path.fields, (field) => {
      required(field.name);
      maxLength(field.name, 64);
      required(field.value);
      maxLength(field.value, 8192);
    });
  });
  protected changeKind(kind: ItemKind): void {
    this.draft.update((item) => ({
      ...item,
      kind,
      fields: (kind === 'login'
        ? ['username', 'password']
        : kind === 'secret'
          ? ['value']
          : ['API_KEY']
      ).map((name) => ({ name, value: '' })),
    }));
  }
  protected add(): void {
    this.draft.update((item) => ({ ...item, fields: [...item.fields, { name: '', value: '' }] }));
  }
  protected remove(index: number): void {
    this.draft.update((item) => ({
      ...item,
      fields: item.fields.filter((_field, i) => i !== index),
    }));
  }
}
