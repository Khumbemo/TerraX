// Generates the synthetic demo files in public/data/samples/.
// Run: node scripts/make-samples.mjs
// Every file is synthetic (made-up but physically plausible values) so each
// TerraX tool can be tried without real data. Do not use them as research data.
import { writeArrayBuffer } from 'geotiff';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../public/data/samples/', import.meta.url);
mkdirSync(OUT, { recursive: true });

// Deterministic pseudo-random numbers (mulberry32) so outputs are reproducible.
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Smooth value noise for natural-looking fields.
function noiseField(w, h, cell, seed) {
  const r = rng(seed);
  const gw = Math.ceil(w / cell) + 2;
  const gh = Math.ceil(h / cell) + 2;
  const g = Array.from({ length: gw * gh }, () => r());
  const s = t => t * t * (3 - 2 * t);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx = x / cell, gy = y / cell;
      const x0 = Math.floor(gx), y0 = Math.floor(gy);
      const fx = s(gx - x0), fy = s(gy - y0);
      const v00 = g[y0 * gw + x0], v10 = g[y0 * gw + x0 + 1], v01 = g[(y0 + 1) * gw + x0], v11 = g[(y0 + 1) * gw + x0 + 1];
      out[y * w + x] = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
    }
  return out;
}

// UTM zone 46N (EPSG:32646), south-west of Kohima; 30 m pixels.
const W = 240, H = 200, RES = 30, E0 = 603000, N0 = 2846000;
const geo = extra => ({
  width: W, height: H, ModelPixelScale: [RES, RES, 0], ModelTiepoint: [0, 0, 0, E0, N0, 0],
  GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32646, GDAL_NODATA: '-9999', ...extra,
});
async function writeTif(name, bands) {
  const n = W * H;
  const data = new Float32Array(n * bands.length);
  for (let i = 0; i < n; i++) for (let b = 0; b < bands.length; b++) data[i * bands.length + b] = bands[b][i];
  const buf = await writeArrayBuffer(data, geo({ SamplesPerPixel: bands.length, BitsPerSample: bands.map(() => 32), SampleFormat: bands.map(() => 3), PlanarConfiguration: 1 }));
  writeFileSync(new URL(name, OUT), Buffer.from(buf));
  console.log('wrote', name);
}

// ── Terrain: ridge-and-valley DEM, 1100–2100 m ──
const n1 = noiseField(W, H, 40, 7), n2 = noiseField(W, H, 12, 8);
const dem = new Float32Array(W * H);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const ridge = Math.exp(-(((x - 150) / 55) ** 2)) * 650;
    const valley = -Math.exp(-(((x - 60 - y * 0.2) / 18) ** 2)) * 180;
    dem[y * W + x] = 1250 + ridge + valley + n1[y * W + x] * 250 + n2[y * W + x] * 40;
  }
await writeTif('terrain_dem_synthetic.tif', [dem]);

// ── Forest: NDVI before (2016) and after (2024) with clearings and regrowth ──
const canopy = noiseField(W, H, 25, 11), fine = noiseField(W, H, 6, 12);
const before = new Float32Array(W * H), after = new Float32Array(W * H);
const r = rng(99);
const clearings = Array.from({ length: 7 }, () => ({ x: 30 + r() * 180, y: 20 + r() * 160, rx: 6 + r() * 14, ry: 5 + r() * 10 }));
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const k = y * W + x;
    const river = Math.abs(x - 60 - y * 0.2) < 3;
    const farm = x > 190 && y > 130;
    let v = river ? -0.1 : farm ? 0.3 + fine[k] * 0.1 : 0.62 + canopy[k] * 0.2 + fine[k] * 0.05;
    before[k] = v;
    const cleared = clearings.some(c => ((x - c.x) / c.rx) ** 2 + ((y - c.y) / c.ry) ** 2 < 1);
    if (cleared && !river && !farm) v = 0.18 + fine[k] * 0.15;
    else if (farm && x > 215) v = 0.62 + fine[k] * 0.08; // abandoned field regrowing
    else v += (fine[k] - 0.5) * 0.04; // small year-to-year noise
    after[k] = v;
  }
await writeTif('forest_ndvi_2016_synthetic.tif', [before]);
await writeTif('forest_ndvi_2024_synthetic.tif', [after]);

// ── Burn: pre- and post-fire NBR with a graded fire scar and some regrowth ──
const pre = new Float32Array(W * H), post = new Float32Array(W * H);
const nb = noiseField(W, H, 9, 21);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const k = y * W + x;
    const river = Math.abs(x - 60 - y * 0.2) < 3;
    const base = river ? -0.2 : 0.3 + canopy[k] * 0.3;
    pre[k] = base;
    // Elliptical scar centred at (150, 90); severity falls from the core outwards.
    const d = Math.sqrt(((x - 150) / 60) ** 2 + ((y - 90) / 42) ** 2);
    let dnbr = (nb[k] - 0.5) * 0.06; // background noise
    if (!river && d < 1) dnbr = 0.08 + 0.72 * (1 - d) ** 0.8 + (nb[k] - 0.5) * 0.1;
    if (!river && x < 45 && y > 150) dnbr = -0.18 + (nb[k] - 0.5) * 0.05; // regrowth on an old clearing
    post[k] = Math.max(-1, Math.min(1, base - dnbr));
  }
await writeTif('burn_nbr_pre_synthetic.tif', [pre]);
await writeTif('burn_nbr_post_synthetic.tif', [post]);

// ── Series: six dated NDVI images (same March season) with slow canopy loss ──
{
  const SW = 60, SH = 50;
  const sn = noiseField(SW, SH, 8, 31);
  const dates = ['2019-03-10', '2020-03-14', '2021-03-09', '2022-03-12', '2023-03-15', '2024-03-11'];
  for (let t = 0; t < dates.length; t++) {
    const r = rng(40 + t);
    const band = new Float32Array(SW * SH);
    for (let k = 0; k < band.length; k++) {
      const x = k % SW;
      // A clearing front advances from the east edge ~4 px per year.
      const cleared = x > SW - 4 - 4 * t;
      band[k] = (cleared ? 0.25 : 0.72) + (sn[k] - 0.5) * 0.12 + (r() - 0.5) * 0.04;
    }
    const buf = await writeArrayBuffer(band, {
      width: SW, height: SH, ModelPixelScale: [RES, RES, 0], ModelTiepoint: [0, 0, 0, E0, N0, 0],
      GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32646, GDAL_NODATA: '-9999',
      SamplesPerPixel: 1, BitsPerSample: [32], SampleFormat: [3], PlanarConfiguration: 1,
    });
    writeFileSync(new URL(`series_ndvi_${dates[t]}_synthetic.tif`, OUT), Buffer.from(buf));
  }
  console.log('wrote 6 series_ndvi_*_synthetic.tif');
}

// ── Satellite: 4-band surface reflectance ×10,000 (B2 blue, B3 green, B4 red, B8 NIR) ──
const blue = new Float32Array(W * H), green = new Float32Array(W * H), red = new Float32Array(W * H), nir = new Float32Array(W * H);
for (let k = 0; k < W * H; k++) {
  const x = k % W, y = Math.floor(k / W);
  const river = Math.abs(x - 60 - y * 0.2) < 4;
  const town = (x - 200) ** 2 + (y - 40) ** 2 < 22 ** 2;
  const f = canopy[k];
  if (river) [blue[k], green[k], red[k], nir[k]] = [700, 900, 600, 350];
  else if (town) [blue[k], green[k], red[k], nir[k]] = [1300 + fine[k] * 300, 1400 + fine[k] * 300, 1500 + fine[k] * 300, 2100 + fine[k] * 300];
  else [blue[k], green[k], red[k], nir[k]] = [300 + (1 - f) * 250, 550 + (1 - f) * 250, 350 + (1 - f) * 500, 2800 + f * 1500];
}
await writeTif('satellite_4band_synthetic.tif', [blue, green, red, nir]);

// ── Survey: a fictional plot boundary (GeoJSON) around the largest clearing,
// inside the forest rasters so it can be used as an analysis boundary ──
const plot = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'Sample plot A (fictional)' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[94.05731, 25.68768], [94.05167, 25.68095], [94.04299, 25.68286], [94.04373, 25.69222], [94.05166, 25.6941], [94.05731, 25.68768]]],
      },
    },
  ],
};
writeFileSync(new URL('survey_plot_synthetic.geojson', OUT), JSON.stringify(plot, null, 2));
console.log('wrote survey_plot_synthetic.geojson');

// ── Photo: a synthetic aerial RGB image (PNG) with forest, fields and a river ──
function png(w, h, rgb) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = buf => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = rgb[y * w * 3 + x];
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PW = 480, PH = 320;
const pn = noiseField(PW, PH, 30, 21), pf = noiseField(PW, PH, 5, 22);
const img = new Uint8Array(PW * PH * 3);
for (let y = 0; y < PH; y++)
  for (let x = 0; x < PW; x++) {
    const k = y * PW + x;
    const river = Math.abs(x - 140 - Math.sin(y / 40) * 30) < 9;
    const field = x > 300 && ((Math.floor(x / 45) + Math.floor(y / 50)) % 2 === 0);
    let c;
    if (river) c = [60, 90, 110];
    else if (field) c = [150 + pf[k] * 30, 125 + pf[k] * 25, 85 + pf[k] * 20];
    else c = [40 + pn[k] * 40 + pf[k] * 15, 85 + pn[k] * 60 + pf[k] * 20, 40 + pn[k] * 25];
    img.set(c.map(v => Math.max(0, Math.min(255, Math.round(v)))), k * 3);
  }
writeFileSync(new URL('aerial_photo_synthetic.png', OUT), png(PW, PH, img));
console.log('wrote aerial_photo_synthetic.png');
