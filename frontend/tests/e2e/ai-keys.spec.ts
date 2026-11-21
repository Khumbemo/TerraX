import { expect, test } from '@playwright/test';
import { chat, start } from './helpers';

// AI keys from any provider (Settings → AI). The server's key check and the AI answer are stood in for, so no real key
// or provider is needed; the backend's own tests cover the providers (tests/test_llm.py).

test('AI keys: an old Gemini key carries over, a new key is recognised, and keys go with each request in order', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('terrax_ai_keys')) {
      localStorage.setItem('terrax_api_key', 'AIzaOldBrowserKey000000000000000000000');
      localStorage.setItem('terrax_model', 'gemini-2.5-pro');
    }
  });
  const checked: string[] = [];
  await page.route('**/api/agents/detect', async route => {
    checked.push(route.request().headers()['x-ai-key'] ?? '');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'groq', name: 'Groq', kind: 'openai', search: false, models: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'], model: 'llama-3.3-70b-versatile', baseUrl: '' }),
    });
  });
  const sent: { provider: string; model: string }[][] = [];
  await page.route('**/api/agents/chat', async route => {
    const header = route.request().headers()['x-ai-credentials'] ?? '';
    const json = Buffer.from(header.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    sent.push((JSON.parse(json) as { provider: string; model: string }[]).map(c => ({ provider: c.provider, model: c.model })));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ text: 'Answered by Groq.', sources: [], suggestions: [], state: {}, engine: 'groq', providerName: 'Groq', model: 'llama-3.3-70b-versatile' }) });
  });

  const errors = await start(page);
  await page.click('#nav-settings');
  const rows = page.locator('#ai-keys li');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Google Gemini');
  await expect(rows.first()).not.toContainText('AIzaOldBrowserKey000000000000000000000'); // masked
  await expect(page.locator('#ai-model-0')).toHaveValue('gemini-2.5-pro');

  await page.fill('#api-key', 'gsk_newKeyForTesting000000000000000');
  await page.click('#ai-add');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText('Groq');
  expect(checked).toEqual(['gsk_newKeyForTesting000000000000000']);
  await expect(page.locator('#ai-model-1')).toHaveValue('llama-3.3-70b-versatile');
  await page.selectOption('#ai-model-1', 'llama-3.1-8b-instant');
  await page.click('button[aria-label="Use Groq first"]');
  await expect(rows.first()).toContainText('Groq');
  await page.keyboard.press('Escape');

  expect(await chat(page, 'guide-chat', 'what is ndvi?')).toContain('Answered by Groq.');
  expect(sent.at(-1)).toEqual([{ provider: 'groq', model: 'llama-3.1-8b-instant' }, { provider: 'gemini', model: 'gemini-2.5-pro' }]);
  // Nothing of the old single-key storage is left behind.
  expect(await page.evaluate(() => [localStorage.getItem('terrax_api_key'), localStorage.getItem('terrax_model')])).toEqual([null, null]);

  // Removing both keys turns AI back to the server's key or off.
  await page.click('#nav-settings');
  await rows.first().locator('button:has-text("Remove")').click();
  await rows.first().locator('button:has-text("Remove")').click();
  await expect(rows).toHaveCount(0);
  expect(errors).toEqual([]);
});
