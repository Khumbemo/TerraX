import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MAPS, normaliseMapSettings } from '../src/lib/basemaps';
import { BIOMES, KOPPEN, KOPPEN_LEGEND, MERCATOR_MAX_LAT, PLATE_CLASSES, PLATES, classFromColor, mercatorPixel, obliquityDeg, platePair } from '../src/lib/world-maps';

test('obliquity of the ecliptic follows IAU 2006', () => {
  // ε0 at J2000.0 is 84381.406″ = 23.4392794°.
  assert.ok(Math.abs(obliquityDeg(new Date('2000-01-01T12:00:00Z')) - 23.4392794) < 1e-6);
  // It falls by about 47″ per century: ≈ 23.4360° in late 2026.
  const e = obliquityDeg(new Date('2026-10-02T00:00:00Z'));
  assert.ok(Math.abs(e - (23.4392794 - (46.836769 * 26.75) / 100 / 3600)) < 1e-4, String(e));
});

test('Web Mercator pixel lookup', () => {
  assert.ok(Math.abs(MERCATOR_MAX_LAT - 85.0511288) < 1e-6);
  assert.deepEqual(mercatorPixel(0, 0, 4096), [2048, 2048]);
  assert.deepEqual(mercatorPixel(0, -180, 4096), [0, 2048]);
  assert.deepEqual(mercatorPixel(0, 180, 4096), [0, 2048]); // wraps to the antimeridian
  assert.equal(mercatorPixel(85.06, 0, 4096), null);
  assert.equal(mercatorPixel(Number.NaN, 0, 4096), null);
  const [, yN] = mercatorPixel(60, 10, 4096)!;
  // y = (1 − ln(tan(45° + φ/2))/π)/2 · size
  assert.equal(yN, Math.floor(((1 - Math.log(Math.tan(Math.PI / 4 + Math.PI / 6)) / Math.PI) / 2) * 4096));
});

test('class tables: 30 Köppen–Geiger classes, 15 biome classes, colours read back', () => {
  assert.equal(KOPPEN.length, 30);
  assert.equal(new Set(KOPPEN.map(k => k.code)).size, 30);
  assert.deepEqual(new Set(KOPPEN_LEGEND.map(k => k.code)), new Set(KOPPEN.map(k => k.code)));
  assert.equal(KOPPEN_LEGEND[0].code, 'Af');
  assert.equal(KOPPEN_LEGEND[29].code, 'EF');
  assert.equal(BIOMES.length, 15);
  assert.equal(new Set(KOPPEN.map(k => k.color)).size, 30); // every colour distinct, so a pixel names one class
  for (const [i, k] of KOPPEN.entries()) {
    const [r, g, b] = k.color.match(/\d+/g)!.map(Number);
    assert.equal(classFromColor(r, g, b, 255, KOPPEN), i + 1, k.code);
  }
  assert.equal(classFromColor(0, 0, 255, 0, KOPPEN), 0); // transparent = no data
  assert.equal(KOPPEN[classFromColor(1, 2, 250, 255, KOPPEN) - 1].code, 'Af'); // nearest colour
});

test('plate names and boundary classes (Bird 2003)', () => {
  assert.equal(Object.keys(PLATES).length, 52);
  assert.equal(Object.keys(PLATE_CLASSES).length, 7);
  assert.equal(platePair('AF-AN'), 'Africa – Antarctica');
  assert.equal(platePair('IN\\EU'), 'India – Eurasia');
  const fc = JSON.parse(readFileSync('public/data/maps/plates.json', 'utf8'));
  assert.ok(fc.features.length > 1000);
  for (const f of fc.features) {
    assert.ok(PLATE_CLASSES[f.properties.c], f.properties.c);
    for (const code of f.properties.b.split(/[-/\\]/)) assert.ok(PLATES[code], code);
    assert.ok(f.properties.v >= 0 && f.properties.v < 300, String(f.properties.v));
  }
  // The fastest boundary in PB2002 is the northern Tonga trench (~260 mm/yr; GPS gives ~240, Bevis et al. 1995).
  const fastest = fc.features.reduce((a: { properties: { v: number } }, b: { properties: { v: number } }) => (b.properties.v > a.properties.v ? b : a));
  assert.match(fastest.properties.b, /TO/);
});

test('built-in maps have their files and credits', () => {
  const builtin = MAPS.filter(m => m.kind === 'builtin');
  assert.equal(builtin.length, 12);
  for (const m of builtin) {
    if (m.file) assert.ok(existsSync(`public/data/maps/${m.file}`), m.file);
    if (m.id !== 'graticule') assert.ok(m.attribution.length > 10, m.id);
  }
  for (const f of ['admin1.json', 'rivers.json', 'lakes.json', 'places.json']) assert.ok(existsSync(`public/data/maps/${f}`), f);
  const places = JSON.parse(readFileSync('public/data/maps/places.json', 'utf8'));
  assert.ok(places.length > 7000);
  for (let i = 1; i < places.length; i++) assert.ok(places[i][3] >= places[i - 1][3], 'sorted by min_zoom');
  // Duplicated overlays are dropped when settings are loaded.
  assert.deepEqual(
    normaliseMapSettings({ overlays: [{ id: 'koppen', opacity: 0.7 }, { id: 'koppen', opacity: 0.5 }] }).overlays,
    [{ id: 'koppen', opacity: 0.7 }],
  );
});
