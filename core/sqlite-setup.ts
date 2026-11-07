import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import type { SQLiteSelection } from '../shared/contracts';
import { databaseTablesSchema } from './database-schema';
import { nameSchema, parseInput, SafeError } from './schema';
import { createSQLiteDemo, inspectSQLiteBytes, readSQLiteFile } from './sqlite';
import type { Vault } from './vault';

export class SQLiteSetup {
  #token = '';
  #controller: AbortController | undefined;
  #selection: { public: SQLiteSelection; bytes: Buffer; session: number } | undefined;
  constructor(private readonly vault: Vault) {}
  clear(): void {
    this.#token = '';
    this.#controller?.abort();
    this.#controller = undefined;
    this.#selection?.bytes.fill(0);
    this.#selection = undefined;
  }
  cancel(input: unknown): void {
    const token = parseInput(z.uuid(), input);
    // Other views and delayed requests must not discard a newer reviewed import.
    if (this.#token === token) this.clear();
  }
  async prepare(file?: string): Promise<SQLiteSelection> {
    const session = this.vault.sessionRevision;
    this.clear();
    const token = randomUUID();
    this.#token = token;
    const controller = new AbortController();
    this.#controller = controller;
    let bytes: Buffer | undefined;
    let retained = false;
    try {
      const path = file ? await realpath(file) : undefined;
      bytes = path
        ? await readSQLiteFile(path, controller.signal)
        : await createSQLiteDemo(controller.signal);
      const tables = await inspectSQLiteBytes(bytes, controller.signal);
      if (!tables.length)
        throw new SafeError(
          'No supported ordinary tables were found. Views, virtual/generated columns and unsupported identifiers are excluded.',
        );
      if (this.#token !== token || session !== this.vault.sessionRevision)
        throw new SafeError('SQLite selection expired. Choose the file again.');
      const selection: SQLiteSelection = {
        token,
        label: path ? basename(path) : 'Synthetic products demo',
        demo: !file,
        tables,
      };
      this.#selection = { public: selection, bytes, session };
      retained = true;
      return structuredClone(selection);
    } finally {
      if (!retained) bytes?.fill(0);
      if (this.#controller === controller) this.#controller = undefined;
    }
  }
  save(input: unknown): void {
    const parsed = parseInput(
      z.strictObject({ token: z.uuid(), name: nameSchema, tables: databaseTablesSchema }),
      input,
    );
    const selection = this.#selection;
    if (
      !selection ||
      selection.public.token !== parsed.token ||
      selection.session !== this.vault.sessionRevision
    )
      throw new SafeError('SQLite selection expired. Choose the file again.');
    for (const table of parsed.tables) {
      const offered = selection.public.tables.find(
        (candidate) => candidate.schema === table.schema && candidate.table === table.table,
      );
      if (!offered || table.columns.some((column) => !offered.columns.includes(column)))
        throw new SafeError('Choose only inspected tables and columns.');
    }
    try {
      this.vault.registerSQLite(parsed.name, selection.bytes, parsed.tables);
    } finally {
      if (!this.vault.storage.unlocked) this.clear();
    }
    this.clear();
  }
}
