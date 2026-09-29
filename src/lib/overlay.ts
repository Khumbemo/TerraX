// Turns an RGBA pixel buffer into a PNG data URL for a map overlay.
export function rgbaToDataUrl(rgba: Uint8ClampedArray, width: number, height: number): string | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(width, height);
  img.data.set(rgba.subarray(0, width * height * 4));
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/** Downsamples an RGBA buffer (nearest neighbour) so overlays stay small. */
export function shrinkRgba(rgba: Uint8ClampedArray, width: number, height: number, maxSide = 1024): { rgba: Uint8ClampedArray; width: number; height: number } {
  const s = Math.min(1, maxSide / Math.max(width, height));
  if (s === 1) return { rgba, width, height };
  const w = Math.max(1, Math.round(width * s));
  const h = Math.max(1, Math.round(height * s));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(y / s));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(x / s));
      out.set(rgba.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return { rgba: out, width: w, height: h };
}

export function mapImage(rgba: Uint8ClampedArray, width: number, height: number, bounds: [[number, number], [number, number]] | null, label: string, legend: { color: string; label: string }[]) {
  if (!bounds) return null;
  const small = shrinkRgba(rgba, width, height);
  const url = rgbaToDataUrl(small.rgba, small.width, small.height);
  return url ? { url, bounds, label, legend } : null;
}
