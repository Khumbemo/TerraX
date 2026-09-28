import { useEffect, useRef } from 'react';

interface Props {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  label: string;
  pixelated?: boolean;
}

/** Draws an RGBA pixel buffer to a canvas scaled to the container width. */
export default function RgbaCanvas({ rgba, width, height, label, pixelated = true }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(width, height);
    img.data.set(rgba.subarray(0, width * height * 4));
    ctx.putImageData(img, 0, 0);
  }, [rgba, width, height]);
  return <canvas ref={ref} className={`raster-canvas ${pixelated ? '' : 'smooth'}`} role="img" aria-label={label} />;
}
