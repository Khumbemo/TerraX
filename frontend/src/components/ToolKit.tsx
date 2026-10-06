// Small pieces shared by the tool panels: server pictures, downloads, upload slots.
import { useCallback, useState } from 'react';
import { apiUrl, checkFile, copySample, downloadArtifact, uploadFile, type Download, type FileKind, type StoredFile } from '../lib/api';
import { useToast } from '../lib/toast';

/** A picture produced by the server (artifact URL), optionally clickable at pixel level. */
export function ArtifactImage({ url, width, height, label, pixelated = true, onPick }: { url: string; width: number; height: number; label: string; pixelated?: boolean; onPick?: (col: number, row: number) => void }) {
  return (
    <img
      src={apiUrl(url)}
      width={width}
      height={height}
      alt={label}
      className={`raster-canvas ${pixelated ? '' : 'smooth'} ${onPick ? 'pickable' : ''}`}
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

/** Buttons for a result's files; `ids` names the buttons (in order) for tests and links. */
export function Downloads({ items, idPrefix, ids = [] }: { items: Download[] | undefined; idPrefix: string; ids?: string[] }) {
  const notify = useToast();
  if (!items?.length) return null;
  return (
    <>
      {items.map((d, i) => (
        <button
          key={d.url}
          type="button"
          id={ids[i] ?? `${idPrefix}-download-${i}`}
          className="btn btn-small"
          onClick={() => {
            if (d.features === 0) return notify('There are no features to export.');
            if (d.truncated) notify(`Only the ${d.features?.toLocaleString()} largest features were exported (${d.truncated.toLocaleString()} smaller ones left out).`);
            downloadArtifact(d).catch(err => notify(err instanceof Error ? err.message : 'The download failed.', 'error'));
          }}
        >
          {d.label}
        </button>
      ))}
    </>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ? `tone-${tone}` : ''}`}>{value}</div>
    </div>
  );
}

/** Uploads a user file or copies a bundled sample, checking that the server could read it. */
export function useUpload<M = StoredFile['meta']>(kinds: FileKind[], what: string) {
  const [progress, setProgress] = useState<number | null>(null);
  const upload = useCallback(
    async (file: File, signal?: AbortSignal): Promise<StoredFile<M>> => {
      setProgress(0);
      try {
        return checkFile<M>(await uploadFile(file, setProgress, signal), kinds, what);
      } finally {
        setProgress(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [what],
  );
  const sample = useCallback(async (name: string) => checkFile<M>(await copySample(name), kinds, what), [kinds, what]);
  return { upload, sample, progress };
}
