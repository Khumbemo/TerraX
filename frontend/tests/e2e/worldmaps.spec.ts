import { expect, test, type Page } from '@playwright/test';
import { mapState, start } from './helpers';

const openLayers = (page: Page) => page.click('.map-layers-toggle');

/** True once the base map is a built-in picture served by the TerraX API and its tiles have loaded. */
const builtinLoaded = (page: Page, id: string) =>
  mapState<boolean>(page, `m => { const s = m.getSource('tx-base'); return !!s && (s.tiles || [])[0]?.includes('/api/maps/tiles/${id}/') && m.areTilesLoaded(); }`);

test('built-in picture maps load from the app itself, with no outside server', async ({ page }) => {
  const errors = await start(page);
  await openLayers(page);
  // From here on, with the online default map switched off, nothing may come from outside.
  await page.selectOption('#layers-map-base', 'offline');
  await page.waitForTimeout(500);
  const outside: string[] = [];
  page.on('request', r => {
    const host = new URL(r.url()).hostname;
    if (!['localhost', '127.0.0.1'].includes(host) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) outside.push(r.url());
  });
  for (const id of ['relief', 'etopo', 'bluemarble', 'blackmarble-local']) {
    const tile = page.waitForResponse(r => r.url().includes(`/api/maps/tiles/${id}/`) && r.status() === 200);
    await page.selectOption('#layers-map-base', 'offline');
    await page.selectOption('#layers-map-base', id);
    await tile;
    await expect.poll(() => builtinLoaded(page, id), { message: id }).toBe(true);
    await expect(page.locator('.map-status')).toHaveCount(0);
  }
  expect(outside).toEqual([]);
  expect(errors).toEqual([]);
});

test('Natural Earth map, labels, grid and plates', async ({ page }) => {
  const errors = await start(page);
  await openLayers(page);
  await page.selectOption('#layers-map-base', 'ne-detailed');
  await expect(page.locator('.place-label', { hasText: 'Kohima' })).toHaveCount(1);
  await expect(page.locator('.maplibregl-ctrl-attrib-inner')).toContainText('Natural Earth');

  await page.selectOption('#layers-map-add-overlay', 'graticule');
  await expect(page.locator('.grid-label', { hasText: /Tropic of Cancer 23\.4\d° N/ }).first()).toBeAttached();
  await expect(page.locator('.grid-label', { hasText: /Arctic Circle 66\.5\d° N/ }).first()).toBeAttached();

  await page.selectOption('#layers-map-add-overlay', 'plates');
  await expect(page.locator('.class-legend', { hasText: 'Plate boundaries' })).toContainText('Subduction zone');
  await expect(page.locator('.maplibregl-ctrl-attrib-inner')).toContainText('Bird (2003)');

  // Opacity of a vector overlay fades all its layers.
  const slider = page.locator('input[aria-label="Opacity of Tectonic plate boundaries (Bird 2003)"]');
  await slider.fill('0.3');
  await expect.poll(() => mapState<number>(page, `m => m.getLayer('tx-ov:plates-solid') && m.getPaintProperty('tx-ov:plates-solid', 'line-opacity')`)).toBe(0.3);
  expect(errors).toEqual([]);
});

test('climate zone and biome under a click', async ({ page }) => {
  const errors = await start(page);
  await openLayers(page);
  await page.selectOption('#layers-map-base', 'relief');
  await page.selectOption('#layers-map-add-overlay', 'koppen');
  await page.selectOption('#layers-map-add-overlay', 'biomes');
  await expect(page.locator('.class-legend', { hasText: 'Köppen' })).toContainText('Cwa');
  await openLayers(page); // close the panel
  // The map opens on the target (Kohima, 25.67° N 94.11° E).
  const box = (await page.locator('.map-container').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const popup = page.locator('.class-popup');
  await expect(popup).toContainText('Climate (Köppen–Geiger)');
  await expect(popup).toContainText('Cwa · Temperate, dry winter, hot summer');
  await expect(popup).toContainText('Biome: Tropical & subtropical moist broadleaf forests');
  expect(errors).toEqual([]);
});

test.describe('sharp at close zoom', () => {
  test.use({ deviceScaleFactor: 2 });

  test('full-detail picture tiles from the server', async ({ page }) => {
    const errors = await start(page);
    // The map opens at zoom 10; the relief has detail to zoom 5 (16,384 px), which the server cuts from the full-detail chunks.
    const tile = page.waitForResponse(r => /\/api\/maps\/tiles\/relief\/5\/\d+\/\d+$/.test(r.url()) && r.status() === 200);
    await openLayers(page);
    await page.selectOption('#layers-map-base', 'relief');
    const res = await tile;
    expect(res.headers()['content-type']).toBe('image/jpeg');
    expect(await mapState<number>(page, `m => m.getSource('tx-base').maxzoom`)).toBe(5);
    expect(errors).toEqual([]);
  });

  test('Natural Earth 1:10m cells load for the view when zoomed in', async ({ page }) => {
    const errors = await start(page);
    // Kohima (94.1° E, 25.7° N) is in the 90–135° E, 0–45° N cell (6-1).
    const detail = page.waitForResponse(r => r.url().includes('/api/maps/detail?') && r.status() === 200);
    await openLayers(page);
    await page.selectOption('#layers-map-base', 'ne-detailed');
    const body = await (await detail).json();
    expect(body.cells).toContain('6-1');
    await expect.poll(() => mapState<number>(page, `m => m.getSource('tx-base-fine-borders') ? m.querySourceFeatures('tx-base-fine-borders').length : 0`)).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});
