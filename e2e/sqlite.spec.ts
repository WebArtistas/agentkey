import { _electron as electron, expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { callMcp, connectDesktopMcp } from './mcp';
import { showFullWindow } from './window-switch';

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
    let client: Client | undefined;
    try {
      client = await connectDesktopMcp(page, directory);
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
      // Unrelated navigation in the second view must not cancel this reviewed import.
      const opening = app.waitForEvent('window');
      await page.getByRole('button', { name: 'Quick access', exact: true }).click();
      const panel = await opening;
      await panel.waitForURL('**?view=compact');
      await panel.getByRole('button', { name: 'Activity', exact: true }).click();
      await showFullWindow(app, panel, page);
      await expect(page.getByRole('heading', { name: 'Choose SQLite access' })).toBeVisible();
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
      expect(await callMcp(client, 'agentkey_read_database', query)).toMatchObject({
        ok: false,
      });
      expect(
        await callMcp(client, 'agentkey_request_access', { operation: 'local-demo' }),
      ).toMatchObject({ ok: true, value: { state: 'awaiting-approval' } });
      await page.getByRole('button', { name: '04 Approvals' }).click();
      const demoApproval = page.getByRole('button', { name: 'Approve local-demo', exact: true });
      await expect(demoApproval).toBeDisabled();
      const missingConsent = await page.evaluate(async () => {
        const api = window.agentkey!;
        const snapshot = await api.snapshot();
        if (!snapshot.ok) throw new Error('Synthetic snapshot unavailable');
        const database = snapshot.value.databases.find((entry) => entry.name === 'local-demo')!;
        return api.approve(database.name, 'once', database.revision);
      });
      expect(missingConsent).toMatchObject({
        ok: false,
        error: expect.stringContaining('data-sharing consent'),
      });
      await page
        .getByRole('checkbox', { name: /I consent to sharing the listed data for local-demo/ })
        .check();
      await demoApproval.click();
      expect(await callMcp(client, 'agentkey_read_database', query)).toMatchObject({
        ok: true,
        value: {
          rows: [
            ['1', 'Notebook'],
            ['2', 'Desk lamp'],
            ['3', 'Pen set'],
          ],
        },
      });
      expect(await callMcp(client, 'agentkey_read_database', query)).toMatchObject({
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
      await page.getByRole('button', { name: 'Inactive 2', exact: true }).click();
      const selectedApproval = page.getByRole('button', {
        name: 'Approve selected-copy',
        exact: true,
        includeHidden: true,
      });
      const selectedConsent = page.getByRole('checkbox', {
        name: /I consent to sharing the listed data for selected-copy/,
      });
      const demoConsent = page.getByRole('checkbox', {
        name: /I consent to sharing the listed data for local-demo/,
      });
      await expect(selectedApproval).toBeDisabled();
      await demoConsent.check();
      await expect(selectedApproval).toBeDisabled();
      await page.getByRole('button', { name: /^selected-copy SQLite/ }).click();
      await selectedConsent.check();
      await page.getByRole('button', { name: /^local-demo SQLite/ }).click();
      await expect(demoConsent).not.toBeChecked();
      await page.getByRole('button', { name: /^selected-copy SQLite/ }).click();
      await page.getByLabel('New approval duration', { exact: true }).click();
      await page.getByRole('option', { name: '1 hour', exact: true }).click();
      await expect(page.getByLabel('New approval duration', { exact: true })).toHaveValue('1 hour');
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await expect(selectedConsent).not.toBeChecked();
      await expect(selectedApproval).toBeDisabled();
      await page.getByLabel('New approval duration', { exact: true }).click();
      await page.getByRole('option', { name: 'One attempt', exact: true }).click();
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await selectedConsent.check();
      await selectedApproval.click();
      expect(
        await callMcp(client, 'agentkey_read_database', {
          ...query,
          connection: 'selected-copy',
          table: 'contacts',
        }),
      ).toMatchObject({ ok: true, value: { rows: [['1', 'Synthetic person']] } });
      expect(readFileSync(source)).toEqual(before);
      expect(JSON.stringify(await callMcp(client, 'agentkey_list_databases'))).not.toContain(
        source,
      );
      for (const file of readdirSync(join(directory, 'sqlite-snapshots'))) {
        const encrypted = readFileSync(join(directory, 'sqlite-snapshots', file));
        expect(encrypted.includes('SQLite format 3\0')).toBe(false);
        expect(encrypted.includes('Synthetic person')).toBe(false);
        expect(encrypted.includes('must not appear')).toBe(false);
      }
      await page.getByRole('button', { name: '03 Databases' }).click();
      const selectedCard = page
        .locator('article')
        .filter({ has: page.getByRole('heading', { name: 'selected-copy', exact: true }) });
      await expect(selectedCard).toContainText('Encrypted managed SQLite snapshot');
      await selectedCard.getByRole('button', { name: 'Edit policy', exact: true }).click();
      await page.getByLabel('Allowed columns 1', { exact: true }).fill('id');
      await page.getByRole('button', { name: 'Save database connection', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Define database access' })).not.toBeVisible();
      expect(await callMcp(client, 'agentkey_list_databases')).toMatchObject({
        ok: true,
        value: expect.arrayContaining([
          expect.objectContaining({
            name: 'selected-copy',
            tables: [{ schema: 'main', table: 'contacts', columns: ['id'] }],
          }),
        ]),
      });
      await page.getByRole('button', { name: '06 Connect an agent' }).click();
      await expect(
        page.getByText('AgentKey is a credential broker, not an agent manager.', { exact: false }),
      ).toBeVisible();
      await expect(page.getByText('Isolated Pi database mode', { exact: false })).toHaveCount(0);
      const cancelled = await page.evaluate(async () => {
        const api = window.agentkey!;
        const prepared = await api.prepareSQLite('demo');
        if (!prepared.ok || !prepared.value) throw new Error('Synthetic selection unavailable');
        const result = await api.cancelSQLite(prepared.value.token);
        if (!result.ok) throw new Error('Synthetic cancellation failed');
        return api.saveSQLite({
          token: prepared.value.token,
          name: 'cancelled-import',
          tables: prepared.value.tables,
        });
      });
      expect(cancelled).toMatchObject({
        ok: false,
        error: expect.stringContaining('selection expired'),
      });
      expect(errors).toEqual([]);
    } finally {
      await client?.close();
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
