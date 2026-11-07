import { Component, computed, input, linkedSignal, output, signal } from '@angular/core';
import { form, FormField, maxLength, required } from '@angular/forms/signals';
import { TuiButton, TuiCheckbox, TuiInput } from '@taiga-ui/core';
import type { SQLiteSelection, SQLiteSetupInput } from '../../shared/contracts';

@Component({
  selector: 'app-sqlite-editor',
  imports: [FormField, TuiButton, TuiCheckbox, TuiInput],
  styles: `
    fieldset {
      min-inline-size: 0;
      border: 1px solid var(--tui-border-normal);
      border-radius: 0.75rem;
      padding: 1rem;
    }
    .columns {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
    }
    .columns label {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
  `,
  template: `
    <form class="editor" (submit)="$event.preventDefault(); submit()" autocomplete="off">
      <div class="section-heading">
        <h2>Choose SQLite access</h2>
        <button tuiButton appearance="flat" size="s" type="button" (click)="cancel.emit()">
          Cancel
        </button>
      </div>
      <p>{{ selection().label }}</p>
      <p class="notice">
        No database password or server is needed. Select only columns the agent may read. Approved
        rows may be sent to its model provider; local storage does not make cloud inference private.
      </p>
      <p class="hint">
        AgentKey saves an encrypted snapshot and reads it in memory. The entire database is
        imported; only your selected columns may be returned to agents. Original files remain
        unchanged and unencrypted by AgentKey. Re-import to refresh the snapshot; source changes are
        not picked up automatically. Use a closed, exported file, up to 16 MiB.
      </p>
      <tui-textfield [tuiTextfieldCleaner]="false"
        ><label tuiLabel>Connection name</label
        ><input tuiInput [formField]="fields.name" placeholder="local-demo"
      /></tui-textfield>
      @for (table of fields.tables; track $index; let ti = $index) {
        <fieldset>
          <legend>{{ draft().tables[ti].table }}</legend>
          <div class="columns">
            @for (column of table.columns; track $index; let ci = $index) {
              <label
                ><input tuiCheckbox type="checkbox" [formField]="column.selected" />{{
                  draft().tables[ti].columns[ci].name
                }}</label
              >
            }
          </div>
        </fieldset>
      }
      <p class="hint">
        At most 32 tables and 16 columns per table. Reads use the main schema, equality filters and
        up to 100 rows. Saving does not approve access. Reusing a name replaces its policy and
        revokes approval.
      </p>
      @if (failure()) {
        <p role="alert">{{ failure() }}</p>
      }
      <button tuiButton type="submit" [disabled]="busy() || !selectedCount()">
        {{ busy() ? 'Saving…' : 'Save SQLite connection' }}
      </button>
    </form>
  `,
})
export class SQLiteEditor {
  readonly selection = input.required<SQLiteSelection>();
  readonly busy = input(false);
  readonly save = output<SQLiteSetupInput>();
  readonly cancel = output<void>();
  protected readonly failure = signal('');
  protected readonly draft = linkedSignal(() => ({
    name: this.selection().demo ? 'local-demo' : '',
    tables: this.selection().tables.map((table) => ({
      ...table,
      columns: table.columns.map((name) => ({
        name,
        selected:
          this.selection().demo && table.table === 'products' && ['id', 'name'].includes(name),
      })),
    })),
  }));
  protected readonly fields = form(this.draft, (path) => {
    required(path.name);
    maxLength(path.name, 64);
  });
  protected readonly selectedCount = computed(() =>
    this.draft().tables.reduce(
      (sum, table) => sum + table.columns.filter((column) => column.selected).length,
      0,
    ),
  );
  protected submit(): void {
    const tables = this.draft()
      .tables.map((table) => ({
        schema: table.schema,
        table: table.table,
        columns: table.columns.filter((column) => column.selected).map((column) => column.name),
      }))
      .filter((table) => table.columns.length);
    if (!tables.length || tables.length > 32 || tables.some((table) => table.columns.length > 16)) {
      this.failure.set('Choose 1–32 tables, with 1–16 columns in each.');
      return;
    }
    this.save.emit({ token: this.selection().token, name: this.draft().name, tables });
  }
}
