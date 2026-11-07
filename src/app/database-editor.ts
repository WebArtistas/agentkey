import { Component, computed, input, linkedSignal, output } from '@angular/core';
import { applyEach, form, FormField, maxLength, required } from '@angular/forms/signals';
import { TuiButton, TuiInput } from '@taiga-ui/core';
import { TuiDataListWrapper, TuiSelect } from '@taiga-ui/kit';
import type { DatabaseInput, ItemSummary } from '../../shared/contracts';

@Component({
  selector: 'app-database-editor',
  imports: [FormField, TuiButton, TuiInput, TuiSelect, TuiDataListWrapper],
  template: `
    <form class="editor" (submit)="$event.preventDefault(); submit()" autocomplete="off">
      <div class="section-heading">
        <h2>Define database access</h2>
        <button tuiButton appearance="flat" size="s" type="button" (click)="cancel.emit()">
          Cancel
        </button>
      </div>
      <p class="notice">
        @if (initial()?.source === 'snapshot') {
          Encrypted SQLite snapshot. You can narrow its allowed columns here. Re-import using the
          same connection name to refresh data or allow additional columns. No writes or raw SQL.
        } @else if (draft().engine === 'sqlite') {
          SQLite file access. Keep the saved source reference and use the main schema. No writes or
          raw SQL.
        } @else {
          Local PostgreSQL. Store the URL as a vault secret first. Use a dedicated restricted
          database role, never an administrator.
        }
        Approved table data enters the agent's model context.
      </p>
      <tui-textfield [tuiTextfieldCleaner]="false">
        <label tuiLabel>Connection name</label
        ><input
          tuiInput
          [formField]="fields.name"
          [readOnly]="initial()?.source === 'snapshot'"
          placeholder="project-dev-db"
        />
      </tui-textfield>
      @if (initial()?.source !== 'snapshot') {
        <div class="field-row">
          <tui-textfield [tuiTextfieldCleaner]="false">
            <label tuiLabel>{{
              draft().engine === 'sqlite' ? 'Source vault item' : 'URL vault item'
            }}</label
            ><input tuiSelect [formField]="fields.item" />
            <tui-data-list-wrapper *tuiDropdown [items]="itemNames()" />
          </tui-textfield>
          <tui-textfield [tuiTextfieldCleaner]="false">
            <label tuiLabel>{{
              draft().engine === 'sqlite' ? 'Source field' : 'URL secret field'
            }}</label
            ><input tuiSelect [formField]="fields.field" />
            <tui-data-list-wrapper *tuiDropdown [items]="fieldNames()" />
          </tui-textfield>
        </div>
      }
      @for (table of fields.tables; track $index; let index = $index) {
        <div class="field-row">
          <tui-textfield [tuiTextfieldCleaner]="false"
            ><label tuiLabel>Schema {{ index + 1 }}</label
            ><input tuiInput [formField]="table.schema"
          /></tui-textfield>
          <tui-textfield [tuiTextfieldCleaner]="false"
            ><label tuiLabel>Table {{ index + 1 }}</label
            ><input tuiInput [formField]="table.table"
          /></tui-textfield>
          <tui-textfield [tuiTextfieldCleaner]="false"
            ><label tuiLabel>Allowed columns {{ index + 1 }}</label
            ><input tuiInput [formField]="table.columns" placeholder="id, name"
          /></tui-textfield>
          @if (draft().tables.length > 1) {
            <button
              tuiButton
              appearance="flat"
              size="s"
              type="button"
              [attr.aria-label]="'Remove table ' + (index + 1)"
              (click)="remove(index)"
            >
              Remove
            </button>
          }
        </div>
      }
      <button
        tuiButton
        appearance="secondary"
        type="button"
        [disabled]="draft().tables.length >= 32"
        (click)="add()"
      >
        Add table
      </button>
      <p class="hint">
        List columns explicitly, separated by commas (maximum 16 per table). No wildcards or system
        schemas. Agents can select these columns and apply equality filters, up to 100 rows per
        call. No raw SQL, writes or migrations. Reusing a connection name replaces its policy and
        revokes approval.
      </p>
      <button tuiButton type="submit" [disabled]="busy()">
        {{ busy() ? 'Saving…' : 'Save database connection' }}
      </button>
    </form>
  `,
})
export class DatabaseEditor {
  readonly items = input.required<ItemSummary[]>();
  readonly initial = input<DatabaseInput | null>(null);
  readonly busy = input(false);
  readonly save = output<DatabaseInput>();
  readonly cancel = output<void>();
  protected readonly draft = linkedSignal(() => {
    const initial = this.initial();
    return {
      engine: initial?.engine ?? 'postgres',
      name: initial?.name ?? '',
      item: initial?.source === 'snapshot' ? '' : (initial?.item ?? ''),
      field: initial?.source === 'snapshot' ? '' : (initial?.field ?? ''),
      tables: initial?.tables.map((table) => ({ ...table, columns: table.columns.join(', ') })) ?? [
        { schema: 'public', table: '', columns: '' },
      ],
    };
  });
  protected readonly fields = form(this.draft, (path) => {
    required(path.name);
    maxLength(path.name, 64);
    required(path.item, { when: () => this.initial()?.source !== 'snapshot' });
    required(path.field, { when: () => this.initial()?.source !== 'snapshot' });
    applyEach(path.tables, (table) => {
      required(table.schema);
      maxLength(table.schema, 63);
      required(table.table);
      maxLength(table.table, 63);
      required(table.columns);
      maxLength(table.columns, 1024);
    });
  });
  protected readonly itemNames = computed(() => this.items().map((item) => item.name));
  protected readonly fieldNames = computed(
    () => this.items().find((item) => item.name === this.draft().item)?.fields ?? [],
  );
  protected add(): void {
    this.draft.update((draft) => ({
      ...draft,
      tables: [
        ...draft.tables,
        { schema: draft.engine === 'sqlite' ? 'main' : 'public', table: '', columns: '' },
      ],
    }));
  }
  protected remove(index: number): void {
    this.draft.update((draft) => ({
      ...draft,
      tables: draft.tables.filter((_table, i) => i !== index),
    }));
  }
  protected submit(): void {
    const draft = this.draft();
    const tables = draft.tables.map((table) => ({
      ...table,
      columns: table.columns.split(',').map((column) => column.trim()),
    }));
    const initial = this.initial();
    this.save.emit(
      initial?.source === 'snapshot'
        ? {
            source: 'snapshot',
            engine: 'sqlite',
            snapshot: initial.snapshot,
            name: initial.name,
            tables,
          }
        : { ...draft, tables },
    );
  }
}
