import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { openTool, start } from './helpers';

test('water: a flood between two Landsat-like dates, cloud-masked from QA_PIXEL', async ({ page }) => {
  const errors = await start(page);
  // 100 × 100 px of 30 m, bands blue … SWIR2 and QA_PIXEL. A river in columns 40–49 widens to 30–59; rows 0–9 are
  // cloudy (QA bit 3) after. Expected: 81 ha of water on both dates and 162 ha of new water.
  const dir = mkdtempSync(join(tmpdir(), 'terrax-water-'));
  const [before, after] = ['before.tif', 'after.tif'].map(n => join(dir, n));
  execFileSync('python3', ['-c', `
import numpy as np, rasterio
from rasterio.transform import from_origin
def scene(path, cols, cloud):
    land, wet = {'green': 0.08, 'nir': 0.3, 'swir1': 0.2}, {'green': 0.06, 'nir': 0.02, 'swir1': 0.01}
    b = {k: np.full((100, 100), v) for k, v in land.items()}
    for k in b:
        b[k][:, cols] = wet[k]
    qa = np.full((100, 100), 64.0)
    if cloud:
        qa[:10] = 8.0
        for k in b:
            b[k][:10] = 0.5
    names = ['blue (B2)', 'green (B3)', 'red (B4)', 'nir (B5)', 'swir1 (B6)', 'swir2 (B7)', 'qa_pixel']
    data = [np.full((100, 100), 0.03), b['green'], np.full((100, 100), 0.04), b['nir'], b['swir1'], np.full((100, 100), 0.1), qa]
    with rasterio.open(path, 'w', driver='GTiff', width=100, height=100, count=7, dtype='float32', crs='EPSG:32646', transform=from_origin(600000, 2850000, 30, 30), nodata=float('nan')) as d:
        for i, (a, n) in enumerate(zip(data, names), 1):
            d.write(a.astype('float32'), i)
            d.set_band_description(i, n)
scene(${JSON.stringify(before)}, slice(40, 50), False)
scene(${JSON.stringify(after)}, slice(30, 60), True)
`]);
  await openTool(page, 'Water & floods');
  await page.setInputFiles('#water-a', before);
  await expect(page.locator('#water-swir1')).toHaveValue('4');
  await page.setInputFiles('#water-b', after);
  await page.click('#water-run');
  await expect(page.locator('.stat', { hasText: 'New water (flood)' })).toContainText('162');
  await expect(page.locator('.stat', { hasText: 'Water both dates' })).toContainText('81');
  await expect(page.locator('.stat', { hasText: 'Threshold' })).toContainText('MNDWI ≥');
  await expect(page.locator('.legend-row')).toContainText('New water (flood)');
  await expect(page.locator('.report-card')).toContainText('removed 10.0 % of pixels');
  expect(errors).toEqual([]);
});

test('water: lakes listed with their turbidity and chlorophyll indices (synthetic 6-band sample)', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Water & floods');
  await page.click('#water-sample');
  // Nine water bodies, 430.9 ha (the clear lake alone 243.1 ha); the river along the eastern edge is cut by the image edge.
  await expect(page.locator('.stat', { hasText: 'Water bodies' })).toContainText('9');
  await expect(page.locator('.stat', { hasText: 'Total area' })).toContainText(/430\.9/);
  await expect(page.locator('.stat', { hasText: 'Cut by edge or cloud' })).toContainText('1');
  await expect(page.locator('#water-bodies-table tbody tr')).toHaveCount(9);
  await expect(page.locator('#water-bodies-table tbody tr').first()).toContainText('243.09');
  await expect(page.locator('#water-bodies-table thead')).toContainText('NDTI (mean)');
  await expect(page.locator('.stat', { hasText: 'Turbidity index NDTI' })).toContainText(/0\.298/);
  await expect(page.locator('.stat', { hasText: 'Chlorophyll index NDCI' })).toBeVisible();
  await page.click('#water-view-ndti');
  await expect(page.locator('.legend-labels')).toContainText('NDTI over interior water');
  await expect(page.getByRole('button', { name: 'Export water-body inventory (CSV)' })).toBeVisible();
  await expect(page.locator('.report-card')).toContainText('Lacaux');
  expect(errors).toEqual([]);
});

test('water over time: occurrence and water on each date (synthetic 6-date reservoir)', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Water & floods');
  await page.click('#water-dates-many');
  await page.click('#water-sample');
  await expect(page.locator('.stat', { hasText: 'Water almost always' })).toContainText('118.7');
  await expect(page.locator('.stat', { hasText: 'Water at times' })).toContainText('262.17');
  const rows = page.locator('#water-series-dates tbody tr');
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(1)).toContainText('89.7 %'); // the cloudy March image
  await expect(rows.nth(2)).toContainText('118.71'); // the dry season
  await expect(page.locator('.stat', { hasText: 'Water bodies' })).toContainText('1');
  await expect(page.locator('.report-card')).toContainText('Pekel et al. 2016');
  expect(errors).toEqual([]);
});
