import { expect, test } from '@playwright/test';
import { exifTiff, withExif } from '../fixtures/exif-builder';
import { openTool, start } from './helpers';

test('forest: burn severity, minimum mapping unit and polygon export', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Forest loss');
  await page.fill('#forest-mmu', '0.5');
  await page.click('button:has-text("Try synthetic sample")');
  await expect(page.locator('.report-card')).toContainText('Minimum mapping unit 0.5 ha');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#forest-export-polygons')]);
  expect(dl.suggestedFilename()).toMatch(/_loss_patches\.geojson$/);
  const fc = JSON.parse(Buffer.concat(await (await dl.createReadStream()).toArray()).toString('utf8'));
  expect(fc.features.length).toBeGreaterThan(0);
  expect(fc.features.every((f: { properties: { area_ha: number } }) => f.properties.area_ha >= 0.5)).toBe(true);

  await page.click('button[role=radio]:has-text("Burn severity")');
  await page.click('button:has-text("Try synthetic sample")');
  await expect(page.locator('.stat', { hasText: 'Burned area' })).toContainText('ha');
  await expect(page.locator('.report-card')).toContainText('Key & Benson 2006');
  await expect(page.locator('.legend-row')).toContainText('High severity');
  expect(errors).toEqual([]);
});

test('terrain: streams, watershed boundary and contours', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Terrain');
  await page.click('button:has-text("Try synthetic DEM")');
  await page.click('#terrain-flow');
  await expect(page.locator('.stat', { hasText: 'Highest stream order' })).toBeVisible();
  const order = Number(await page.locator('.stat', { hasText: 'Highest stream order' }).locator('.stat-value').innerText());
  expect(order).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.report-card')).toContainText('Strahler');
  // Pick outlets along the bottom edge until one drains a sizeable basin.
  const canvas = page.locator('canvas.raster-canvas.pickable');
  const box = (await canvas.boundingBox())!;
  const area = page.locator('.stat', { hasText: 'Watershed area' }).locator('.stat-value');
  let km2 = 0;
  for (const fx of [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7]) {
    await canvas.click({ position: { x: box.width * fx, y: box.height - 2 } });
    await expect(area).toContainText('km²');
    km2 = Number((await area.innerText()).replace(/[^\d.]/g, ''));
    if (km2 > 2) break;
  }
  expect(km2).toBeGreaterThan(2);
  await page.click('#watershed-boundary');
  await expect(page.locator('.boundary-banner')).toContainText('Watershed of');
  await expect(page.locator('.report-card')).toContainText('Limited to the analysis boundary');

  await page.check('#terrain-contours');
  await expect(page.locator('.leaflet-overlay-pane path.leaflet-interactive').first()).toBeAttached();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#terrain-export-contours')]);
  expect(dl.suggestedFilename()).toMatch(/_contours_\d+m\.geojson$/);
  expect(errors).toEqual([]);
});

test('photos: EXIF location on the map and comparing two photos', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Space & aerial photos');
  // Draw a green-and-brown test image in the browser and encode it as JPEG.
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = 80;
    const g = c.getContext('2d')!;
    g.fillStyle = '#3f8f3a';
    g.fillRect(0, 0, 120, 80);
    g.fillStyle = '#8a6d4b';
    g.fillRect(70, 0, 50, 80);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  });
  const jpeg = withExif(Buffer.from(b64, 'base64'), exifTiff({ make: 'TestCam', model: 'X1', dateTime: '2025:03:14 10:22:05', lat: 25.6742, lon: 94.1086, alt: 1490 }));
  await page.setInputFiles('#photo-file', { name: 'plot.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await expect(page.locator('#photo-exif')).toContainText('Location from EXIF');
  await expect(page.locator('#photo-exif')).toContainText('2025-03-14');
  await expect(page.locator('.report-card')).toContainText('GPS 25.674200, 94.108600');
  await expect(page.locator('.leaflet-overlay-pane path.leaflet-interactive')).toHaveCount(1);
  const cover = await page.locator('.stat', { hasText: 'Vegetation cover' }).locator('.stat-value').innerText();
  expect(Number(cover.replace('%', ''))).toBeGreaterThan(40);

  await page.setInputFiles('#photo-compare', { name: 'later.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') });
  await expect(page.locator('#photo-compare-stats')).toContainText('0.0 pp');
  await expect(page.locator('.report-card')).toContainText('Compared with later.jpg');
  expect(errors).toEqual([]);
});
