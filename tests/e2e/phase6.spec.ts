import { expect, test } from '@playwright/test';
import { backToTools, openTool, start } from './helpers';

const bytes = async (dl: import('@playwright/test').Download) => Buffer.concat(await (await dl.createReadStream()).toArray());

test('PDF report includes figures, and saved reports keep them', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Forest loss');
  await page.click('button:has-text("Try synthetic sample")');
  await expect(page.locator('.report-card')).toContainText('Method and limits');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.report-card button:has-text("PDF")')]);
  const pdf = (await bytes(dl)).toString('latin1');
  expect(pdf.startsWith('%PDF')).toBe(true);
  expect((pdf.match(/\/Subtype \/Image/g) ?? []).length).toBe(1); // the change map (NDVI mode draws no chart)
  await page.click('.report-card button:has-text("Save to Reports")');
  await page.click('#nav-reports');
  await expect(page.locator('.report-figures img').first()).toBeVisible();
  await expect(page.locator('.report-figures figcaption').first()).toContainText('Map: Forest change');

  // A chart-only tool: the weather time series is captured from its SVG.
  await page.click('button:has-text("Tools")'); // back to the open Forest loss tool
  await backToTools(page);
  await openTool(page, 'Weather & climate');
  await page.click('button.chip:has-text("Rainfall")');
  await expect(page.locator('.tool-workspace svg.recharts-surface').first()).toBeVisible();
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('.report-card button:has-text("PDF")')]);
  const pdf2 = (await bytes(dl2)).toString('latin1');
  expect((pdf2.match(/\/Subtype \/Image/g) ?? []).length).toBeGreaterThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('project export and import restore boundary and reports', async ({ page, browser }) => {
  const errors = await start(page);
  await openTool(page, 'Land survey');
  await page.click('button:has-text("Try sample plot")');
  await page.click('#use-boundary');
  await page.click('.report-card button:has-text("Save to Reports")');
  await page.click('#nav-reports');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#project-export')]);
  expect(dl.suggestedFilename()).toMatch(/^TerraX_project_\d{4}-\d{2}-\d{2}\.terrax\.json$/);
  const file = await bytes(dl);
  const json = JSON.parse(file.toString('utf8'));
  expect(json.format).toBe('terrax-project');
  expect(JSON.stringify(json)).not.toContain('api_key');

  // A fresh browser profile: import the file and get the boundary and report back.
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await start(p2);
  await p2.click('#nav-reports');
  await p2.setInputFiles('#project-import', { name: 'p.terrax.json', mimeType: 'application/json', buffer: file });
  await expect(p2.locator('.toast')).toContainText('Project imported: 1 new report, analysis boundary');
  await expect(p2.locator('.report-list-item')).toHaveCount(1);
  await p2.click('button:has-text("Tools")');
  await openTool(p2, 'Terrain');
  await expect(p2.locator('.boundary-banner')).toContainText('Sample plot A');
  await p2.click('#nav-reports');
  await p2.setInputFiles('#project-import', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"a":1}') });
  await expect(p2.locator('.toast-error')).toContainText('not a TerraX project file');
  await ctx.close();
  expect(errors).toEqual([]);
});

test('display preferences: light theme, imperial units, Hindi and the tour', async ({ page }) => {
  const errors = await start(page);
  await page.click('#nav-settings');
  await page.selectOption('#pref-theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(244, 246, 249)');
  await page.selectOption('#pref-units', 'imperial');
  await page.selectOption('#pref-lang', 'hi');
  await expect(page.locator('#nav-settings')).toHaveText('सेटिंग्स');
  await page.click('#start-tour');
  await expect(page.locator('.tour-card h3')).toHaveText('एक टूल चुनें');
  for (let i = 0; i < 4; i++) await page.click('#tour-next');
  await expect(page.locator('.tour-card h3')).toHaveText('सेटिंग्स');
  await page.click('#tour-next');
  await expect(page.locator('.tour-card')).toHaveCount(0);
  await expect(page.locator('.tool-card[data-name="Land survey"] .tool-name')).toHaveText('भूमि सर्वेक्षण');
  await page.click('.tool-card[data-name="Land survey"]');
  await page.click('button:has-text("Try sample plot")');
  await expect(page.locator('.stat', { hasText: 'Area' }).first()).toContainText('acres');
  // Preferences persist across a reload.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('#nav-settings')).toHaveText('सेटिंग्स');
  expect(errors).toEqual([]);
});

test('survey: declination gives magnetic bearings; a GPX track has an elevation profile', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Land survey');
  const pts = Array.from({ length: 12 }, (_, i) => `<trkpt lat="${25.67 + i * 0.0005}" lon="${94.1 + i * 0.0004}"><ele>${1400 + i * 8 + (i % 2) * 2}</ele></trkpt>`).join('');
  await page.setInputFiles('#survey-file', { name: 'climb.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(`<?xml version="1.0"?><gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Climb</name><trkseg>${pts}</trkseg></trk></gpx>`) });
  await expect(page.locator('.elevation-profile')).toContainText('ascent');
  await expect(page.locator('.elevation-profile svg.recharts-surface')).toBeVisible();
  await page.fill('#survey-declination', '-1.5');
  await expect(page.locator('.tool-body th', { hasText: 'Bearing (magnetic)' })).toBeVisible();
  await expect(page.locator('.report-card')).toContainText('1.5° west');
  expect(errors).toEqual([]);
});

test('installed app works offline after one visit', async ({ page, context }) => {
  const errors = await start(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // Let the worker finish precaching, then go offline and reload.
  await expect.poll(async () => page.evaluate(async () => (await caches.keys()).includes('terrax-v1') && (await (await caches.open('terrax-v1')).keys()).length), { timeout: 20_000 }).toBeGreaterThan(20);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.tool-card').first()).toBeVisible();
  await openTool(page, 'Land cover'); // a lazily loaded tool, never opened online
  await backToTools(page);
  await context.setOffline(false);
  expect(errors).toEqual([]);
});
