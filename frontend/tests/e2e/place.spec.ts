import { expect, test } from '@playwright/test';
import { backToTools, mapState, openTool, start } from './helpers';

// The front-page map: click anywhere for the place card, search places offline, and see saved reports as "My areas".

async function clickMapCentre(page: import('@playwright/test').Page) {
  const box = (await page.locator('.map-container').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.6);
}

test('place card: what is here, and tools opened at the clicked point', async ({ page }) => {
  const errors = await start(page);
  // The map opens on the default target, Kohima.
  await expect.poll(() => mapState<boolean>(page, 'm => m.loaded()')).toBe(true);
  await clickMapCentre(page);
  const card = page.locator('[data-testid=place-card]');
  await expect(card.locator('#place-koppen')).toContainText('Cwa');
  await expect(card.locator('#place-nearest')).toContainText('Kohima');
  await expect(card.locator('#place-biome')).toContainText('Tropical & subtropical moist broadleaf forests');
  await expect(card).toContainText('UTM 46N');
  await expect(card).toContainText('India');
  await expect(card.locator('#place-sun')).toContainText('UTC');
  await expect(page.locator('.pick-marker')).toBeVisible();

  // Weather history here: the Weather tool opens with its fetch panel at that point.
  const lat = Number((await card.locator('.place-fact .num').first().innerText()).split('°')[0]);
  await card.locator('#place-weather').click();
  await expect(page.locator('.tool-workspace h2')).toHaveText('Weather & climate');
  await expect(page.locator('.live-panel')).toHaveAttribute('open', '');
  expect(Math.abs(Number(await page.inputValue('#live-lat')) - lat)).toBeLessThan(1e-4);
  await expect(card).toHaveCount(0);

  // Draw a boundary from here: Land survey in drawing mode with the first point placed.
  await backToTools(page);
  await clickMapCentre(page);
  await page.click('#place-boundary');
  await expect(page.locator('.tool-workspace h2')).toHaveText('Land survey');
  await expect(page.getByText('click the map to add points (1 so far)')).toBeVisible();
  await page.locator('.tool-workspace button', { hasText: 'Cancel' }).click();

  // Set as telemetry target.
  await backToTools(page);
  await clickMapCentre(page);
  await page.click('#place-target');
  await expect(page.locator('.toast')).toContainText('Telemetry target set to');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('terrax_target')!).name)).toBe('Kohima');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('place search: names without accents, countries, coordinates and look-alike names', async ({ page }) => {
  const errors = await start(page);
  const search = page.locator('#place-search');
  await search.fill('sao pau');
  await expect(page.locator('#place-search-list')).toContainText('São Paulo');
  await expect(page.locator('#place-search-list')).toContainText('Brazil');
  await search.press('Enter');
  await expect(page.locator('#place-name')).toHaveText('São Paulo');
  await expect(page.locator('#place-koppen')).toContainText('Cfa');
  // The map flew there.
  await expect.poll(() => mapState<number>(page, 'm => m.getCenter().lat'), { timeout: 10_000 }).toBeLessThan(-20);

  // Two Hyderabads: the country tells them apart.
  await search.fill('hyderabad');
  await expect(page.locator('#place-search-list li')).toHaveCount(2);
  await expect(page.locator('#place-search-list')).toContainText('India');
  await expect(page.locator('#place-search-list')).toContainText('Pakistan');
  // Escape closes the list but not the card.
  await search.press('Escape');
  await expect(page.locator('#place-search-list')).toHaveCount(0);
  await expect(page.locator('[data-testid=place-card]')).toBeVisible();

  // A country flies there without a card; coordinates (decimal or DMS) open one.
  await search.fill('kenya');
  await page.locator('#place-search-list button', { hasText: 'Kenya' }).click();
  await expect.poll(() => mapState<number>(page, 'm => m.getCenter().lng'), { timeout: 10_000 }).toBeGreaterThan(33);
  await search.fill('64°08′N 21°56′W');
  await expect(page.locator('#place-search-list')).toContainText('64.13333°, -21.93333°');
  await search.press('Enter');
  await expect(page.locator('#place-nearest')).toContainText('Reykjavík');
  await search.fill('no such place xyz');
  await expect(page.locator('#place-search-list')).toContainText('No match');
  expect(errors).toEqual([]);
});

test('my areas: a saved report appears on the map and opens from it', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Land survey');
  await page.click('button:has-text("Try sample plot")');
  await page.click('.report-card button:has-text("Save to Reports")');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('terrax_reports')!)[0]);
  expect(saved.footprint.type).toMatch(/Polygon/);
  await backToTools(page);
  await expect.poll(() => mapState<boolean>(page, `m => !!m.getLayer('tx-areas-fill')`)).toBe(true);
  await page.click('.map-layers-toggle');
  await expect(page.locator('#map-layers-panel')).toContainText('My areas (1 saved report)');
  await page.click('.map-layers-toggle');
  // Fly to the plot and click inside it: the report opens.
  const [lon, lat] = saved.footprint.type === 'Polygon' ? saved.footprint.coordinates[0][0] : saved.footprint.coordinates[0][0][0];
  const ring: number[][] = saved.footprint.type === 'Polygon' ? saved.footprint.coordinates[0] : saved.footprint.coordinates[0][0];
  const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length,
    cy = ring.reduce((a, p) => a + p[1], 0) / ring.length;
  expect(Number.isFinite(lon + lat)).toBe(true);
  await page.evaluate(([x, y]) => (window as unknown as { __terraxMap: { jumpTo: (o: object) => void } }).__terraxMap.jumpTo({ center: [x, y], zoom: 17 }), [cx, cy]);
  await expect.poll(() => mapState<number>(page, `m => m.queryRenderedFeatures(m.project([${cx}, ${cy}]), { layers: ['tx-areas-fill'] }).length`)).toBeGreaterThan(0);
  const pt = await mapState<{ x: number; y: number }>(page, `m => m.project([${cx}, ${cy}])`);
  const box = (await page.locator('.map-canvas').boundingBox())!;
  await page.mouse.click(box.x + pt.x, box.y + pt.y);
  await expect(page.locator('#nav-reports')).toHaveClass(/active-link/);
  await expect(page.getByRole('heading', { name: saved.datasetName, level: 3 })).toBeVisible();
  expect(errors).toEqual([]);
});
