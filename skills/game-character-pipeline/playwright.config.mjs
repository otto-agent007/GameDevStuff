import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  timeout: 15000,
  expect: { timeout: 2000 },
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } } },
    { name: 'narrow', use: { browserName: 'chromium', viewport: { width: 420, height: 900 } } }
  ]
});
