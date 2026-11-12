import { _electron as electron, expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { callBroker } from '../agent/client';
import { connectDesktopMcp } from './mcp';

async function checkAccessibility(page: Page): Promise<void> {
  // Electron cannot create axe's analysis tab. No cross-origin frames exist in this app.
  const result = await new AxeBuilder({ page })
    .setLegacyMode(true)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(result.violations).toEqual([]);
}

async function checkPasswordToggle(page: Page, label: string, fieldName: string): Promise<void> {
  const input = page.getByLabel(label, { exact: true });
  const value = await input.inputValue();
  await expect(input).toHaveAttribute('type', 'password');
  const show = page.getByRole('button', { name: `Show ${fieldName}`, exact: true });
  await expect(show).toHaveAttribute('type', 'button');
  await show.click();
  await expect(input).toHaveAttribute('type', 'text');
  await expect(input).toHaveValue(value);
  const hide = page.getByRole('button', { name: `Hide ${fieldName}`, exact: true });
  await expect(hide).toHaveAttribute('aria-pressed', 'true');
  await hide.press('Space');
  await expect(input).toHaveAttribute('type', 'password');
  await expect(input).toHaveValue(value);
}

test('desktop creates all item types, approves an agent, revokes and locks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ak-ui-'));
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );
  const application = await electron.launch({ args: [resolve('.'), '--data-dir', directory], env });
  const page = await application.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  try {
    await expect(page.getByRole('heading', { name: 'Create your local vault' })).toBeVisible();
    await page
      .getByLabel('Master passphrase', { exact: true })
      .fill('local-test-master-passphrase');
    await page
      .getByLabel('Confirm passphrase', { exact: true })
      .fill('local-test-master-passphrase');
    await checkPasswordToggle(page, 'Master passphrase', 'master passphrase');
    await checkPasswordToggle(page, 'Confirm passphrase', 'confirmation passphrase');
    await page.getByRole('button', { name: 'Create encrypted vault' }).click();
    await expect(page.getByRole('button', { name: 'Lock vault', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add item', exact: true }).click();
    await page.getByLabel('Item name', { exact: true }).fill('test-api');
    await page.getByLabel('Secret value', { exact: true }).fill('synthetic-secret-canary-619');
    await checkPasswordToggle(page, 'Secret value', 'secret value');
    await page.getByRole('button', { name: 'Save encrypted item' }).click();
    await expect(page.getByRole('heading', { name: 'test-api', exact: true })).toBeVisible();
    await expect(page.locator('input[type=password]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Add item', exact: true }).click();
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await page.getByLabel('Item name', { exact: true }).fill('test-login');
    await page.getByLabel('Username', { exact: true }).fill('test-user');
    await page.getByLabel('Password', { exact: true }).fill('synthetic-login-password');
    await checkPasswordToggle(page, 'Password', 'password');
    await expect(page.getByRole('button', { name: 'Show username', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Save encrypted item' }).click();
    await expect(page.getByRole('heading', { name: 'test-login', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add item', exact: true }).click();
    await page.getByRole('button', { name: 'Variable group', exact: true }).click();
    await page.getByLabel('Item name', { exact: true }).fill('test-group');
    await page.getByLabel('Variable name 1', { exact: true }).fill('FIRST_KEY');
    await page.getByLabel('Secret value 1', { exact: true }).fill('synthetic-first-key');
    await page.getByRole('button', { name: 'Add variable', exact: true }).click();
    await page.getByLabel('Variable name 2', { exact: true }).fill('SECOND_KEY');
    await page.getByLabel('Secret value 2', { exact: true }).fill('synthetic-second-key');
    await checkPasswordToggle(page, 'Secret value 1', 'secret value FIRST_KEY');
    await checkPasswordToggle(page, 'Secret value 2', 'secret value SECOND_KEY');
    await page
      .getByRole('button', { name: 'Show secret value FIRST_KEY', exact: true })
      .press('Enter');
    await expect(page.getByLabel('Secret value 1', { exact: true })).toHaveAttribute(
      'type',
      'text',
    );
    await expect(page.getByLabel('Secret value 2', { exact: true })).toHaveAttribute(
      'type',
      'password',
    );
    await page.getByRole('button', { name: 'Hide secret value FIRST_KEY', exact: true }).click();
    await page.getByRole('button', { name: 'Save encrypted item' }).click();
    await expect(page.getByRole('heading', { name: 'test-group', exact: true })).toBeVisible();
    await expect(page.locator('.shell')).toHaveCSS('display', 'grid');
    await expect(page.getByRole('button', { name: 'Add item', exact: true })).toHaveCSS(
      'background-color',
      'rgb(17, 25, 21)',
    );
    await page.screenshot({ path: 'test-results/vault.png', fullPage: true });
    await checkAccessibility(page);
    await page.getByRole('button', { name: '02 API operations' }).click();
    await page.getByRole('button', { name: 'Add operation', exact: true }).click();
    await page.getByLabel('Operation name', { exact: true }).fill('test-health');
    await page.getByLabel('Vault item', { exact: true }).click();
    await page.getByRole('option', { name: 'test-api', exact: true }).click();
    await page
      .getByLabel('Exact HTTPS URL', { exact: true })
      .fill('https://api.example.com/health');
    await page.getByLabel('Field 1', { exact: true }).click();
    await page.getByRole('option', { name: 'value', exact: true }).click();
    await page.getByRole('button', { name: 'Save operation', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'test-health', exact: true })).toBeVisible();
    const request = await callBroker(directory, {
      action: 'request-access',
      operation: 'test-health',
    });
    expect(request).toEqual({
      ok: true,
      value: { state: 'awaiting-approval', operation: 'test-health' },
    });
    await page.getByRole('button', { name: '04 Approvals' }).click();
    await expect(page.getByRole('button', { name: 'Needs review 1', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByLabel('New approval duration', { exact: true }).click();
    await page.getByRole('option', { name: 'Until revoked', exact: true }).click();
    await page.getByRole('button', { name: 'Approve test-health', exact: true }).click();
    await page.getByRole('button', { name: 'Active access 1', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Revoke access', exact: true })).toBeVisible();
    expect(
      await callBroker(directory, { action: 'request-access', operation: 'test-health' }),
    ).toEqual({ ok: true, value: { state: 'approved', operation: 'test-health' } });
    await page.getByRole('button', { name: 'Revoke access', exact: true }).click();
    expect(await callBroker(directory, { action: 'run', operation: 'test-health' })).toMatchObject({
      ok: false,
    });
    await page.getByRole('button', { name: '06 Connect an agent' }).click();
    await expect(page.locator('pre').filter({ hasText: 'mcpServers' })).toContainText('mcpServers');
    await page.setViewportSize({ width: 720, height: 700 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole('button', { name: 'Lock vault', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Unlock your vault', exact: true }),
    ).toBeVisible();
    await checkAccessibility(page);
    await expect(page.getByLabel('Master passphrase', { exact: true })).toHaveAttribute(
      'type',
      'password',
    );
    expect(await callBroker(directory, { action: 'list-items' })).toMatchObject({ ok: false });
    expect(readFileSync(join(directory, 'vault.json'), 'utf8')).not.toContain(
      'synthetic-secret-canary',
    );
    expect(errors).toEqual([]);
    const preferences = await application.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents;
      // Test-only inspection: feature-detect Electron's internal preference getter.
      if (
        !contents ||
        !('getLastWebPreferences' in contents) ||
        typeof contents.getLastWebPreferences !== 'function'
      )
        throw new Error('Preference inspection unavailable');
      const result: unknown = contents.getLastWebPreferences();
      return result;
    });
    expect(preferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    });
  } finally {
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('database policy, approval and editing never reveal the saved URL', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ak-db-ui-'));
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );
  const application = await electron.launch({ args: [resolve('.'), '--data-dir', directory], env });
  const page = await application.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page
      .getByLabel('Master passphrase', { exact: true })
      .fill('synthetic database UI passphrase');
    await page
      .getByLabel('Confirm passphrase', { exact: true })
      .fill('synthetic database UI passphrase');
    await page.getByRole('button', { name: 'Create encrypted vault' }).click();
    await page.getByRole('button', { name: 'Add item', exact: true }).click();
    await page.getByLabel('Item name', { exact: true }).fill('db-url');
    await page
      .getByLabel('Secret value', { exact: true })
      .fill('postgresql://reader:synthetic-db-ui-password@127.0.0.1:5432/demo');
    await page.getByRole('button', { name: 'Save encrypted item' }).click();
    await page.getByRole('button', { name: '03 Databases' }).click();
    await page.getByRole('button', { name: 'Add database', exact: true }).click();
    await page.getByLabel('Connection name', { exact: true }).fill('demo-db');
    await page.getByLabel('URL vault item', { exact: true }).click();
    await page.getByRole('option', { name: 'db-url', exact: true }).click();
    await page.getByLabel('URL secret field', { exact: true }).click();
    await page.getByRole('option', { name: 'value', exact: true }).click();
    await page.getByLabel('Table 1', { exact: true }).fill('products');
    await page.getByLabel('Allowed columns 1', { exact: true }).fill('id, name');
    await checkAccessibility(page);
    await page.getByRole('button', { name: 'Save database connection', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'demo-db', exact: true })).toBeVisible();
    expect(JSON.stringify(await callBroker(directory, { action: 'list-databases' }))).not.toContain(
      'synthetic-db-ui-password',
    );
    expect(
      await callBroker(directory, { action: 'request-access', operation: 'demo-db' }),
    ).toMatchObject({ ok: true, value: { state: 'awaiting-approval' } });
    await page.getByRole('button', { name: '04 Approvals' }).click();
    await expect(page.getByText('public.products → id, name')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve demo-db', exact: true })).toBeDisabled();
    await page
      .getByRole('checkbox', { name: /I consent to sharing the listed data for demo-db/ })
      .check();
    await page.getByRole('button', { name: 'Approve demo-db', exact: true }).click();
    expect(
      await callBroker(directory, { action: 'request-access', operation: 'demo-db' }),
    ).toMatchObject({ ok: true, value: { state: 'approved' } });
    await checkAccessibility(page);
    await page.getByRole('button', { name: '03 Databases' }).click();
    await page.getByRole('button', { name: 'Edit policy', exact: true }).click();
    await expect(page.getByLabel('Allowed columns 1', { exact: true })).toHaveValue('id, name');
    await page.getByLabel('Allowed columns 1', { exact: true }).fill('id');
    await page.getByRole('button', { name: 'Save database connection', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Define database access', exact: true }),
    ).toHaveCount(0);
    expect(
      await callBroker(directory, { action: 'request-access', operation: 'demo-db' }),
    ).toMatchObject({ ok: true, value: { state: 'awaiting-approval' } });
    expect(await page.locator('body').innerText()).not.toContain('synthetic-db-ui-password');
    await page.getByRole('button', { name: '06 Connect an agent' }).click();
    await expect(page.getByLabel('Isolated broker directory', { exact: true })).toHaveCount(0);
    const connection = await page.evaluate(() => window.agentkey!.connection());
    expect(connection.ok).toBe(true);
    if (connection.ok) expect(connection.value).not.toHaveProperty('isolatedDirectory');
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('packaged executable serves both the desktop and its stdio MCP adapter', async () => {
  const executable =
    process.platform === 'win32'
      ? resolve('release/win-unpacked/AgentKey.exe')
      : process.platform === 'darwin'
        ? resolve(
            `release/mac${process.arch === 'arm64' ? '-arm64' : ''}/AgentKey.app/Contents/MacOS/AgentKey`,
          )
        : resolve('release/linux-unpacked/agentkey');
  test.skip(!existsSync(executable), 'Run pnpm package:dir first to verify the host package.');
  const directory = mkdtempSync(join(tmpdir(), 'ak-package-'));
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );
  const application = await electron.launch({
    executablePath: executable,
    args: ['--data-dir', directory],
    env,
  });
  let client: Client | undefined;
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: 'Create your local vault' })).toBeVisible();
    client = await connectDesktopMcp(page, directory);
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(11);
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['agentkey_propose_command', 'agentkey_run_command']),
    );
    const status = await client.callTool({ name: 'agentkey_status', arguments: {} });
    expect(status.isError).toBe(false);
    expect(JSON.stringify(status)).toContain('initialized');
    expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const opening = application.waitForEvent('window');
    await page.getByRole('button', { name: 'Quick access', exact: true }).click();
    const compact = await opening;
    await compact.waitForURL('**?view=compact');
    await expect(compact.getByRole('heading', { name: 'Create your local vault' })).toBeVisible();
    await expect(compact.getByRole('button', { name: 'Full window', exact: true })).toBeVisible();
  } finally {
    await client?.close();
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
