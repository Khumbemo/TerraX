// Decorative backgrounds drawn on a canvas:
//  • Earth from orbit: orthographic view of Natural Earth land, centred
//    south of the target so the target region sits on the visible upper
//    globe. "live" lights it by the real sun position (day/night line now);
//    "night" shows the visible side at night with a dawn glow on one limb.
//    City lights are drawn from 49,025 GeoNames places (≥ 5,000 people):
//    each light's extent and brightness scale with population, so the
//    pattern follows where people live, as in night-time satellite
//    composites, but it is a model, not satellite night-light data.
//    Land colours are illustrative; there are no clouds.
//  • Galaxy: procedural star field and Milky-Way-like band (not a real sky map).

const RAD = Math.PI / 180;
/** Land mask size (equirectangular). 4096 × 2048 stays within every browser's canvas limit. */
const MASK_W = 4096, MASK_H = 2048;

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise in [0, 1) with a fixed lattice, plus fractal sum. */
function makeNoise(seed: number) {
  const r = rng(seed);
  const N = 256;
  const lat = Float32Array.from({ length: N * N }, () => r());
  const at = (x: number, y: number) => lat[((y & (N - 1)) * N + (x & (N - 1))) >>> 0];
  const s = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, y: number) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = s(x - x0), fy = s(y - y0);
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  return (x: number, y: number, oct = 5) => {
    let v = 0, amp = 0.5, f = 1, norm = 0;
    for (let o = 0; o < oct; o++) {
      v += amp * noise(x * f, y * f);
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return v / norm;
  };
}

type Ring = number[][];
export interface LandShapes {
  features: { geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: Ring[] | Ring[][] } }[];
}

/** Rasterises land polygons to an equirectangular mask (1 = land). */
export function landMask(land: LandShapes, w = MASK_W, h = MASK_H): Uint8Array {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  const X = (lon: number) => ((lon + 180) / 360) * w;
  const Y = (lat: number) => ((90 - lat) / 180) * h;
  for (const f of land.features) {
    const polys = (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates) as Ring[][];
    for (const poly of polys) {
      // Rings that cross the 180° meridian jump by ~360° in longitude; unwrap them so they stay
      // continuous, then draw the polygon shifted by −360°, 0 and +360° so both sides are filled.
      const unwrapped = poly.map(ring => {
        let off = 0;
        return ring.map(([lon, lat], i) => {
          if (i) {
            const prev = ring[i - 1][0];
            if (lon - prev > 180) off -= 360;
            else if (prev - lon > 180) off += 360;
          }
          return [lon + off, lat];
        });
      });
      for (const shift of [-360, 0, 360]) {
        g.beginPath();
        for (const ring of unwrapped) {
          ring.forEach(([lon, lat], i) => (i ? g.lineTo(X(lon + shift), Y(lat)) : g.moveTo(X(lon + shift), Y(lat))));
          g.closePath();
        }
        g.fill('evenodd');
      }
    }
  }
  const px = g.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4 + 3] > 127 ? 1 : 0;
  return mask;
}

function drawStars(img: ImageData, count: number, seed: number, skip?: (x: number, y: number) => boolean) {
  const { width: w, height: h, data } = img;
  const r = rng(seed);
  for (let i = 0; i < count; i++) {
    const x = Math.floor(r() * w), y = Math.floor(r() * h);
    if (skip?.(x, y)) continue;
    const b = r() ** 3;
    const warm = r();
    const col = warm < 0.2 ? [255, 214, 170] : warm > 0.85 ? [170, 200, 255] : [235, 240, 255];
    const k = (y * w + x) * 4;
    const a = 60 + b * 195;
    for (let c = 0; c < 3; c++) data[k + c] = Math.min(255, data[k + c] + (col[c] * a) / 255);
    if (b > 0.6 && x > 0 && y > 0 && x < w - 1 && y < h - 1) {
      for (const d of [-4, 4, -w * 4, w * 4]) for (let c = 0; c < 3; c++) data[k + d + c] = Math.min(255, data[k + d + c] + (col[c] * a) / 700);
    }
  }
}

/** Decodes the packed city table into lon, lat (degrees) and population arrays. */
export function decodeCities(b64: string, minPop: number): { lon: Float32Array; lat: Float32Array; pop: Float32Array } {
  const bin = atob(b64);
  const n = Math.floor(bin.length / 5);
  const lon = new Float32Array(n), lat = new Float32Array(n), pop = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 5;
    const u = bin.charCodeAt(o) | (bin.charCodeAt(o + 1) << 8);
    const v = bin.charCodeAt(o + 2) | (bin.charCodeAt(o + 3) << 8);
    lon[i] = (u / 65535) * 360 - 180;
    lat[i] = (v / 65535) * 180 - 90;
    pop[i] = minPop * 10 ** ((bin.charCodeAt(o + 4) / 255) * 4);
  }
  return { lon, lat, pop };
}

export type Cities = ReturnType<typeof decodeCities>;

/** Separable box blur of a float image, `passes` times (≈ Gaussian). */
function blur(src: Float32Array, w: number, h: number, r: number, passes = 3): Float32Array {
  let a = Float32Array.from(src);
  let b = new Float32Array(src.length);
  const norm = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      let acc = 0;
      const row = y * w;
      for (let x = -r; x <= r; x++) acc += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[row + x] = acc * norm;
        acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc * norm;
        acc += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
  }
  return a;
}

/** Earth seen from orbit, centred below `target`; "live" lights it from the subsolar point `sun`, "night" shows a night-side view. */
export function renderEarth(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  mask: Uint8Array,
  target: { lat: number; lon: number },
  /** Subsolar point (degrees), from the server's solar geometry. */
  sun: { lat: number; lon: number },
  mode: 'live' | 'night' = 'live',
  cities: Cities | null = null,
) {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const MW = MASK_W, MH = MASK_H;
  const R = Math.max(w, h) * 0.95;
  const horizon = 0.3; // globe top at 30 % of the height
  const cx = w * 0.5, cy = h * horizon + R;
  // Tilt the view so the target appears about 68 % down the screen, i.e. the
  // populated region around it fills the visible part of the globe.
  const rhoT = Math.max(0.2, Math.min(0.98, 1 - (h * (0.68 - horizon)) / R));
  const lat0 = Math.max(-85, Math.min(85, target.lat - Math.asin(rhoT) / RAD)) * RAD, lon0 = target.lon * RAD;
  const sin0 = Math.sin(lat0), cos0 = Math.cos(lat0);
  let sx: number, sy: number, sz: number;
  if (mode === 'night') {
    // Sun almost behind the globe, just beyond the top horizon: everything on screen is night,
    // with only a thin sunrise arc along the horizon (as in photos from the ISS).
    const cxv = cos0 * Math.cos(lon0), cyv = cos0 * Math.sin(lon0), czv = sin0;
    const nx0 = -sin0 * Math.cos(lon0), ny0 = -sin0 * Math.sin(lon0), nz0 = cos0; // north at the view centre
    const a = 174 * RAD;
    sx = Math.cos(a) * cxv + Math.sin(a) * nx0;
    sy = Math.cos(a) * cyv + Math.sin(a) * ny0;
    sz = Math.cos(a) * czv + Math.sin(a) * nz0;
  } else {
    const sl = sun.lat * RAD, sL = sun.lon * RAD;
    sx = Math.cos(sl) * Math.cos(sL);
    sy = Math.cos(sl) * Math.sin(sL);
    sz = Math.sin(sl);
  }
  // Night-side factor per pixel (0 day … 1 full night), used to place city lights.
  const nightAt = new Float32Array(w * h);
  const noise = makeNoise(11);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const k = (py * w + px) * 4;
      const x = (px - cx) / R, y = (cy - py) / R;
      const rho2 = x * x + y * y;
      if (rho2 >= 1) {
        // Space with a thin atmospheric glow above the limb, brighter where the limb is sunlit.
        const t = Math.max(0, 1 - (Math.sqrt(rho2) - 1) * 45);
        const lit = Math.max(0, Math.min(1, ((x * (sy * Math.cos(lon0) - sx * Math.sin(lon0)) + y * (sz * cos0 - (sx * Math.cos(lon0) + sy * Math.sin(lon0)) * sin0)) / Math.sqrt(rho2) + 0.35) / 0.7));
        const g = t * t * (0.35 + 0.65 * lit);
        d[k] = 2 + 45 * g;
        d[k + 1] = 4 + 120 * g;
        d[k + 2] = 10 + 230 * g;
        d[k + 3] = 255;
        continue;
      }
      const rho = Math.sqrt(rho2), c = Math.asin(rho);
      const sinc = Math.sin(c), cosc = Math.cos(c);
      const lat = rho ? Math.asin(cosc * sin0 + (y * sinc * cos0) / rho) : lat0;
      const lon = lon0 + (rho ? Math.atan2(x * sinc, rho * cosc * cos0 - y * sinc * sin0) : 0);
      const la = lat / RAD;
      let lo = lon / RAD;
      lo = ((((lo + 180) % 360) + 360) % 360) - 180;
      // Bilinear sample of the land mask for smooth coastlines.
      const fx = ((lo + 180) / 360) * MW - 0.5, fy = ((90 - la) / 180) * MH - 0.5;
      const x0 = Math.floor(fx), y0 = Math.max(0, Math.min(MH - 2, Math.floor(fy)));
      const tx = fx - x0, ty = Math.max(0, Math.min(1, fy - y0));
      const X0 = ((x0 % MW) + MW) % MW, X1 = (X0 + 1) % MW;
      const landFrac =
        mask[y0 * MW + X0] * (1 - tx) * (1 - ty) + mask[y0 * MW + X1] * tx * (1 - ty) + mask[(y0 + 1) * MW + X0] * (1 - tx) * ty + mask[(y0 + 1) * MW + X1] * tx * ty;
      const nx = Math.cos(lat) * Math.cos(lon), ny = Math.cos(lat) * Math.sin(lon), nz = Math.sin(lat);
      const mu = nx * sx + ny * sy + nz * sz; // cosine of the solar zenith angle
      const day = Math.min(1, Math.max(0, (mu + 0.08) / 0.3)); // soft twilight band
      const n = noise(lo * 0.08 + 50, la * 0.08 + 50);
      // Illustrative surface colours: ice sheets only on Antarctica and Greenland; tundra at high northern latitudes.
      const ocean: [number, number, number] = [14 + 8 * n, 48 + 12 * n, 96 + 20 * n];
      // Smooth blends between temperate, tundra and ice colours (no hard latitude edges).
      const sstep = (a: number, b: number, t: number) => {
        const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
        return x * x * (3 - 2 * x);
      };
      const arid = Math.max(0, 1 - Math.abs(Math.abs(la) - 24) / 14) * (0.4 + 0.8 * n);
      const temperate = [52 + 110 * arid, 88 + 40 * arid, 50 + 30 * arid];
      const tundra = [112 + 20 * n, 112 + 14 * n, 94 + 10 * n];
      const ice = [214, 222, 230];
      const tT = sstep(58, 70, la);
      const greenlandIce = la > 59 && lo > -74 && lo < -11 ? sstep(59, 64, la) : 0;
      const tI = Math.max(sstep(-58, -64, la), greenlandIce);
      const ground = temperate.map((t0, i) => {
        const g1 = t0 + (tundra[i] - t0) * tT;
        return g1 + (ice[i] - g1) * tI;
      }) as [number, number, number];
      const base = ocean.map((o, i) => o + (ground[i] - o) * landFrac) as [number, number, number];
      const edge = Math.pow(1 - cosc, 2.2); // limb: atmosphere haze
      const light = day * (0.55 + 0.45 * Math.max(0, mu));
      // Night surface: faint "moonlit" land and near-black ocean, as in night composites.
      const nightCol = [4 + 14 * landFrac + 4 * n, 8 + 16 * landFrac + 4 * n, 18 + 18 * landFrac + 6 * n];
      for (let ch = 0; ch < 3; ch++) d[k + ch] = nightCol[ch] * (1 - day) + base[ch] * light;
      const haze = edge * (0.25 + 0.75 * day);
      d[k] += 40 * haze;
      d[k + 1] += 110 * haze;
      d[k + 2] += 210 * haze;
      // Warm twilight band along the terminator.
      const dusk = Math.max(0, 1 - Math.abs(mu + 0.02) / 0.07) * 0.35;
      d[k] += 70 * dusk;
      d[k + 1] += 32 * dusk;
      d[k + 2] += 8 * dusk;
      d[k + 3] = 255;
      nightAt[py * w + px] = Math.min(1, Math.max(0, (-mu - 0.01) / 0.12)) * (1 - 0.6 * edge);
    }
  }
  if (cities) drawCityLights(d, w, h, cities, { cx, cy, R, lon0, sin0, cos0 }, nightAt);
  drawStars(img, Math.round((w * h) / 900), 5, (x, yy) => (x - cx) ** 2 + (yy - cy) ** 2 < R * R * 1.001);
  ctx.putImageData(img, 0, 0);
}

/**
 * Splats city lights on the night side: each place becomes a cluster of
 * small glows covering roughly its urban extent (radius ≈ 0.9 km ×
 * (population / 10,000)^0.45) with total brightness ∝ population^0.85,
 * then a blurred bloom is added. Tone-mapped with 1 − e^(−L).
 */
function drawCityLights(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  c: Cities,
  v: { cx: number; cy: number; R: number; lon0: number; sin0: number; cos0: number },
  nightAt: Float32Array,
) {
  const L = new Float32Array(w * h);
  const pxPerKm = v.R / 6371;
  const r = rng(17);
  const deposit = (x: number, y: number, amount: number) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) return;
    const fx = x - x0, fy = y - y0;
    L[y0 * w + x0] += amount * (1 - fx) * (1 - fy);
    L[y0 * w + x0 + 1] += amount * fx * (1 - fy);
    L[(y0 + 1) * w + x0] += amount * (1 - fx) * fy;
    L[(y0 + 1) * w + x0 + 1] += amount * fx * fy;
  };
  for (let i = 0; i < c.lon.length; i++) {
    const phi = c.lat[i] * RAD, dl = c.lon[i] * RAD - v.lon0;
    const cp = Math.cos(phi);
    const cosc = v.sin0 * Math.sin(phi) + v.cos0 * cp * Math.cos(dl);
    if (cosc <= 0.02) continue; // far side or edge-on
    const sx = v.cx + v.R * cp * Math.sin(dl);
    const sy = v.cy - v.R * (v.cos0 * Math.sin(phi) - v.sin0 * cp * Math.cos(dl));
    if (sx < -20 || sy < -20 || sx > w + 20 || sy > h + 20) continue;
    const night = nightAt[Math.min(h - 1, Math.max(0, Math.round(sy))) * w + Math.min(w - 1, Math.max(0, Math.round(sx)))];
    if (night <= 0.01) continue;
    const pop = c.pop[i];
    const radiusPx = 0.9 * Math.pow(pop / 1e4, 0.45) * pxPerKm;
    const total = 0.8 * Math.pow(pop / 5000, 0.85) * night * (0.4 + 0.6 * cosc);
    // Few sub-lights for towns, many for metropolises, so large cities get an organic, speckled shape.
    const nSub = Math.max(1, Math.min(600, Math.round(radiusPx * radiusPx * 1.5)));
    const per = total / nSub;
    for (let j = 0; j < nSub; j++) {
      // Gaussian offsets (Box–Muller), squashed toward the limb by cos c in the radial direction (approximation).
      const g1 = Math.sqrt(-2 * Math.log(1 - r())) * 0.55 * radiusPx;
      const t = r() * 2 * Math.PI;
      deposit(sx + g1 * Math.cos(t), sy + g1 * Math.sin(t) * (0.35 + 0.65 * cosc), per);
    }
  }
  const glowNear = blur(L, w, h, 1, 2);
  const bloom = blur(L, w, h, Math.max(2, Math.round(w / 300)), 3);
  for (let k = 0; k < w * h; k++) {
    const core = glowNear[k] * 0.9 + L[k] * 0.35;
    const halo = bloom[k] * 3.5;
    if (core + halo < 0.002) continue;
    const a = 1 - Math.exp(-core * 2.2);
    const hb = 1 - Math.exp(-halo);
    const o = k * 4;
    // Sodium orange at the edges, warm white in bright cores.
    const white = Math.min(1, core * 0.8);
    d[o] = Math.min(255, d[o] + 255 * a + 150 * hb);
    d[o + 1] = Math.min(255, d[o + 1] + (170 + 70 * white) * a + 80 * hb);
    d[o + 2] = Math.min(255, d[o + 2] + (70 + 120 * white) * a + 25 * hb);
  }
}

/** Procedural galaxy: star field with a dusty, glowing band across the sky. */
export function renderGalaxy(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const noise = makeNoise(23);
  const noise2 = makeNoise(29);
  // Band along a tilted line through the centre.
  const ang = -0.42, ca = Math.cos(ang), sa = Math.sin(ang);
  const span = Math.hypot(w, h);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const k = (py * w + px) * 4;
      const u = ((px - w / 2) * ca + (py - h / 2) * sa) / span; // along the band
      const v = (-(px - w / 2) * sa + (py - h / 2) * ca) / span; // across
      const n = noise(px / 160, py / 160);
      const width = 0.09 + 0.05 * noise2(px / 400, py / 400);
      const band = Math.exp(-(v * v) / (2 * width * width));
      const core = Math.exp(-((u + 0.08) ** 2) / 0.02) * Math.exp(-(v * v) / 0.004);
      const dust = Math.max(0, 1 - Math.abs(v + 0.012 * Math.sin(u * 20)) / 0.02) * (0.5 + noise2(px / 60, py / 60));
      const glow = band * (0.35 + 0.9 * n) * (1 - 0.8 * Math.min(1, dust)) + core * 0.9;
      const neb = Math.max(0, noise2(px / 260 + 7, py / 260 + 3) - 0.55) * 1.6;
      d[k] = 3 + 70 * glow + 120 * core + 60 * neb;
      d[k + 1] = 3 + 55 * glow + 90 * core + 10 * neb;
      d[k + 2] = 12 + 120 * glow + 60 * core + 90 * neb;
      d[k + 3] = 255;
    }
  }
  drawStars(img, Math.round((w * h) / 350), 9);
  // Extra faint stars concentrated in the band.
  const r = rng(13);
  for (let i = 0; i < (w * h) / 250; i++) {
    const u = (r() - 0.5) * 1.2, v = (r() + r() + r() - 1.5) * 0.08;
    const x = Math.round(w / 2 + (u * ca - v * sa) * span), y = Math.round(h / 2 + (u * sa + v * ca) * span);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const k = (y * w + x) * 4, a = 40 + r() * 120;
    d[k] = Math.min(255, d[k] + a);
    d[k + 1] = Math.min(255, d[k + 1] + a);
    d[k + 2] = Math.min(255, d[k + 2] + a);
  }
  ctx.putImageData(img, 0, 0);
}
