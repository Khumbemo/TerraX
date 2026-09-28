import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { readRaster } from '../lib/raster';
import { parseDelimited, parseXlsx } from '../lib/table';
import type { Dataset } from '../lib/types';

interface Props {
  onLoaded: (dataset: Dataset, file: File) => void;
  onError: (message: string) => void;
}

export const SAMPLE_DATASETS = [
  { file: 'ndvi_data.csv', label: 'Vegetation (NDVI / EVI)' },
  { file: 'lst_data.csv', label: 'Land surface temperature' },
  { file: 'precipitation_data.csv', label: 'Rainfall' },
  { file: 'temp_humidity_data.csv', label: 'Temperature & humidity' },
  { file: 'evapotranspiration_data.csv', label: 'Evapotranspiration' },
  { file: 'solar_radiation_data.csv', label: 'Solar radiation' },
];

const ACCEPT = '.csv,.tsv,.txt,.xlsx,.tif,.tiff';
const MAX_BYTES = 300 * 1024 * 1024;

export async function parseFile(file: File): Promise<Dataset> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 300 MB. Clip or resample it before uploading.`);
  if (file.size === 0) throw new Error(`${file.name} is empty.`);
  switch (ext) {
    case 'csv':
    case 'txt':
      return parseDelimited(await file.text(), file.name, file.size);
    case 'tsv':
      return parseDelimited(await file.text(), file.name, file.size, '\t');
    case 'xlsx':
      return parseXlsx(file);
    case 'xls':
      throw new Error('Legacy .xls files are not supported. Open the file in a spreadsheet app and save it as .xlsx or .csv.');
    case 'tif':
    case 'tiff':
      return readRaster(file);
    default:
      throw new Error(`“.${ext || '?'}” files are not supported. Use CSV, TSV, XLSX or GeoTIFF.`);
  }
}

export default function DataUploader({ onLoaded, onError }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(file.name);
    try {
      onLoaded(await parseFile(file), file);
    } catch (err) {
      console.warn('TerraX: could not read', file.name, err);
      onError(err instanceof Error ? err.message : `Could not read ${file.name}.`);
    } finally {
      setBusy(null);
    }
  };

  const loadSample = async (name: string) => {
    if (busy) return;
    setBusy(name);
    try {
      const res = await fetch(new URL(`data/${name}`, document.baseURI));
      if (!res.ok) throw new Error(`The sample file ${name} could not be loaded (HTTP ${res.status}).`);
      const blob = await res.blob();
      const file = new File([blob], name, { type: 'text/csv' });
      onLoaded(await parseFile(file), file);
    } catch (err) {
      onError(err instanceof Error ? err.message : `Could not load ${name}.`);
    } finally {
      setBusy(null);
    }
  };

  const onDrag = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const files = e.dataTransfer.files;
    if (files.length > 1) onError(`Only one file is loaded at a time; using ${files[0].name}.`);
    load(files[0]);
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    load(e.target.files?.[0]);
    e.target.value = ''; // allow picking the same file again
  };

  return (
    <section className="uploader-container" aria-label="Load data">
      <div
        className={`upload-zone ${dragActive ? 'active' : ''} ${busy ? 'processing' : ''}`}
        role="button"
        tabIndex={0}
        aria-busy={Boolean(busy)}
        aria-label="Upload a data file"
        onDragEnter={onDrag}
        onDragLeave={onDrag}
        onDragOver={onDrag}
        onDrop={onDrop}
        onClick={() => !busy && inputRef.current?.click()}
        onKeyDown={e => {
          if ((e.key === 'Enter' || e.key === ' ') && !busy) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
      >
        <input ref={inputRef} id="file-input" type="file" accept={ACCEPT} hidden onChange={onPick} />
        {busy ? (
          <div className="processing-state">
            <div className="scanner-line" />
            <p>Reading {busy}…</p>
          </div>
        ) : (
          <>
            <span className="upload-icon" aria-hidden="true">
              [ ↓ ]
            </span>
            <p>Drop a file here or click to browse</p>
            <p className="upload-formats">CSV · TSV · XLSX · GeoTIFF</p>
          </>
        )}
      </div>

      <div className="sample-row">
        <div className="eyebrow">Sample data · Kohima, Nagaland</div>
        <div className="chip-row">
          {SAMPLE_DATASETS.map(s => (
            <button key={s.file} type="button" className="chip" disabled={Boolean(busy)} onClick={() => loadSample(s.file)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
