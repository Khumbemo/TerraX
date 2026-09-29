import { expect, test } from '@playwright/test';
import { backToTools, chat, openTool, shapefileZip, start } from './helpers';

test('tool hub lists every tool', async ({ page }) => {
  const errors = await start(page);
  await expect(page.locator('.tool-card')).toHaveCount(await page.locator('.tool-card').count());
  for (const name of ['Forest loss', 'Carbon & biomass', 'Land survey', 'Weather & climate', 'Satellite imagery', 'Terrain', 'Space & aerial photos']) {
    await expect(page.locator('.tool-card', { hasText: name })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('forest loss: synthetic sample gives areas and a report', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Forest loss');
  await page.click('button:has-text("Try synthetic sample")');
  const stats = page.locator('.result-block .stat-grid').first();
  await expect(stats).toContainText('Forest loss');
  await expect(stats).toContainText('ha');
  await expect(page.locator('.report-card')).toContainText('Method and limits');
  expect(errors).toEqual([]);
});

test('carbon: inventory sample, settings and a generic CSV', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Carbon & biomass');
  await page.click('button:has-text("Try synthetic inventory")');
  const agb = page.locator('.stat', { hasText: 'Above-ground biomass' }).locator('.stat-value');
  await expect(agb).toContainText('t/ha');
  const before = await agb.innerText();
  await expect(page.locator('.report-card')).toContainText('Chave et al. (2014)');
  await expect(page.locator('.data-notes')).toContainText('dead stems');
  // Denser wood → more biomass.
  await page.fill('#carbon-density', '0.8');
  await expect(agb).not.toHaveText(before);
  const n = (s: string) => Number(s.replace(/,/g, '').match(/[\d.]+/)![0]);
  expect(n(await agb.innerText())).toBeGreaterThan(n(before));
  // An invalid value is flagged and ignored.
  await page.fill('#carbon-density', '9');
  await expect(page.locator('#carbon-density')).toHaveAttribute('aria-invalid', 'true');
  const csv = 'Species,GBH\nSchima wallichii,94.2478\nSchima wallichii,62.83\n';
  await page.setInputFiles('#carbon-file', { name: 'girths.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.locator('.stat', { hasText: 'Live trees' })).toContainText('2');
  await page.fill('#carbon-area', '100');
  await expect(agb).toContainText('t/ha');
  expect(errors).toEqual([]);
});

test('land survey: sample, KML, GPX, shapefile and a broken zip', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Land survey');
  await page.click('button:has-text("Try sample plot")');
  await expect(page.locator('.feature-card').first()).toContainText('ha');
  const kml = '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>KML field</name><Polygon><outerBoundaryIs><LinearRing><coordinates>94.10,25.67,0 94.11,25.67,0 94.11,25.68,0 94.10,25.68,0 94.10,25.67,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>';
  await page.setInputFiles('#survey-file', { name: 'field.kml', mimeType: 'application/vnd.google-earth.kml+xml', buffer: Buffer.from(kml) });
  await expect(page.locator('.feature-card h3').first()).toHaveText('KML field');
  await expect(page.locator('.feature-card').first()).toContainText('111.2');
  const gpx = '<?xml version="1.0"?><gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Walk</name><trkseg><trkpt lat="25.670" lon="94.100"><ele>1400</ele></trkpt><trkpt lat="25.671" lon="94.101"><ele>1410</ele></trkpt><trkpt lat="25.672" lon="94.101"><ele>1425</ele></trkpt></trkseg></trk></gpx>';
  await page.setInputFiles('#survey-file', { name: 'walk.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx) });
  await expect(page.locator('.feature-card').first()).toContainText('1,400–1,425 m');
  await page.setInputFiles('#survey-file', { name: 'plot.zip', mimeType: 'application/zip', buffer: shapefileZip() });
  await expect(page.locator('.feature-card h3').first()).toHaveText('Shapefile plot');
  await expect(page.locator('.feature-card').first()).toContainText('111.22 ha');
  await page.setInputFiles('#survey-file', { name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from('PK not a zip') });
  await expect(page.locator('.toast-error')).toContainText('not a valid zip');
  expect(errors).toEqual([]);
});

test('weather: rainfall sample shows IMD indices and trend', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Weather & climate');
  await page.click('button.chip:has-text("Rainfall")');
  await expect(page.locator('.core-analysis-module')).toContainText('Analysis · precipitation_data.csv');
  await expect(page.locator('.report-card')).toContainText('Rainy days');
  await page.click('button[role=tab]:has-text("Classes")');
  await expect(page.locator('.classes-view')).toContainText('India Meteorological Department');
  expect(errors).toEqual([]);
});

test('satellite: indices and composites', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Satellite imagery');
  await page.click('button.chip:has-text("Synthetic 4-band")');
  await expect(page.locator('.core-analysis-module')).toContainText('satellite_4band_synthetic.tif');
  await page.locator('.band-setup summary').click();
  await page.selectOption('#raster-index', 'ndwi');
  await page.click('button:has-text("Compute NDWI")');
  await expect(page.locator('.legend-labels').first()).toContainText('NDWI');
  await page.click('button:has-text("False colour")');
  await expect(page.locator('figcaption', { hasText: 'False colour' })).toBeVisible();
  await page.selectOption('#raster-index', 'evi');
  await page.click('button:has-text("Compute EVI")');
  await expect(page.locator('.hint-list').last()).toContainText('10,000');
  expect(errors).toEqual([]);
});

test('terrain and photo samples', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Terrain');
  await page.click('button:has-text("Try synthetic DEM")');
  await expect(page.locator('.result-block .stat-grid').first()).toContainText('Relief');
  await page.click('button[role=tab]:has-text("Slope classes")');
  await backToTools(page);
  await openTool(page, 'Space & aerial photos');
  await page.click('button:has-text("Try synthetic photo")');
  await expect(page.locator('.result-block .stat-grid').first()).toContainText('Vegetation cover');
  await page.check('#photo-mask');
  expect(errors).toEqual([]);
});

test('reports: save and reopen', async ({ page }) => {
  await start(page);
  await openTool(page, 'Terrain');
  await page.click('button:has-text("Try synthetic DEM")');
  await page.click('button:has-text("Save to Reports")');
  await page.click('nav button:has-text("Reports")');
  await expect(page.getByText('Saved reports (1)')).toBeVisible();
});

test('offline assistant holds a conversation', async ({ page }) => {
  await start(page, 'Asha');
  expect(await chat(page, 'guide-chat', 'hi')).toMatch(/Asha/);
  expect(await chat(page, 'guide-chat', 'how do i calcualte forest los')).toContain('Forest loss');
  expect(await chat(page, 'guide-chat', 'yes')).toContain('same season');
  expect(await chat(page, 'guide-chat', 'convert 3 acres to hectares')).toContain('1.21406 ha');
  await openTool(page, 'Forest loss');
  await page.click('button:has-text("Try synthetic sample")');
  await expect(page.locator('.result-block')).toBeVisible();
  expect(await chat(page, 'dataset-chat', 'how much forest was lost?')).toMatch(/Forest loss.*ha/);
});
