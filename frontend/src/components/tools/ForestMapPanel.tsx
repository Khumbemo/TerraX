// Forest at the start from a map closer to the FAO definition than NDVI ≥ 0.5 (backend: processing/baseline.py):
// a tree-cover map, a canopy height model or a class map.
import { type RasterMeta, type StoredFile } from '../../lib/api';
import FileDrop from '../FileDrop';

export type ForestMapKind = 'ndvi' | 'cover' | 'height' | 'classes';

export interface ForestMapInputs {
  kind: ForestMapKind;
  map: StoredFile<RasterMeta> | null;
  minCover: string;
  minHeight: string;
  classes: string;
  minHa: string;
}

export const NDVI_FOREST: ForestMapInputs = { kind: 'ndvi', map: null, minCover: '10', minHeight: '5', classes: '10', minHa: '0.5' };

const KINDS: [ForestMapKind, string, string][] = [
  ['ndvi', 'NDVI threshold on the earlier image', ''],
  ['cover', 'Tree-cover map (%)', 'e.g. Hansen treecover2000 or Copernicus tree cover density'],
  ['height', 'Canopy height model (m)', 'e.g. the canopy tool’s CHM from LiDAR'],
  ['classes', 'Class map', 'e.g. TerraX land cover or ESA WorldCover (trees = 10)'],
];

/** The `forestMap` parameter and input for a forest run, an error message, or null for the NDVI threshold. */
export function forestMapRequest(f: ForestMapInputs): { params: Record<string, unknown>; file: string } | string | null {
  if (f.kind === 'ndvi') return null;
  if (!f.map) return 'Upload the forest map, or choose the NDVI threshold.';
  const n = (s: string) => Number(s);
  const cover = n(f.minCover), height = n(f.minHeight), minHa = n(f.minHa);
  if (!(cover >= 0 && cover <= 100)) return 'Set the minimum tree cover between 0 and 100 %.';
  if (!(height >= 0 && height <= 200)) return 'Set the minimum tree height between 0 and 200 m.';
  if (!(minHa >= 0 && minHa <= 1000)) return 'Set the minimum forest area between 0 and 1,000 ha.';
  const params: Record<string, unknown> = { kind: f.kind, minCover: cover, minHeight: height, minHa };
  if (f.kind === 'classes') {
    const classes = f.classes.split(/[\s,;]+/).filter(Boolean).map(Number);
    if (!classes.length || classes.some(c => !Number.isFinite(c))) return 'List the forest classes as numbers, for example 10 for ESA WorldCover tree cover.';
    params.classes = classes;
  }
  return { params, file: f.map.id };
}

export function ForestMapSettings({ value, onChange, onMapFile, busy }: { value: ForestMapInputs; onChange: (v: ForestMapInputs) => void; onMapFile: (f: File) => void; busy: boolean }) {
  const set = (patch: Partial<ForestMapInputs>) => onChange({ ...value, ...patch });
  const hint = KINDS.find(k => k[0] === value.kind)?.[2];
  return (
    <details className="param-panel" open={value.kind !== 'ndvi'}>
      <summary>Forest at the start: {value.kind === 'ndvi' ? 'NDVI threshold' : KINDS.find(k => k[0] === value.kind)?.[1]}</summary>
      <p className="field-hint">
        FAO defines forest as more than 0.5 ha with trees taller than 5 m and canopy cover above 10 %. An NDVI threshold only measures greenness, so dense crops can
        pass as forest and their harvest as loss. A forest map follows the definition more closely; loss is still a drop in NDVI on that forest.
      </p>
      <div className="param-row">
        <label className="inline-select">
          <span>From</span>
          <select id="forest-map-kind" value={value.kind} onChange={e => set({ kind: e.target.value as ForestMapKind })}>
            {KINDS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {value.kind !== 'ndvi' && (
        <>
          <div className="param-row">
            <FileDrop id="forest-map" compact label="Forest map" accept=".tif,.tiff" hint={`GeoTIFF · ${hint}`} busy={busy} loaded={value.map?.name} onFile={onMapFile} />
          </div>
          <div className="param-row">
            {value.kind === 'classes' ? (
              <label className="param" title="Class values counted as forest, separated by commas">
                <span>Forest classes</span>
                <input id="forest-map-classes" value={value.classes} onChange={e => set({ classes: e.target.value })} />
              </label>
            ) : (
              <label className="param" title="FAO: more than 10 %">
                <span>Min. canopy cover (%)</span>
                <input id="forest-map-cover" type="number" min="0" max="100" step="5" value={value.minCover} onChange={e => set({ minCover: e.target.value })} />
              </label>
            )}
            {value.kind === 'height' && (
              <label className="param" title="FAO: trees taller than 5 m">
                <span>Min. tree height (m)</span>
                <input id="forest-map-height" type="number" min="0" max="200" step="1" value={value.minHeight} onChange={e => set({ minHeight: e.target.value })} />
              </label>
            )}
            <label className="param" title="FAO: more than 0.5 ha; smaller forest patches are not counted (0 = keep all)">
              <span>Min. forest area (ha)</span>
              <input id="forest-map-minha" type="number" min="0" max="1000" step="0.1" value={value.minHa} onChange={e => set({ minHa: e.target.value })} />
            </label>
          </div>
        </>
      )}
    </details>
  );
}
