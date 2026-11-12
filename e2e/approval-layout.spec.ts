import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { callBroker } from '../agent/client';
import type { DesktopApi } from '../shared/contracts';

declare global {
  interface Window {
    agentkey?: DesktopApi;
  }
}

// Synthetic approvals are exercised, but no command, API or database call is executed.
test('approval controls precede long details in wide, narrow and compact views', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ak-approval-layout-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );
  const app = await electron.launch({ args: [resolve('.'), '--data-dir', directory], env });
  const page = await app.firstWindow();
  try {
    const results = await page.evaluate(async () => {
      const api = window.agentkey!;
      return [
        await api.initialize('synthetic-layout-passphrase'),
        await api.saveItem({
          name: 'layout-token',
          kind: 'secret',
          fields: [{ name: 'value', value: 'synthetic-layout-token' }],
        }),
        await api.saveItem({
          name: 'layout-db',
          kind: 'secret',
          fields: [{ name: 'value', value: 'postgresql://reader:synthetic@127.0.0.1/demo' }],
        }),
        await api.saveOperation({
          name: 'saved-api',
          item: 'layout-token',
          url: 'https://api.example.com/products',
          method: 'POST',
          auth: 'headers',
          bindings: [{ header: 'Authorization', field: 'value', prefix: 'Bearer ' }],
          body: JSON.stringify({ rows: Array.from({ length: 40 }, (_, i) => `row-${i}`) }),
          responseFields: ['id'],
        }),
        await api.saveDatabase({
          name: 'saved-database',
          item: 'layout-db',
          field: 'value',
          tables: Array.from({ length: 20 }, (_, i) => ({
            schema: 'public',
            table: `table_${i}`,
            columns: ['id', 'name'],
          })),
        }),
      ];
    });
    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      await callBroker(directory, {
        action: 'propose-command',
        command: {
          name: 'new-command',
          executable: process.execPath,
          cwd: directory,
          args: Array.from({ length: 40 }, (_, i) => `argument-${i}`),
          bindings: [{ env: 'APP_TOKEN', item: 'layout-token', field: 'value' }],
          timeoutMs: 1000,
        },
      }),
    ).toMatchObject({ ok: true });
    expect(
      await callBroker(directory, {
        action: 'propose-operation',
        operation: {
          name: 'new-api',
          item: 'layout-token',
          url: 'https://api.example.com/products',
          method: 'POST',
          auth: 'headers',
          bindings: [{ header: 'Authorization', field: 'value', prefix: 'Bearer ' }],
          body: JSON.stringify({ rows: Array.from({ length: 40 }, (_, i) => `row-${i}`) }),
          responseFields: ['id'],
        },
      }),
    ).toMatchObject({ ok: true });
    for (const operation of ['saved-api', 'saved-database']) {
      expect(await callBroker(directory, { action: 'request-access', operation })).toMatchObject({
        ok: true,
      });
    }
    await page.getByRole('button', { name: '04 Approvals' }).click();
    for (const width of [1400, 420, 'compact'] as const) {
      let view = page;
      if (width === 'compact') {
        const opening = app.waitForEvent('window');
        await page.getByRole('button', { name: 'Quick access', exact: true }).click();
        view = await opening;
        await view.waitForURL('**?view=compact');
        const panelWindow = await app.browserWindow(view);
        await expect
          .poll(() => panelWindow.evaluate((panel) => panel.isVisible() && panel.isFocused()))
          .toBe(true);
        await panelWindow.dispose();
        await view.getByRole('button', { name: 'Approvals', exact: true }).click();
      } else {
        await page.setViewportSize({ width, height: 950 });
      }
      const viewportWidth = await view.evaluate(() => innerWidth);
      const list = view.getByRole('region', { name: 'Approval requests', exact: true });
      const review = view.getByRole('region', { name: 'Request review', exact: true });
      for (const entry of [
        { name: 'new-command', button: 'Approve one attempt', detail: 'Executable' },
        { name: 'new-api', button: 'Approve request', detail: 'Exact request and secret mapping' },
        { name: 'saved-api', button: 'Approve saved-api', detail: 'Show request body' },
        { name: 'saved-database', button: 'Approve saved-database', detail: 'public.table_0' },
      ]) {
        await list.getByRole('button', { name: new RegExp(`^${entry.name} `) }).click();
        const approve = review.getByRole('button', { name: entry.button, exact: true });
        await expect(approve).toBeDisabled();
        const detail = review.getByText(entry.detail, { exact: entry.name !== 'saved-database' });
        const actionBounds = await approve.boundingBox();
        const detailBounds = await detail.boundingBox();
        expect(actionBounds).not.toBeNull();
        expect(detailBounds).not.toBeNull();
        expect(actionBounds!.y + actionBounds!.height).toBeLessThan(detailBounds!.y);
        await approve.scrollIntoViewIfNeeded();
        await expect(approve).toBeInViewport();
        expect(actionBounds!.x).toBeGreaterThanOrEqual(0);
        expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(viewportWidth);
      }
      for (const name of ['saved-api', 'saved-database']) {
        const request = list.getByRole('button', { name: new RegExp(`^${name} `) });
        await request.click();
        // Approval removes the previous card and briefly selects the next pending request.
        // Wait for this selection to render before resolving its consent checkbox.
        await expect(request).toHaveAttribute('aria-pressed', 'true');
        await expect(review.getByRole('heading', { name, exact: true })).toBeVisible();
        await review.getByRole('checkbox').check();
        await review.getByRole('button', { name: `Approve ${name}`, exact: true }).click();
      }
      await view.getByRole('button', { name: 'Active access 2', exact: true }).click();
      for (const name of ['saved-api', 'saved-database']) {
        await list.getByRole('button', { name: new RegExp(`^${name} `) }).click();
        const heading = review.getByRole('heading', { name, exact: true });
        await expect(heading).toBeVisible();
        expect(
          await heading.evaluate((element) =>
            element.nextElementSibling?.classList.contains('grant-state'),
          ),
        ).toBe(true);
        const status = heading.locator('..').locator('.grant-state');
        await expect(status).toContainText('Approved · One attempt remaining');
        const revoke = status.getByRole('button', { name: 'Revoke access', exact: true });
        const bounds = await revoke.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewportWidth);
        await revoke.click();
        await expect(status).toHaveCount(0);
        expect(
          await callBroker(directory, { action: 'request-access', operation: name }),
        ).toMatchObject({
          ok: true,
          value: { state: 'awaiting-approval' },
        });
      }
      await view.getByRole('button', { name: 'Needs review 4', exact: true }).click();
      expect(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    const snapshot = await page.evaluate(() => window.agentkey!.snapshot());
    expect(snapshot.ok && snapshot.value.grants).toEqual([]);
    expect(snapshot.ok && snapshot.value.commands[0]?.state).toBe('pending');
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
