import { useEffect, useRef } from 'react';

interface Props {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  label: string;
  pixelated?: boolean;
  /** Called with the clicked pixel (column, row). */
  onPick?: (col: number, row: number) => void;
}

/** Draws an RGBA pixel buffer to a canvas scaled to the container width. */
export default function RgbaCanvas({ rgba, width, height, label, pixelated = true, onPick }: Props) {
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
  return (
    <canvas
      ref={ref}
      className={`raster-canvas ${pixelated ? '' : 'smooth'} ${onPick ? 'pickable' : ''}`}
      role="img"
      aria-label={label}
      onClick={
        onPick
          ? e => {
              const b = e.currentTarget.getBoundingClientRect();
              const col = Math.floor(((e.clientX - b.left) / b.width) * width);
              const row = Math.floor(((e.clientY - b.top) / b.height) * height);
              if (col >= 0 && row >= 0 && col < width && row < height) onPick(col, row);
            }
          : undefined
      }
    />
  );
}
