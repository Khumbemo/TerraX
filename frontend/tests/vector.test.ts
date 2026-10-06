import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drawnPolygon, editableVertices, formatAreaM2, formatLength, magneticBearing, polygonFeatures, toGpx, toKml } from '../src/lib/vector';

test('vector exports and drawn polygons', () => {
  const fc = drawnPolygon([[25.6, 94.1], [25.6, 94.2], [25.7, 94.2]], 'Plot <A>');
  const ring = (fc.features[0].geometry as { coordinates: number[][][] }).coordinates[0];
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.deepEqual(ring[0], [94.1, 25.6]);
  assert.deepEqual(editableVertices(fc), [[25.6, 94.1], [25.6, 94.2], [25.7, 94.2]]);
  assert.throws(() => drawnPolygon([[1, 2], [3, 4]], 'x'), /three points/);
  const kml = toKml(fc, 'Plot <A>');
  assert.match(kml, /<name>Plot &lt;A&gt;<\/name>/);
  assert.match(kml, /<outerBoundaryIs><LinearRing><coordinates>94.1,25.6 94.2,25.6 94.2,25.7 94.1,25.6<\/coordinates>/);
  const gpx = toGpx({ type: 'FeatureCollection', features: [...fc.features, { type: 'Feature', properties: { name: 'W1' }, geometry: { type: 'Point', coordinates: [94.15, 25.65, 1200] } }] }, 'x');
  assert.match(gpx, /<wpt lat="25.65" lon="94.15"><ele>1200<\/ele><name>W1<\/name><\/wpt>/);
  assert.equal((gpx.match(/<trkpt /g) ?? []).length, 4);
  assert.equal(polygonFeatures({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'GeometryCollection', geometries: [fc.features[0].geometry] } }] }).features.length, 1);
});

test('survey display helpers', () => {
  assert.equal(magneticBearing(10, 15), 355);
  assert.equal(magneticBearing(350, -15), 5);
  assert.equal(formatLength(1234.5), '1.2345 km');
  assert.equal(formatLength(12.3), '12.3 m');
  assert.match(formatAreaM2(5000), /^5,000 m² \(0.5 ha, 1.236 acres\)$/);
});
