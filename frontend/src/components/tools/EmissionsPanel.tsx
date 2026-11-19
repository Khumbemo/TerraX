// CO₂ emissions from forest loss (backend: processing/emissions.py): the settings sent with a forest run, and the
// result, from the mapped loss area or, after validation, from the sample's estimated area.
import { type RasterMeta, type StoredFile } from '../../lib/api';
import { fmt } from '../../lib/stats';
import FileDrop from '../FileDrop';
import { Notes, Stat } from '../ToolKit';

/** IPCC 2006 Vol. 4 Table 4.4 zones (root-to-shoot ratios); the rules themselves are in processing/carbon.py. */
const ZONES = [
  ['trop-rain', 'Tropical rainforest'],
  ['trop-moist', 'Tropical moist deciduous forest'],
  ['trop-dry', 'Tropical dry forest'],
  ['trop-shrub', 'Tropical shrubland'],
  ['trop-mountain', 'Tropical mountain systems'],
  ['temp-broadleaf', 'Temperate broadleaf forest'],
  ['temp-conifer', 'Temperate conifer forest'],
] as const;

export interface EmissionInputs {
  on: boolean;
  agb: string;
  agbCi: string;
  zone: string;
  afterBiomass: string;
  map: StoredFile<RasterMeta> | null;
  mapCiPct: string;
}

export const NO_EMISSIONS: EmissionInputs = { on: false, agb: '', agbCi: '', zone: 'trop-moist', afterBiomass: '0', map: null, mapCiPct: '' };

export interface Emissions {
  areaHa: number;
  areaCi: number | null;
  areaSource: 'map' | 'sample';
  agb: number;
  agbCi: number | null;
  biomassSource: 'value' | 'map';
  rootShoot: number;
  totalBiomass: number;
  carbonPerHa: number;
  co2PerHa: number;
  carbon: number;
  co2: number;
  co2Low: number;
  co2High: number;
  biomassMap?: { file: string; coveredShare: number };
  notes: string[];
}

const num = (s: string) => (s.trim() === '' ? null : Number(s));

/** The `emissions` parameter and `biomass` input for a forest run, or an error message; null when emissions are off. */
export function emissionRequest(e: EmissionInputs): { params: Record<string, unknown>; biomass?: string } | string | null {
  if (!e.on) return null;
  const agb = num(e.agb), agbCi = num(e.agbCi), after = num(e.afterBiomass) ?? 0, mapCi = num(e.mapCiPct);
  if (!e.map && agb === null) return 'For emissions, give the above-ground biomass of the lost forest (t/ha) or upload a biomass map.';
  for (const [v, hi, what] of [[agb, 2000, 'Biomass'], [agbCi, 2000, 'Its uncertainty'], [after, 2000, 'Biomass left after clearing'], [mapCi, 200, 'The map’s uncertainty']] as const) {
    if (v !== null && (!Number.isFinite(v) || v < 0 || v > hi)) return `${what} must be between 0 and ${hi.toLocaleString()}.`;
  }
  const params: Record<string, unknown> = { zone: e.zone, afterBiomass: after };
  if (e.map) params.biomassCiPct = mapCi;
  else Object.assign(params, { agb, agbCi });
  return { params, biomass: e.map?.id };
}

export function EmissionSettings({ value, onChange, onMapFile, busy }: { value: EmissionInputs; onChange: (v: EmissionInputs) => void; onMapFile: (f: File) => void; busy: boolean }) {
  const set = (patch: Partial<EmissionInputs>) => onChange({ ...value, ...patch });
  return (
    <details className="param-panel" open={value.on}>
      <summary>CO₂ emissions (optional)</summary>
      <label className="check">
        <input id="emissions-on" type="checkbox" checked={value.on} onChange={e => set({ on: e.target.checked })} /> Estimate the CO₂ emitted by the forest loss
      </label>
      {value.on && (
        <>
          <p className="field-hint">
            Emissions = loss area × biomass carbon (IPCC 2006 Vol. 4), with a 95 % Monte Carlo interval. Give the lost forest’s above-ground biomass from field plots or a published estimate for the
            area, or upload a biomass map (t/ha; the canopy tool exports one from LiDAR and field plots).
          </p>
          <div className="param-row">
            <label className="param">
              <span>Above-ground biomass (t/ha)</span>
              <input id="emissions-agb" type="number" min="0" step="10" value={value.agb} disabled={Boolean(value.map)} onChange={e => set({ agb: e.target.value })} />
            </label>
            <label className="param" title="95 % half-width, e.g. from your plots’ confidence interval">
              <span>± (t/ha, 95 %)</span>
              <input id="emissions-agb-ci" type="number" min="0" step="5" value={value.agbCi} disabled={Boolean(value.map)} onChange={e => set({ agbCi: e.target.value })} />
            </label>
            <label className="param" title="Sets the root-to-shoot ratio for below-ground biomass (IPCC 2006 Table 4.4)">
              <span>Ecological zone</span>
              <select id="emissions-zone" value={value.zone} onChange={e => set({ zone: e.target.value })}>
                {ZONES.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="param" title="Biomass that stays on the land after clearing, e.g. a plantation or crop; 0 for clearing to bare land">
              <span>Left after clearing (t/ha)</span>
              <input id="emissions-after" type="number" min="0" step="5" value={value.afterBiomass} onChange={e => set({ afterBiomass: e.target.value })} />
            </label>
          </div>
          <div className="param-row">
            <FileDrop id="emissions-map" compact label="Biomass map (optional)" accept=".tif,.tiff" hint="GeoTIFF, t/ha" busy={busy} loaded={value.map?.name} onFile={onMapFile} />
            {value.map && (
              <>
                <label className="param" title="The map’s own 95 % uncertainty of the mean, from its validation">
                  <span>Map uncertainty (± %)</span>
                  <input id="emissions-map-ci" type="number" min="0" max="200" step="5" value={value.mapCiPct} onChange={e => set({ mapCiPct: e.target.value })} />
                </label>
                <button type="button" className="btn" onClick={() => set({ map: null })}>
                  Use a biomass value instead
                </button>
              </>
            )}
          </div>
        </>
      )}
    </details>
  );
}

export function EmissionsResult({ e, title, id }: { e: Emissions; title: string; id: string }) {
  const area = `${fmt(e.areaHa, 4)}${e.areaCi ? ` ± ${fmt(e.areaCi, 3)}` : ''} ha`;
  return (
    <div className="render-window" id={id}>
      <div className="eyebrow">{title}</div>
      <div className="stat-grid">
        <Stat label="CO₂ emitted" value={`${fmt(e.co2, 4)} t`} tone="bad" />
        <Stat label="95 % interval" value={e.co2Low === e.co2High ? '—' : `${fmt(e.co2Low, 3)} – ${fmt(e.co2High, 3)} t`} />
        <Stat label={e.areaSource === 'sample' ? 'Estimated loss area' : 'Mapped loss area'} value={area} />
        <Stat label="Carbon lost per ha" value={`${fmt(e.carbonPerHa, 4)} t C`} />
      </div>
      <p className="field-hint">
        Biomass {fmt(e.agb, 4)}
        {e.agbCi ? ` ± ${fmt(e.agbCi, 3)}` : ''} t/ha above ground{e.biomassSource === 'map' && e.biomassMap ? ` (mean of ${e.biomassMap.file} over the loss)` : ''}, root-to-shoot {e.rootShoot.toFixed(3)}
        , {fmt(e.totalBiomass, 4)} t/ha in total.
      </p>
      <Notes items={e.notes} />
    </div>
  );
}
