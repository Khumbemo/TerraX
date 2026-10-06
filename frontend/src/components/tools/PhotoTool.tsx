import { useState } from 'react';
import type { FeatureCollection } from 'geojson';
import { runJob, type StoredFile, type Summary } from '../../lib/api';
import { toDms, type LatLngBounds } from '../../lib/geo';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import { useJob } from '../../lib/useJob';
import type { ToolOutput } from '../../lib/tools/registry';
import FileDrop from '../FileDrop';
import JobStatus from '../JobStatus';
import { ArtifactImage, Notes, Stat, useUpload } from '../ToolKit';

interface Props {
  onOutput: (out: ToolOutput | null) => void;
}

interface PhotoResult {
  filename: string;
  width: number;
  height: number;
  aw: number;
  ah: number;
  channels: Record<'r' | 'g' | 'b', Summary>;
  vari: Summary | null;
  vegetationFraction: number;
  brightness: Summary;
  exif: { make: string | null; model: string | null; dateTime: string | null; lat: number | null; lon: number | null; altitude: number | null } | null;
  notes: string[];
}

interface PhotoJob {
  name: string;
  markdown: string;
  photo: PhotoResult;
  other: PhotoResult | null;
  views: { photo: string; vegetation: string; other?: string; otherVegetation?: string };
  map: { bounds: LatLngBounds; geojson: FeatureCollection } | null;
}

const ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';

export default function PhotoTool({ onOutput }: Props) {
  const notify = useToast();
  const job = useJob();
  const files = useUpload(['image'], 'a JPG, PNG or WebP image');
  const [photo, setPhoto] = useState<StoredFile | null>(null);
  const [out, setOut] = useState<PhotoJob | null>(null);
  const [showMask, setShowMask] = useState(false);
  const result = out?.photo ?? null;
  const other = out?.other ?? null;
  const busy = Boolean(job.busy);
  const fail = (m: string) => notify(m, 'error');

  const analyse = async (a: StoredFile, b: StoredFile | null) => {
    const r = await job.run('run', (signal, onProgress) => runJob<PhotoJob>('photo', { photo: a.id, other: b?.id }, {}, { signal, onProgress }), fail);
    if (!r) return;
    setPhoto(a);
    setOut(r);
    onOutput({ tool: 'photo', name: r.name, markdown: r.markdown, map: r.map ?? undefined, summary: { photo: r.photo, other: r.other }, figures: [{ title: r.photo.filename, url: r.views.photo }] });
  };

  const pick = async (picked: File | string, which: 'photo' | 'other') => {
    const f = await job.run('upload', signal => (typeof picked === 'string' ? files.sample(picked) : files.upload(picked, signal)), fail);
    if (!f) return;
    if (which === 'photo') {
      setShowMask(false);
      await analyse(f, null);
    } else if (photo) await analyse(photo, f);
  };

  return (
    <div className="tool-body">
      <p className="tool-intro">
        Upload an ordinary colour image: a satellite snapshot, a drone or aircraft photo, or an astronaut photo of Earth. TerraX estimates green cover from the visible
        bands. For calibrated NDVI, use Satellite imagery with a multispectral GeoTIFF.
      </p>
      <FileDrop id="photo-file" label="Image" accept={ACCEPT} hint="JPG · PNG · WebP" busy={job.busy === 'upload' && !result} loaded={result?.filename} onFile={f => pick(f, 'photo')} />
      <div className="param-row">
        {result && (
          <label className="check">
            <input id="photo-mask" type="checkbox" checked={showMask} onChange={e => setShowMask(e.target.checked)} /> Show vegetation mask
          </label>
        )}
        <div className="button-row push-right">
          <button type="button" className="btn" disabled={busy} onClick={() => pick('aerial_photo_synthetic.png', 'photo')}>
            Try synthetic photo
          </button>
        </div>
      </div>

      {result && (
        <FileDrop id="photo-compare" compact label="Compare with a second photo (optional)" accept={ACCEPT} hint="Same scene, later date" busy={job.busy === 'upload' && Boolean(result)} loaded={other?.filename} onFile={f => pick(f, 'other')} />
      )}
      <JobStatus job={job} />

      {result && out && (
        <div className="result-block">
          {result.exif && (result.exif.lat !== null || result.exif.dateTime) && (
            <p className="field-hint" id="photo-exif">
              {result.exif.lat !== null && result.exif.lon !== null ? `Location from EXIF: ${toDms(result.exif.lat, 'N', 'S')}, ${toDms(result.exif.lon, 'E', 'W')} (shown on the map). ` : 'No GPS position in the file. '}
              {result.exif.dateTime ? `Taken ${result.exif.dateTime.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')} (camera clock).` : ''}
            </p>
          )}
          {other && (
            <div className="stat-grid" id="photo-compare-stats">
              <Stat label={`Green cover in ${other.filename}`} value={`${(other.vegetationFraction * 100).toFixed(1)} %`} />
              <Stat label="Change in green cover" value={`${((other.vegetationFraction - result.vegetationFraction) * 100).toFixed(1)} pp`} tone={other.vegetationFraction < result.vegetationFraction ? 'bad' : 'good'} />
            </div>
          )}
          <div className="stat-grid">
            <Stat label="Vegetation cover" value={`${(result.vegetationFraction * 100).toFixed(1)} %`} tone="good" />
            <Stat label="VARI mean" value={result.vari ? fmt(result.vari.mean) : '—'} />
            <Stat label="Brightness" value={`${fmt(result.brightness.mean)} / 255`} />
            <Stat label="Mean R · G · B" value={`${fmt(result.channels.r.mean, 3)} · ${fmt(result.channels.g.mean, 3)} · ${fmt(result.channels.b.mean, 3)}`} />
          </div>
          <figure className="raster-figure">
            <ArtifactImage url={showMask ? out.views.vegetation : out.views.photo} width={result.aw} height={result.ah} label={showMask ? 'Vegetation mask' : result.filename} pixelated={false} />
            {showMask && (
              <figcaption className="legend-row">
                <span>
                  <i className="class-swatch" style={{ background: '#34d399' }} /> Vegetation (ExG above threshold)
                </span>
              </figcaption>
            )}
          </figure>
          <Notes items={result.notes} />
        </div>
      )}
    </div>
  );
}
