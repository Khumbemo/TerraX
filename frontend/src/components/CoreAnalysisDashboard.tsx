import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { SPI_SCALES, analyzeMetric, numericColumns } from '../lib/analysis';
import { spiClass } from '../lib/climate-stats';
import { MONTHS, decimalYear, formatDate } from '../lib/dates';
import { fmt, fmtP, quantileSorted, sampleIndices } from '../lib/stats';
import type { TableDataset } from '../lib/types';

interface Props {
  dataset: TableDataset;
  metric: string;
  onMetricChange: (column: string) => void;
}

type Tab = 'series' | 'season' | 'anomalies' | 'spi' | 'classes' | 'table';
const PAGE_SIZE = 50;
const MAX_CHART_POINTS = 1500;
const AXIS = { stroke: '#4a6580', fontSize: 11, fontFamily: 'Space Mono, monospace' };

function ChartTooltip({ active, payload, label, time }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: number | string; time: boolean }) {
  if (!active || !payload?.length) return null;
  const heading = time && typeof label === 'number' ? formatDate(new Date(label)) : String(label);
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-label">{heading}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color: p.color }}>
          {p.name}: {fmt(p.value)}
        </div>
      ))}
    </div>
  );
}

export default function CoreAnalysisDashboard({ dataset, metric, onMetricChange }: Props) {
  const [tab, setTab] = useState<Tab>('series');
  const [page, setPage] = useState(0);
  const [showTrend, setShowTrend] = useState(true);
  const [spiScale, setSpiScale] = useState(3);
  const columns = numericColumns(dataset);
  const analysis = useMemo(() => analyzeMetric(dataset, metric), [dataset, metric]);
  const hasTime = Boolean(dataset.times);

  const chartData = useMemo(() => {
    const pts = analysis.points;
    const trend = analysis.trend;
    let intercept = 0;
    if (trend && hasTime) {
      const residuals = pts.map(p => p.value - trend.senSlope * decimalYear(p.time!)).sort((a, b) => a - b);
      intercept = quantileSorted(residuals, 0.5);
    }
    return sampleIndices(pts.length, MAX_CHART_POINTS).map(i => {
      const p = pts[i];
      return {
        x: hasTime ? p.time!.getTime() : i + 1,
        value: p.value,
        trend: trend && hasTime ? intercept + trend.senSlope * decimalYear(p.time!) : undefined,
      };
    });
  }, [analysis, hasTime]);

  const s = analysis.summary;
  const t = analysis.trend;
  const cls = analysis.classification;
  const classTotal = analysis.classCounts.reduce((a, b) => a + b, 0);
  const classData = cls.buckets.map((b, i) => ({ name: b.label, value: analysis.classCounts[i], color: b.color }));
  const pageCount = Math.max(1, Math.ceil(analysis.points.length / PAGE_SIZE));
  const pageRows = analysis.points.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: 'series', label: hasTime ? 'Time series' : 'Series', show: true },
    { id: 'season', label: 'Seasonal cycle', show: Boolean(analysis.monthly) },
    { id: 'anomalies', label: 'Anomalies', show: Boolean(analysis.climate?.anomalies.length) },
    { id: 'spi', label: 'Drought (SPI)', show: Boolean(analysis.climate?.spi || analysis.climate?.spiNote) },
    { id: 'classes', label: 'Classes', show: true },
    { id: 'table', label: 'Values', show: true },
  ];

  return (
    <section className="core-analysis-module" aria-label="Analysis">
      <div className="analysis-header">
        <span className="pulse-dot" aria-hidden="true" />
        <span>Analysis · {dataset.filename}</span>
        <label className="inline-select">
          <span>Variable</span>
          <select
            id="metric-select"
            value={metric}
            onChange={e => {
              onMetricChange(e.target.value);
              setPage(0);
            }}
          >
            {columns.map(c => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="stat-label">Values</div>
          <div className="stat-value">{s?.n ?? 0}</div>
          {hasTime && (
            <div className="stat-sub">
              <span className="nowrap">{formatDate(analysis.start)}</span> → <span className="nowrap">{formatDate(analysis.end)}</span>
            </div>
          )}
        </div>
        <div className="stat">
          <div className="stat-label">Mean ± SD</div>
          <div className="stat-value">
            {fmt(s?.mean)} <span className="stat-pm">± {fmt(s?.sd)}</span>
          </div>
          <div className="stat-sub">median {fmt(s?.median)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Range</div>
          <div className="stat-value">
            {fmt(s?.min)} – {fmt(s?.max)}
          </div>
          <div className="stat-sub">IQR {fmt(s?.q1)} – {fmt(s?.q3)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Trend (Mann–Kendall)</div>
          {t ? (
            <>
              <div className={`stat-value trend-${t.direction.replace(' ', '-')}`}>{t.direction === 'no trend' ? 'Not significant' : t.direction === 'increasing' ? '↑ Increasing' : '↓ Decreasing'}</div>
              <div className="stat-sub">
                Sen slope {fmt(t.senSlope)}/yr · p {fmtP(t.p)}
              </div>
              {analysis.trendCaveat && (
                <div className="stat-caveat" title={analysis.trendCaveat}>
                  Record under 2 years: likely seasonal
                </div>
              )}
            </>
          ) : (
            <div className="stat-sub">{hasTime ? 'Needs ≥ 4 dated values' : 'Needs a date column'}</div>
          )}
        </div>
      </div>

      <div className="view-toggles" role="tablist">
        {tabs
          .filter(x => x.show)
          .map(x => (
            <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} className={tab === x.id ? 'active' : ''} onClick={() => setTab(x.id)}>
              {x.label}
            </button>
          ))}
      </div>

      <div className="render-window">
        {tab === 'series' && (
          <>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData} margin={{ top: 10, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#16283c" />
                <XAxis
                  dataKey="x"
                  type="number"
                  scale={hasTime ? 'time' : 'linear'}
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={v => (hasTime ? formatDate(new Date(v)).slice(0, 7) : String(v))}
                  {...AXIS}
                />
                <YAxis {...AXIS} width={56} domain={['auto', 'auto']} tickFormatter={v => fmt(v, 3)} />
                <Tooltip content={<ChartTooltip time={hasTime} />} />
                <Line type="linear" dataKey="value" name={metric} stroke="#34d399" strokeWidth={1.8} dot={chartData.length <= 120 ? { r: 2 } : false} isAnimationActive={false} />
                {showTrend && t && hasTime && <Line type="linear" dataKey="trend" name="Theil–Sen trend" stroke="#f5b84b" strokeDasharray="6 4" dot={false} isAnimationActive={false} />}
              </LineChart>
            </ResponsiveContainer>
            <div className="chart-foot">
              {t && hasTime && (
                <label className="check">
                  <input id="toggle-trend" type="checkbox" checked={showTrend} onChange={e => setShowTrend(e.target.checked)} /> Show Theil–Sen trend line
                </label>
              )}
              {analysis.trendCaveat && t && <span className="caveat-text">{analysis.trendCaveat}</span>}
              {analysis.points.length > MAX_CHART_POINTS && <span>Chart shows {MAX_CHART_POINTS} evenly spaced of {analysis.points.length} values; statistics use all values.</span>}
            </div>
          </>
        )}

        {tab === 'season' && analysis.monthly && (
          <>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={analysis.monthly} margin={{ top: 10, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#16283c" />
                <XAxis dataKey="label" {...AXIS} />
                <YAxis {...AXIS} width={56} tickFormatter={v => fmt(v, 3)} />
                <Tooltip content={<ChartTooltip time={false} />} />
                <Bar dataKey="mean" name={`Mean ${metric}`} fill="#38bdf8" radius={[2, 2, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
            <div className="chart-foot">Mean of all values in each calendar month.</div>
          </>
        )}

        {tab === 'anomalies' && analysis.climate && (
          <>
            {analysis.climate.seasonalKendall && (
              <p className="field-hint" id="seasonal-kendall">
                Seasonal Kendall ({analysis.climate.seasonalKendall.seasons} months, n = {analysis.climate.seasonalKendall.n}):{' '}
                <strong>{analysis.climate.seasonalKendall.direction === 'no trend' ? 'no significant trend' : `${analysis.climate.seasonalKendall.direction} trend`}</strong>, slope{' '}
                {fmt(analysis.climate.seasonalKendall.slope)}/yr, p {fmtP(analysis.climate.seasonalKendall.p)}. It compares each month with the same month in other years, so the
                seasonal cycle is not mistaken for a trend.
              </p>
            )}
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={analysis.climate.anomalies.map(a => ({ label: `${MONTHS[a.month]} ${a.year}`, anomaly: a.anomaly }))} margin={{ top: 10, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#16283c" />
                <XAxis dataKey="label" {...AXIS} minTickGap={40} />
                <YAxis {...AXIS} width={56} tickFormatter={v => fmt(v, 3)} />
                <ReferenceLine y={0} stroke="#4a6580" />
                <Tooltip content={<ChartTooltip time={false} />} />
                <Bar dataKey="anomaly" name="Anomaly" isAnimationActive={false}>
                  {analysis.climate.anomalies.map((a, i) => (
                    <Cell key={i} fill={a.anomaly >= 0 ? '#38bdf8' : '#f59e0b'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="chart-foot">Monthly mean minus the mean of the same calendar month over the whole record.</div>
          </>
        )}

        {tab === 'spi' && analysis.climate && (
          <>
            {analysis.climate.spi ? (
              <>
                <div className="param-row">
                  <label className="inline-select">
                    <span>Time scale</span>
                    <select id="spi-scale" value={spiScale} onChange={e => setSpiScale(Number(e.target.value))}>
                      {SPI_SCALES.map(k => (
                        <option key={k} value={k}>
                          SPI-{k} ({k} month{k === 1 ? '' : 's'})
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {(() => {
                  const r = analysis.climate!.spi!.find(x => x.scale === spiScale)!;
                  const rows = r.rows.filter(x => x.spi !== null);
                  const last = rows[rows.length - 1];
                  return (
                    <>
                      <ResponsiveContainer width="100%" height={280}>
                        <BarChart data={rows.map(x => ({ label: `${MONTHS[x.month]} ${x.year}`, spi: x.spi }))} margin={{ top: 10, right: 16, bottom: 4, left: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#16283c" />
                          <XAxis dataKey="label" {...AXIS} minTickGap={40} />
                          <YAxis {...AXIS} width={40} domain={[-3, 3]} />
                          <ReferenceLine y={-1} stroke="#f59e0b" strokeDasharray="4 4" />
                          <ReferenceLine y={1} stroke="#38bdf8" strokeDasharray="4 4" />
                          <Tooltip content={<ChartTooltip time={false} />} />
                          <Bar dataKey="spi" name={`SPI-${spiScale}`} isAnimationActive={false}>
                            {rows.map((x, i) => (
                              <Cell key={i} fill={x.spi! < 0 ? '#f59e0b' : '#38bdf8'} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                      <p className="field-hint" id="spi-latest">
                        Latest: SPI-{spiScale} = {last ? `${fmt(last.spi!, 2)} in ${MONTHS[last.month]} ${last.year} (${spiClass(last.spi!)})` : '—'}. {rows.filter(x => x.spi! <= -1).length} of {rows.length} months were moderately dry or
                        worse (≤ −1).
                      </p>
                      <ul className="hint-list">
                        {r.notes.map(n => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    </>
                  );
                })()}
              </>
            ) : (
              <p className="notice">{analysis.climate.spiNote}</p>
            )}
          </>
        )}

        {tab === 'classes' && (
          <div className="classes-view">
            <div className="class-bars">
              {classData.map(c => (
                <div key={c.name} className="class-row">
                  <span className="class-swatch" style={{ background: c.color }} aria-hidden="true" />
                  <span className="class-name">{c.name}</span>
                  <span className="class-bar-track">
                    <span className="class-bar" style={{ width: `${classTotal ? (c.value / classTotal) * 100 : 0}%`, background: c.color }} />
                  </span>
                  <span className="class-count">
                    {c.value} <span className="muted">({classTotal ? ((c.value / classTotal) * 100).toFixed(1) : '0.0'} %)</span>
                  </span>
                </div>
              ))}
            </div>
            <p className="basis">
              <strong>Basis:</strong> {cls.basis}
              {cls.note && (
                <>
                  <br />
                  <strong>Note:</strong> {cls.note}
                </>
              )}
            </p>
          </div>
        )}

        {tab === 'table' && (
          <div className="tabular-view">
            <table>
              <thead>
                <tr>
                  <th>{dataset.timeColumn ?? 'Row'}</th>
                  <th>{metric}</th>
                  <th>Class</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map(p => {
                  const idx = cls.classify(p.value);
                  const bucket = idx >= 0 ? cls.buckets[idx] : null;
                  return (
                    <tr key={p.row}>
                      <td>{p.label}</td>
                      <td className="num">{fmt(p.value, 5)}</td>
                      <td>
                        {bucket && (
                          <span className="class-chip">
                            <span className="class-swatch" style={{ background: bucket.color }} aria-hidden="true" />
                            {bucket.label}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {pageCount > 1 && (
              <div className="pager">
                <button type="button" className="btn btn-small" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                  ← Previous
                </button>
                <span>
                  Page {page + 1} of {pageCount}
                </span>
                <button type="button" className="btn btn-small" disabled={page >= pageCount - 1} onClick={() => setPage(p => p + 1)}>
                  Next →
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
