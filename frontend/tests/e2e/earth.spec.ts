import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { mapState, start } from './helpers';

// Live Earth layers on the front-page map. The outside services are not called from the tests: /api/live/earth/* answer
// with what the server's own parsers (backend/terrax/services/earth.py) make of real USGS, FIRMS and Open-Meteo
// responses recorded on 28 November 2026 (backend/tests/fixtures/earth). The status endpoint and the Admin tab use
// the real API.
const fx = JSON.parse(readFileSync(new URL('./earth-fixtures.json', import.meta.url), 'utf8'));

async function jump(page: Page, lon: number, lat: number, zoom: number) {
  await page.evaluate(([x, y, z]) => (window as unknown as { __terraxMap: { jumpTo: (o: object) => void } }).__terraxMap.jumpTo({ center: [x, y], zoom: z }), [lon, lat, zoom]);
  await expect.poll(() => mapState<boolean>(page, 'm => !m.isMoving() && m.loaded()')).toBe(true);
}

/** Clicks the map at a longitude and latitude. */
async function clickAt(page: Page, lon: number, lat: number) {
  const p = await mapState<{ x: number; y: number }>(page, `m => m.project([${lon}, ${lat}])`);
  const box = (await page.locator('.map-canvas').boundingBox())!;
  await page.mouse.click(box.x + p.x, box.y + p.y);
}

test('earthquakes from the USGS feed: size by magnitude, a popup with the event', async ({ page }) => {
  const asked: string[] = [];
  await page.route('**/api/live/earth/quakes?**', route => {
    asked.push(new URL(route.request().url()).searchParams.get('feed')!);
    return route.fulfill({ json: fx.quakes });
  });
  const errors = await start(page);
  await expect.poll(() => mapState<boolean>(page, 'm => m.loaded()')).toBe(true);
  await page.click('.map-layers-toggle');
  await page.check('#layer-quakes');
  await expect(page.locator('#quake-status')).toContainText('4 events');
  await expect.poll(() => mapState<boolean>(page, 'm => Boolean(m.getLayer("tx-quakes-circle"))')).toBe(true);
  expect(asked).toEqual(['2.5_day']);
  await page.selectOption('[aria-label="Earthquake period"]', 'week');
  await expect.poll(() => asked.at(-1)).toBe('2.5_week');

  // The M 2.7 in New Mexico: [-103.8251, 31.9967], 8.254 km deep.
  await page.click('.map-layers-toggle'); // close the panel so it does not cover the map
  await jump(page, -103.8251, 31.9967, 6);
  await clickAt(page, -103.8251, 31.9967);
  const pop = page.locator('.class-popup');
  await expect(pop).toContainText('M 2.7');
  await expect(pop).toContainText('34 km SE of Malaga, New Mexico');
  await expect(pop).toContainText('Depth 8.3 km');
  await expect(pop.locator('a')).toHaveAttribute('href', 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000ue2m');
  // A click on an earthquake does not open the place card.
  await expect(page.locator('[data-testid=place-card]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('without a MAP_KEY the fire layer says where to add one', async ({ page }) => {
  const errors = await start(page);
  await expect.poll(() => mapState<boolean>(page, 'm => m.loaded()')).toBe(true);
  await page.click('.map-layers-toggle');
  await page.check('#layer-fires');
  await expect(page.locator('#fire-status')).toContainText('Admin → Site settings'); // the real server has no key
  expect((await page.request.get('/api/live/earth/fires')).status()).toBe(409);
  expect(errors).toEqual([]);
});

test('active fires from FIRMS: points coloured by FRP, a popup with the detection', async ({ page }) => {
  await page.route('**/api/live/earth/status', async route => {
    const real = await (await route.fetch()).json();
    return route.fulfill({ json: { ...real, fires: { ...real.fires, available: true } } });
  });
  const asked: URLSearchParams[] = [];
  await page.route('**/api/live/earth/fires?**', route => {
    asked.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: fx.fires });
  });
  const errors = await start(page);
  await expect.poll(() => mapState<boolean>(page, 'm => m.loaded()')).toBe(true);
  await page.click('.map-layers-toggle');
  await page.check('#layer-fires');
  await expect(page.locator('#fire-status')).toContainText('20 detections in view');
  await expect(page.locator('[aria-label="Fire satellite"]')).toHaveValue('VIIRS_NOAA20_NRT');
  expect(asked[0].get('source')).toBe('VIIRS_NOAA20_NRT');
  expect(asked[0].get('days')).toBe('1');
  expect(Number(asked[0].get('west'))).toBeLessThan(Number(asked[0].get('east')));
  await page.click('.map-layers-toggle');
  // First recorded detection: -1.51695, 29.24614, FRP 0.6 MW, nominal, 2026-11-27 00:00 UTC, night.
  await jump(page, 29.24614, -1.51695, 11);
  await clickAt(page, 29.24614, -1.51695);
  const pop = page.locator('.class-popup');
  await expect(pop).toContainText('FRP 0.6 MW · confidence nominal');
  await expect(pop).toContainText('2026-11-27 00:00 UTC · night overpass');
  await expect(pop).toContainText('NOAA-20');
  expect(errors).toEqual([]);
});

test('today’s weather as map points, and elevation on the place card', async ({ page }) => {
  await page.route('**/api/live/earth/weather?**', route => route.fulfill({ json: fx.weather }));
  await page.route('**/api/live/earth/elevation?**', route => route.fulfill({ json: fx.elevation }));
  const errors = await start(page);
  await expect.poll(() => mapState<boolean>(page, 'm => m.loaded()')).toBe(true);
  await jump(page, 13.41, 52.52, 5);
  await page.click('.map-layers-toggle');
  await page.check('#layer-weather');
  await expect(page.locator('#weather-status')).toContainText('3 forecast points');
  await page.click('.map-layers-toggle');
  const berlin = page.locator('.wx-marker', { hasText: '0°' }).first();
  await expect(berlin).toBeVisible();
  await berlin.click();
  const pop = page.locator('.class-popup');
  await expect(pop).toContainText('Partly cloudy');
  await expect(pop).toContainText('Today (2026-11-28): Overcast, -2.4 to 1.3 °C');
  await expect(pop.locator('a', { hasText: 'Weather data by Open-Meteo.com' })).toHaveAttribute('href', 'https://open-meteo.com/');
  await expect(page.locator('[data-testid=place-card]')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await clickAt(page, 17.5, 50.0); // away from the markers
  const card = page.locator('[data-testid=place-card]');
  await expect(card.locator('#place-elevation')).toHaveText('38 m');
  await expect(card).toContainText('Copernicus DEM GLO-90');
  expect(errors).toEqual([]);
});

test('an administrator saves a FIRMS MAP_KEY, sees only its end, and removes it', async ({ page }) => {
  const errors = await start(page);
  await page.click('#account-button');
  await page.fill('#signin-email', 'admin@terrax.test');
  await page.fill('#signin-password', 'e2e admin passphrase');
  await page.click('#signin-submit');
  await page.click('#account-button');
  await page.click('#account-tab-admin');
  await page.click('#admin-section-site');
  await expect(page.locator('#admin-firms-state')).toContainText('No MAP_KEY yet');
  await page.fill('#admin-firms-key', 'bad key!');
  await page.click('#admin-firms-save');
  await expect(page.locator('.toast-error')).toContainText('letters and digits');
  const key = 'e2e0123456789abcdef0123456789abc';
  await page.fill('#admin-firms-key', key);
  await page.click('#admin-firms-save');
  await expect(page.locator('#admin-firms-state')).toContainText('ending in 9abc');
  await expect(page.locator('#admin-firms-key')).toHaveValue('');
  const settings = await page.request.get('/api/admin/settings');
  expect(await settings.text()).not.toContain(key);
  expect((await (await page.request.get('/api/live/earth/status')).json()).fires.available).toBe(true);
  await page.click('#admin-firms-remove');
  await expect(page.locator('#admin-firms-state')).toContainText('No MAP_KEY yet');
  expect(errors).toEqual([]);
});
