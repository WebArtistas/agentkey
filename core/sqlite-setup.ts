import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { SQLiteSelection } from '../shared/contracts';
import { databaseSchema } from './database-schema';
import { nameSchema, parseInput, SafeError } from './schema';
import { createSQLiteDemo, inspectSQLite } from './sqlite';
import type { Vault } from './vault';

export class SQLiteSetup {
  #token = '';
  #selection:
    { public: SQLiteSelection; path: string; session: number; demoDirectory?: string } | undefined;
  constructor(private readonly vault: Vault) {}
  clear(): void {
    this.#token = '';
    const directory = this.#selection?.demoDirectory;
    this.#selection = undefined;
    if (directory) void rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  async prepare(file?: string): Promise<SQLiteSelection> {
    const session = this.vault.sessionRevision;
    this.clear();
    const token = randomUUID();
    this.#token = token;
    let demoDirectory: string | undefined;
    let retained = false;
    try {
      let path: string;
      if (file) path = await realpath(file);
      else {
        demoDirectory = await mkdtemp(join(this.vault.storage.directory, 'sqlite-demo-'));
        path = await createSQLiteDemo(demoDirectory);
      }
      const tables = await inspectSQLite(path);
      if (!tables.length)
        throw new SafeError(
          'No supported ordinary tables were found. Views, virtual/generated columns and unsupported identifiers are excluded.',
        );
      if (this.#token !== token || session !== this.vault.sessionRevision)
        throw new SafeError('SQLite selection expired. Choose the file again.');
      const selection: SQLiteSelection = {
        token,
        label: file ? basename(path) : 'Synthetic products demo',
        demo: !file,
        tables,
      };
      this.#selection = { public: selection, path, session, demoDirectory };
      retained = true;
      return structuredClone(selection);
    } finally {
      if (!retained && demoDirectory) await rm(demoDirectory, { recursive: true, force: true });
    }
  }
  save(input: unknown): void {
    const parsed = parseInput(
      z.strictObject({ token: z.uuid(), name: nameSchema, tables: databaseSchema.shape.tables }),
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
    this.vault.registerSQLite(parsed.name, selection.path, parsed.tables);
    this.#selection = undefined;
    this.#token = '';
  }
}
