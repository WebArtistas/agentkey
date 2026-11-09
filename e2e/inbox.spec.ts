import { test, expect, _electron as electron } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { callBroker } from '../agent/client';

// Only disposable metadata and synthetic credentials; no operation is executed.
test('approval inbox groups, filters and reviews requests without losing drafts or consent boundaries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ak-inbox-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );
  const app = await electron.launch({ args: [resolve('.'), '--data-dir', directory], env });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const results = await page.evaluate(async () => {
      const api = window.agentkey!;
      const results = [await api.initialize('synthetic-inbox-passphrase')];
      results.push(
        await api.saveItem({
          name: 'api-token',
          kind: 'secret',
          fields: [{ name: 'value', value: 'synthetic-inbox-token-12345' }],
        }),
      );
      results.push(
        await api.saveItem({
          name: 'database-token',
          kind: 'secret',
          fields: [
            { name: 'value', value: 'postgresql://reader:synthetic-db-token@127.0.0.1:5432/demo' },
          ],
        }),
      );
      for (const name of ['active-api', 'daily-report'])
        results.push(
          await api.saveOperation({
            name,
            item: 'api-token',
            url: 'https://api.example.com/v1/products',
            method: 'GET',
            auth: 'headers',
            bindings: [{ header: 'Authorization', field: 'value', prefix: 'Bearer ' }],
            body: '',
          }),
        );
      const snapshot = await api.snapshot();
      if (!snapshot.ok) throw new Error('Synthetic snapshot unavailable');
      const revision = snapshot.value.operations.find(
        (operation) => operation.name === 'active-api',
      )!.revision;
      results.push(await api.approve('active-api', 'until-revoked', revision));
      results.push(
        await api.saveDatabase({
          name: 'catalog',
          item: 'database-token',
          field: 'value',
          tables: [{ schema: 'public', table: 'products', columns: ['id', 'name'] }],
        }),
      );
      return results;
    });
    expect(results.every((result) => result.ok)).toBe(true);
    for (const name of ['alpha-read', 'beta-delete']) {
      expect(
        await callBroker(directory, {
          action: 'propose-operation',
          operation: {
            name,
            item: 'api-token',
            url: 'https://api.example.com/v1/products',
            method: name === 'alpha-read' ? 'GET' : 'DELETE',
            auth: 'headers',
            bindings: [{ header: 'Authorization', field: 'value', prefix: 'Bearer ' }],
            body: '',
            responseFields: ['data[].id'],
          },
        }),
      ).toMatchObject({ ok: true });
    }
    await callBroker(directory, { action: 'request-access', operation: 'catalog' });
    await page.getByRole('button', { name: '04 Approvals' }).click();
    const status = page.getByRole('group', { name: 'Approval status', exact: true });
    await expect(status.getByRole('button', { name: 'Needs review 3' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(status.getByRole('button', { name: 'Active access 1' })).toBeVisible();
    await expect(status.getByRole('button', { name: 'Inactive 1' })).toBeVisible();
    const list = page.getByRole('region', { name: 'Approval requests', exact: true });
    const review = page.getByRole('region', { name: 'Request review', exact: true });
    const card = review.locator('app-http-review:not([hidden])');
    await expect(list.getByRole('button')).toHaveCount(3);
    await expect(card).toContainText('alpha-read');
    await card.getByLabel('Allow this request', { exact: true }).click();
    await page.getByRole('option', { name: '1 hour', exact: true }).click();
    await card.getByText('Advanced: reusable API permissions', { exact: true }).click();
    await review
      .getByRole('checkbox', { name: 'Let agents change requests within explicit rules' })
      .check();
    await card.getByLabel('Allowed paths (one per line)').fill('/v1/products\n/v1/products/*');
    await list.getByRole('button', { name: /^beta-delete/ }).click();
    await expect(review).toBeFocused();
    await expect(card).toContainText('Delete data');
    await expect(
      review.getByRole('button', { name: 'Approve request', exact: true }),
    ).toBeDisabled();
    await list.getByRole('button', { name: /^alpha-read/ }).focus();
    await page.keyboard.press('Enter');
    await expect(review).toBeFocused();
    await expect(card.getByLabel('Allow this request', { exact: true })).toHaveValue('1 hour');
    await expect(card.getByLabel('Allowed paths (one per line)')).toHaveValue(
      '/v1/products\n/v1/products/*',
    );
    await page
      .getByRole('group', { name: 'Request type' })
      .getByRole('button', { name: 'Database', exact: true })
      .click();
    await expect(list.getByRole('button')).toHaveCount(1);
    await expect(review.getByRole('heading', { name: 'catalog' })).toBeVisible();
    await expect(review.getByRole('button', { name: 'Approve catalog' })).toBeDisabled();
    await page.getByLabel('Search approvals', { exact: true }).fill('DATABASE-TOKEN');
    await expect(list.getByRole('button')).toHaveCount(1);
    await page.getByLabel('Search approvals', { exact: true }).fill('no-match');
    await expect(page.getByRole('heading', { name: 'No matching approvals.' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Approve / })).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await status.getByRole('button', { name: 'Active access 1' }).click();
    await expect(list.getByRole('button')).toHaveCount(1);
    await expect(review).toContainText('Until revoked');
    await page.getByLabel('Search approvals', { exact: true }).fill('no-match');
    // The preload's navigation event must reset stale inbox filters, not grant permission.
    await page.evaluate(() => window.dispatchEvent(new Event('agentkey-approvals')));
    await expect(status.getByRole('button', { name: 'Needs review 3' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByLabel('Search approvals', { exact: true })).toHaveValue('');
    await list.getByRole('button', { name: /^beta-delete/ }).click();
    await expect(card).toContainText('beta-delete');
    await card.getByRole('button', { name: 'Dismiss request' }).click();
    await expect(status.getByRole('button', { name: 'Needs review 2' })).toBeFocused();
    await list.getByRole('button', { name: /^alpha-read/ }).click();
    await expect(card.getByLabel('Allow this request', { exact: true })).toHaveValue('1 hour');
    await review.getByRole('checkbox', { name: /I trust this destination/ }).check();
    await page.setViewportSize({ width: 1400, height: 950 });
    await page.screenshot({ path: 'test-results/approval-inbox.png', fullPage: true });
    expect(
      (
        await new AxeBuilder({ page })
          .setLegacyMode(true)
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await review.getByRole('button', { name: 'Approve request', exact: true }).click();
    await expect(status.getByRole('button', { name: 'Needs review 1' })).toBeFocused();
    await expect(review.getByRole('button', { name: 'Approve catalog' })).toBeDisabled();
    const snapshot = await page.evaluate(() => window.agentkey!.snapshot());
    expect(snapshot.ok && snapshot.value.grants.map((grant) => grant.operation).sort()).toEqual([
      'active-api',
      'alpha-read',
    ]);
    expect(snapshot.ok && snapshot.value.proposals).toEqual([]);
    await status.getByRole('button', { name: 'Active access 2' }).click();
    await list.getByRole('button', { name: /^alpha-read/ }).click();
    await expect(review.getByRole('heading', { name: 'alpha-read', exact: true })).toBeVisible();
    await review.getByRole('button', { name: 'Revoke access' }).click();
    await expect(status.getByRole('button', { name: 'Inactive 2' })).toBeVisible();
    await status.getByRole('button', { name: 'Needs review 1' }).click();
    for (const width of [900, 420]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const bounds = await review.boundingBox();
      expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width).toBe(true);
    }
    await page.screenshot({ path: 'test-results/approval-inbox-narrow.png', fullPage: true });
    expect(
      (
        await new AxeBuilder({ page })
          .setLegacyMode(true)
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(await page.locator('body').innerText()).not.toContain('synthetic-inbox-token-12345');
    expect(await page.locator('body').innerText()).not.toContain('synthetic-db-token');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
