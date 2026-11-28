import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { DEPTH_CLASSES, FRP_CLASSES, ago, fireCollection, fireHtml, quakeFeedLabel, quakeHtml, utc, viewKey, weatherGlyph, weatherHtml, type FireRow, type QuakeProps, type WeatherPoint } from '../src/lib/earth';

// The backend's recordings of real responses (backend/tests/fixtures/earth).
const usgs = JSON.parse(readFileSync(new URL('../../backend/tests/fixtures/earth/usgs_2.5_day.json', import.meta.url), 'utf8'));

test('quake popup from a real USGS feature, as the server passes it on', () => {
  const f = usgs.features.find((x: { id: string }) => x.id === 'us6000ue2m');
  const p: QuakeProps = {
    id: f.id,
    mag: f.properties.mag,
    magType: f.properties.magType,
    place: f.properties.place,
    time: f.properties.time,
    depthKm: f.geometry.coordinates[2],
    alert: f.properties.alert,
    tsunami: f.properties.tsunami === 1,
    sig: f.properties.sig,
    status: f.properties.status,
    type: f.properties.type,
    url: f.properties.url,
  };
  const html = quakeHtml(p, p.time! + 30 * 60_000);
  assert.match(html, /M 2\.7/);
  assert.match(html, /34 km SE of Malaga, New Mexico/);
  assert.match(html, /Depth 8\.3 km · reviewed/);
  assert.match(html, /30 min ago/);
  assert.match(html, /href="https:\/\/earthquake\.usgs\.gov\/earthquakes\/eventpage\/us6000ue2m"/);
  assert.doesNotMatch(html, /PAGER|Tsunami/);
  // the USGS time is ms since the epoch in UTC
  assert.equal(utc(1795849848993), new Date(1795849848993).toISOString().slice(0, 16).replace('T', ' ') + ' UTC');
});

test('popup text is escaped', () => {
  const html = quakeHtml({ id: 'x', mag: 5, magType: '<b>', place: '<img src=x onerror=alert(1)>', time: null, depthKm: null, alert: 'red', tsunami: true, sig: null, status: null, type: 'earthquake', url: null });
  assert.doesNotMatch(html, /<img|<b>/);
  assert.match(html, /PAGER alert: <strong>red/);
  assert.match(html, /does not|tsunami\.gov/);
});

test('fire rows become points and popups keep the units FIRMS uses', () => {
  const rows: FireRow[] = [
    [29.24614, -1.51695, 0.6, 'nominal', '2026-11-27T00:00Z', 'N'],
    [126.69572, 36.98157, 9.84, 61, '2026-11-27T00:22Z', 'D'],
    [10, 10, null, null, '', ''],
  ];
  const fc = fireCollection(rows);
  assert.equal(fc.features.length, 3);
  assert.deepEqual(fc.features[0].geometry.coordinates, [29.24614, -1.51695]);
  const p0 = fc.features[0].properties as { frp: number; hasFrp: boolean; conf: string; when: string; dn: string };
  assert.match(fireHtml(p0, 'VIIRS 375 m, NOAA-20'), /FRP 0\.6 MW · confidence nominal/);
  assert.match(fireHtml(p0, 'x'), /2026-11-27 00:00 UTC · night overpass/);
  assert.match(fireHtml(fc.features[1].properties as never, 'MODIS'), /confidence 61 %/);
  assert.match(fireHtml(fc.features[2].properties as never, 'x'), /FRP — · confidence —/);
});

test('weather popup and glyphs follow the WMO code groups', () => {
  assert.equal(weatherGlyph(0, true), '☀');
  assert.equal(weatherGlyph(0, false), '☾');
  assert.equal(weatherGlyph(61), '☂');
  assert.equal(weatherGlyph(75), '❄');
  assert.equal(weatherGlyph(95), '⚡');
  assert.equal(weatherGlyph(45), '≡');
  const p: WeatherPoint = {
    lat: 52.52, lon: 13.41, gridLat: 52.512604, gridLon: 13.419517, modelElevation: 38, timezone: 'Europe/Berlin', time: '2026-11-28T08:15',
    temperature: -0.1, code: 2, text: 'Partly cloudy', isDay: true, windSpeed: 12.3, windDirection: 97, date: '2026-11-28', dayCode: 3, dayText: 'Overcast',
    tMax: 1.3, tMin: -2.4, precipitation: 0, precipitationProbability: 0, units: { temperature: '°C', wind: 'km/h', precipitation: 'mm' },
  };
  const html = weatherHtml(p);
  assert.match(html, /-0\.1 °C<\/strong> · Partly cloudy/);
  assert.match(html, /Today \(2026-11-28\): Overcast, -2\.4 to 1\.3 °C/);
  assert.match(html, /Wind 12\.3 km\/h from 97°/);
  assert.match(html, /2026-11-28 08:15 local time \(Europe\/Berlin\)/);
});

test('labels, bins and view keys', () => {
  assert.equal(quakeFeedLabel('2.5_day'), 'M2.5+, past day');
  assert.equal(quakeFeedLabel('significant_month'), 'Significant, past 30 days');
  for (const bins of [DEPTH_CLASSES, FRP_CLASSES]) for (let i = 1; i < bins.length; i++) assert.ok(bins[i].max > bins[i - 1].max);
  assert.equal(viewKey({ west: 10.01, south: 45.1, east: 11.99, north: 47.05 }), viewKey({ west: 10.04, south: 45.04, east: 11.96, north: 46.99 }));
  assert.equal(ago(0, 3 * 3600_000), '3 h ago');
  assert.equal(ago(0, 5 * 86400_000), '5 days ago');
});
