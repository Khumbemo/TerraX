import { expect, test } from '@playwright/test';
import { backToTools, openTool, start } from './helpers';

const bytes = async (dl: import('@playwright/test').Download) => Buffer.concat(await (await dl.createReadStream()).toArray());

test('PDF report includes figures, and saved reports keep them', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Forest loss');
  await page.click('button:has-text("Try synthetic sample")');
  await expect(page.locator('.report-card')).toContainText('Method and limits');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.report-card button:has-text("PDF")')]);
  const pdf = (await bytes(dl)).toString('latin1');
  expect(pdf.startsWith('%PDF')).toBe(true);
  expect((pdf.match(/\/Subtype \/Image/g) ?? []).length).toBe(1); // the change map (NDVI mode draws no chart)
  await page.click('.report-card button:has-text("Save to Reports")');
  await page.click('#nav-reports');
  await expect(page.locator('.report-figures img').first()).toBeVisible();
  await expect(page.locator('.report-figures figcaption').first()).toContainText('Map: Forest change');

  // A chart-only tool: the weather time series is captured from its SVG.
  await page.click('button:has-text("Tools")'); // back to the open Forest loss tool
  await backToTools(page);
  await openTool(page, 'Weather & climate');
  await page.click('button.chip:has-text("Rainfall")');
  await expect(page.locator('.tool-workspace svg.recharts-surface').first()).toBeVisible();
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('.report-card button:has-text("PDF")')]);
  const pdf2 = (await bytes(dl2)).toString('latin1');
  expect((pdf2.match(/\/Subtype \/Image/g) ?? []).length).toBeGreaterThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('project export and import restore boundary and reports', async ({ page, browser }) => {
  const errors = await start(page);
  await openTool(page, 'Land survey');
  await page.click('button:has-text("Try sample plot")');
  await page.click('#use-boundary');
  await page.click('.report-card button:has-text("Save to Reports")');
  await page.click('#nav-reports');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#project-export')]);
  expect(dl.suggestedFilename()).toMatch(/^TerraX_project_\d{4}-\d{2}-\d{2}\.terrax\.json$/);
  const file = await bytes(dl);
  const json = JSON.parse(file.toString('utf8'));
  expect(json.format).toBe('terrax-project');
  expect(JSON.stringify(json)).not.toContain('api_key');

  // A fresh browser profile: import the file and get the boundary and report back.
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await start(p2);
  await p2.click('#nav-reports');
  await p2.setInputFiles('#project-import', { name: 'p.terrax.json', mimeType: 'application/json', buffer: file });
  await expect(p2.locator('.toast')).toContainText('Project imported: 1 new report, analysis boundary');
  await expect(p2.locator('.report-list-item')).toHaveCount(1);
  await p2.click('button:has-text("Tools")');
  await openTool(p2, 'Terrain');
  await expect(p2.locator('.boundary-banner')).toContainText('Sample plot A');
  await p2.click('#nav-reports');
  await p2.setInputFiles('#project-import', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"a":1}') });
  await expect(p2.locator('.toast-error')).toContainText('not a TerraX project file');
  await ctx.close();
  expect(errors).toEqual([]);
});

test('display preferences: light theme, imperial units, Hindi and the tour', async ({ page }) => {
  const errors = await start(page);
  await page.click('#nav-settings');
  await page.selectOption('#pref-theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(244, 246, 249)');
  await page.selectOption('#pref-units', 'imperial');
  await page.selectOption('#pref-lang', 'hi');
  await expect(page.locator('#nav-settings')).toHaveText('सेटिंग्स');
  await page.click('#start-tour');
  await expect(page.locator('.tour-card h3')).toHaveText('एक टूल चुनें');
  for (let i = 0; i < 4; i++) await page.click('#tour-next');
  await expect(page.locator('.tour-card h3')).toHaveText('सेटिंग्स');
  await page.click('#tour-next');
  await expect(page.locator('.tour-card')).toHaveCount(0);
  await expect(page.locator('.tool-card[data-name="Land survey"] .tool-name')).toHaveText('भूमि सर्वेक्षण');
  await page.click('.tool-card[data-name="Land survey"]');
  await page.click('button:has-text("Try sample plot")');
  await expect(page.locator('.stat', { hasText: 'Area' }).first()).toContainText('acres');
  // Preferences persist across a reload.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('#nav-settings')).toHaveText('सेटिंग्स');
  expect(errors).toEqual([]);
});

test('survey: declination gives magnetic bearings; a GPX track has an elevation profile', async ({ page }) => {
  const errors = await start(page);
  await openTool(page, 'Land survey');
  const pts = Array.from({ length: 12 }, (_, i) => `<trkpt lat="${25.67 + i * 0.0005}" lon="${94.1 + i * 0.0004}"><ele>${1400 + i * 8 + (i % 2) * 2}</ele></trkpt>`).join('');
  await page.setInputFiles('#survey-file', { name: 'climb.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(`<?xml version="1.0"?><gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Climb</name><trkseg>${pts}</trkseg></trk></gpx>`) });
  await expect(page.locator('.elevation-profile')).toContainText('ascent');
  await expect(page.locator('.elevation-profile svg.recharts-surface')).toBeVisible();
  await page.fill('#survey-declination', '-1.5');
  await expect(page.locator('.tool-body th', { hasText: 'Bearing (magnetic)' })).toBeVisible();
  await expect(page.locator('.report-card')).toContainText('1.5° west');
  expect(errors).toEqual([]);
});

test('installed app works offline after one visit', async ({ page, context }) => {
  const errors = await start(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // Let the worker finish precaching, then go offline and reload.
  // The cache name is read from the worker, so bumping its version cannot break this test.
  const cacheName = await page.evaluate(async () => (await (await fetch('./sw.js')).text()).match(/const CACHE = '([^']+)'/)?.[1] ?? '');
  expect(cacheName).toMatch(/^terrax-v\d+$/);
  await expect.poll(async () => page.evaluate(async name => ((await caches.keys()).includes(name) ? (await (await caches.open(name)).keys()).length : 0), cacheName), { timeout: 20_000 }).toBeGreaterThan(20);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.tool-card').first()).toBeVisible();
  await openTool(page, 'Land cover'); // a lazily loaded tool, never opened online
  await backToTools(page);
  await context.setOffline(false);
  expect(errors).toEqual([]);
});

test('space background: Earth at night by default, galaxy, off, and the galaxy theme', async ({ page }) => {
  const errors = await start(page);
  await expect(page.locator('.space-background.bg-earth canvas.space-canvas')).toBeAttached();
  await expect(page.locator('html')).toHaveAttribute('data-bg', 'on');
  // The Earth canvas is actually drawn (not blank): sample its pixels.
  await expect.poll(async () => page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.space-canvas')!;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let bright = 0;
    // City lights: warm pixels (red well above blue) on the night side.
    for (let i = 0; i < d.length; i += 40) if (d[i] > 120 && d[i] > d[i + 2] + 50) bright++;
    return bright;
  }), { timeout: 20_000 }).toBeGreaterThan(200);
  await page.click('#nav-settings');
  await expect(page.locator('#pref-background')).toHaveValue('earth-night');
  await page.selectOption('#pref-background', 'earth');
  await expect(page.locator('.space-background.bg-earth canvas')).toBeAttached();
  await page.selectOption('#pref-background', 'galaxy');
  await expect(page.locator('.space-background.bg-galaxy canvas')).toBeAttached();
  await page.selectOption('#pref-theme', 'galaxy');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'galaxy');
  await page.selectOption('#pref-background', 'custom');
  await expect(page.locator('label[for="pref-bg-file"]')).toBeVisible();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  await page.setInputFiles('#pref-bg-file', { name: 'mine.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.space-custom')).toBeAttached();
  await page.selectOption('#pref-background', 'off');
  await expect(page.locator('html')).toHaveAttribute('data-bg', 'off');
  await expect(page.locator('.space-background')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-bg', 'off');
  expect(errors).toEqual([]);
});

test('old daytime background setting moves to the night view once; panel see-through levels', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('terrax_background', '"earth"');
    }
  });
  const errors = await start(page);
  expect(await page.evaluate(() => localStorage.getItem('terrax_background'))).toBe('"earth-night"');
  await page.click('#nav-settings');
  await expect(page.locator('#pref-background')).toHaveValue('earth-night');
  await page.selectOption('#pref-background', 'earth'); // a deliberate choice is kept after reload
  await page.selectOption('#pref-panels', 'clear');
  await expect(page.locator('html')).toHaveAttribute('data-panels', 'clear');
  await page.reload();
  expect(await page.evaluate(() => localStorage.getItem('terrax_background'))).toBe('"earth"');
  await expect(page.locator('html')).toHaveAttribute('data-panels', 'clear');
  expect(errors).toEqual([]);
});

test('only visible cards blur the background, not the empty column below them', async ({ page }) => {
  const errors = await start(page);
  const blurred = await page.evaluate(() =>
    [...document.querySelectorAll('*')]
      .filter(e => getComputedStyle(e).backdropFilter !== 'none')
      .map(e => ({ cls: String(e.className), transparent: getComputedStyle(e).backgroundColor === 'rgba(0, 0, 0, 0)' })),
  );
  expect(blurred.length).toBeGreaterThan(3);
  expect(blurred.filter(b => b.transparent)).toEqual([]); // a transparent element would blur empty space
  expect(blurred.some(b => /^telemetry-panel$/.test(b.cls))).toBe(false);
  expect(errors).toEqual([]);
});

test('telemetry globe rotates while online and stops on target when offline', async ({ page, context }) => {
  const errors = await start(page);
  const globe = page.locator('canvas.globe');
  const snap = () => globe.evaluate((c: HTMLCanvasElement) => c.toDataURL());
  await expect(globe).toHaveAttribute('data-spinning', 'true');
  await expect(page.locator('.globe-status')).toContainText('rotating');
  const a = await snap();
  await page.waitForTimeout(400);
  expect(await snap()).not.toBe(a); // frames change while spinning

  await context.setOffline(true);
  await expect(globe).toHaveAttribute('data-spinning', 'false');
  await expect(page.locator('.globe-status')).toContainText('Offline');
  await page.waitForTimeout(150);
  const b = await snap();
  await page.waitForTimeout(400);
  expect(await snap()).toBe(b); // static when offline

  await context.setOffline(false);
  await expect(globe).toHaveAttribute('data-spinning', 'true');
  await page.click('.globe-spin-toggle');
  await expect(globe).toHaveAttribute('data-spinning', 'false');
  await expect(page.locator('.globe-status')).toContainText('paused');
  expect(errors).toEqual([]);
});

test('logo, opening animation and space pictures', async ({ page, request }) => {
  // The animation is skipped in automated browsers unless asked for with ?intro.
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/?intro=1');
  await expect(page.locator('[data-testid=intro]')).toBeVisible();
  await expect(page.locator('.intro-mark svg .logo-land')).toBeAttached(); // the turning Earth is drawn
  await page.click('.intro-skip');
  await expect(page.locator('[data-testid=intro]')).toHaveCount(0);
  await expect(page.locator('.gate-logo')).toBeVisible();
  expect(await page.locator('.gate-logo').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  // Without ?intro (and in this automated browser) it does not play.
  await page.goto('/');
  await expect(page.locator('#operator-name')).toBeVisible();
  await expect(page.locator('[data-testid=intro]')).toHaveCount(0);
  await page.fill('#operator-name', 'Test Operator');
  await page.click('button:has-text("Start session")');
  expect(await page.locator('.brand-logo').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await page.click('#nav-settings');
  // Every space picture and its thumbnail is served.
  await expect(page.locator('.bg-thumb')).toHaveCount(10);
  const ids = await page.locator('.bg-thumb').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.bg!));
  for (const id of ids)
    for (const f of [`${id}.webp`, `${id}.thumb.webp`]) {
      const r = await request.get(`/backgrounds/${f}`);
      expect(r.status(), f).toBe(200);
    }
  await page.click('.bg-thumb[data-bg=saturn]');
  await expect(page.locator('#pref-background')).toHaveValue('saturn');
  await expect(page.locator('.bg-thumb[data-bg=saturn]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.space-background.bg-image .space-image')).toHaveAttribute('style', /backgrounds\/saturn\.webp/);
  await page.selectOption('#pref-background', 'nebula');
  await expect(page.locator('.space-image')).toHaveAttribute('style', /nebula\.webp/);
  // The animation can be turned off; the choice is kept.
  await page.uncheck('#pref-intro');
  await page.reload();
  expect(await page.evaluate(() => [localStorage.getItem('terrax_intro'), localStorage.getItem('terrax_background')])).toEqual(['false', '"nebula"']);
  await expect(page.locator('.space-image')).toHaveAttribute('style', /nebula\.webp/);
  expect(errors).toEqual([]);
});

test('languages: every one loads, Arabic reads right to left while numbers and English content keep their order', async ({ page }) => {
  const errors = await start(page);
  await page.click('#nav-settings');
  await expect(page.locator('#pref-lang option')).toHaveCount(18);
  const codes = await page.locator('#pref-lang option').evaluateAll(els => els.map(e => (e as HTMLOptionElement).value));
  for (const code of codes) {
    await page.selectOption('#pref-lang', code);
    await expect(page.locator('html')).toHaveAttribute('lang', code);
    // The tab label changes from English (except in English itself) once the language has loaded.
    if (code !== 'en') await expect(page.locator('#settings-title')).not.toHaveText('Settings & guide');
  }
  await page.selectOption('#pref-lang', 'ar');
  await expect(page.locator('#settings-title')).toHaveText('الإعدادات والدليل');
  await expect(page.locator('#settings-title')).toHaveAttribute('dir', 'rtl');
  await page.keyboard.press('Escape');
  await expect(page.locator('.tool-card[data-name="Forest loss"] .tool-name')).toHaveText('فقدان الغابات');
  await expect(page.locator('.tool-card[data-name="Forest loss"] .tool-name')).toHaveAttribute('dir', 'rtl');
  // The page layout and the untranslated content stay left to right.
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  expect(await page.locator('.brand').innerText()).toBe('TERRAX');
  // The choice is kept after a reload.
  await page.reload();
  await expect(page.locator('#nav-settings')).toHaveText('الإعدادات');
  expect(errors).toEqual([]);
});
