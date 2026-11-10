import { expect, type ElectronApplication, type Page } from '@playwright/test';

/** Switching native windows is not document navigation. Verify the actual window transition. */
export async function showFullWindow(
  application: ElectronApplication,
  panel: Page,
  full: Page,
): Promise<void> {
  const panelWindow = await application.browserWindow(panel);
  const fullWindow = await application.browserWindow(full);
  const originalUrl = full.url();
  try {
    // Chromium's post-click navigation epilogue can stall after Electron hides the panel on Windows.
    // Keep click actionability checks; replace only the navigation wait with native-state assertions.
    await panel
      .getByRole('button', { name: 'Full window', exact: true })
      .click({ noWaitAfter: true });
    await expect
      .poll(async () => ({
        panelVisible: await panelWindow.evaluate((view) => view.isVisible()),
        fullVisible: await fullWindow.evaluate((view) => view.isVisible()),
      }))
      .toEqual({ panelVisible: false, fullVisible: true });
    await expect(full).toHaveURL(originalUrl);
  } finally {
    await panelWindow.dispose();
    await fullWindow.dispose();
  }
}
