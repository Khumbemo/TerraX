import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProject, mergeReports, parseProject } from '../src/lib/project';

const rep = (id: string, createdAt: string, title = id) => ({ id, title, datasetName: 'd', createdAt, source: 'local' as const, content: '# x' });

test('project round trip, validation and report merging', () => {
  const boundary = { name: 'Plot', areaM2: 100, geojson: { type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }] } };
  const p = buildProject({ target: { lat: 25.6, lon: 94.1, name: 'Kohima' }, boundary, reports: [rep('a', '2025-01-01')], preferences: { declination: '-1.2' } });
  const back = parseProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(back.boundary, boundary);
  assert.equal(back.reports.length, 1);
  assert.equal(back.preferences.declination, '-1.2');
  assert.ok(!JSON.stringify(p).includes('api_key'));
  assert.throws(() => parseProject({ format: 'other' }), /not a TerraX project/);
  assert.throws(() => parseProject({ format: 'terrax-project', version: 99 }), /newer TerraX/);
  const bad = parseProject({ format: 'terrax-project', version: 1, target: { lat: 200, lon: 0 }, boundary: { name: 'x', areaM2: 1, geojson: { type: 'FeatureCollection', features: [{ geometry: { type: 'Point' } }] } }, reports: [{ id: 1 }, rep('b', '2025-02-01')] });
  assert.equal(bad.target, null);
  assert.equal(bad.boundary, null);
  assert.equal(bad.reports.length, 1);
  const m = mergeReports([rep('a', '2025-01-01', 'old'), rep('c', '2024-06-01')], [rep('a', '2025-03-01', 'new'), rep('b', '2025-02-01')]);
  assert.equal(m.added, 1);
  assert.deepEqual(m.reports.map(r => r.id), ['a', 'b', 'c']);
  assert.equal(m.reports[0].title, 'new');
});
