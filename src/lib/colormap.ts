// Viridis (perceptually uniform, colour-blind safe), sampled at 11 stops
// from matplotlib's definition and linearly interpolated.
const VIRIDIS = ['#440154', '#482475', '#414487', '#355f8d', '#2a788e', '#21918c', '#22a884', '#44bf70', '#7ad151', '#bddf26', '#fde725'];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const STOPS = VIRIDIS.map(hexToRgb);

export const VIRIDIS_CSS = `linear-gradient(90deg, ${VIRIDIS.join(', ')})`;

export function viridis(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
}

/** Paints a value grid onto a canvas with viridis; NaN pixels are transparent. */
export function paintGrid(canvas: HTMLCanvasElement, data: Float32Array, width: number, height: number, min: number, max: number) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(width, height);
  const range = max - min || 1;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    const o = i * 4;
    if (Number.isNaN(v)) {
      img.data[o + 3] = 0;
      continue;
    }
    const [r, g, b] = viridis((v - min) / range);
    img.data[o] = r;
    img.data[o + 1] = g;
    img.data[o + 2] = b;
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
