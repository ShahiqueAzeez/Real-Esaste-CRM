import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * The MVP path, end to end, through the real UI and API with the simulated provider:
 * platform admin creates an organisation → its admin joins → disables calling hours (so the
 * test runs at any time) → invites an agent → imports leads → agent makes a simulated call →
 * wrap-up with a callback → admin sees the call and report numbers.
 */
const run = Date.now().toString(36);
const PLATFORM_EMAIL = process.env.E2E_PLATFORM_EMAIL ?? 'e2e-platform@calling-crm.test';
const PLATFORM_PASSWORD = process.env.E2E_PLATFORM_PASSWORD ?? 'E2e-platform-pass-1';
const ADMIN_EMAIL = `admin-${run}@e2e-realty.test`;
const AGENT_EMAIL = `agent-${run}@e2e-realty.test`;
const PASSWORD = 'E2e-password-123';

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function acceptInvite(browser: Browser, link: string, name: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(link);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Choose a password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  return { ctx, page };
}

test.describe.serial('calling CRM MVP flow (simulated telephony)', () => {
  let adminInvite = '';
  let agentInvite = '';

  test('platform admin creates an organisation', async ({ page }) => {
    await login(page, PLATFORM_EMAIL, PLATFORM_PASSWORD);
    await page.waitForURL('**/platform');
    await page.getByRole('button', { name: 'New organisation' }).click();
    await page.getByLabel('Name', { exact: true }).fill(`E2E Realty ${run}`);
    await page.getByLabel('Slug').fill(`e2e-${run}`);
    await page.getByLabel('Administrator email').fill(ADMIN_EMAIL);
    await page.getByRole('button', { name: 'Create' }).click();
    const link = page.getByLabel('Invitation link');
    await expect(link).toBeVisible();
    adminInvite = await link.inputValue();
    expect(adminInvite).toContain('/invite/');
  });

  test('organisation admin joins, relaxes calling hours and invites an agent', async ({ browser }) => {
    const { ctx, page } = await acceptInvite(browser, adminInvite, 'E2E Admin');
    await page.waitForURL('**/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.goto('/compliance');
    await page.getByLabel('Enforce calling hours').uncheck();
    await page.getByRole('button', { name: 'Save hours' }).click();
    await expect(page.getByText('Settings saved')).toBeVisible();

    await page.goto('/team');
    await page.getByRole('button', { name: 'Invite member' }).click();
    await page.getByLabel('Email').fill(AGENT_EMAIL);
    await page.getByRole('button', { name: 'Send invitation' }).click();
    const link = page.getByLabel('Link');
    await expect(link).toBeVisible();
    agentInvite = await link.inputValue();
    await ctx.close();
  });

  test('admin imports leads from CSV with a validation preview', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page, ADMIN_EMAIL, PASSWORD);
    await page.waitForURL('**/dashboard');
    await page.goto('/imports');
    const n = Number(String(Date.now()).slice(-6));
    const csv = [
      'Customer Name,Mobile Number,Area,Budget,Consent',
      `Lakshmi Iyer,98${String(n).padStart(6, '0')}41,Adyar,95L,yes`,
      `Ravi Kumar,97${String(n).padStart(6, '0')}52,Porur,60L,yes`,
      `No Phone,,Tambaram,,yes`,
    ].join('\n');
    await page.setInputFiles('input[type=file]', { name: 'e2e-leads.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.waitForURL('**/imports/*');
    await expect(page.getByLabel('Full name')).toHaveValue('Customer Name');
    await expect(page.getByLabel('Phone')).toHaveValue('Mobile Number');
    await page.getByRole('button', { name: 'Validate file' }).click();
    await expect(page.getByRole('button', { name: /Import 2 valid rows/ })).toBeVisible();
    await expect(page.getByText('Phone is empty')).toBeVisible();
    await page.getByRole('button', { name: /Import 2 valid rows/ }).click();
    await expect(page.getByText('Import complete')).toBeVisible();
    await expect(page.getByText('2 leads added')).toBeVisible();
    await ctx.close();
  });

  test('agent joins, makes a simulated call and wraps it up with a callback', async ({ browser }) => {
    const { ctx, page } = await acceptInvite(browser, agentInvite, 'E2E Agent');
    await page.waitForURL('**/agent');
    await expect(page.getByText('SIMULATED').first()).toBeVisible();
    await page.getByRole('button', { name: 'Start calling' }).click();
    await expect(page.getByText('Current call')).toBeVisible();
    await expect(page.getByText('talk time', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('listitem').filter({ hasText: 'Connected' })).toBeVisible();
    await page.getByRole('button', { name: 'Hang up' }).click();
    await expect(page.getByText('Wrap-up required')).toBeVisible();
    // The next call cannot start before the outcome is saved.
    await expect(page.getByRole('button', { name: 'Call next lead' })).toHaveCount(0);
    await page.getByText('Callback scheduled', { exact: true }).click();
    await page.getByLabel('Notes').fill('Asked for a call back with floor plans');
    await page.getByRole('button', { name: 'Save & pause' }).click();
    await expect(page.getByText('Outcome saved')).toBeVisible();
    await expect(page.getByText('You are paused')).toBeVisible();
    await page.goto('/callbacks');
    await expect(page.getByRole('cell', { name: /Lakshmi Iyer|Ravi Kumar/ })).toBeVisible();
    await ctx.close();
  });

  test('admin sees the call, its outcome and updated reports', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page, ADMIN_EMAIL, PASSWORD);
    await page.waitForURL('**/dashboard');
    await page.goto('/calls');
    const row = page.getByRole('row').filter({ hasText: 'E2E Agent' }).first();
    await expect(row).toContainText('SIMULATED');
    await expect(row).toContainText('Callback scheduled');
    await page.goto('/reports');
    const attempts = page.locator('div').filter({ has: page.getByText('Attempts (customer dialled)', { exact: true }) }).locator('p.text-2xl').first();
    await expect(attempts).toHaveText('1');
    await ctx.close();
  });
});
