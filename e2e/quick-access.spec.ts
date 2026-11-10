import { _electron as electron, expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { callBroker } from '../agent/client';
import type { DesktopApi } from '../shared/contracts';
import { showFullWindow } from './window-switch';

declare global {
  interface Window {
    agentkey?: DesktopApi;
  }
}

test('compact management shares the vault, preserves drafts and enforces reviewed approvals', async () => {
  test.setTimeout(90_000);
  const directory = mkdtempSync(join(tmpdir(), 'ak-quick-ui-'));
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );
  const application = await electron.launch({ args: [resolve('.'), '--data-dir', directory], env });
  const full = await application.firstWindow();
  try {
    const opening = application.waitForEvent('window');
    await full.getByRole('button', { name: 'Quick access', exact: true }).click();
    const panel = await opening;
    await panel.waitForURL('**?view=compact');
    const errors: string[] = [];
    panel.on('pageerror', (error) => errors.push(error.message));
    const isVisible = () =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((view) => view.webContents.getURL().endsWith('?view=compact'))
          ?.isVisible(),
      );
    await expect(panel.getByRole('heading', { name: 'Create your local vault' })).toBeVisible();
    await panel
      .getByLabel('Master passphrase', { exact: true })
      .fill('synthetic quick access passphrase');
    await panel
      .getByLabel('Confirm passphrase', { exact: true })
      .fill('synthetic quick access passphrase');
    await panel.getByRole('button', { name: 'Create encrypted vault' }).click();
    await panel.getByRole('button', { name: 'Vault', exact: true }).click();
    await panel.getByRole('button', { name: 'Add item', exact: true }).click();
    await panel.getByLabel('Item name', { exact: true }).fill('quick-url');
    const url = 'postgresql://reader:synthetic-quick-password@127.0.0.1:5432/demo';
    await panel.getByLabel('Secret value', { exact: true }).fill(url);
    await panel.getByRole('button', { name: 'Show secret value', exact: true }).click();
    await expect(panel.getByLabel('Secret value', { exact: true })).toHaveAttribute('type', 'text');
    await panel.keyboard.press('Escape');
    await expect.poll(isVisible).toBe(false);
    await full.getByRole('button', { name: 'Quick access', exact: true }).click();
    await expect.poll(isVisible).toBe(true);
    await expect(panel.getByLabel('Secret value', { exact: true })).toHaveValue(url);
    await expect(panel.getByLabel('Secret value', { exact: true })).toHaveAttribute(
      'type',
      'password',
    );
    await panel.getByRole('button', { name: 'Save encrypted item' }).click();
    await expect(panel.getByRole('heading', { name: 'quick-url', exact: true })).toBeVisible();

    await panel.getByRole('button', { name: 'Add item', exact: true }).click();
    await panel.getByRole('button', { name: 'Login', exact: true }).click();
    await panel.getByLabel('Item name', { exact: true }).fill('quick-login');
    await panel.getByLabel('Username', { exact: true }).fill('synthetic-user');
    await panel.getByLabel('Password', { exact: true }).fill('synthetic-login-password');
    await panel.getByRole('button', { name: 'Save encrypted item' }).click();
    const login = panel
      .getByRole('article')
      .filter({ has: panel.getByRole('heading', { name: 'quick-login', exact: true }) });
    await login.getByRole('button', { name: 'Replace values', exact: true }).click();
    await expect(panel.getByLabel('Password', { exact: true })).toHaveValue('');
    await panel.getByLabel('Username', { exact: true }).fill('synthetic-new-user');
    await panel.getByLabel('Password', { exact: true }).fill('synthetic-new-password');
    await panel.getByRole('button', { name: 'Save encrypted item' }).click();
    await login.getByRole('button', { name: 'Delete', exact: true }).click();
    await login.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
    await expect(login).toHaveCount(0);

    await panel.getByRole('button', { name: 'API operations', exact: true }).click();
    await panel.getByRole('button', { name: 'Add operation', exact: true }).click();
    await panel.getByLabel('Operation name', { exact: true }).fill('quick-health');
    await panel.getByLabel('Vault item', { exact: true }).click();
    await panel.getByRole('option', { name: 'quick-url', exact: true }).click();
    await panel
      .getByLabel('Exact HTTPS URL', { exact: true })
      .fill('https://api.example.com/health');
    await panel.getByLabel('Field 1', { exact: true }).click();
    await panel.getByRole('option', { name: 'value', exact: true }).click();
    await panel.getByRole('button', { name: 'Save operation', exact: true }).click();
    await expect(panel.getByRole('heading', { name: 'quick-health', exact: true })).toBeVisible();

    await panel.getByRole('button', { name: 'Databases', exact: true }).click();
    await panel.getByRole('button', { name: 'Add database', exact: true }).click();
    await panel.getByLabel('Connection name', { exact: true }).fill('quick-db');
    await panel.getByLabel('URL vault item', { exact: true }).click();
    await panel.getByRole('option', { name: 'quick-url', exact: true }).click();
    await panel.getByLabel('URL secret field', { exact: true }).click();
    await panel.getByRole('option', { name: 'value', exact: true }).click();
    await panel.getByLabel('Table 1', { exact: true }).fill('products');
    await panel.getByLabel('Allowed columns 1', { exact: true }).fill('id, name');
    expect(
      (
        await new AxeBuilder({ page: panel })
          .setLegacyMode(true)
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(
      await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await panel.getByRole('button', { name: 'Save database connection', exact: true }).click();
    await expect(panel.getByRole('heading', { name: 'quick-db', exact: true })).toBeVisible();
    await callBroker(directory, { action: 'request-access', operation: 'quick-db' });
    await panel.getByRole('button', { name: 'Approvals', exact: true }).click();
    await expect(
      panel.getByRole('button', { name: 'Needs review 1', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await panel.getByText('Search, filters & duration', { exact: true }).click();
    await panel.getByLabel('New approval duration', { exact: true }).click();
    await panel.keyboard.press('Escape');
    await expect(panel.getByRole('listbox')).toHaveCount(0);
    await expect.poll(isVisible).toBe(true);
    await expect(
      panel.getByRole('button', { name: 'Approve quick-db', exact: true }),
    ).toBeDisabled();
    await panel
      .getByRole('checkbox', { name: /I consent to sharing the listed data for quick-db/ })
      .check();
    await panel.getByRole('button', { name: 'Approve quick-db', exact: true }).click();
    expect(
      await callBroker(directory, { action: 'request-access', operation: 'quick-db' }),
    ).toMatchObject({ ok: true, value: { state: 'approved' } });
    await panel.getByRole('button', { name: 'Active access 1', exact: true }).click();
    await panel.getByRole('button', { name: 'Revoke access', exact: true }).click();
    await panel.locator('main').evaluate((main) => main.scrollTo(0, 0));
    await panel.screenshot({ path: 'test-results/quick-access.png', animations: 'disabled' });
    expect(
      (
        await new AxeBuilder({ page: panel })
          .setLegacyMode(true)
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    const revision = await panel.evaluate(async () => {
      const api = window.agentkey;
      if (!api) throw new Error('Desktop bridge unavailable');
      const result = await api.snapshot();
      if (!result.ok) throw new Error('Snapshot unavailable');
      return result.value.databases[0]!.revision;
    });
    await panel.getByRole('button', { name: 'Activity', exact: true }).click();
    await expect(panel.getByText('revoked', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(panel.locator('pre').filter({ hasText: 'mcpServers' })).toBeVisible();
    await showFullWindow(application, panel, full);
    await expect.poll(isVisible).toBe(false);
    await full.getByRole('button', { name: '03 Databases' }).click();
    await full.getByRole('button', { name: 'Edit policy', exact: true }).click();
    await full.getByLabel('Allowed columns 1', { exact: true }).fill('id');
    await full.getByRole('button', { name: 'Save database connection', exact: true }).click();
    await expect(
      full.getByRole('heading', { name: 'Define database access', exact: true }),
    ).toHaveCount(0);
    expect(
      await panel.evaluate(async (old) => {
        if (!window.agentkey) throw new Error('Desktop bridge unavailable');
        return window.agentkey.approve('quick-db', 'day', old, true);
      }, revision),
    ).toMatchObject({ ok: false, error: expect.stringContaining('settings changed') });
    expect(
      await panel.evaluate(async () => {
        const api = window.agentkey;
        if (!api) throw new Error('Desktop bridge unavailable');
        return Reflect.apply(api.approve, api, ['quick-db', 'day']);
      }),
    ).toMatchObject({ ok: false });

    // The same URL and preload do not give another BrowserWindow desktop authority.
    expect(
      await application.evaluate(async ({ app, BrowserWindow }) => {
        const rogue = new BrowserWindow({
          show: false,
          webPreferences: {
            preload: `${app.getAppPath()}/dist/desktop/preload.js`,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        try {
          await rogue.loadURL('agentkey://app/index.html?view=compact');
          return await rogue.webContents.executeJavaScript('window.agentkey.snapshot()');
        } finally {
          rogue.destroy();
        }
      }),
    ).toEqual({ ok: false, error: 'Untrusted window.' });
    await full.getByRole('button', { name: 'Quick access', exact: true }).click();
    await panel.getByRole('button', { name: 'Lock vault', exact: true }).click();
    await expect(
      panel.getByRole('heading', { name: 'Unlock your vault', exact: true }),
    ).toBeVisible();
    await expect(
      full.getByRole('heading', { name: 'Unlock your vault', exact: true }),
    ).toBeVisible();
    expect(await callBroker(directory, { action: 'list-databases' })).toMatchObject({ ok: false });
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
