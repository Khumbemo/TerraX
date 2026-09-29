// Decorative backgrounds drawn on a canvas:
//  • Earth from orbit: orthographic view of Natural Earth land, centred
//    south of the target so the target region sits on the visible upper
//    globe, lit by the real sun position (day/night terminator for now).
//    Land colours are illustrative, not imagery; there are no clouds or
//    city lights because no such data is bundled.
//  • Galaxy: procedural star field and Milky-Way-like band (not a real sky map).
import { solarAngles } from './solar';

const RAD = Math.PI / 180;

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

/** Subsolar point (degrees) for a date, from the NOAA solar position formulas. */
export function subsolarPoint(date: Date): { lat: number; lon: number } {
  const { declination, equationOfTime } = solarAngles(date);
  const utc = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let lon = (12 - utc - equationOfTime / 60) * 15;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat: declination, lon };
}

type Ring = number[][];
export interface LandShapes {
  features: { geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: Ring[] | Ring[][] } }[];
}

/** Rasterises land polygons to an equirectangular mask (1 = land). */
export function landMask(land: LandShapes, w = 2048, h = 1024): Uint8Array {
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
      g.beginPath();
      for (const ring of poly) {
        ring.forEach(([lon, lat], i) => (i ? g.lineTo(X(lon), Y(lat)) : g.moveTo(X(lon), Y(lat))));
        g.closePath();
      }
      g.fill('evenodd');
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

/** Earth seen from orbit, centred below `target`, lit by the sun at `date`. */
export function renderEarth(ctx: CanvasRenderingContext2D, w: number, h: number, mask: Uint8Array, target: { lat: number; lon: number }, date: Date) {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const MW = 2048, MH = 1024;
  const R = Math.max(w, h) * 0.95;
  const cx = w * 0.55, cy = h * 0.42 + R; // globe top at ~42 % of the height
  // Centre the view ~30° south of the target so it appears on the visible upper cap.
  const lat0 = Math.max(-80, Math.min(80, target.lat - 30)) * RAD, lon0 = target.lon * RAD;
  const sin0 = Math.sin(lat0), cos0 = Math.cos(lat0);
  const sun = subsolarPoint(date);
  const sl = sun.lat * RAD, sL = sun.lon * RAD;
  const sx = Math.cos(sl) * Math.cos(sL), sy = Math.cos(sl) * Math.sin(sL), sz = Math.sin(sl);
  const noise = makeNoise(11);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const k = (py * w + px) * 4;
      const x = (px - cx) / R, y = (cy - py) / R;
      const rho2 = x * x + y * y;
      if (rho2 >= 1) {
        // Space with a thin atmospheric glow above the limb.
        const t = Math.max(0, 1 - (Math.sqrt(rho2) - 1) * 60);
        d[k] = 2 + 30 * t * t;
        d[k + 1] = 4 + 90 * t * t;
        d[k + 2] = 10 + 170 * t * t;
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
      let ground: [number, number, number];
      const greenland = la > 59 && lo > -74 && lo < -11;
      if (la < -60 || (greenland && la > 61)) ground = [214, 222, 230];
      else if (la > 64) ground = [112 + 20 * n, 112 + 14 * n, 94 + 10 * n];
      else {
        const arid = Math.max(0, 1 - Math.abs(Math.abs(la) - 24) / 14) * (0.4 + 0.8 * n);
        ground = [52 + 110 * arid, 88 + 40 * arid, 50 + 30 * arid];
      }
      const base = ocean.map((o, i) => o + (ground[i] - o) * landFrac) as [number, number, number];
      const edge = Math.pow(1 - cosc, 2.2); // limb: atmosphere haze
      const light = 0.12 + 0.88 * day * (0.55 + 0.45 * Math.max(0, mu));
      d[k] = base[0] * light * (1 - edge * 0.5) + 40 * edge * (0.3 + day);
      d[k + 1] = base[1] * light * (1 - edge * 0.5) + 110 * edge * (0.3 + day);
      d[k + 2] = base[2] * light * (1 - edge * 0.5) + 200 * edge * (0.3 + day);
      if (day < 0.5) {
        const night = (0.5 - day) * 2;
        for (let ch = 0; ch < 3; ch++) d[k + ch] *= 1 - 0.75 * night;
        d[k + 2] += 6 * night;
      }
      d[k + 3] = 255;
    }
  }
  drawStars(img, Math.round((w * h) / 900), 5, (x, yy) => (x - cx) ** 2 + (yy - cy) ** 2 < R * R * 1.001);
  ctx.putImageData(img, 0, 0);
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
