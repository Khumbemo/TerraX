import { useMemo, useState } from 'react';
import { fetchSample } from '../../lib/samples';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import { analyzePhoto, type PhotoResult } from '../../lib/tools/photo';
import type { ToolOutput } from '../../lib/tools/registry';
import { formatBytes } from '../../lib/report';
import FileDrop from '../FileDrop';
import RgbaCanvas from '../RgbaCanvas';
import { Stat } from './ForestLossTool';

interface Props {
  onOutput: (out: ToolOutput | null) => void;
}

function markdown(p: PhotoResult): string {
  return [
    '## Dataset',
    '',
    `- File: ${p.filename} (${formatBytes(p.sizeBytes)}, ${p.width} × ${p.height} px, RGB image without georeferencing)`,
    '',
    '## Results',
    '',
    '| Measure | Value |',
    '|---|---|',
    `| Vegetation cover (ExG + Otsu) | ${(p.vegetationFraction * 100).toFixed(1)} % of the image |`,
    `| VARI mean ± SD | ${p.vari ? `${fmt(p.vari.mean)} ± ${fmt(p.vari.sd)}` : '—'} |`,
    `| Mean brightness (0–255) | ${fmt(p.brightness.mean)} |`,
    `| Mean R / G / B | ${fmt(p.channels.r.mean)} / ${fmt(p.channels.g.mean)} / ${fmt(p.channels.b.mean)} |`,
    '',
    '## Method and limits',
    '',
    ...p.notes.map(n => `- ${n}`),
  ].join('\n');
}

export default function PhotoTool({ onOutput }: Props) {
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PhotoResult | null>(null);
  const [showMask, setShowMask] = useState(false);

  const analyse = async (file: File) => {
    setBusy(true);
    try {
      const r = await analyzePhoto(file);
      setResult(r);
      setShowMask(false);
      onOutput({ tool: 'photo', name: file.name, markdown: markdown(r) });
    } catch (err) {
      notify(err instanceof Error ? err.message : `Could not read ${file.name}.`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const maskImage = useMemo(() => {
    if (!result) return null;
    const out = new Uint8ClampedArray(result.rgba.length);
    for (let i = 0; i < result.mask.length; i++) {
      const o = i * 4;
      if (result.rgba[o + 3] < 128) continue;
      if (result.mask[i]) out.set([52, 211, 153, 255], o);
      else {
        const l = 0.2126 * result.rgba[o] + 0.7152 * result.rgba[o + 1] + 0.0722 * result.rgba[o + 2];
        out.set([l * 0.35, l * 0.35, l * 0.4, 255], o);
      }
    }
    return out;
  }, [result]);

  return (
    <div className="tool-body">
      <p className="tool-intro">
        Upload an ordinary colour image: a satellite snapshot, a drone or aircraft photo, or an astronaut photo of Earth. TerraX estimates green cover from the visible
        bands. For calibrated NDVI, use Satellite imagery with a multispectral GeoTIFF.
      </p>
      <FileDrop id="photo-file" label="Image" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" hint="JPG · PNG · WebP" busy={busy} loaded={result?.filename} onFile={analyse} />
      <div className="param-row">
        {result && (
          <label className="check">
            <input id="photo-mask" type="checkbox" checked={showMask} onChange={e => setShowMask(e.target.checked)} /> Show vegetation mask
          </label>
        )}
        <div className="button-row push-right">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={async () => {
              try {
                await analyse(await fetchSample('samples/aerial_photo_synthetic.png', 'image/png'));
              } catch (err) {
                notify(err instanceof Error ? err.message : 'Could not load the sample.', 'error');
              }
            }}
          >
            Try synthetic photo
          </button>
        </div>
      </div>

      {result && maskImage && (
        <div className="result-block">
          <div className="stat-grid">
            <Stat label="Vegetation cover" value={`${(result.vegetationFraction * 100).toFixed(1)} %`} tone="good" />
            <Stat label="VARI mean" value={result.vari ? fmt(result.vari.mean) : '—'} />
            <Stat label="Brightness" value={`${fmt(result.brightness.mean)} / 255`} />
            <Stat label="Mean R · G · B" value={`${fmt(result.channels.r.mean, 3)} · ${fmt(result.channels.g.mean, 3)} · ${fmt(result.channels.b.mean, 3)}`} />
          </div>
          <figure className="raster-figure">
            <RgbaCanvas rgba={showMask ? maskImage : result.rgba} width={result.aw} height={result.ah} label={showMask ? 'Vegetation mask' : result.filename} pixelated={false} />
            {showMask && (
              <figcaption className="legend-row">
                <span>
                  <i className="class-swatch" style={{ background: '#34d399' }} /> Vegetation (ExG above threshold)
                </span>
              </figcaption>
            )}
          </figure>
          <ul className="hint-list">
            {result.notes.map(n => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
