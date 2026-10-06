import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MAP_SETTINGS, MAPS, gibsDefaultDate, mapDef, mapProblem, normaliseMapSettings, resolveBase, tileTemplates } from '../src/lib/basemaps';

const S = DEFAULT_MAP_SETTINGS;
const now = new Date('2026-10-02T03:00:00Z');

test('every map has a unique id, attribution or own-source note, and terms', () => {
  assert.equal(new Set(MAPS.map(m => m.id)).size, MAPS.length);
  for (const m of MAPS) {
    assert.ok(m.terms.length > 10, m.id);
    if (m.kind === 'raster' && !m.id.startsWith('custom')) {
      assert.ok(m.urls?.length, m.id);
      assert.ok(m.attribution.length > 5, m.id);
      for (const u of m.urls!) assert.match(u, /^https:\/\/.+\{z\}/, m.id);
    }
    if (m.kind === 'vector') assert.match(m.style!, /^https:\/\/tiles\.openfreemap\.org\/styles\//);
  }
  // Everything recommended is present.
  for (const id of ['osm', 'opentopomap', 'carto-dark', 'ofm-liberty', 'protomaps', 'stadia-dark', 'stamen-toner', 'maptiler-streets', 'gibs-modis', 'gibs-blackmarble', 'eox-2016', 'eox-2020', 'esri-imagery', 'custom-wms', 'offline']) assert.ok(MAPS.some(m => m.id === id), id);
});

test('templates: dates, keys and fallbacks', () => {
  assert.equal(gibsDefaultDate(now), '2026-10-01');
  const modis = tileTemplates(mapDef('gibs-modis'), S, now);
  assert.equal(modis.length, 2);
  assert.equal(modis[0], 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/2026-10-01/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg');
  assert.match(tileTemplates(mapDef('gibs-modis'), { ...S, gibsDate: '2024-03-15' }, now)[0], /\/2024-03-15\//);
  assert.match(tileTemplates(mapDef('gibs-blackmarble'), S, now)[0], /VIIRS_Black_Marble\/default\/2016-01-01\/GoogleMapsCompatible_Level8\/\{z\}\/\{y\}\/\{x\}\.png$/);
  assert.match(tileTemplates(mapDef('eox-2016'), S, now)[1], /s2cloudless-2016_3857\/default\/g\/\{z\}\/\{y\}\/\{x\}\.jpg$/);
  // MapTiler needs a key; Stadia works without one on registered domains.
  assert.deepEqual(tileTemplates(mapDef('maptiler-streets'), S, now), []);
  assert.match(mapProblem(mapDef('maptiler-streets'), S)!, /API key/);
  assert.equal(tileTemplates(mapDef('maptiler-streets'), { ...S, keys: { maptiler: 'k&1' } }, now)[0], 'https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}{r}.png?key=k%261');
  assert.equal(tileTemplates(mapDef('stadia-dark'), S, now)[0], 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png');
  assert.equal(tileTemplates(mapDef('stadia-dark'), { ...S, keys: { stadia: 'abc' } }, now)[0], 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png?api_key=abc');
  // Custom sources
  assert.deepEqual(tileTemplates(mapDef('custom-xyz'), { ...S, customXyz: { ...S.customXyz, url: 'not a url' } }, now), []);
  assert.equal(tileTemplates(mapDef('custom-xyz'), { ...S, customXyz: { ...S.customXyz, url: 'https://x.org/{z}/{x}/{y}.png' } }, now)[0], 'https://x.org/{z}/{x}/{y}.png');
  assert.match(mapProblem(mapDef('custom-wms'), S)!, /WMS address/);
});

test('settings are normalised and the automatic base follows the theme', () => {
  const n = normaliseMapSettings({ base: 'nope', overlays: [{ id: 'gibs-blackmarble', opacity: 7 }, { id: 'unknown', opacity: 0.5 }, { id: 'offline', opacity: 1 }], gibsDate: 'yesterday' });
  assert.equal(n.base, 'auto');
  assert.deepEqual(n.overlays, [{ id: 'gibs-blackmarble', opacity: 1 }]);
  assert.equal(n.gibsDate, '');
  assert.equal(resolveBase(n, 'light').id, 'carto-light');
  assert.equal(resolveBase(n, 'galaxy').id, 'carto-dark');
  assert.equal(resolveBase({ ...n, base: 'osm' }, 'dark').id, 'osm');
});
