import { test, expect, Page } from '@playwright/test';

async function signUp(page: Page, email: string, password: string) {
  await page.goto('/signup');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('Confirm Password').fill(password);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.waitForLoadState('networkidle');
}

async function ensureAuth(page: Page) {
  const email = `cron+${Date.now()}@example.com`;
  const password = 'P@ssw0rd123!';
  await signUp(page, email, password);
}

async function enableGmailAutoPull(page: Page) {
  const res = await page.request.post('/api/settings', {
    data: {
      gmailAutoPullEnabled: true,
      gmailLabelQuery: 'label:customer-inquiries newer_than:7d',
      gmailPollingIntervalSec: 300,
    },
    headers: { 'content-type': 'application/json' },
  });
  expect(res.ok()).toBeTruthy();
}

// E2E: Gmail cron poll API and Settings UI toast behavior with standardized Result envelope

test.describe('Gmail Cron Poll & Settings', () => {
  test.beforeEach(async ({ page }) => {
    await ensureAuth(page);
    // Clear user data (emails/proposals) for isolation
    const clearRes = await page.request.post('/api/dev/clear');
    expect(clearRes.ok()).toBeTruthy();
    // Enable auto-pull so cron includes this user
    await enableGmailAutoPull(page);
  });

  test('cron route requires secret and returns standardized envelopes', async ({ page }) => {
    // Unauthorized without secret
    const unauth = await page.request.get('/api/cron/gmail-poll');
    expect(unauth.status()).toBe(401);

    // Authorized with header (secret is injected via Playwright webServer env)
    const authRes = await page.request.get('/api/cron/gmail-poll?maxResults=5', {
      headers: { 'x-cron-secret': 'test-cron-secret' },
    });
    expect(authRes.ok()).toBeTruthy();

    const json = await authRes.json() as {
      processedUsers: number;
      results: Array<{ userId: string; ok: boolean; code?: string; message?: string; data?: any }>;
    };

    expect(json.processedUsers).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(json.results)).toBeTruthy();
    expect(json.results.length).toBeGreaterThanOrEqual(1);

    // Since no Gmail token is configured, expect standardized failure envelope for this user
    const first = json.results[0];
    expect(typeof first.userId).toBe('string');
    expect(first.ok).toBeFalsy();
    expect(typeof first.code === 'string' || typeof first.message === 'string').toBeTruthy();
  });

  test('Settings: Run Poll Now shows toast from standardized envelope', async ({ page }) => {
    await page.goto('/settings');
    // Click Run Poll Now; without Gmail token we expect an error toast using message/code
    const btn = page.getByRole('button', { name: 'Run Poll Now' });
    await expect(btn).toBeVisible();
    await btn.click();

    // Expect a toast with either the message or the error code
    const possibleMessages = [/No Gmail token/i, /GMAIL_NO_TOKEN/i, /Poll failed/i];
    await expect(async () => {
      const bodyText = await page.locator('body').innerText();
      expect(possibleMessages.some((re) => re.test(bodyText))).toBeTruthy();
    }).toPass();
  });
});
