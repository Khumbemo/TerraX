import { useMemo, useState } from 'react';
import { readExif, type ExifInfo } from '../../lib/exif';
import { toDms } from '../../lib/geo';
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

interface Photo {
  result: PhotoResult;
  exif: ExifInfo | null;
}

function exifLine(e: ExifInfo | null): string | null {
  if (!e) return null;
  const parts = [
    e.make || e.model ? `camera ${[e.make, e.model].filter(Boolean).join(' ')}` : null,
    e.dateTime ? `taken ${e.dateTime.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')} (camera clock)` : null,
    e.lat !== null && e.lon !== null ? `GPS ${e.lat.toFixed(6)}, ${e.lon.toFixed(6)}${e.altitude !== null ? `, ${fmt(e.altitude)} m` : ''}` : null,
  ].filter(Boolean);
  return parts.length ? `- EXIF: ${parts.join('; ')}` : null;
}

function markdown(ph: Photo, other: Photo | null): string {
  const p = ph.result;
  const lines = [
    '## Dataset',
    '',
    `- File: ${p.filename} (${formatBytes(p.sizeBytes)}, ${p.width} × ${p.height} px, RGB image without georeferencing)`,
    ...[exifLine(ph.exif)].filter((x): x is string => Boolean(x)),
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
  ];
  if (other) {
    const q = other.result;
    lines.push(
      `### Compared with ${q.filename}`,
      '',
      '| Measure | This photo | Other photo | Change |',
      '|---|---|---|---|',
      `| Vegetation cover | ${(p.vegetationFraction * 100).toFixed(1)} % | ${(q.vegetationFraction * 100).toFixed(1)} % | ${((q.vegetationFraction - p.vegetationFraction) * 100).toFixed(1)} percentage points |`,
      `| VARI mean | ${p.vari ? fmt(p.vari.mean) : '—'} | ${q.vari ? fmt(q.vari.mean) : '—'} | ${p.vari && q.vari ? fmt(q.vari.mean - p.vari.mean) : '—'} |`,
      `| Mean brightness | ${fmt(p.brightness.mean)} | ${fmt(q.brightness.mean)} | ${fmt(q.brightness.mean - p.brightness.mean)} |`,
      '',
      ...[exifLine(other.exif)].filter((x): x is string => Boolean(x)),
      '- The comparison is of whole-image fractions; the photos are not co-registered. It is meaningful only for the same scene and framing, similar light and camera settings. A large brightness change is a warning sign.',
      '',
    );
  }
  lines.push('## Method and limits', '', ...p.notes.map(n => `- ${n}`));
  return lines.join('\n');
}

function photoMap(photos: Photo[]): ToolOutput['map'] {
  const pts = photos.filter(p => p.exif?.lat != null && p.exif?.lon != null);
  if (!pts.length) return undefined;
  const lats = pts.map(p => p.exif!.lat!), lons = pts.map(p => p.exif!.lon!);
  const pad = 0.002;
  return {
    bounds: [
      [Math.min(...lats) - pad, Math.min(...lons) - pad],
      [Math.max(...lats) + pad, Math.max(...lons) + pad],
    ],
    geojson: {
      type: 'FeatureCollection',
      features: pts.map(p => ({ type: 'Feature', properties: { name: p.result.filename }, geometry: { type: 'Point', coordinates: [p.exif!.lon!, p.exif!.lat!] } })),
    },
  };
}

async function loadPhoto(file: File): Promise<Photo> {
  const [result, buf] = await Promise.all([analyzePhoto(file), file.arrayBuffer()]);
  let exif: ExifInfo | null = null;
  try {
    exif = readExif(buf);
  } catch {
    exif = null; // malformed EXIF is not fatal
  }
  return { result, exif };
}

export default function PhotoTool({ onOutput }: Props) {
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [other, setOther] = useState<Photo | null>(null);
  const [showMask, setShowMask] = useState(false);
  const result = photo?.result ?? null;

  const publish = (a: Photo, b: Photo | null) =>
    onOutput({ tool: 'photo', name: b ? `${a.result.filename} vs ${b.result.filename}` : a.result.filename, markdown: markdown(a, b), map: photoMap(b ? [a, b] : [a]) });

  const analyseOther = async (file: File) => {
    if (!photo) return;
    setBusy(true);
    try {
      const b = await loadPhoto(file);
      setOther(b);
      publish(photo, b);
    } catch (err) {
      notify(err instanceof Error ? err.message : `Could not read ${file.name}.`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const analyse = async (file: File) => {
    setBusy(true);
    try {
      const a = await loadPhoto(file);
      setPhoto(a);
      setOther(null);
      setShowMask(false);
      publish(a, null);
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

      {result && (
        <FileDrop id="photo-compare" compact label="Compare with a second photo (optional)" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" hint="Same scene, later date" busy={false} loaded={other?.result.filename} onFile={analyseOther} />
      )}

      {result && maskImage && (
        <div className="result-block">
          {photo?.exif && (photo.exif.lat !== null || photo.exif.dateTime) && (
            <p className="field-hint" id="photo-exif">
              {photo.exif.lat !== null && photo.exif.lon !== null ? `Location from EXIF: ${toDms(photo.exif.lat, 'N', 'S')}, ${toDms(photo.exif.lon, 'E', 'W')} (shown on the map). ` : 'No GPS position in the file. '}
              {photo.exif.dateTime ? `Taken ${photo.exif.dateTime.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')} (camera clock).` : ''}
            </p>
          )}
          {other && (
            <div className="stat-grid" id="photo-compare-stats">
              <Stat label={`Green cover in ${other.result.filename}`} value={`${(other.result.vegetationFraction * 100).toFixed(1)} %`} />
              <Stat
                label="Change in green cover"
                value={`${((other.result.vegetationFraction - result.vegetationFraction) * 100).toFixed(1)} pp`}
                tone={other.result.vegetationFraction < result.vegetationFraction ? 'bad' : 'good'}
              />
            </div>
          )}
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
