import { expect, test } from '@playwright/test';
import { backToTools, openTool, start } from './helpers';

// The monitor API answers from fixed data here (the backend tests run the real checks against a stand-in catalogue),
// so this checks the panel: who may use it, what it sends, and how monitors and alerts show.
test('forest loss: watch the analysis boundary for new loss', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Forest loss');
  await page.click('summary:has-text("Watch this area for new loss")');
  await expect(page.locator('details', { hasText: 'Watch this area for new loss' })).toContainText('Sign in');
  await backToTools(page);

  // An account, then the sample plot as the analysis boundary.
  await page.click('#account-button');
  await page.click('#account-tab-signup');
  await page.fill('#signup-email', `watch.${Date.now()}@terrax.test`);
  await page.fill('#signup-password', 'correct horse battery');
  await page.click('#signup-submit');
  await expect(page.locator('.toast', { hasText: 'Account created' })).toBeVisible();
  await openTool(page, 'Land survey');
  await page.click('button:has-text("Try sample plot")');
  await page.click('#use-boundary');
  await backToTools(page);

  const alert = { id: 'a'.repeat(32), firstSeen: '2026-10-02', confirmed: '2026-10-07', areaHa: 6.04, patches: 2, emailed: true };
  const monitor = {
    id: 'm'.repeat(32), name: 'Sample plot A', active: true, email: true, status: 'Checked 2 new scenes up to 2026-10-07: 1 new alert (6.04 ha).',
    lastChecked: 1_790_000_000, nextCheck: 1_790_086_400, settings: { forestNdvi: 0.5, drop: 0.25, minAreaHa: 1, maxCloud: 40, checkHours: 24 },
  };
  let created: { name: string; geojson: { features: unknown[] }; settings: { drop: number; minAreaHa: number; radar?: number; vhDrop?: number } } | null = null;
  await page.route('**/api/monitors**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'POST' && url.pathname === '/api/monitors') {
      created = JSON.parse(req.postData() ?? '{}');
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ...monitor, alerts: [alert] }) });
    }
    if (req.method() === 'GET' && url.pathname === '/api/monitors') {
      const list = created ? [{ ...monitor, alertCount: 1 }] : [];
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ monitors: list, canEmail: true, limit: 10 }) });
    }
    if (req.method() === 'GET' && url.pathname === `/api/monitors/${monitor.id}`) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...monitor, alerts: [alert] }) });
    return route.fallback();
  });

  await openTool(page, 'Forest loss');
  await page.click('summary:has-text("Watch an area for new loss")');
  await expect(page.locator('#monitor-panel')).toContainText('analysis boundary “Sample plot A (fictional)”');
  await page.fill('#monitor-drop', '0.25');
  await expect(page.locator('#monitor-radar')).toBeChecked();
  await page.fill('#monitor-vh-drop', '4');
  await page.fill('#monitor-min-area', '1');
  await page.click('#monitor-create');
  await expect(page.locator('.toast', { hasText: 'Watching “Sample plot A”' })).toBeVisible();
  expect(created!.name).toBe('Sample plot A (fictional)');
  expect(created!.geojson.features.length).toBeGreaterThan(0);
  expect(created!.settings).toEqual({ drop: 0.25, minAreaHa: 1, radar: 1, vhDrop: 4 });
  await expect(page.locator('#monitor-list')).toContainText('1 new alert (6.04 ha)');
  await expect(page.locator('#monitor-alerts')).toContainText('2026-10-07');
  await expect(page.locator('#monitor-alerts')).toContainText('6.04');
  await expect(page.locator('#monitor-alerts a', { hasText: 'GeoJSON' })).toHaveAttribute('href', `/api/monitors/${monitor.id}/alerts/${alert.id}.geojson`);
  expect(errors).toEqual([]);
});
