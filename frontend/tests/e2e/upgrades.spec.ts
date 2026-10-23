import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { exifTiff, withExif } from '../fixtures/exif-builder';
import { mapState, openTool, start } from './helpers';

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
  const canvas = page.locator('img.raster-canvas.pickable');
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
  await expect.poll(() => mapState<number>(page, `m => m.getSource('tx-features') ? m.getSource('tx-features').serialize().data.features.length : 0`)).toBeGreaterThan(0);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#terrain-export-contours')]);
  expect(dl.suggestedFilename()).toMatch(/_contours_\d+m\.geojson$/);
  expect(errors).toEqual([]);
});

test('terrain: D∞ flow adds a wetness index layer', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Terrain');
  await page.click('button:has-text("Try synthetic DEM")');
  await page.selectOption('#terrain-flow-method', 'dinf');
  await page.click('#terrain-flow');
  await expect(page.locator('.stat', { hasText: 'Median wetness index' })).toBeVisible();
  await page.click('[role="tab"]:has-text("Wetness (TWI)")');
  await expect(page.locator('figcaption .legend-labels')).toContainText('ln(a / tan β)');
  await expect(page.locator('img.raster-canvas')).toHaveAttribute('src', /wetness\.png/);
  await expect(page.locator('.report-card')).toContainText('Topographic wetness index');
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
  await expect.poll(() => mapState<number>(page, `m => m.getSource('tx-features') ? m.getSource('tx-features').serialize().data.features.length : 0`)).toBe(1);
  const cover = await page.locator('.stat', { hasText: 'Vegetation cover' }).locator('.stat-value').innerText();
  expect(Number(cover.replace('%', ''))).toBeGreaterThan(40);

  await page.setInputFiles('#photo-compare', { name: 'later.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') });
  await expect(page.locator('#photo-compare-stats')).toContainText('0.0 pp');
  await expect(page.locator('.report-card')).toContainText('Compared with later.jpg');
  expect(errors).toEqual([]);
});

test('satellite: pixel inspector, stretch and a multi-date series', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Satellite imagery');
  await page.click('button.chip:has-text("Synthetic 4-band scene")');
  const preview = page.locator('.raster-grid img.raster-canvas');
  await expect(preview).toBeVisible();
  await preview.click({ position: { x: 20, y: 20 } });
  await expect(page.locator('#pixel-inspector')).toContainText('B4');
  await expect(page.locator('#pixel-inspector')).toContainText('25.');
  await page.locator('summary', { hasText: 'Band roles' }).click();
  await page.click('button:has-text("True colour")');
  await expect(page.locator('figcaption', { hasText: 'True colour' })).toContainText('2–98 %');
  await page.fill('#stretch-lo', '5');
  await page.fill('#stretch-hi', '95');
  await page.click('button:has-text("Apply stretch")');
  await expect(page.locator('figcaption', { hasText: 'True colour' })).toContainText('5–95 %');
  await expect(page.locator('#qa-band')).toBeVisible();

  await page.click('button:has-text("Try synthetic 6-date series")');
  await expect(page.locator('#stack-trend')).toContainText('decreasing');
  await expect(page.locator('.report-card')).toContainText('6 images, 2019-03-10 to 2024-03-11');
  expect(errors).toEqual([]);
});

test('series: per-pixel disturbance dates for a clearing front', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Satellite imagery');
  // The synthetic series clears 4 columns × 50 rows (200 px of 30 m) a year from the east edge. With two clear dates
  // needed on each side of a drop, the 2021, 2022 and 2023 fronts can be dated: 18 ha each.
  await page.check('#stack-breaks');
  await page.click('button:has-text("Try synthetic 6-date series")');
  await expect(page.locator('#stack-breaks-table tbody tr')).toHaveCount(3);
  await expect(page.locator('#stack-breaks-table')).toContainText('2021-03-09');
  await expect(page.locator('#stack-breaks-total')).toContainText('54 ha');
  await expect(page.locator('.report-card')).toContainText('Disturbances (per pixel)');
  expect(errors).toEqual([]);
});

test('land cover: radar separates classes the optical bands cannot', async ({ page }) => {
  const errors = await start(page);
  // Forest and plantation with the same optical spectra but VH 6 dB apart (the API test checks the accuracies in detail).
  const dir = mkdtempSync(join(tmpdir(), 'terrax-fuse-'));
  const [opt, s1, train] = ['optical.tif', 's1.tif', 'train.geojson'].map(n => join(dir, n));
  execFileSync('python3', ['-c', `
import json, numpy as np, rasterio
from pyproj import Transformer
from rasterio.transform import from_origin
rng = np.random.default_rng(12); E0, N0, n = 600000.0, 2850000.0, 120
pl = np.arange(n)[None, :].repeat(n, 0) >= n // 2
o = np.stack([v + rng.normal(0, s, (n, n)) for v, s in ((0.03, 0.004), (0.06, 0.006), (0.04, 0.005), (0.32, 0.02))]).astype(np.float32)
vh = np.where(pl, -20.0, -14.0) + rng.normal(0, 1, (n, n)); vv = vh + 7 + rng.normal(0, 0.8, (n, n))
for path, data in ((${JSON.stringify(opt)}, o), (${JSON.stringify(s1)}, np.stack([vv, vh]).astype(np.float32))):
    with rasterio.open(path, 'w', driver='GTiff', width=n, height=n, count=data.shape[0], dtype='float32', crs='EPSG:32646', transform=from_origin(E0, N0, 10, 10), nodata=float('nan')) as d:
        d.write(data)
t = Transformer.from_crs(32646, 4326, always_xy=True); feats = []
for k, (r0, c0) in enumerate([(10, 10), (60, 15), (95, 30), (10, 70), (55, 85), (95, 100)]):
    x0, y1 = E0 + c0 * 10, N0 - r0 * 10
    ring = [list(t.transform(x, y)) for x, y in [(x0, y1), (x0 + 150, y1), (x0 + 150, y1 - 150), (x0, y1 - 150), (x0, y1)]]
    feats.append({'type': 'Feature', 'properties': {'class': 'Forest' if k < 3 else 'Plantation'}, 'geometry': {'type': 'Polygon', 'coordinates': [ring]}})
json.dump({'type': 'FeatureCollection', 'features': feats}, open(${JSON.stringify(train)}, 'w'))
`]);
  await openTool(page, 'Land cover');
  await page.selectOption('#landcover-method', 'rf');
  // Dropped one after another without waiting: none of the uploads may cancel another.
  await page.setInputFiles('#landcover-file', opt);
  await page.setInputFiles('#landcover-radar', s1);
  await page.setInputFiles('#landcover-training', train);
  await expect(page.locator('#landcover-run')).toBeEnabled();
  await page.click('#landcover-run');
  await expect(page.locator('.stat', { hasText: 'Cross-validated by shape' })).toContainText('100.0 %');
  await expect(page.locator('.report-card')).toContainText('Radar features from s1.tif');
  expect(errors).toEqual([]);
});

test('land cover: random forest from training shapes, validation sample and accuracy', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Land cover');
  await page.selectOption('#landcover-method', 'rf');
  await page.click('button:has-text("Try synthetic scene")');
  await expect(page.locator('.stat', { hasText: 'Cross-validated by shape' })).toBeVisible();
  await expect(page.locator('#landcover-label-1')).toHaveValue('Built-up');
  await page.fill('#landcover-sample-total', '90');
  await page.fill('#landcover-sample-min', '20');
  await page.click('#landcover-sample');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Validation sample (CSV)")')]);
  const csv = await (await import('node:fs/promises')).readFile((await dl.path())!, 'utf8');
  // Label every point from the scene's true geometry (scripts/make_samples.py): river, town, forest.
  const [head, ...lines] = csv.trim().split(/\r?\n/); // RFC 4180 CSV ends lines with CRLF
  const cols = head.split(',');
  const at = (name: string) => cols.indexOf(name);
  const labelled = [head, ...lines.map(l => {
    const v = l.split(',');
    const x = Number(v[at('col')]) + 0.5, y = Number(v[at('row')]) + 0.5;
    v[at('reference')] = Math.abs(x - 60 - y * 0.2) < 4 ? 'Water' : (x - 200) ** 2 + (y - 40) ** 2 < 22 ** 2 ? 'Built-up' : 'Forest';
    return v.join(',');
  })].join('\n');
  expect(lines).toHaveLength(90);
  await page.setInputFiles('#landcover-reference', { name: 'labelled.csv', mimeType: 'text/csv', buffer: Buffer.from(labelled) });
  await expect(page.locator('#landcover-accuracy tbody tr')).toHaveCount(3);
  await expect(page.locator('.stat', { hasText: 'Overall accuracy' })).toContainText('%');
  await expect(page.locator('.report-card')).toContainText('Accuracy and area (stratified sample)');
  expect(errors).toEqual([]);
});

test('land cover: classify, rename a class and export', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Land cover');
  await page.click('button:has-text("Try synthetic scene")');
  await expect(page.locator('.tabular-view tbody tr')).toHaveCount(5);
  await expect(page.locator('#landcover-label-1')).toHaveValue('Water (suggested)');
  await page.fill('#landcover-label-1', 'River');
  await expect(page.locator('.report-card table')).toContainText('River');
  await page.fill('#landcover-k', '3');
  await page.click('#landcover-run');
  await expect(page.locator('.tabular-view tbody tr')).toHaveCount(3);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Export class table")')]);
  expect(dl.suggestedFilename()).toBe('satellite_4band_synthetic_landcover_classes.csv');
  await expect.poll(() => mapState<boolean>(page, `m => !!m.getLayer('tx-image-r')`)).toBe(true);
  expect(errors).toEqual([]);
});

test('radar: speckle-filtered Sentinel-1 pair maps the clearing', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Radar (Sentinel-1)');
  await page.click('button:has-text("Try synthetic pair")');
  await expect(page.locator('.stat', { hasText: 'VH decrease' })).toContainText('ha');
  const ha = Number((await page.locator('.stat', { hasText: 'VH decrease' }).locator('.stat-value').innerText()).split(' ')[0]);
  expect(ha).toBeGreaterThan(25);
  expect(ha).toBeLessThan(35); // the 600 m × 500 m clearing is 30 ha
  await expect(page.locator('#radar-vh')).toHaveValue('1');
  await expect(page.locator('.report-card')).toContainText('Lee (1980)');
  await page.click('[role="tab"]:has-text("False colour")');
  await expect(page.locator('img.raster-canvas')).toHaveAttribute('src', /composite\.png/);
  expect(errors).toEqual([]);
});

test('canopy: LiDAR point cloud gives height, cover and tree tops', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Canopy height');
  await page.click('button:has-text("Try synthetic LiDAR")');
  await expect(page.locator('.stat', { hasText: 'Tree tops' })).toContainText('25');
  await expect(page.locator('.stat', { hasText: 'Canopy cover' })).toContainText('%');
  await expect(page.locator('.report-card')).toContainText('Popescu & Wynne');
  await expect.poll(() => mapState<number>(page, `m => m.getSource('tx-features') ? m.getSource('tx-features').serialize().data.features.length : 0`)).toBe(25);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Export canopy height model")')]);
  expect(dl.suggestedFilename()).toBe('chm.tif');
  expect(errors).toEqual([]);
});

test('canopy: field plots with biomass give a biomass and carbon estimate with an interval', async ({ page }) => {
  const errors = await start(page);
  // A 1 m CHM of 25 m stands and 30 plots of 25 m whose biomass follows AGB = 4.5 · TCH^1.3 (the API test checks the fit).
  const dir = mkdtempSync(join(tmpdir(), 'terrax-agb-'));
  const chm = join(dir, 'chm.tif');
  const plots = join(dir, 'plots.geojson');
  execFileSync('python3', ['-c', `
import json, numpy as np, rasterio
from pyproj import Transformer
from rasterio.transform import from_origin
rng = np.random.default_rng(8); E0, N0, s, n = 600000.0, 2850000.0, 25, 12
h = rng.uniform(4, 30, (n, n)); c = np.maximum(np.kron(h, np.ones((s, s))) + rng.normal(0, 1, (n * s, n * s)), 0).astype(np.float32)
with rasterio.open(${JSON.stringify(chm)}, 'w', driver='GTiff', width=n * s, height=n * s, count=1, dtype='float32', crs='EPSG:32646', transform=from_origin(E0, N0, 1, 1), nodata=float('nan')) as d:
    d.write(c, 1)
t = Transformer.from_crs(32646, 4326, always_xy=True); feats = []
for k in rng.choice(n * n, 30, replace=False):
    i, j = divmod(int(k), n); x0, y1 = E0 + j * s, N0 - i * s
    ring = [list(t.transform(x, y)) for x, y in [(x0, y1), (x0 + s, y1), (x0 + s, y1 - s), (x0, y1 - s), (x0, y1)]]
    tch = float(c[i * s:(i + 1) * s, j * s:(j + 1) * s].mean())
    feats.append({'type': 'Feature', 'properties': {'agb': 4.5 * tch ** 1.3 * float(np.exp(rng.normal(0, 0.15)))}, 'geometry': {'type': 'Polygon', 'coordinates': [ring]}})
json.dump({'type': 'FeatureCollection', 'features': feats}, open(${JSON.stringify(plots)}, 'w'))
`]);
  await openTool(page, 'Canopy height');
  await page.selectOption('#canopy-source', 'chm');
  await page.setInputFiles('#canopy-chm', chm);
  await page.setInputFiles('#canopy-plots', plots);
  await expect(page.locator('#canopy-agb-field')).toBeVisible();
  await page.click('#canopy-run');
  await expect(page.locator('.stat', { hasText: 'Above-ground biomass (30 plots)' })).toContainText('95 % CI');
  await expect(page.locator('.stat', { hasText: 'Carbon' })).toContainText('Mg CO₂e');
  await expect(page.locator('.report-card')).toContainText('Asner & Mascaro');
  expect(errors).toEqual([]);
});

test('forest loss: stratified sample gives the loss area with a confidence interval', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Forest loss');
  await page.click('button:has-text("Try synthetic sample")');
  await expect(page.locator('.result-block .stat-grid').first()).toContainText('Forest loss');
  await page.fill('#forest-sample-total', '120');
  await page.fill('#forest-sample-min', '25');
  await page.click('#forest-sample');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Validation sample (CSV)")')]);
  const csv = await (await import('node:fs/promises')).readFile((await dl.path())!, 'utf8');
  const [head, ...lines] = csv.trim().split(/\r?\n/);
  const cols = head.split(',');
  // The map is right except that two stable-forest points were in fact cleared.
  let missed = 0;
  const labelled = [head, ...lines.map(l => {
    const v = l.split(',');
    const map = v[cols.indexOf('map_class')];
    const ref = map === 'Stable forest' && missed < 2 ? (missed++, 'Forest loss') : map;
    v[cols.indexOf('reference')] = ref;
    return v.join(',');
  })].join('\n');
  expect(lines).toHaveLength(120);
  await page.setInputFiles('#forest-reference', { name: 'labelled.csv', mimeType: 'text/csv', buffer: Buffer.from(labelled) });
  const loss = page.locator('#forest-accuracy tbody tr', { hasText: 'Forest loss' });
  await expect(loss).toContainText('±');
  await expect(page.locator('.report-card')).toContainText('Accuracy and area (stratified sample)');
  expect(errors).toEqual([]);
});
