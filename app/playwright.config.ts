import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests-e2e',
  fullyParallel: true,
  timeout: 60_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    headless: true,
  },
  webServer: {
    command: 'pnpm dev',
    port: 3000,
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      // Provide a cron secret specifically for test runs so /api/cron/gmail-poll can be authorized
      CRON_SECRET: 'test-cron-secret',
      // Minimal required env to boot the app server for e2e runs
      VITE_BASE_URL: 'http://localhost:3000',
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/tanstarter',
      BETTER_AUTH_SECRET: 'test-auth-secret',
      // 32+ bytes recommended; use a placeholder for tests only
      MASTER_KEY: '0123456789abcdef0123456789abcdef',
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
