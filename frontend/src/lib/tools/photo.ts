// Ordinary RGB images (JPG/PNG/WebP) from satellites, drones, aircraft or
// the ISS. There is no georeferencing or calibrated reflectance, so only
// visible-band indices are possible:
//  - VARI = (G − R) / (G + R − B)          Gitelson et al. (2002)
//  - ExG  = 2g − r − b on chromatic coordinates (r = R/(R+G+B), …)
//                                           Woebbecke et al. (1995)
// Vegetation cover is estimated by Otsu (1979) thresholding of ExG.
import { summarize } from '../stats';
import type { NumericSummary } from '../types';

const MAX_SIDE = 1024;

export interface PhotoResult {
  filename: string;
  sizeBytes: number;
  width: number;
  height: number;
  /** Width/height of the analysis copy (downsampled for speed). */
  aw: number;
  ah: number;
  rgba: Uint8ClampedArray;
  channels: { r: NumericSummary; g: NumericSummary; b: NumericSummary };
  vari: NumericSummary | null;
  exgThreshold: number;
  vegetationFraction: number;
  /** 1 = classified as vegetation, 0 = other, per analysis pixel. */
  mask: Uint8Array;
  brightness: NumericSummary;
  notes: string[];
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall back to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function otsu(values: Float32Array, bins = 256): number {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!(max > min)) return max;
  const hist = new Array(bins).fill(0);
  const w = (max - min) / bins;
  for (const v of values) hist[Math.min(bins - 1, Math.floor((v - min) / w))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 0;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) {
      best = between;
      thr = i;
    }
  }
  return min + (thr + 1) * w;
}

export async function analyzePhoto(file: File): Promise<PhotoResult> {
  let img: ImageBitmap | HTMLImageElement;
  try {
    img = await decode(file);
  } catch {
    throw new Error(`${file.name} could not be decoded as an image. Use JPG, PNG or WebP (for GeoTIFFs use the Satellite imagery tool).`);
  }
  const width = 'naturalWidth' in img ? img.naturalWidth : img.width;
  const height = 'naturalHeight' in img ? img.naturalHeight : img.height;
  const s = Math.min(1, MAX_SIDE / Math.max(width, height));
  const aw = Math.max(1, Math.round(width * s));
  const ah = Math.max(1, Math.round(height * s));
  const canvas = document.createElement('canvas');
  canvas.width = aw;
  canvas.height = ah;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser cannot read image pixels.');
  ctx.drawImage(img, 0, 0, aw, ah);
  const rgba = ctx.getImageData(0, 0, aw, ah).data;

  const n = aw * ah;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), L = new Float32Array(n);
  const exg = new Float32Array(n);
  const vari: number[] = [];
  let opaque = 0;
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3] < 128) continue;
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    R[opaque] = r;
    G[opaque] = g;
    B[opaque] = b;
    L[opaque] = 0.2126 * r + 0.7152 * g + 0.0722 * b; // Rec. 709 luma (gamma-encoded)
    const sum = r + g + b;
    exg[opaque] = sum > 0 ? (2 * g - r - b) / sum : 0;
    const d = g + r - b;
    if (Math.abs(d) >= 1) {
      const v = (g - r) / d;
      if (v >= -1 && v <= 1) vari.push(v);
    }
    opaque++;
  }
  if (!opaque) throw new Error(`${file.name} has no visible pixels.`);
  const exgValid = exg.subarray(0, opaque);
  const thr = Math.max(0, otsu(exgValid));
  const mask = new Uint8Array(n);
  let veg = 0;
  for (let i = 0, j = 0; i < n; i++) {
    if (rgba[i * 4 + 3] < 128) continue;
    if (exg[j] > thr) {
      mask[i] = 1;
      veg++;
    }
    j++;
  }

  return {
    filename: file.name,
    sizeBytes: file.size,
    width,
    height,
    aw,
    ah,
    rgba,
    channels: { r: summarize(R.subarray(0, opaque))!, g: summarize(G.subarray(0, opaque))!, b: summarize(B.subarray(0, opaque))! },
    vari: summarize(vari),
    exgThreshold: thr,
    vegetationFraction: veg / opaque,
    mask,
    brightness: summarize(L.subarray(0, opaque))!,
    notes: [
      'VARI = (G − R) / (G + R − B) (Gitelson et al. 2002); ExG = 2g − r − b on chromatic coordinates (Woebbecke et al. 1995).',
      `Vegetation cover: pixels with ExG above an Otsu (1979) threshold of ${thr.toFixed(3)} (never below 0).`,
      'Ordinary images have no calibrated reflectance, georeferencing or near-infrared band: haze, shadows, white balance and JPEG compression change the result. Treat it as a relative estimate; use the Satellite imagery tool with multispectral GeoTIFFs for NDVI.',
      width !== aw ? `Analysed at ${aw}×${ah} (downsampled from ${width}×${height}).` : 'Analysed at full resolution.',
    ],
  };
}
