// Accuracy and area of a classified map from a stratified random sample (Olofsson et al. 2014): draw the sample,
// label it in the field or from finer imagery, upload it. Used by land cover and forest change.
import { useState } from 'react';
import { request, type Download } from '../../lib/api';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import { useJob } from '../../lib/useJob';
import FileDrop from '../FileDrop';
import { Downloads, Notes, Stat, useUpload } from '../ToolKit';

interface SampleResult {
  points: number;
  unit: 'ha' | 'px';
  allocation: { label: string; mapped: number; share: number; n: number }[];
  downloads: Download[];
  note: string;
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
}

const pct = (v: number | null, ci: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)} %${ci === null ? '' : ` ± ${(ci * 100).toFixed(1)}`}`);
const area = (v: number, unit: 'ha' | 'px') => (unit === 'ha' ? `${fmt(v, 4)} ha` : `${Math.round(v).toLocaleString()} px`);

export default function MapValidation({ jobId, idPrefix, labels, classes, intro, onAccuracy }: Props) {
  const notify = useToast();
  const job = useJob();
  const busy = Boolean(job.busy);
  const refFiles = useUpload(['table', 'vector'], 'the labelled validation sample (CSV or GeoJSON)');
  const [sampleTotal, setSampleTotal] = useState('');
  const [minPerClass, setMinPerClass] = useState('50');
  const [validation, setValidation] = useState<SampleResult | null>(null);
  const [accuracy, setAccuracy] = useState<AccuracyResult | null>(null);
  const fail = (m: string) => notify(m, 'error');

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
  };

  const assessFile = async (picked: File) => {
    const f = await job.run('reference', signal => refFiles.upload(picked, signal), fail);
    if (!f) return;
    const a = await job.run('assess', signal => request<AccuracyResult>(`/api/jobs/${jobId}/validation/accuracy`, { method: 'POST', json: { file: f.id }, signal }), fail);
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
