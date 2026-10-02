import { expect, test, type Page } from '@playwright/test';
import { start } from './helpers';

const openLayers = (page: Page) => page.click('.map-layers-toggle');

/** True once some tile canvas of the base map has non-transparent pixels. */
const tilesPainted = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLCanvasElement>('.leaflet-tile-pane canvas')].some(c => {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 400) if (d[i] > 0) return true;
      return false;
    }),
  );

test('built-in picture maps load from the app itself, with no outside server', async ({ page }) => {
  const errors = await start(page);
  const outside: string[] = [];
  page.on('request', r => {
    const host = new URL(r.url()).hostname;
    if (!['localhost', '127.0.0.1'].includes(host) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) outside.push(r.url());
  });
  await openLayers(page);
  for (const id of ['relief', 'etopo', 'bluemarble', 'blackmarble-local']) {
    await page.selectOption('#layers-map-base', id);
    await expect.poll(() => tilesPainted(page), { message: id }).toBe(true);
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
  await expect(page.locator('.leaflet-control-attribution')).toContainText('Natural Earth');

  await page.selectOption('#layers-map-add-overlay', 'graticule');
  await expect(page.locator('.grid-label', { hasText: /Tropic of Cancer 23\.4\d° N/ }).first()).toBeAttached();
  await expect(page.locator('.grid-label', { hasText: /Arctic Circle 66\.5\d° N/ }).first()).toBeAttached();

  await page.selectOption('#layers-map-add-overlay', 'plates');
  await expect(page.locator('.class-legend', { hasText: 'Plate boundaries' })).toContainText('Subduction zone');
  await expect(page.locator('.leaflet-control-attribution')).toContainText('Bird (2003)');

  // Opacity of a vector overlay fades its whole pane.
  const slider = page.locator('input[aria-label="Opacity of Tectonic plate boundaries (Bird 2003)"]');
  await slider.fill('0.3');
  await expect.poll(() => page.evaluate(() => (document.querySelector('.leaflet-builtin-plates-pane') as HTMLElement).style.opacity)).toBe('0.3');
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
