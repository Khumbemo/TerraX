// Figures for PDF reports: the tool's result map and the charts on screen,
// rendered to PNG in the browser.
import type { ToolOutput } from './tools/registry';

export interface ReportFigure {
  title: string;
  dataUrl: string;
  width: number;
  height: number;
}

const MAX_SIDE = 1000;
const MAX_CHARTS = 4;
const CHART_BG = '#0b1520';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not render a figure.'));
    img.src = src;
  });
}

async function toPng(src: string, w: number, h: number, background: string | null, scale = 1): Promise<ReportFigure['dataUrl']> {
  const img = await loadImage(src);
  const s = Math.min(scale, MAX_SIDE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d')!;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.imageSmoothingEnabled = !background ? false : true;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

export async function svgToPng(svg: SVGSVGElement): Promise<{ dataUrl: string; width: number; height: number } | null> {
  const box = svg.getBoundingClientRect();
  if (box.width < 10 || box.height < 10) return null;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(box.width));
  clone.setAttribute('height', String(box.height));
  clone.style.fontFamily = getComputedStyle(svg).fontFamily || 'sans-serif';
  const xml = new XMLSerializer().serializeToString(clone);
  const dataUrl = await toPng(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`, box.width, box.height, CHART_BG, 2);
  return { dataUrl, width: box.width, height: box.height };
}

function chartTitle(svg: Element): string {
  const win = svg.closest('.render-window');
  const eyebrow = win?.querySelector('.eyebrow')?.textContent?.trim();
  if (eyebrow) return eyebrow;
  const tab = svg.closest('.core-analysis-module')?.querySelector('[role=tab][aria-selected=true]')?.textContent?.trim();
  return tab ? `Chart: ${tab}` : 'Chart';
}

/** Collects the result map and up to four on-screen charts from the tool workspace. */
export async function collectFigures(output: ToolOutput, root: ParentNode = document): Promise<ReportFigure[]> {
  const figs: ReportFigure[] = [];
  const img = output.map?.image;
  if (img) {
    try {
      const el = await loadImage(img.url);
      figs.push({ title: `Map: ${img.label}${img.legend.length ? ` (${img.legend.map(l => l.label).join(', ')})` : ''}`, dataUrl: await toPng(img.url, el.naturalWidth, el.naturalHeight, null, 4), width: el.naturalWidth, height: el.naturalHeight });
    } catch {
      /* skip a figure that cannot be rendered */
    }
  }
  const svgs = Array.from(root.querySelectorAll<SVGSVGElement>('.tool-workspace svg.recharts-surface')).slice(0, MAX_CHARTS);
  for (const svg of svgs) {
    try {
      const png = await svgToPng(svg);
      if (png) figs.push({ title: chartTitle(svg), ...png });
    } catch {
      /* skip */
    }
  }
  return figs;
}
