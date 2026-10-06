import { useEffect, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { runJob, type StoredFile } from '../../lib/api';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import { usePrefs } from '../../lib/prefs';
import { perHa } from '../../lib/units';
import { useJob } from '../../lib/useJob';
import type { ToolOutput } from '../../lib/tools/registry';
import FileDrop from '../FileDrop';
import JobStatus from '../JobStatus';
import { Stat, useUpload } from '../ToolKit';

type ForestType = 'dry' | 'moist' | 'wet';
interface CarbonParams {
  defaultDensity: number;
  densities: Record<string, number>;
  forestType: ForestType;
  stressE: number | null;
  rootShoot: string;
  carbonFraction: number;
  minDbh: number;
  plotAreaM2: number;
}
const DEFAULT_PARAMS: CarbonParams = { defaultDensity: 0.57, densities: {}, forestType: 'moist', stressE: null, rootShoot: 'trop-moist', carbonFraction: 0.47, minDbh: 5, plotAreaM2: 0 };
interface Estimate {
  mean: number;
  sd: number | null;
  ci95: [number, number] | null;
}
interface CarbonResult {
  filename: string;
  live: { trees: number; basalArea: number; agb: number };
  species: { species: string; density: number; densityDefault: boolean; trees: number; basalArea: number; agb: number; meanDbh: number }[];
  perHa: { plots: number; areaHa: number; agb: Estimate; bgb: Estimate; carbon: Estimate; co2e: Estimate; basalArea: Estimate; stems: Estimate; rootShoot: number } | null;
  measured: { agb: number; bgb: number; carbon: number; co2e: number; rootShoot: number };
  equations: Record<'chave2014-h' | 'chave2014-e' | 'chave2005', number>;
  diameterClasses: { label: string; trees: number; agb: number }[];
  notes: string[];
  warnings: string[];
}
interface CarbonJob {
  name: string;
  markdown: string;
  carbon: CarbonResult;
  speciesList: string[];
  needsArea: boolean;
  forestTypes: { id: ForestType; label: string }[];
  zones: { id: string; label: string; rule: string }[];
}

interface Props {
  onOutput: (out: ToolOutput | null) => void;
}

const AXIS = { stroke: '#4a6580', fontSize: 11, fontFamily: 'Space Mono, monospace' };

function ciText(e: Estimate): string | undefined {
  return e.ci95 ? `95 % CI ${fmt(Math.max(0, e.ci95[0]), 3)}–${fmt(e.ci95[1], 3)}` : undefined;
}

/** Numeric text input that keeps what the user types and reports valid numbers. */
function NumberField({ id, label, value, onChange, step, min, max, placeholder }: { id: string; label: string; value: number | null; onChange: (v: number | null) => void; step: string; min?: number; max?: number; placeholder?: string }) {
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => {
    setText(t => (Number(t) === value || (value === null && t === '') ? t : value === null ? '' : String(value)));
  }, [value]);
  const invalid = text !== '' && (!Number.isFinite(Number(text)) || (min !== undefined && Number(text) < min) || (max !== undefined && Number(text) > max));
  return (
    <label className="param">
      <span>{label}</span>
      <input
        id={id}
        type="number"
        step={step}
        min={min}
        max={max}
        placeholder={placeholder}
        value={text}
        aria-invalid={invalid}
        onChange={e => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value === '') onChange(null);
          else if (Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max)) onChange(n);
        }}
      />
    </label>
  );
}

export default function CarbonTool({ onOutput }: Props) {
  const notify = useToast();
  const { units } = usePrefs();
  const job = useJob();
  const busy = Boolean(job.busy);
  const files = useUpload(['table', 'other'], 'a CSV tree inventory');
  const [file, setFile] = useState<StoredFile | null>(null);
  const [params, setParams] = useState<CarbonParams>(DEFAULT_PARAMS);
  const [out, setOut] = useState<CarbonJob | null>(null);
  const result = out?.carbon ?? null;
  const set = <K extends keyof CarbonParams>(k: K, v: CarbonParams[K]) => setParams(p => ({ ...p, [k]: v }));
  const fail = (m: string) => notify(m, 'error');

  const compute = async (f: StoredFile, p: CarbonParams) => {
    const r = await job.run('run', (signal, onProgress) => runJob<CarbonJob>('carbon', { file: f.id }, { ...p }, { signal, onProgress }), msg => {
      fail(msg);
      setOut(null);
      onOutput(null);
    });
    if (!r) return;
    setOut(r);
    onOutput({ tool: 'carbon', name: r.name, markdown: r.markdown, summary: r.carbon });
  };

  const load = async (picked: File | string) => {
    if (typeof picked !== 'string' && !/\.(csv|txt|tsv)$/i.test(picked.name)) return fail('Upload the inventory as CSV (Forest-Capture: Export → CSV).');
    const f = await job.run('upload', signal => (typeof picked === 'string' ? files.sample(picked) : files.upload(picked, signal)), fail);
    if (!f) return;
    setFile(f);
    await compute(f, params);
  };

  // Settings changes re-run the estimate after a short pause.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!file) return;
    const t = setTimeout(() => compute(file, params), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const speciesNames = out?.speciesList ?? [];
  const needsArea = Boolean(out?.needsArea);

  return (
    <div className="tool-body">
      <p className="tool-intro">
        Upload a tree inventory: the Forest-Capture survey CSV, or any table with species, DBH (cm) or girth/GBH (cm) and, ideally, height (m), plus plot and plot size
        (m²) columns. TerraX estimates above- and below-ground biomass, carbon and CO₂ equivalent per tree, per species and per hectare.
      </p>
      <FileDrop id="carbon-file" label="Tree inventory" accept=".csv,.tsv,.txt" hint="Forest-Capture CSV · CSV with DBH/GBH, height, species" busy={job.busy === 'upload'} loaded={file?.name} onFile={load} />
      <div className="param-row">
        <div className="button-row push-right">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => load('forest_capture_inventory_synthetic.csv')}
          >
            Try synthetic inventory
          </button>
        </div>
      </div>

      <JobStatus job={job} />
      {out && (
        <details className="param-panel" open>
          <summary>Method settings</summary>
          <div className="param-row">
            <NumberField id="carbon-density" label="Default wood density (g/cm³)" value={params.defaultDensity} step="0.01" min={0.1} max={1.5} onChange={v => v !== null && set('defaultDensity', v)} />
            <NumberField id="carbon-mindbh" label="Minimum DBH (cm)" value={params.minDbh} step="1" min={0} max={50} onChange={v => v !== null && set('minDbh', v)} />
            <NumberField id="carbon-cf" label="Carbon fraction" value={params.carbonFraction} step="0.01" min={0.3} max={0.6} onChange={v => v !== null && set('carbonFraction', v)} />
            {needsArea && (
              <NumberField id="carbon-area" label="Plot size for rows without one (m²)" value={params.plotAreaM2 || null} step="1" min={1} placeholder="e.g. 400" onChange={v => set('plotAreaM2', v ?? 0)} />
            )}
          </div>
          <div className="param-row">
            <label className="param">
              <span>Below-ground (IPCC 2006 zone)</span>
              <select id="carbon-zone" value={params.rootShoot} onChange={e => set('rootShoot', e.target.value)}>
                {out.zones.map(z => (
                  <option key={z.id} value={z.id}>
                    {z.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="param">
              <span>Trees without height</span>
              <select id="carbon-foresttype" value={params.stressE === null ? params.forestType : 'E'} onChange={e => (e.target.value === 'E' ? set('stressE', 0) : setParams(p => ({ ...p, stressE: null, forestType: e.target.value as ForestType })))}>
                {out.forestTypes.map(k => (
                  <option key={k.id} value={k.id}>
                    Chave 2005 · {k.label}
                  </option>
                ))}
                <option value="E">Chave 2014 eq. 7 · enter site E</option>
              </select>
            </label>
            {params.stressE !== null && <NumberField id="carbon-e" label="Environmental stress E" value={params.stressE} step="0.01" min={-1} max={1.5} onChange={v => v !== null && set('stressE', v)} />}
          </div>
          <p className="field-hint">
            E is read from the gridded layer published with Chave et al. (2014) for the plot’s coordinates; TerraX does not bundle it. Wood density per species can be
            taken from the Global Wood Density Database.
          </p>
          {speciesNames.length > 0 && (
            <details>
              <summary>Wood density by species · {speciesNames.length}</summary>
              <div className="density-grid">
                {speciesNames.map(s => (
                  <NumberField
                    key={s}
                    id={`rho-${s.replace(/\W+/g, '-')}`}
                    label={s}
                    value={params.densities[s] ?? null}
                    step="0.01"
                    min={0.1}
                    max={1.5}
                    placeholder={`${params.defaultDensity} (default)`}
                    onChange={v =>
                      setParams(p => {
                        const d = { ...p.densities };
                        if (v === null) delete d[s];
                        else d[s] = v;
                        return { ...p, densities: d };
                      })
                    }
                  />
                ))}
              </div>
            </details>
          )}
        </details>
      )}

      {result && (
        <div className="result-block">
          {result.perHa ? (
            <div className="stat-grid">
              <Stat label="Above-ground biomass" value={perHa(result.perHa.agb.mean, 't', units)} />
              <Stat label="Carbon stock" value={perHa(result.perHa.carbon.mean, 't', units, ' C')} tone="good" />
              <Stat label="CO₂ equivalent" value={perHa(result.perHa.co2e.mean, 't', units, ' CO₂e')} />
              <Stat label="Basal area" value={perHa(result.perHa.basalArea.mean, 'm2', units)} />
              <Stat label="Stems" value={perHa(result.perHa.stems.mean, 'stems', units)} />
              <Stat label="Plots" value={`${result.perHa.plots} · ${fmt(result.perHa.areaHa, 3)} ha`} />
            </div>
          ) : (
            <div className="stat-grid">
              <Stat label="AGB (measured trees)" value={`${fmt(result.measured.agb, 4)} t`} />
              <Stat label="Carbon (measured trees)" value={`${fmt(result.measured.carbon, 4)} t C`} tone="good" />
              <Stat label="CO₂e (measured trees)" value={`${fmt(result.measured.co2e, 4)} t`} />
              <Stat label="Live trees" value={String(result.live.trees)} />
            </div>
          )}
          {result.perHa && (
            <p className="field-hint">
              {[['AGB', result.perHa.agb], ['Carbon', result.perHa.carbon]].map(([l, e]) => `${l}: ${ciText(e as Estimate) ?? 'one plot, no interval'}`).join(' · ')}. The interval reflects variation between plots only.
            </p>
          )}

          {result.warnings.length > 0 && (
            <ul className="data-notes">
              {result.warnings.map(w => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          <div className="render-window">
            <div className="eyebrow">Above-ground biomass by diameter class (t, measured trees)</div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={result.diameterClasses} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#16283c" />
                <XAxis dataKey="label" {...AXIS} />
                <YAxis {...AXIS} width={56} tickFormatter={v => fmt(v, 3)} />
                <Tooltip formatter={(v, n) => (n === 'agb' ? `${fmt(Number(v), 3)} t` : String(v))} contentStyle={{ background: '#030814', border: '1px solid #38bdf8' }} />
                <Bar dataKey="agb" name="agb" fill="#46a758" isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="tabular-view">
            <table>
              <thead>
                <tr>
                  <th>Species</th>
                  <th>Trees</th>
                  <th>Mean DBH</th>
                  <th>ρ (g/cm³)</th>
                  <th>AGB (t)</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {result.species.map(s => (
                  <tr key={s.species}>
                    <td>{s.species}</td>
                    <td className="num">{s.trees}</td>
                    <td className="num">{fmt(s.meanDbh, 3)} cm</td>
                    <td className="num">
                      {fmt(s.density, 3)}
                      {s.densityDefault ? '*' : ''}
                    </td>
                    <td className="num">{fmt(s.agb / 1000, 4)}</td>
                    <td className="num">{((s.agb / (result.live.agb || 1)) * 100).toFixed(1)} %</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="field-hint">* default wood density. Equations used: {result.equations['chave2014-h']} trees with height (Chave 2014), {result.equations.chave2005 + result.equations['chave2014-e']} diameter-only.</p>
          </div>

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
