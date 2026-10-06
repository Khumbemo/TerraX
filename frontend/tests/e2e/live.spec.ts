import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { openTool, start } from './helpers';

// The TerraX server fetches Open-Meteo, NASA POWER and Earth Search itself (tested with
// pytest on recorded responses). Here the browser-facing /api/live endpoints and the
// Sentinel-2 job are mocked, and everything after them runs on the real API.

async function upload(request: APIRequestContext, name: string, body: Buffer, mimeType: string) {
  const r = await request.post('/api/files', { multipart: { file: { name, mimeType, buffer: body } } });
  expect(r.ok()).toBeTruthy();
  return r.json();
}

test('weather: fetched ERA5 daily data is analysed', async ({ page, request }) => {
  const errors = await start(page);
  const rows = ['date,precipitation_sum (mm),temperature_2m_mean (°C)'];
  for (let d = 0; d < 800; d++) {
    const t = new Date(Date.UTC(2022, 0, 1) + d * 86_400_000).toISOString().slice(0, 10);
    rows.push(`${t},${d % 3 ? 0 : 6.5},${(15 + 8 * Math.sin((d / 365) * 2 * Math.PI)).toFixed(2)}`);
  }
  const file = await upload(request, 'open-meteo_era5_25.674_94.108_2022-01-01_2024-03-10.csv', Buffer.from(rows.join('\n')), 'text/csv');
  let sent: Record<string, unknown> = {};
  await page.route('**/api/live/weather', async route => {
    sent = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ file, note: 'Open-Meteo Historical Weather API (ERA5/ERA5-Land reanalysis), grid cell centred near 25.680°, 94.100°.' }) });
  });
  await openTool(page, 'Weather & climate');
  await page.locator('summary', { hasText: 'Fetch data for a location' }).click();
  await page.click('#live-fetch');
  await expect(page.locator('.core-analysis-module')).toContainText('open-meteo_era5_25.674_94.108');
  expect(sent.vars).toEqual(['precipitation_sum', 'temperature_2m_mean']);
  expect(sent.source).toBe('open-meteo');
  await expect(page.locator('.data-notes')).toContainText('Open-Meteo Historical Weather API');
  await expect(page.locator('.report-card')).toContainText('Rainy days');
  await page.click('button[role=tab]:has-text("Anomalies")');
  await expect(page.locator('#seasonal-kendall')).toContainText('Seasonal Kendall');
  await page.click('button[role=tab]:has-text("Drought (SPI)")');
  await expect(page.locator('.notice')).toContainText('at least 10 years');
  expect(errors).toEqual([]);
});

test('weather: long monthly sample gives SPI and a seasonal trend', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Weather & climate');
  await page.click('button.chip:has-text("Monthly climate 1990–2024")');
  await expect(page.locator('#metric-select')).toBeVisible();
  await page.selectOption('#metric-select', 'temperature_c');
  await page.click('button[role=tab]:has-text("Anomalies")');
  await expect(page.locator('#seasonal-kendall')).toContainText('increasing trend');
  await page.selectOption('#metric-select', 'precipitation_mm');
  await page.click('button[role=tab]:has-text("Drought (SPI)")');
  await page.selectOption('#spi-scale', '6');
  await expect(page.locator('#spi-latest')).toContainText('SPI-6 =');
  await expect(page.locator('.report-card')).toContainText('SPI-12');
  expect(errors).toEqual([]);
});

test('satellite: a Sentinel-2 window loads as a masked NDVI layer', async ({ page, request }) => {
  const errors = await start(page);
  // A 5-band reflectance window as the server writes it (blue, green, red, NIR, SCL with clouds on the west half).
  const dir = mkdtempSync(join(tmpdir(), 'terrax-s2-'));
  const path = join(dir, 'S2B_46RFQ_20240301_0_L2A.tif');
  execFileSync('python3', ['-c', `
import numpy as np, rasterio
from rasterio.transform import from_origin
w = 300
b = [np.full((w, w), v, np.float32) for v in (0.03, 0.06, 0.04, 0.34)]
scl = np.where(np.arange(w)[None, :].repeat(w, 0) < w // 2, 9, 4).astype(np.float32)
with rasterio.open(${JSON.stringify(path)}, 'w', driver='GTiff', width=w, height=w, count=5, dtype='float32', crs='EPSG:32646', transform=from_origin(609000, 2842000, 10, 10), nodata=float('nan')) as d:
    for i, a in enumerate(b + [scl], 1):
        d.write(a, i)
`]);
  const file = await upload(request, 'S2B_46RFQ_20240301_0_L2A.tif', readFileSync(path), 'image/tiff');
  const item = { id: 'S2B_46RFQ_20240301_0_L2A', datetime: '2024-03-01T04:25:00Z', cloud: 4.1, epsg: 32646, assets: {}, processingBaseline: '05.10' };
  await page.route('**/api/live/sentinel/search', async route => {
    expect(JSON.parse(route.request().postData() ?? '{}').bbox).toHaveLength(4);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [item] }) });
  });
  await page.route('**/api/jobs', async route => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    if (route.request().method() !== 'POST' || body.tool !== 'sentinel') return route.fallback();
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ id: '0'.repeat(32), tool: 'sentinel', state: 'done', progress: 1, message: 'Done', result: { file, notes: ['Reflectance = DN × scale + offset from the STAC raster:bands metadata.'] } }),
    });
  });
  await openTool(page, 'Satellite imagery');
  await page.locator('summary', { hasText: 'Search Sentinel-2 scenes' }).click();
  await page.click('#s2-search');
  await expect(page.locator('td', { hasText: 'S2B_46RFQ_20240301_0_L2A' })).toBeVisible();
  await page.click('button:has-text("Load")');
  await expect(page.locator('.core-analysis-module')).toContainText('S2B_46RFQ_20240301_0_L2A.tif');
  // NDVI = (0.34 − 0.04) / (0.34 + 0.04) = 0.7895 on the clear half.
  await expect(page.locator('.report-card')).toContainText('0.7895');
  await expect(page.locator('.report-card')).toContainText('Quality mask from band 5');
  expect(errors).toEqual([]);
});
