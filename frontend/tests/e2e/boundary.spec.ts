import { expect, test } from '@playwright/test';
import { backToTools, mapState, openTool, start } from './helpers';

test('analysis boundary clips the forest analysis and can be cleared', async ({ page }) => {
  const errors = await start(page);

  await openTool(page, 'Forest loss');
  await page.click('button:has-text("Try synthetic sample")');
  const lossStat = page.locator('.stat', { hasText: 'Forest loss' }).locator('.stat-value');
  await expect(lossStat).toContainText('ha');
  const fullLoss = await lossStat.innerText();
  await backToTools(page);

  await openTool(page, 'Land survey');
  await page.click('button:has-text("Try sample plot")');
  await page.click('#use-boundary');
  await expect(page.locator('.boundary-banner')).toContainText('Sample plot A');
  await expect(page.locator('#use-boundary')).toHaveText('Is the analysis boundary');
  await backToTools(page);

  await openTool(page, 'Terrain');
  await page.click('button:has-text("Try synthetic DEM")');
  await expect(page.locator('.report-card')).toContainText('Limited to the analysis boundary');
  await backToTools(page);
  await openTool(page, 'Satellite imagery');
  await page.click('button.chip:has-text("Synthetic 4-band scene")');
  await expect(page.locator('.report-card')).toContainText('Limited to the analysis boundary');
  await backToTools(page);

  await openTool(page, 'Forest loss');
  await expect(page.locator('.boundary-banner')).toContainText('Only pixels inside it are analysed');
  await page.click('button:has-text("Try synthetic sample")');
  await expect(page.locator('.report-card')).toContainText('Limited to the analysis boundary');
  const clippedLoss = await lossStat.innerText();
  expect(clippedLoss).not.toEqual(fullLoss);
  const ha = (s: string) => Number(s.replace(/,/g, '').match(/([\d.]+) ha/)![1]);
  expect(ha(clippedLoss)).toBeGreaterThan(0);
  expect(ha(clippedLoss)).toBeLessThan(ha(fullLoss));

  // Clearing the boundary re-runs the analysis over the whole image.
  await page.click('#boundary-clear');
  await expect(page.locator('.boundary-banner')).toHaveCount(0);
  await expect(lossStat).toHaveText(fullLoss);
  await expect(page.locator('.report-card')).not.toContainText('Limited to the analysis boundary');
  expect(errors).toEqual([]);
});

test('draw, edit and export a plot on the map', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Land survey');
  await page.click('#draw-start');
  const map = page.locator('.maplibregl-canvas');
  await expect(map).toHaveCSS('cursor', 'crosshair');
  await map.click({ position: { x: 80, y: 120 } });
  await map.click({ position: { x: 220, y: 110 } });
  await map.click({ position: { x: 300, y: 300 } });
  await expect(page.locator('.draw-bar')).toContainText('3 so far');
  await page.click('.draw-bar button:has-text("Undo")');
  await expect(page.locator('.draw-bar')).toContainText('2 so far');
  await expect(page.locator('#draw-finish')).toBeDisabled();
  await map.click({ position: { x: 200, y: 300 } });
  await page.click('#draw-finish');
  await expect(page.locator('.draw-bar')).toHaveCount(0);
  const card = page.locator('.feature-card').first();
  await expect(card.locator('h3')).toHaveText('Drawn plot');
  const areaBefore = await card.locator('.stat', { hasText: 'Area' }).innerText();

  // Edit: drag a vertex and finish again; the area changes.
  await page.click('#edit-vertices');
  const handles = page.locator('.vertex-handle');
  await expect(handles).toHaveCount(3);
  const box = (await handles.nth(2).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 20, { steps: 8 });
  await page.mouse.up();
  await page.click('#draw-finish');
  await expect(card.locator('h3')).toHaveText('Drawn plot');
  await expect(card.locator('.stat', { hasText: 'Area' })).not.toHaveText(areaBefore);

  const [geo] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("GeoJSON")')]);
  expect(geo.suggestedFilename()).toBe('Drawn_plot.geojson');
  const fc = JSON.parse(await (await geo.createReadStream()).toArray().then(c => Buffer.concat(c).toString('utf8')));
  expect(fc.features[0].geometry.type).toBe('Polygon');
  expect(fc.features[0].geometry.coordinates[0]).toHaveLength(4);
  const [kml] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("KML")')]);
  expect(kml.suggestedFilename()).toBe('Drawn_plot.kml');
  const [gpx] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("GPX")')]);
  expect(gpx.suggestedFilename()).toBe('Drawn_plot.gpx');
  expect(errors).toEqual([]);
});

test('map layers panel: result overlay, opacity and legend', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Terrain');
  await page.click('button:has-text("Try synthetic DEM")');
  await expect(page.locator('.report-card')).toContainText('Hypsometric integral');
  const overlay = () => mapState<{ shown: boolean; opacity: number } | null>(page, `m => m.getLayer('tx-image-r') ? { shown: true, opacity: m.getPaintProperty('tx-image-r', 'raster-opacity') } : { shown: false, opacity: 0 }`);
  await expect.poll(async () => (await overlay())?.shown).toBe(true);
  await page.click('.map-layers-toggle');
  const panel = page.locator('#map-layers-panel');
  await expect(panel).toContainText('Slope classes');
  await expect(panel.locator('.map-legend')).toContainText('Steep (15–30°)');
  await page.locator('#layer-opacity').fill('0.4');
  await expect.poll(async () => (await overlay())?.opacity).toBe(0.4);
  await page.uncheck('#layer-image');
  await expect.poll(async () => (await overlay())?.shown).toBe(false);
  await page.check('#layer-image');
  await expect.poll(async () => (await overlay())?.shown).toBe(true);
  expect(errors).toEqual([]);
});
