import { _electron as electron, expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { callMcp, connectDesktopMcp } from './mcp';

for (const packaged of [false, true]) {
  test(`HTTPS proposal approval, consent and advanced permissions (${packaged ? 'packaged' : 'source'})`, async () => {
    const executable =
      process.platform === 'win32'
        ? resolve('release/win-unpacked/AgentKey.exe')
        : process.platform === 'darwin'
          ? resolve(
              `release/mac${process.arch === 'arm64' ? '-arm64' : ''}/AgentKey.app/Contents/MacOS/AgentKey`,
            )
          : resolve('release/linux-unpacked/agentkey');
    test.skip(packaged && !existsSync(executable), 'Build the host package first.');
    const directory = mkdtempSync(join(tmpdir(), 'ak-http-ui-'));
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
    // Exercise the real main-process wiring without showing OS popups during tests.
    await app.evaluate(({ Notification, app }) => {
      Notification.isSupported = () => true;
      Notification.prototype.show = function () {
        Object.assign(app, { testNotification: this });
      };
      Notification.prototype.close = function () {};
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let client: Client | undefined;
    try {
      await page
        .getByLabel('Master passphrase', { exact: true })
        .fill('synthetic-http-ui-passphrase');
      await page
        .getByLabel('Confirm passphrase', { exact: true })
        .fill('synthetic-http-ui-passphrase');
      await page.getByRole('button', { name: 'Create encrypted vault' }).click();
      await page.getByRole('button', { name: 'Add item', exact: true }).click();
      await page.getByLabel('Item name', { exact: true }).fill('demo-key');
      await page.getByLabel('Secret value', { exact: true }).fill('synthetic-ui-secret-67493');
      await page.getByRole('button', { name: 'Save encrypted item' }).click();
      await expect(page.getByRole('heading', { name: 'demo-key', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Lock vault', exact: true })).toHaveAttribute(
        'data-appearance',
        'secondary-destructive',
      );
      await page.getByRole('button', { name: '04 Approvals' }).click();
      await page.getByLabel('New approval duration', { exact: true }).click();
      await page.getByRole('option', { name: '24 hours', exact: true }).click();
      await page.getByRole('button', { name: '01 Vault' }).click();
      client = await connectDesktopMcp(page, directory);
      const request = {
        name: 'read-products',
        item: 'demo-key',
        url: 'https://api.example.com/v1/products?limit=5',
        method: 'GET',
        auth: 'headers',
        bindings: [{ header: 'Authorization', field: 'value', prefix: 'Bearer ' }],
        body: '',
        responseFields: ['data[].id', 'data[].name'],
      };
      expect(await callMcp(client, 'agentkey_propose_operation', request)).toMatchObject({
        ok: true,
        value: { state: 'awaiting-approval' },
      });
      expect(
        await callMcp(client, 'agentkey_run_operation', { operation: request.name }),
      ).toMatchObject({ ok: false });
      const waitForDecision = callMcp(client, 'agentkey_wait_for_approval', {
        operation: request.name,
      }).catch((error: unknown) => ({
        waitError: error instanceof Error ? error.message : String(error),
      }));
      const notification = await app.evaluate(({ app, Notification }) => {
        if (!('testNotification' in app) || !(app.testNotification instanceof Notification))
          throw new Error('Missing notification');
        const result = { title: app.testNotification.title, body: app.testNotification.body };
        app.testNotification.emit('click');
        return result;
      });
      expect(notification).toEqual({
        title: 'AgentKey approval needed',
        body: 'A new request is waiting. Open AgentKey to review it.',
      });
      const card = page.locator('app-http-review');
      await expect(card.getByRole('heading', { name: 'api.example.com' })).toBeVisible();
      await expect(card.getByLabel('Allow this request', { exact: true })).toHaveValue('24 hours');
      await expect(
        card.getByRole('button', { name: 'Approve request', exact: true }),
      ).toBeDisabled();
      await card.getByText('Exact request and secret mapping', { exact: true }).click();
      await expect(card).toContainText('[demo-key.value]');
      expect(await page.locator('body').innerText()).not.toContain('synthetic-ui-secret-67493');
      const consent = card.getByRole('checkbox', { name: /I trust this destination/ });
      await consent.check();
      // Polling new snapshots must not clear a review draft or its consent.
      await expect
        .poll(async () => {
          await page.waitForTimeout(2200);
          return consent.isChecked();
        })
        .toBe(true);
      await card.getByLabel('Allow this request', { exact: true }).click();
      await page.getByRole('option', { name: '1 hour', exact: true }).click();
      await expect(consent).not.toBeChecked();
      await expect(page.getByRole('option', { name: '1 hour', exact: true })).toHaveCount(0);
      await page.getByLabel('New approval duration', { exact: true }).click();
      await page.getByRole('option', { name: 'Until revoked', exact: true }).click();
      await expect(card.getByLabel('Allow this request', { exact: true })).toHaveValue('1 hour');
      await card.getByText('Advanced: reusable API permissions', { exact: true }).click();
      await card
        .getByRole('checkbox', { name: 'Let agents change requests within explicit rules' })
        .check();
      await card
        .getByLabel('Allowed paths (one per line)', { exact: true })
        .fill('/v1/products\n/v1/products/*');
      await card.getByRole('checkbox', { name: 'POST', exact: true }).check();
      await consent.check();
      const axe = await new AxeBuilder({ page })
        .setLegacyMode(true)
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(axe.violations).toEqual([]);
      await page.screenshot({
        path: `test-results/http-${packaged ? 'packaged' : 'source'}.png`,
        fullPage: true,
      });
      await card.getByRole('button', { name: 'Approve request', exact: true }).click();
      expect(await waitForDecision).toEqual({
        ok: true,
        value: { operation: request.name, state: 'approved' },
      });
      await expect(card).toHaveCount(0);
      expect(await callMcp(client, 'agentkey_list_operations')).toMatchObject({
        ok: true,
        value: [
          expect.objectContaining({
            name: request.name,
            scope: { paths: ['/v1/products', '/v1/products/*'], methods: ['GET', 'POST'] },
            responseFields: ['data[].id', 'data[].name'],
          }),
        ],
      });
      await page.getByRole('button', { name: 'Active access 1', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Revoke access', exact: true }),
      ).toHaveAttribute('data-appearance', 'secondary-destructive');
      await page.getByRole('button', { name: 'Revoke access', exact: true }).click();
      await page.getByRole('button', { name: 'Inactive 1', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Approve read-products', exact: true }),
      ).toBeDisabled();
      expect(
        await callMcp(client, 'agentkey_run_operation', { operation: request.name }),
      ).toMatchObject({ ok: false });
      // A separate exact request stays exact and can be approved without configuring anything.
      await callMcp(client, 'agentkey_propose_operation', { ...request, name: 'exact-products' });
      await expect(card).toHaveCount(1);
      await page.getByRole('button', { name: 'Needs review 1', exact: true }).click();
      await expect(card.getByLabel('Allow this request', { exact: true })).toHaveValue(
        'Until revoked',
      );
      const opening = app.waitForEvent('window');
      await page.getByRole('button', { name: 'Quick access', exact: true }).click();
      const panel = await opening;
      panel.on('pageerror', (error) => errors.push(error.message));
      await panel.waitForURL('**?view=compact');
      const compactCard = panel.locator('app-http-review');
      await expect(compactCard).toHaveCount(1);
      expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const compactAxe = await new AxeBuilder({ page: panel })
        .setLegacyMode(true)
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(compactAxe.violations).toEqual([]);
      await panel.screenshot({
        path: `test-results/http-compact-${packaged ? 'packaged' : 'source'}.png`,
        fullPage: true,
      });
      await compactCard.getByRole('checkbox', { name: /I trust this destination/ }).check();
      await compactCard.getByRole('button', { name: 'Approve request', exact: true }).click();
      await expect(compactCard).toHaveCount(0);
      await panel.keyboard.press('Escape');
      await expect(card).toHaveCount(0);
      const policies = await page.evaluate(() => window.agentkey!.snapshot());
      expect(policies.ok).toBe(true);
      if (policies.ok)
        expect(
          policies.value.operations.find((op) => op.name === 'exact-products')?.scope,
        ).toBeUndefined();
      await callMcp(client, 'agentkey_propose_operation', { ...request, name: 'dismiss-me' });
      await expect(card).toHaveCount(1);
      await card.getByRole('button', { name: 'Dismiss request' }).click();
      await expect(card).toHaveCount(0);
      await page.setViewportSize({ width: 420, height: 740 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(errors).toEqual([]);
    } finally {
      await client?.close();
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
