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

// These tests hit dev-only HTTP test routes to validate retry/timeout/idempotency behavior
// Ensure the app is running in dev mode for these to work.

test.describe('HTTP retry/timeout/idempotency via fetchWithRetry', () => {
  test.beforeEach(async ({ page }) => {
    const email = `e2e-http+${Date.now()}@example.com`;
    const password = 'P@ssw0rd123!';
    await signUp(page, email, password);
  });

  test('GET: 500 then 200 is retried and succeeds', async ({ page }) => {
    const res = await page.request.get('/api/dev/http-probe?mode=500-then-200&retries=2');
    expect(res.ok()).toBeTruthy();
    const json = await res.json();
    expect(json.ok).toBeTruthy();
    expect(json.data?.attempt).toBeGreaterThanOrEqual(2);
  });

  test('GET: 429 then 200 is retried and succeeds', async ({ page }) => {
    const res = await page.request.get('/api/dev/http-probe?mode=429-then-200&retries=2');
    expect(res.ok()).toBeTruthy();
    const json = await res.json();
    expect(json.ok).toBeTruthy();
    expect(json.data?.attempt).toBeGreaterThanOrEqual(2);
  });

  test('GET: timeout triggers retry and then succeeds', async ({ page }) => {
    const res = await page.request.get('/api/dev/http-probe?mode=delay-then-200&timeoutMs=100&retries=2&backoffMs=0');
    expect(res.ok()).toBeTruthy();
    const json = await res.json();
    expect(json.ok).toBeTruthy();
    expect(json.data?.attempt).toBeGreaterThanOrEqual(2);
  });

  test('POST: idempotency key is attached for mutating requests', async ({ page }) => {
    const res = await page.request.post('/api/dev/http-probe?mode=echo-idempotency');
    expect(res.ok()).toBeTruthy();
    const json = await res.json();
    expect(json.ok).toBeTruthy();
    expect(typeof json.data?.idempotencyKey === 'string' && json.data.idempotencyKey.length > 0).toBeTruthy();
    expect(json.data?.consistent).toBeTruthy();
  });
});
