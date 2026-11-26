import { expect, test } from '@playwright/test';
import { openTool, start } from './helpers';

// 1×1 PNG for the imagery tiles: tests must not depend on the internet.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('forest loss: label the sample over imagery in the app, then the accuracy and the emissions summary', async ({ page }) => {
  const tiles: string[] = [];
  await page.route(/arcgisonline\.com|tiles\.maps\.eox\.at/, route => {
    tiles.push(route.request().url());
    return route.fulfill({ contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: PNG });
  });
  const errors = await start(page);
  await openTool(page, 'Forest loss');
  await page.click('summary:has-text("CO₂ emissions")');
  await page.check('#emissions-on');
  await page.fill('#emissions-agb', '250');
  await page.fill('#emissions-agb-ci', '50');
  await page.click('button:has-text("Try synthetic sample")');
  await expect(page.locator('#forest-emissions')).toBeVisible();
  await page.fill('#forest-sample-total', '40');
  await page.fill('#forest-sample-min', '8');
  await page.click('#forest-sample');
  await page.click('#forest-label-open');
  const progress = page.locator('#forest-label-progress');
  await expect(progress).toContainText('Point 1 of 40 · 0 labelled');
  await expect.poll(() => tiles.some(u => u.includes('World_Imagery'))).toBe(true);
  // The classes are offered as buttons, and the map's own class is not shown.
  const buttons = page.locator('.labeller-classes button');
  await expect(buttons.first()).toContainText('1 · ');
  await expect(page.locator('#forest-labeller')).not.toContainText('map class');
  // Label 10 points by keyboard (1 = the first class), skip one, and come back to the labels after closing the panel.
  for (let k = 0; k < 10; k++) await page.keyboard.press('1');
  await expect(progress).toContainText('10 labelled');
  await page.keyboard.press('0');
  await page.selectOption('#forest-label-imagery', 'eox-2016');
  await expect.poll(() => tiles.some(u => u.includes('s2cloudless-2016'))).toBe(true);
  await page.click('#forest-label-open');
  await page.click('#forest-label-open');
  await expect(progress).toContainText('10 labelled');
  await page.fill('#forest-period', '8');
  await page.click('#forest-label-assess');
  await expect(page.locator('.stat', { hasText: 'Reference points' })).toContainText('10 (30 unlabelled)');
  await expect(page.locator('#forest-accuracy')).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Emissions summary (Markdown)")')]);
  const md = await (await import('node:fs/promises')).readFile((await dl.path())!, 'utf8');
  expect(md).toContain('## 1. Activity data');
  expect(md).toContain('t CO₂/yr');
  expect(errors).toEqual([]);
});
