import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  // E2E fixtures use disposable vaults and synthetic credentials only.
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
