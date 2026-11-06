import { _electron as electron, expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { callBroker } from '../agent/client';

for (const packaged of [false, true]) {
  test(`SQLite guided demo and selected file (${packaged ? 'packaged' : 'source'})`, async () => {
    const executable =
      process.platform === 'win32'
        ? resolve('release/win-unpacked/AgentKey.exe')
        : process.platform === 'darwin'
          ? resolve(
              `release/mac${process.arch === 'arm64' ? '-arm64' : ''}/AgentKey.app/Contents/MacOS/AgentKey`,
            )
          : resolve('release/linux-unpacked/agentkey');
    test.skip(packaged && !existsSync(executable), 'Build host package first.');
    const directory = mkdtempSync(join(tmpdir(), 'ak-sqlite-ui-'));
    const source = join(directory, 'export.sqlite');
    const db = new DatabaseSync(source);
    db.exec(
      "CREATE TABLE contacts(id INTEGER, name TEXT, private_note TEXT); INSERT INTO contacts VALUES (1,'Synthetic person','must not appear');",
    );
    db.close();
    const before = readFileSync(source);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
      ),
    );
    const app = await electron.launch({
      ...(packaged
        ? { executablePath: executable, args: ['--data-dir', directory] }
        : { args: [resolve('.'), '--data-dir', directory] }),
      env,
    });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page
        .getByLabel('Master passphrase', { exact: true })
        .fill('synthetic sqlite UI passphrase');
      await page
        .getByLabel('Confirm passphrase', { exact: true })
        .fill('synthetic sqlite UI passphrase');
      await page.getByRole('button', { name: 'Create encrypted vault' }).click();
      await page.getByRole('button', { name: '03 Databases' }).click();
      await page.getByRole('button', { name: 'Try SQLite demo', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Choose SQLite access' })).toBeVisible();
      await expect(page.getByLabel('id', { exact: true })).toBeChecked();
      await expect(page.getByLabel('name', { exact: true })).toBeChecked();
      await expect(page.getByLabel('internal_note', { exact: true })).not.toBeChecked();
      expect(
        (
          await new AxeBuilder({ page })
            .setLegacyMode(true)
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.getByRole('button', { name: 'Save SQLite connection', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'local-demo', exact: true })).toBeVisible();
      const query = {
        connection: 'local-demo',
        schema: 'main',
        table: 'products',
        columns: ['id', 'name'],
        filters: [],
        limit: 10,
      };
      expect(await callBroker(directory, { action: 'read-database', query })).toMatchObject({
        ok: false,
      });
      await page.getByRole('button', { name: '04 Approvals' }).click();
      await page.getByRole('button', { name: 'Approve local-demo', exact: true }).click();
      expect(await callBroker(directory, { action: 'read-database', query })).toMatchObject({
        ok: true,
        value: {
          rows: [
            ['1', 'Notebook'],
            ['2', 'Desk lamp'],
            ['3', 'Pen set'],
          ],
        },
      });
      expect(await callBroker(directory, { action: 'read-database', query })).toMatchObject({
        ok: false,
      });
      await page.getByRole('button', { name: '03 Databases' }).click();
      // Stub the native OS dialog only; inspection, save, approval and reads remain real.
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      }, source);
      await page.getByRole('button', { name: 'Choose SQLite file', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Choose SQLite access' })).toBeVisible();
      await expect(page.getByLabel('name', { exact: true })).not.toBeChecked();
      await page.getByLabel('Connection name', { exact: true }).fill('selected-copy');
      await page.getByLabel('id', { exact: true }).check();
      await page.getByLabel('name', { exact: true }).check();
      await page.getByRole('button', { name: 'Save SQLite connection', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'selected-copy', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '04 Approvals' }).click();
      await page.getByRole('button', { name: 'Approve selected-copy', exact: true }).click();
      expect(
        await callBroker(directory, {
          action: 'read-database',
          query: { ...query, connection: 'selected-copy', table: 'contacts' },
        }),
      ).toMatchObject({ ok: true, value: { rows: [['1', 'Synthetic person']] } });
      expect(readFileSync(source)).toEqual(before);
      expect(
        JSON.stringify(await callBroker(directory, { action: 'list-databases' })),
      ).not.toContain(source);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
