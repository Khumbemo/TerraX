import { expect, test } from '@playwright/test';
import { openTool, start } from './helpers';

const unique = (who: string) => `${who}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@terrax.test`;

test('account: sign up keeps guest work, history and server projects follow the account', async ({ page, browser }) => {
  const errors = await start(page);
  // As a guest first: the analysis belongs to this browser only.
  await openTool(page, 'Terrain');
  await page.click('button:has-text("Try synthetic DEM")');
  await expect(page.locator('.report-card')).toContainText('Hypsometric integral');
  const jobs = await (await page.request.get('/api/jobs')).json();
  expect(jobs.jobs).toHaveLength(1);
  const jobId: string = jobs.jobs[0].id;
  const other = await browser.newContext();
  expect((await other.request.get(`/api/jobs/${jobId}`)).status()).toBe(404); // another browser cannot read it, even with the ID

  // Create an account: the guest's work moves into it.
  const email = unique('ana');
  await page.click('#account-button');
  await page.click('#account-tab-signup');
  await page.fill('#signup-email', email);
  await page.fill('#signup-password', 'correct horse battery');
  await page.click('#signup-submit');
  await expect(page.locator('.toast', { hasText: 'Account created' })).toBeVisible();
  await expect(page.locator('#account-button')).toHaveText(email);
  await page.click('#account-button');
  await expect(page.locator('.history-item')).toHaveCount(1);
  await expect(page.locator('.history-item').first()).toContainText('Terrain');
  await page.locator('.history-row').first().click();
  await expect(page.locator('.history-detail button:has-text("Save to Reports")')).toBeVisible();

  // Save a project on the server.
  await page.click('#account-tab-projects');
  await page.fill('#project-name', 'Kohima e2e');
  await page.click('#project-save');
  await expect(page.locator('.projects-panel .history-item')).toContainText('Kohima e2e');

  // Sign out, sign in on another device: the history and the project are there.
  await page.click('#account-tab-account');
  await page.click('#signout');
  await expect(page.locator('#account-button')).toHaveText('Sign in');
  const second = await other.newPage();
  await start(second);
  await second.click('#account-button');
  await second.fill('#signin-email', email);
  await second.fill('#signin-password', 'correct horse battery');
  await second.click('#signin-submit');
  await expect(second.locator('.toast', { hasText: `Signed in as ${email}` })).toBeVisible();
  await second.click('#account-button');
  await expect(second.locator('.history-item').first()).toContainText('Terrain');
  await second.click('#account-tab-projects');
  await second.locator('.history-item', { hasText: 'Kohima e2e' }).locator('button:has-text("Open")').click();
  await expect(second.locator('.toast', { hasText: '“Kohima e2e” opened' })).toBeVisible();
  expect((await second.request.get(`/api/jobs/${jobId}`)).status()).toBe(200);
  await other.close();
  expect(errors).toEqual([]);
});

test('admin: usage, accounts and errors reported from a browser', async ({ page }) => {
  await start(page);
  // A browser error is reported to the server on its own.
  const marker = `e2e boom ${Date.now()}`;
  const reported = page.waitForResponse(r => r.url().endsWith('/api/client-errors') && r.status() === 204);
  await page.evaluate(m => setTimeout(() => { throw new Error(m); }), marker);
  await reported;
  await page.click('#account-button');
  await page.fill('#signin-email', 'admin@terrax.test');
  await page.fill('#signin-password', 'e2e admin passphrase');
  await page.click('#signin-submit');
  await page.click('#account-button');
  await page.click('#account-tab-admin');
  await expect(page.locator('#admin-stats')).toContainText('Accounts');
  await expect(page.locator('#admin-users')).toContainText('admin@terrax.test');
  await page.selectOption('#admin-error-source', 'client');
  await expect(page.locator('#admin-errors')).toContainText(marker);
  const metrics = await page.request.get('/api/metrics');
  expect(metrics.status()).toBe(200);
  expect(await metrics.text()).toContain('terrax_http_requests_total');
});

test('a server that requires accounts shows only the sign-in page until signed in', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  // As TERRAX_AUTH=required answers before sign-in (the sign-in itself is the real one).
  let required = true;
  await page.route('**/api/auth/me', async route => {
    if (!required) return route.fallback();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ mode: 'required', signup: 'closed', user: null, guest: false }) });
  });
  await page.goto('/');
  await expect(page.locator('.account-page')).toContainText('This TerraX server needs an account');
  await expect(page.locator('#account-tab-signup')).toHaveCount(0); // sign-up closed
  await expect(page.locator('#operator-name')).toHaveCount(0);
  required = false;
  await page.fill('#signin-email', 'admin@terrax.test');
  await page.fill('#signin-password', 'wrong password here');
  await page.click('#signin-submit');
  await expect(page.locator('.form-error')).toContainText('not right');
  await page.fill('#signin-password', 'e2e admin passphrase');
  await page.click('#signin-submit');
  await expect(page.locator('.login-note', { hasText: 'Signed in as admin@terrax.test' })).toBeVisible();
  await expect(page.locator('.modal-backdrop')).toHaveCount(0); // no dialog left over from before signing in
  expect(errors).toEqual([]);
});

/** RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits), as an authenticator app computes it. */
async function totp(secret: string, offset = 0): Promise<string> {
  const { createHmac } = await import('node:crypto');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/\s/g, '')) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const mac = createHmac('sha1', key).update(counter).digest();
  const o = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

test('two-factor sign-in, signing out other devices and the audit log', async ({ page, browser }) => {
  const errors = await start(page);
  const email = unique('totp');
  await page.click('#account-button');
  await page.click('#account-tab-signup');
  await page.fill('#signup-email', email);
  await page.fill('#signup-password', 'correct horse battery');
  await page.click('#signup-submit');
  await expect(page.locator('#account-button')).toHaveText(email);

  // Set up an authenticator: a QR code and the key; the first code turns it on and shows recovery codes.
  await page.click('#account-button');
  await page.click('#account-tab-account');
  await page.click('#totp-start');
  await expect(page.locator('#totp-setup svg.qr-code')).toBeVisible();
  const secret = (await page.locator('#totp-secret').innerText()).replace(/\s/g, '');
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await page.fill('#totp-code', await totp(secret));
  await page.click('#totp-enable');
  await expect(page.locator('#recovery-codes pre')).toContainText(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}/);
  const recovery = (await page.locator('#recovery-codes pre').innerText()).split('\n')[0];

  // Another device: the password alone is not enough; a recovery code is.
  const other = await browser.newContext();
  const second = await other.newPage();
  await start(second);
  await second.click('#account-button');
  await second.fill('#signin-email', email);
  await second.fill('#signin-password', 'correct horse battery');
  await second.click('#signin-submit');
  await expect(second.locator('#signin-code')).toBeVisible();
  await expect(second.locator('#account-button')).toHaveText('Sign in');
  await second.fill('#signin-code', recovery);
  await second.click('#signin-submit');
  await expect(second.locator('.toast', { hasText: `Signed in as ${email}` })).toBeVisible();

  // The first device lists both and signs the second one out.
  await page.click('#account-tab-history');
  await page.click('#account-tab-account');
  await expect(page.locator('#sessions .history-item')).toHaveCount(2);
  await expect(page.locator('#sessions')).toContainText('(this device)');
  await page.click('#sessions-end-others');
  await expect(page.locator('.toast', { hasText: 'Signed out 1 other device' })).toBeVisible();
  await expect(page.locator('#sessions .history-item')).toHaveCount(1);
  expect((await (await second.request.get('/api/auth/me')).json()).user).toBeNull();
  await other.close();

  // The administrator sees it all in the audit log.
  await page.click('#signout'); // the dialog stays open, on the sign-in form
  await page.click('#account-tab-signin');
  await page.fill('#signin-email', 'admin@terrax.test');
  await page.fill('#signin-password', 'e2e admin passphrase');
  await page.click('#signin-submit');
  await page.click('#account-button');
  await page.click('#account-tab-admin');
  await page.fill('#admin-audit-q', email);
  for (const action of ['auth.signup', 'auth.2fa_enabled', 'auth.login', 'auth.sessions_ended']) await expect(page.locator('#admin-audit')).toContainText(action);
  expect(await page.locator('#admin-audit').innerText()).not.toContain(recovery);
  expect(errors).toEqual([]);
});

test('links back from e-mail and single sign-on open the right form and leave the address bar clean', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/auth/reset', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, email: 'r@terrax.test' }) }));
  await page.goto('/?reset=the-token-from-the-mail');
  await expect(page.locator('#reset-password')).toBeVisible();
  expect(page.url()).not.toContain('the-token');
  const sent = page.waitForRequest(r => r.url().endsWith('/api/auth/reset'));
  await page.fill('#reset-password', 'a brand new passphrase');
  await page.click('#reset-submit');
  expect((await sent).postDataJSON()).toEqual({ token: 'the-token-from-the-mail', password: 'a brand new passphrase' });
  await expect(page.locator('.toast', { hasText: 'New password set for r@terrax.test' })).toBeVisible();
  await expect(page.locator('#signin-email')).toBeVisible();

  await page.goto('/?signin_error=That%20sign-in%20took%20too%20long');
  await expect(page.locator('.modal .notice')).toContainText('That sign-in took too long');
  expect(page.url()).not.toContain('signin_error');
  // A confirmation link that is no longer valid says so.
  await page.goto('/?verify=expired-token');
  await expect(page.locator('.modal .notice')).toContainText('not valid any more');
  expect(errors).toEqual([]);
});
