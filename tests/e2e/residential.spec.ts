import { expect, test } from '@playwright/test';
import { openTool, start } from './helpers';

test('residential plot: sample images reveal a neighbour extension across the boundary', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Residential plot');
  await page.click('button:has-text("Try synthetic plot")');
  await expect(page.locator('.tabular-view tbody tr')).toHaveCount(3);
  await expect(page.locator('.tabular-view td', { hasText: 'Current' })).toBeVisible();
  await page.click('#plot-run');
  const crossing = page.locator('.stat', { hasText: 'Crossing the boundary' }).locator('.stat-value');
  await expect(crossing).toContainText('1 patch');
  const m2 = Number((await crossing.innerText()).match(/([\d.]+) m² inside/)![1]);
  expect(m2).toBeGreaterThan(45);
  expect(m2).toBeLessThan(60);
  await expect(page.locator('.stat', { hasText: 'Deepest crossing' })).toContainText('m');
  await expect(page.locator('#plot-patches')).toContainText('Crosses the boundary');
  await expect(page.locator('#plot-patches')).toContainText('Thin strip along the line');
  await expect(page.locator('.report-card')).toContainText('not proof of encroachment');
  await expect(page.locator('.render-window', { hasText: 'each image compared' }).locator('svg.recharts-surface').first()).toBeVisible();
  await page.locator('#plot-swipe').fill('20');
  await expect(page.locator('.swipe-top')).toHaveAttribute('style', /inset\(0px 80% 0px 0px\)|inset\(0 80% 0 0\)/);
  await page.selectOption('#plot-base', '1'); // 2021 → 2024
  await expect(page.locator('.report-card')).toContainText('2021-02-14');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#plot-export')]);
  const fc = JSON.parse(Buffer.concat(await (await dl.createReadStream()).toArray()).toString('utf8'));
  expect(fc.features.length).toBeGreaterThan(0);
  expect(fc.features[0].geometry.type).toBe('MultiPolygon');
  await expect(page.locator('img.leaflet-image-layer')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('residential plot: same-view photos with a traced outline', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Residential plot');
  await page.click('button[role=radio]:has-text("Photos")');
  const jpg = async (extended: boolean) => {
    const b64 = await page.evaluate(ext => {
      const c = document.createElement('canvas');
      c.width = 400;
      c.height = 300;
      const g = c.getContext('2d')!;
      g.fillStyle = '#4f7a3a';
      g.fillRect(0, 0, 400, 300);
      g.fillStyle = '#9b4b3c';
      g.fillRect(90, 90, 80, 60); // own house
      g.fillStyle = '#8f96a3';
      g.fillRect(300, 80, 80, 90); // neighbour house
      if (ext) g.fillRect(230, 100, 70, 50); // extension reaching 30 px past the boundary at x = 260
      return c.toDataURL('image/png').split(',')[1];
    }, extended);
    return Buffer.from(b64, 'base64');
  };
  await page.setInputFiles('#plot-images', [
    { name: 'view_2020-01-01.png', mimeType: 'image/png', buffer: await jpg(false) },
    { name: 'view_2024-01-01.png', mimeType: 'image/png', buffer: await jpg(true) },
  ]);
  const svg = page.locator('.trace-svg');
  const box = (await svg.boundingBox())!;
  // Plot corners at image pixels (40, 40), (260, 40), (260, 260), (40, 260).
  for (const [x, y] of [[40, 40], [260, 40], [260, 260], [40, 260]]) await svg.click({ position: { x: (x / 400) * box.width, y: (y / 300) * box.height } });
  await expect(page.locator('.sub-panel .eyebrow', { hasText: 'Trace your plot' })).toContainText('4 corners');
  await page.fill('#plot-ground-width', '40'); // 0.1 m per pixel
  await page.click('#plot-run');
  const crossing = page.locator('.stat', { hasText: 'Crossing the boundary' }).locator('.stat-value');
  await expect(crossing).toContainText('1 patch');
  // Inside part: 30 px × 50 px at 0.1 m = 15 m²; depth 3 m.
  const m2 = Number((await crossing.innerText()).match(/([\d.]+) m² inside/)![1]);
  expect(Math.abs(m2 - 15)).toBeLessThan(1.5);
  const depth = Number((await page.locator('.stat', { hasText: 'Deepest crossing' }).locator('.stat-value').innerText()).match(/[\d.]+/)![0]);
  expect(Math.abs(depth - 3)).toBeLessThan(0.3);
  expect(errors).toEqual([]);
});
