import { _electron as electron, expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { callMcp, connectDesktopMcp } from './mcp';

for (const packaged of [false, true]) {
  test(`one-attempt command approval and secret-bound execution (${packaged ? 'packaged' : 'source'})`, async () => {
    const executable =
      process.platform === 'win32'
        ? resolve('release/win-unpacked/AgentKey.exe')
        : process.platform === 'darwin'
          ? resolve(
              `release/mac${process.arch === 'arm64' ? '-arm64' : ''}/AgentKey.app/Contents/MacOS/AgentKey`,
            )
          : resolve('release/linux-unpacked/agentkey');
    test.skip(packaged && !existsSync(executable), 'Build the host package first.');
    const directory = mkdtempSync(join(tmpdir(), 'ak-command-ui-'));
    const file = join(directory, 'fixture.cjs');
    writeFileSync(
      file,
      'process.stdout.write("received=" + Boolean(process.env.APP_TOKEN) + " " + process.env.APP_TOKEN);',
    );
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
      await page
        .getByLabel('Master passphrase', { exact: true })
        .fill('synthetic-command-ui-passphrase');
      await page
        .getByLabel('Confirm passphrase', { exact: true })
        .fill('synthetic-command-ui-passphrase');
      await page.getByRole('button', { name: 'Create encrypted vault' }).click();
      await page.getByRole('button', { name: 'Add item', exact: true }).click();
      await page.getByLabel('Item name', { exact: true }).fill('demo-key');
      await page.getByLabel('Secret value', { exact: true }).fill('synthetic-command-ui-8874');
      await page.getByRole('button', { name: 'Save encrypted item' }).click();
      await expect(page.getByRole('heading', { name: 'demo-key', exact: true })).toBeVisible();
      client = await connectDesktopMcp(page, directory);
      const command = {
        name: 'check-child',
        executable: process.execPath,
        cwd: directory,
        args: [file],
        bindings: [{ env: 'APP_TOKEN', item: 'demo-key', field: 'value' }],
        timeoutMs: 5000,
      };
      expect(await callMcp(client, 'agentkey_propose_command', command)).toMatchObject({
        ok: true,
        value: { state: 'awaiting-approval' },
      });
      await page.getByRole('button', { name: '04 Approvals' }).click();
      await page.getByLabel('New approval duration', { exact: true }).click();
      await page.getByRole('option', { name: 'Until revoked', exact: true }).click();
      await page.getByRole('button', { name: 'Command', exact: true }).click();
      const card = page.locator('app-command-review');
      await expect(card).toBeVisible();
      await expect(card).toContainText('APP_TOKEN ← [demo-key.value]');
      await expect(card).toContainText('not a sandbox');
      await expect(card.getByRole('combobox')).toHaveCount(0);
      expect(await page.locator('body').innerText()).not.toContain('synthetic-command-ui-8874');
      const snapshot = await page.evaluate(() => window.agentkey!.snapshot());
      if (!snapshot.ok) throw new Error('Missing synthetic snapshot');
      const revision = snapshot.value.commands[0]!.revision;
      const run = { operation: command.name, revision };
      expect(await callMcp(client, 'agentkey_run_command', run)).toMatchObject({ ok: false });
      const approve = card.getByRole('button', { name: 'Approve one attempt', exact: true });
      await expect(approve).toBeDisabled();
      await card.getByRole('checkbox', { name: /I trust this program/ }).check();
      await expect(approve).toBeDisabled();
      await card.getByRole('checkbox', { name: /I accept best-effort redaction/ }).check();
      await page.waitForTimeout(2200);
      await expect(approve).toBeEnabled();
      const axe = await new AxeBuilder({ page })
        .setLegacyMode(true)
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(axe.violations).toEqual([]);
      const waiting = callMcp(client, 'agentkey_wait_for_approval', { operation: command.name });
      await approve.click();
      expect(await waiting).toMatchObject({ ok: true, value: { state: 'approved' } });
      expect(await callMcp(client, 'agentkey_run_command', run)).toEqual({
        ok: true,
        value: {
          operation: command.name,
          exitCode: 0,
          successful: true,
          stdout: 'received=true [REDACTED]',
          stderr: '',
        },
      });
      expect(await callMcp(client, 'agentkey_run_command', run)).toMatchObject({ ok: false });
      await expect(card).toHaveCount(0);
      expect(await callMcp(client, 'agentkey_propose_command', command)).toMatchObject({
        ok: true,
        value: { state: 'awaiting-approval' },
      });
      await expect(card).toBeVisible();
      await expect(card.getByRole('button', { name: 'Approve one attempt' })).toBeDisabled();
      await card.getByRole('button', { name: 'Dismiss command' }).click();
      await expect(card).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await client?.close();
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
