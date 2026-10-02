import { expect, test, type Page, type Route } from '@playwright/test';
import { rasterPmtiles } from '../fixtures/pmtiles-builder';
import { start } from './helpers';

// 1×1 PNG: tile servers are simulated, since tests must not depend on the internet.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const TILE_HOSTS = /basemaps\.cartocdn\.com|tile\.openstreetmap\.org|opentopomap\.org|stadiamaps\.com|maptiler\.com|earthdata\.nasa\.gov|maps\.eox\.at|arcgisonline\.com|tiles\.openfreemap\.org|example\.(org|test)/;

async function mockTiles(page: Page, opts: { fail?: RegExp } = {}) {
  const requested: string[] = [];
  await page.route(url => TILE_HOSTS.test(url.hostname), async (route: Route) => {
    const url = route.request().url();
    requested.push(url);
    if (opts.fail?.test(url)) return route.fulfill({ status: 404, body: 'not found' });
    if (url.includes('/styles/')) {
      return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#1d3b5a' } }] }) });
    }
    return route.fulfill({ contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: PNG });
  });
  return requested;
}

test('choose base maps and stack overlays from Settings and the Layers panel', async ({ page }) => {
  const requested = await mockTiles(page);
  const errors = await start(page);
  await page.click('#nav-settings');
  await page.click('[role=tab]:has-text("Map")');
  // Every recommended map is offered.
  const options = await page.locator('#settings-map-base option').allInnerTexts();
  for (const name of ['OpenStreetMap standard', 'OpenTopoMap', 'CARTO Voyager', 'OpenFreeMap Liberty', 'Protomaps', 'Stadia Alidade Smooth Dark', 'Stamen Toner', 'MapTiler Streets', 'Esri World Imagery', 'Sentinel-2 cloudless 2016', 'NASA MODIS Terra', 'NASA Black Marble', 'Custom WMS']) {
    expect(options.some(o => o.includes(name)), name).toBe(true);
  }
  await page.selectOption('#settings-map-base', 'osm');
  await page.selectOption('#settings-map-add-overlay', 'gibs-blackmarble');
  await page.selectOption('#settings-map-add-overlay', 'carto-labels-dark');
  await expect(page.locator('.overlay-row')).toHaveCount(2);
  await page.locator('.overlay-row input[type=range]').first().fill('0.3');
  await page.keyboard.press('Escape');
  await expect.poll(() => requested.some(u => u.startsWith('https://tile.openstreetmap.org/'))).toBe(true);
  await expect.poll(() => requested.some(u => /gibs\.earthdata\.nasa\.gov\/wmts\/epsg3857\/best\/VIIRS_Black_Marble\/default\/2016-01-01\/GoogleMapsCompatible_Level8\/\d+\/\d+\/\d+\.png$/.test(u))).toBe(true);
  await expect.poll(() => requested.some(u => /dark_only_labels/.test(u))).toBe(true);
  // Overlay opacity is applied to its layer without rebuilding.
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.leaflet-tile-pane .leaflet-layer')].map(e => e.style.opacity))).toContain('0.3');
  // Same choices from the map's Layers panel.
  await page.click('.map-layers-toggle');
  await expect(page.locator('#layers-map-base')).toHaveValue('osm');
  await page.selectOption('#layers-map-base', 'opentopomap');
  await expect.poll(() => requested.some(u => /tile\.opentopomap\.org\/\d+\/\d+\/\d+\.png$/.test(u))).toBe(true);
  await page.reload();
  await page.click('.map-layers-toggle');
  await expect(page.locator('#layers-map-base')).toHaveValue('opentopomap');
  await expect(page.locator('.map-layers-panel .overlay-row')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('NASA daily date, keys, fallback URL and a clear notice when a map cannot load', async ({ page }) => {
  // The first GIBS host fails, so the second URL form must be tried; EOX fails completely.
  const requested = await mockTiles(page, { fail: /gibs\.earthdata\.nasa\.gov|maps\.eox\.at/ });
  const errors = await start(page);
  await page.click('#nav-settings');
  await page.click('[role=tab]:has-text("Map")');
  await page.fill('#map-gibs-date', '2024-03-15');
  await page.selectOption('#settings-map-base', 'gibs-modis');
  await page.keyboard.press('Escape');
  await expect.poll(() => requested.some(u => /map1\.vis\.earthdata\.nasa\.gov\/wmts-webmerc\/MODIS_Terra_CorrectedReflectance_TrueColor\/default\/2024-03-15\//.test(u)), { timeout: 15_000 }).toBe(true);
  await expect(page.locator('.map-status')).toHaveCount(0);

  await page.click('.map-layers-toggle');
  await page.selectOption('#layers-map-base', 'eox-2016');
  await expect(page.locator('.map-status')).toContainText('Not loading: Sentinel-2 cloudless 2016 (EOX)', { timeout: 15_000 });
  expect(requested.some(u => u.includes('/wmts/1.0.0/s2cloudless-2016_3857/default/g/'))).toBe(true); // backup form was tried

  await page.selectOption('#layers-map-base', 'maptiler-streets');
  await expect(page.locator('.map-status')).toContainText('needs more settings');
  await page.click('#nav-settings');
  await page.click('[role=tab]:has-text("Map")');
  await page.fill('#map-key-maptiler', 'test-key');
  await page.keyboard.press('Escape');
  await expect.poll(() => requested.some(u => u.startsWith('https://api.maptiler.com/maps/streets-v2/') && u.endsWith('?key=test-key'))).toBe(true);
  expect(errors).toEqual([]);
});

test('vector maps (OpenFreeMap), custom WMS and a local Protomaps file', async ({ page }) => {
  const requested = await mockTiles(page);
  const errors = await start(page);
  await page.click('.map-layers-toggle');
  await page.selectOption('#layers-map-base', 'ofm-liberty');
  await expect.poll(() => requested.includes('https://tiles.openfreemap.org/styles/liberty')).toBe(true);
  await expect(page.locator('.leaflet-gl-layer, canvas.maplibregl-canvas').first()).toBeAttached({ timeout: 15_000 });
  await expect(page.locator('.map-status')).toHaveCount(0);

  await page.click('#nav-settings');
  await page.click('[role=tab]:has-text("Map")');
  await page.fill('#map-custom-wms', 'https://wms.example.org/wms');
  await page.fill('#map-custom-wms-layers', 'india_lulc');
  await page.selectOption('#settings-map-add-overlay', 'custom-wms');
  await page.setInputFiles('#map-pmtiles-file', { name: 'world.pmtiles', mimeType: 'application/octet-stream', buffer: rasterPmtiles(PNG) });
  await expect(page.locator('.map-settings')).toContainText('Local file: world.pmtiles');
  await page.selectOption('#settings-map-base', 'protomaps');
  await page.keyboard.press('Escape');
  await expect.poll(() => requested.some(u => u.startsWith('https://wms.example.org/wms?') && /layers=india_lulc/i.test(u) && /request=GetMap/i.test(u))).toBe(true);
  // The PMTiles raster tile is shown as a blob image in the tile pane.
  await expect(page.locator('.leaflet-tile-pane img[src^="blob:"]').first()).toBeAttached({ timeout: 15_000 });
  await expect(page.locator('.map-status')).toHaveCount(0);

  // A file that is not PMTiles gives a clear message.
  await page.click('#nav-settings');
  await page.click('[role=tab]:has-text("Map")');
  await page.setInputFiles('#map-pmtiles-file', { name: 'bad.pmtiles', mimeType: 'application/octet-stream', buffer: Buffer.from('not a pmtiles archive at all, sorry') });
  await page.keyboard.press('Escape');
  await expect(page.locator('.map-status')).toContainText('bad.pmtiles is not a readable PMTiles file');
  expect(errors).toEqual([]);
});
