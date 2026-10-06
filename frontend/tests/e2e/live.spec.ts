import { expect, test, type Route } from '@playwright/test';
import { writeArrayBuffer } from 'geotiff';
import { openTool, start } from './helpers';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges' };

async function preflight(route: Route): Promise<boolean> {
  if (route.request().method() !== 'OPTIONS') return false;
  await route.fulfill({ status: 204, headers: CORS });
  return true;
}

test('weather: fetch ERA5 daily data (mocked Open-Meteo) and analyse it', async ({ page }) => {
  const errors = await start(page);
  let requested = '';
  await page.route('https://archive-api.open-meteo.com/**', async route => {
    if (await preflight(route)) return;
    requested = route.request().url();
    const time: string[] = [], rain: number[] = [], temp: number[] = [];
    for (let d = 0; d < 800; d++) {
      const t = new Date(Date.UTC(2022, 0, 1) + d * 86_400_000);
      time.push(t.toISOString().slice(0, 10));
      rain.push(d % 3 ? 0 : 6.5);
      temp.push(15 + 8 * Math.sin((d / 365) * 2 * Math.PI));
    }
    await route.fulfill({ headers: CORS, contentType: 'application/json', body: JSON.stringify({ latitude: 25.68, longitude: 94.1, elevation: 1431, daily_units: { time: 'iso8601', precipitation_sum: 'mm', temperature_2m_mean: '°C' }, daily: { time, precipitation_sum: rain, temperature_2m_mean: temp } }) });
  });
  await openTool(page, 'Weather & climate');
  await page.locator('summary', { hasText: 'Fetch data for a location' }).click();
  await page.click('#live-fetch');
  await expect(page.locator('.core-analysis-module')).toContainText('open-meteo_era5_25.674_94.108');
  expect(new URL(requested).searchParams.get('daily')).toBe('precipitation_sum,temperature_2m_mean');
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

test('satellite: search Sentinel-2 (mocked STAC and COGs) and load a masked NDVI window', async ({ page }) => {
  const errors = await start(page);
  // Synthetic 10 m bands around Kohima (UTM 46N) and a 20 m SCL band with clouds on the west half.
  const E0 = 609000, N0 = 2842000, W = 600;
  const tif = async (w: number, res: number, f: (c: number) => number) => {
    const data = new Uint16Array(w * w);
    for (let r = 0; r < w; r++) for (let c = 0; c < w; c++) data[r * w + c] = f(c);
    return Buffer.from(await writeArrayBuffer(data, { width: w, height: w, ModelPixelScale: [res, res, 0], ModelTiepoint: [0, 0, 0, E0, N0, 0], GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32646, BitsPerSample: [16], SampleFormat: [1], SamplesPerPixel: 1 }));
  };
  const files: Record<string, Buffer> = {
    'B02.tif': await tif(W, 10, () => 1300),
    'B03.tif': await tif(W, 10, () => 1600),
    'B04.tif': await tif(W, 10, () => 1400),
    'B08.tif': await tif(W, 10, () => 4400),
    'SCL.tif': await tif(W / 2, 20, c => (c < W / 4 ? 9 : 4)),
  };
  await page.route('https://earth-search.aws.element84.com/v1/search', async route => {
    if (await preflight(route)) return;
    const body = JSON.parse(route.request().postData() ?? '{}');
    expect(body.collections).toEqual(['sentinel-2-l2a']);
    const asset = (f: string) => ({ href: `https://cogs.test/${f}`, 'raster:bands': [{ scale: 0.0001, offset: -0.1 }] });
    await route.fulfill({
      headers: CORS,
      contentType: 'application/geo+json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [{ id: 'S2B_46RFQ_20240301_0_L2A', properties: { datetime: '2024-03-01T04:25:00Z', 'eo:cloud_cover': 4.1, 'proj:epsg': 32646 }, assets: { blue: asset('B02.tif'), green: asset('B03.tif'), red: asset('B04.tif'), nir: asset('B08.tif'), scl: { href: 'https://cogs.test/SCL.tif' } } }] }),
    });
  });
  await page.route('https://cogs.test/**', async route => {
    if (await preflight(route)) return;
    const buf = files[new URL(route.request().url()).pathname.slice(1)];
    const range = route.request().headers()['range'];
    const m = range?.match(/bytes=(\d+)-(\d*)/);
    if (!m) return route.fulfill({ headers: { ...CORS, 'Accept-Ranges': 'bytes' }, body: buf });
    const a = Number(m[1]), b = Math.min(buf.length - 1, m[2] ? Number(m[2]) : buf.length - 1);
    await route.fulfill({ status: 206, headers: { ...CORS, 'Content-Range': `bytes ${a}-${b}/${buf.length}`, 'Accept-Ranges': 'bytes', 'Content-Type': 'image/tiff' }, body: buf.subarray(a, b + 1) });
  });
  await openTool(page, 'Satellite imagery');
  await page.locator('summary', { hasText: 'Search Sentinel-2 scenes' }).click();
  await page.click('#s2-search');
  await expect(page.locator('td', { hasText: 'S2B_46RFQ_20240301_0_L2A' })).toBeVisible();
  await page.click('button:has-text("Load")');
  await expect(page.locator('.core-analysis-module')).toContainText('S2B_46RFQ_20240301_0_L2A.tif');
  // NDVI of (0.34 − 0.04) / (0.34 + 0.04) = 0.789 after the −0.1 offset.
  await expect(page.locator('.report-card')).toContainText('0.7895');
  await expect(page.locator('.report-card')).toContainText('Quality mask from band 5');
  expect(errors).toEqual([]);
});
