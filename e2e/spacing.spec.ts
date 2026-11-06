import { _electron as electron, expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('database actions and editor spacing fit full and narrow quick-access views', async ({}, info) => {
  const directory = mkdtempSync(join(tmpdir(), 'ak-spacing-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );
  const app = await electron.launch({ args: [resolve('.'), '--data-dir', directory], env });
  const full = await app.firstWindow();
  try {
    await full
      .getByLabel('Master passphrase', { exact: true })
      .fill('synthetic spacing passphrase');
    await full
      .getByLabel('Confirm passphrase', { exact: true })
      .fill('synthetic spacing passphrase');
    await full.getByRole('button', { name: 'Create encrypted vault' }).click();
    await full.getByRole('button', { name: '03 Databases' }).click();
    const actions = full
      .getByRole('button', { name: 'Try SQLite demo', exact: true })
      .locator('..');
    const actionsBox = await actions.boundingBox();
    const emptyBox = await full.locator('.empty-state').boundingBox();
    const emptyGap = emptyBox!.y - actionsBox!.y - actionsBox!.height;
    await full.screenshot({ path: info.outputPath('full-empty.png') });
    await full.getByRole('button', { name: 'Try SQLite demo', exact: true }).click();
    await expect(full.getByRole('heading', { name: 'Choose SQLite access' })).toBeVisible();
    await full.screenshot({ path: info.outputPath('full-editor.png') });
    const paragraphMargin = await full
      .locator('.editor > .notice')
      .evaluate((element) => getComputedStyle(element).marginTop);
    const opening = app.waitForEvent('window');
    await full.getByRole('button', { name: 'Quick access', exact: true }).click();
    const panel = await opening;
    await panel.waitForURL('**?view=compact');
    await panel.getByRole('button', { name: 'Databases', exact: true }).click();
    await panel.getByRole('button', { name: 'Try SQLite demo', exact: true }).click();
    await expect(panel.getByRole('heading', { name: 'Choose SQLite access' })).toBeVisible();
    const checkButtonBounds = async () => {
      const bounds = await panel.locator('main').evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          left: rect.x + parseFloat(style.paddingLeft),
          right: rect.x + element.clientWidth - parseFloat(style.paddingRight),
        };
      });
      for (const name of ['Try SQLite demo', 'Choose SQLite file']) {
        const box = await panel.getByRole('button', { name, exact: true }).boundingBox();
        expect
          .soft(box!.x, `${name} left edge remains inside content`)
          .toBeGreaterThanOrEqual(bounds.left - 1);
        expect
          .soft(box!.x + box!.width, `${name} right edge remains inside content`)
          .toBeLessThanOrEqual(bounds.right + 1);
      }
    };
    for (const width of [420, 320]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const view = BrowserWindow.getAllWindows().find((view) =>
          view.webContents.getURL().endsWith('?view=compact'),
        );
        view?.setBounds({ width, height: 640 });
      }, width);
      await panel.locator('main').evaluate((element) => (element.scrollTop = 0));
      await panel.screenshot({ path: info.outputPath(`compact-${width}.png`) });
      await checkButtonBounds();
      expect
        .soft(
          await panel
            .locator('main')
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
          `no horizontal scrolling at ${width}px`,
        )
        .toBe(true);
    }
    await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows().find((view) =>
        view.webContents.getURL().endsWith('?view=compact'),
      );
      view?.setBounds({ width: 420, height: 640 });
      view?.webContents.setZoomFactor(1.25);
    });
    await checkButtonBounds();
    await panel.getByLabel('internal_note', { exact: true }).focus();
    await expect(panel.getByLabel('internal_note', { exact: true })).toBeFocused();
    await panel.getByLabel('internal_note', { exact: true }).press('Space');
    await expect(panel.getByLabel('internal_note', { exact: true })).toBeChecked();
    expect
      .soft(
        await panel
          .locator('main')
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
        'no horizontal scrolling at 125% zoom',
      )
      .toBe(true);
    expect(
      (
        await new AxeBuilder({ page: panel })
          .setLegacyMode(true)
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect
      .soft(emptyGap, 'separation between database actions and empty state')
      .toBeGreaterThanOrEqual(16);
    expect.soft(paragraphMargin, 'editor grid owns paragraph spacing').toBe('0px');
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
