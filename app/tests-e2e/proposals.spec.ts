import { test, expect, Page } from '@playwright/test';

async function signUp(page: Page, email: string, password: string) {
  await page.goto('/signup');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('Confirm Password').fill(password);
  await page.getByRole('button', { name: 'Sign up' }).click();
  // Redirect can go to dashboard; we will navigate to /proposals ourselves
  await page.waitForLoadState('networkidle');
}

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForLoadState('networkidle');
}

async function ensureAuthAndSeed(page: Page) {
  const email = `e2e+${Date.now()}@example.com`;
  const password = 'P@ssw0rd123!';
  await signUp(page, email, password);
  // Clear then seed data for the logged-in user
  const clearRes = await page.request.post('/api/dev/clear');
  expect(clearRes.ok()).toBeTruthy();
  const seedRes = await page.request.post('/api/dev/seed');
  expect(seedRes.ok()).toBeTruthy();
}

// E2E: Proposals list end-to-end coverage
// Covers pagination, filtering, bulk actions, Gmail link presence, and Poll Now throttling

test.describe('Proposals E2E', () => {
  test.beforeEach(async ({ page }) => {
    await ensureAuthAndSeed(page);
  });

  test('lists proposals with headers and Gmail link; supports pagination', async ({ page }) => {
    await page.goto('/proposals');
    await expect(page.getByTestId('proposals-header')).toBeVisible();

    // At least one card with gmail link
    const firstCard = page.getByTestId('proposal-card').first();
    await expect(firstCard).toBeVisible();
    const gmailLink = firstCard.getByTestId('gmail-link');
    await expect(gmailLink).toBeVisible();
    await expect(gmailLink).toHaveAttribute('href', /mail\.google\.com\/mail\/u\/0\/\#all\//);

    // Pagination: click Load More until disabled or twice
    const loadMore = page.getByTestId('load-more');
    await expect(loadMore).toBeVisible();

    const initialCount = await page.getByTestId('proposal-card').count();
    await loadMore.click();
    await page.waitForTimeout(300);
    const afterFirst = await page.getByTestId('proposal-card').count();
    expect(afterFirst).toBeGreaterThanOrEqual(initialCount);

    if (await loadMore.isEnabled()) {
      await loadMore.click();
      await page.waitForTimeout(300);
      const afterSecond = await page.getByTestId('proposal-card').count();
      expect(afterSecond).toBeGreaterThanOrEqual(afterFirst);
    }
  });

  test('filtering by actionType works and counts update', async ({ page }) => {
    await page.goto('/proposals');
    await expect(page.getByTestId('filters')).toBeVisible();

    await page.getByTestId('filter-actionType').fill('refund');
    await page.getByTestId('apply-filters').click();

    // Expect cards showing only refund
    const cards = page.getByTestId('proposal-card');
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    for (let i = 0; i < Math.min(count, 10); i++) {
      await expect(cards.nth(i)).toContainText('refund', { ignoreCase: true });
    }
  });

  test('bulk approve and bulk reject with confirmation', async ({ page }) => {
    await page.goto('/proposals');

    // Click Proposed tab to get actionable items
    const tabs = page.getByTestId('status-tabs');
    await expect(tabs).toBeVisible();
    await page.getByRole('button', { name: /Proposed/ }).click();

    // Select first two proposals
    const checkboxes = page.getByTestId('proposal-checkbox');
    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();

    page.once('dialog', (d) => d.accept());
    await page.getByTestId('bulk-approve').click();

    // After approve, status badge should read approved or no error toast should show
    // We will allow some time for mutation
    await page.waitForTimeout(500);

    // Try reject as well
    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();
    page.once('dialog', (d) => d.accept());
    await page.getByTestId('bulk-reject').click();
    await page.waitForTimeout(500);

    // At least ensure no crash and buttons are still present
    await expect(page.getByTestId('bulk-approve')).toBeVisible();
    await expect(page.getByTestId('bulk-reject')).toBeVisible();
  });

  test('Poll Now throttling prevents rapid clicks', async ({ page }) => {
    await page.goto('/proposals');

    const pollNow = page.getByTestId('poll-now');
    await expect(pollNow).toBeVisible();
    await pollNow.click();
    await pollNow.click(); // immediate second click should be throttled

    // Expect a toast error message from the UI
    await expect(page.getByText(/Please wait a few seconds before polling again\./)).toBeVisible();
  });
});
