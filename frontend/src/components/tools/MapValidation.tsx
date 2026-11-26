// Accuracy and area of a classified map from a stratified random sample (Olofsson et al. 2014): draw the sample,
// label it in the field or from finer imagery, upload it. Used by land cover and forest change.
import { lazy, Suspense, useState } from 'react';
import { request, type Download } from '../../lib/api';
import { getItem, removeItem, setItem } from '../../lib/storage';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import { useJob } from '../../lib/useJob';
import FileDrop from '../FileDrop';
import { Downloads, Notes, Stat, useUpload } from '../ToolKit';
import type { SampleLocation } from './ReferenceLabeller';

const ReferenceLabeller = lazy(() => import('./ReferenceLabeller'));

interface SampleResult {
  points: number;
  unit: 'ha' | 'px';
  allocation: { label: string; mapped: number; share: number; n: number }[];
  downloads: Download[];
  note: string;
  /** Each point with its pixel outline, without its map class, in a shuffled order (for labelling here). */
  locations: SampleLocation[];
  labels: string[];
}

interface AccuracyClass {
  label: string;
  samples: number;
  mappedArea: number;
  area: number;
  areaCi: number | null;
  userAccuracy: number | null;
  userCi: number | null;
  producerAccuracy: number | null;
  producerCi: number | null;
}

export interface AccuracyResult {
  unit: 'ha' | 'px';
  samples: number;
  unlabelled: number;
  overallAccuracy: number;
  overallCi: number | null;
  classes: AccuracyClass[];
  markdown: string;
  /** Forest loss with emissions: the emissions summary (activity data, emission factor, emissions, uncertainty). */
  reddSummary?: { markdown: string; download: Download };
}

interface Props {
  /** The job whose class map is validated. */
  jobId: string;
  /** Prefix of the element ids (kept per tool so links and tests stay stable). */
  idPrefix: string;
  /** Class names as the user set them (land cover lets them rename classes). */
  labels?: string[];
  /** Placeholder for the sample size: about 100 points per class. */
  classes: number;
  /** What the sample is for, shown above the controls. */
  intro: string;
  /** Called with the assessment, or null when a new sample makes the last one stale. */
  onAccuracy: (a: AccuracyResult | null) => void;
  /** Ask for the years between the two images (forest loss with emissions: a yearly mean in the summary). */
  askPeriod?: boolean;
}

const labelsKey = (jobId: string) => `validation_labels_${jobId}`;

function savedLabels(jobId: string): Record<string, string> {
  try {
    const v = JSON.parse(getItem(labelsKey(jobId)) ?? '{}') as Record<string, string>;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

const pct = (v: number | null, ci: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)} %${ci === null ? '' : ` ± ${(ci * 100).toFixed(1)}`}`);
const area = (v: number, unit: 'ha' | 'px') => (unit === 'ha' ? `${fmt(v, 4)} ha` : `${Math.round(v).toLocaleString()} px`);

export default function MapValidation({ jobId, idPrefix, labels, classes, intro, onAccuracy, askPeriod }: Props) {
  const notify = useToast();
  const job = useJob();
  const busy = Boolean(job.busy);
  const refFiles = useUpload(['table', 'vector'], 'the labelled validation sample (CSV or GeoJSON)');
  const [sampleTotal, setSampleTotal] = useState('');
  const [minPerClass, setMinPerClass] = useState('50');
  const [validation, setValidation] = useState<SampleResult | null>(null);
  const [accuracy, setAccuracy] = useState<AccuracyResult | null>(null);
  const [refLabels, setRefLabels] = useState<Record<string, string>>(() => savedLabels(jobId));
  const [labelling, setLabelling] = useState(false);
  const [years, setYears] = useState('');
  const fail = (m: string) => notify(m, 'error');

  const period = (): number | null | false => {
    if (!askPeriod || !years.trim()) return null;
    const y = Number(years);
    return y > 0 && y <= 200 ? y : false;
  };

  const setLabel = (id: string, value: string) => {
    setRefLabels(cur => {
      const next = { ...cur };
      if (value) next[id] = value;
      else delete next[id];
      setItem(labelsKey(jobId), JSON.stringify(next));
      return next;
    });
  };

  const assessLabels = async () => {
    const y = period();
    if (y === false) return fail('Set the years between the two images as a positive number, or leave it empty.');
    const ids = new Set((validation?.locations ?? []).map(l => l.id));
    const sent = Object.fromEntries(Object.entries(refLabels).filter(([k]) => ids.has(k)));
    if (!Object.keys(sent).length) return fail('Label at least one point first.');
    const a = await job.run('assess', signal => request<AccuracyResult>(`/api/jobs/${jobId}/validation/accuracy`, { method: 'POST', json: { labels: sent, periodYears: y }, signal }), fail);
    if (!a) return;
    setAccuracy(a);
    onAccuracy(a);
  };

  const makeSample = async () => {
    const total = sampleTotal.trim() ? Number(sampleTotal) : undefined;
    const min = Number(minPerClass);
    if (total !== undefined && (!Number.isInteger(total) || total < 2)) return fail('Set the sample size as a whole number of points, or leave it empty.');
    if (!Number.isInteger(min) || min < 1) return fail('Set the minimum points per class as a whole number.');
    const s = await job.run('sample', signal => request<SampleResult>(`/api/jobs/${jobId}/validation/sample`, { method: 'POST', json: { total, minPerClass: min, labels }, signal }), fail);
    if (!s) return;
    setValidation(s);
    setAccuracy(null);
    onAccuracy(null);
    // A new sample has new points: labels for the old one no longer apply.
    removeItem(labelsKey(jobId));
    setRefLabels({});
  };

  const assessFile = async (picked: File) => {
    const f = await job.run('reference', signal => refFiles.upload(picked, signal), fail);
    if (!f) return;
    const y = period();
    if (y === false) return fail('Set the years between the two images as a positive number, or leave it empty.');
    const a = await job.run('assess', signal => request<AccuracyResult>(`/api/jobs/${jobId}/validation/accuracy`, { method: 'POST', json: { file: f.id, periodYears: y }, signal }), fail);
    if (!a) return;
    setAccuracy(a);
    onAccuracy(a);
  };

  return (
    <section className="sub-panel" aria-label="Accuracy assessment">
      <div className="eyebrow">Accuracy and area</div>
      <p className="field-hint">{intro}</p>
      <div className="param-row">
        <label className="param">
          <span>Sample points</span>
          <input id={`${idPrefix}-sample-total`} type="number" min="2" step="1" placeholder={String(100 * classes)} value={sampleTotal} onChange={e => setSampleTotal(e.target.value)} />
        </label>
        <label className="param">
          <span>Minimum per class</span>
          <input id={`${idPrefix}-sample-min`} type="number" min="1" step="1" value={minPerClass} onChange={e => setMinPerClass(e.target.value)} />
        </label>
        <button type="button" id={`${idPrefix}-sample`} className="btn" disabled={busy} onClick={makeSample}>
          {job.busy === 'sample' ? 'Drawing…' : validation ? 'Draw a new sample' : 'Create validation sample'}
        </button>
      </div>
      {validation && (
        <>
          <div className="tabular-view">
            <table>
              <thead>
                <tr>
                  <th>Class</th>
                  <th>Mapped</th>
                  <th>Share</th>
                  <th>Points</th>
                </tr>
              </thead>
              <tbody>
                {validation.allocation.map(a => (
                  <tr key={a.label}>
                    <td>{a.label}</td>
                    <td className="num">{area(a.mapped, validation.unit)}</td>
                    <td className="num">{(a.share * 100).toFixed(1)} %</td>
                    <td className="num">{a.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="button-row">
            <Downloads idPrefix={`${idPrefix}-sample`} items={validation.downloads} />
          </div>
          <Notes items={[validation.note]} />
          {askPeriod && (
            <div className="param-row">
              <label className="param" title="For the yearly mean in the emissions summary; leave empty to omit it">
                <span>Years between the images</span>
                <input id={`${idPrefix}-period`} type="number" min="0.1" max="200" step="0.5" value={years} onChange={e => setYears(e.target.value)} placeholder="optional" />
              </label>
            </div>
          )}
          {validation.locations.length > 0 && (
            <div className="param-row">
              <button type="button" id={`${idPrefix}-label-open`} className="btn" onClick={() => setLabelling(!labelling)}>
                {labelling ? 'Hide the labelling' : 'Label the points here, over imagery'}
              </button>
              <span className="field-hint">
                {Object.keys(refLabels).filter(id => validation.locations.some(l => l.id === id)).length} of {validation.locations.length} labelled
              </span>
              <button type="button" id={`${idPrefix}-label-assess`} className="btn btn-primary push-right" disabled={busy} onClick={assessLabels}>
                {job.busy === 'assess' ? 'Computing…' : 'Compute accuracy from these labels'}
              </button>
            </div>
          )}
          {labelling && (
            <Suspense fallback={<div className="loading-block">Loading the map…</div>}>
              <ReferenceLabeller idPrefix={idPrefix} locations={validation.locations} classes={validation.labels} labels={refLabels} onLabel={setLabel} />
            </Suspense>
          )}
          <p className="field-hint">Or label the downloaded file elsewhere (in the field, or in GIS software) and upload it:</p>
          <FileDrop
            id={`${idPrefix}-reference`}
            label="Labelled sample"
            accept=".csv,.geojson,.json"
            hint="The sample file with its “reference” column filled in"
            busy={job.busy === 'reference' || job.busy === 'assess'}
            onFile={f => assessFile(f)}
          />
        </>
      )}
      {accuracy && (
        <>
          <div className="stat-grid">
            <Stat label="Overall accuracy" value={pct(accuracy.overallAccuracy, accuracy.overallCi)} />
            <Stat label="Reference points" value={`${accuracy.samples}${accuracy.unlabelled ? ` (${accuracy.unlabelled} unlabelled)` : ''}`} />
          </div>
          {accuracy.reddSummary && (
            <div className="button-row">
              <span className="field-hint">
                Emissions summary: activity data with its confidence interval, emission factor, emissions and uncertainty, laid out for REDD+ and IPCC reporting.
              </span>
              <span className="push-right">
                <Downloads idPrefix={`${idPrefix}-summary`} items={[accuracy.reddSummary.download]} />
              </span>
            </div>
          )}
          <div className="tabular-view">
            <table id={`${idPrefix}-accuracy`}>
              <thead>
                <tr>
                  <th>Class</th>
                  <th>Mapped</th>
                  <th>Estimated area (95 % CI)</th>
                  <th>User’s</th>
                  <th>Producer’s</th>
                </tr>
              </thead>
              <tbody>
                {accuracy.classes.map(c => (
                  <tr key={c.label}>
                    <td>{c.label}</td>
                    <td className="num">{area(c.mappedArea, accuracy.unit)}</td>
                    <td className="num">
                      {area(c.area, accuracy.unit)}
                      {c.areaCi === null ? '' : ` ± ${accuracy.unit === 'ha' ? fmt(c.areaCi, 3) : Math.round(c.areaCi).toLocaleString()}`}
                    </td>
                    <td className="num">{pct(c.userAccuracy, c.userCi)}</td>
                    <td className="num">{pct(c.producerAccuracy, c.producerCi)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
