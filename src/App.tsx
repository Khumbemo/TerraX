/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import ChatPanel, { type ChatReply } from './components/ChatPanel';
import DataUploader from './components/DataUploader';
import ErrorBoundary from './components/ErrorBoundary';
import LiveTelemetryDock from './components/LiveTelemetryDock';
import MapPanel from './components/MapPanel';
import PlanetaryTelemetry from './components/PlanetaryTelemetry';
import ReportPanel from './components/ReportPanel';
import SessionGate from './components/SessionGate';
import type { Target } from './components/SettingsModal';
import { AiUnavailableError, generate, getAiMode, type AiMode } from './lib/ai';
import { analyzeMetric, numericColumns } from './lib/analysis';
import { downloadText, safeFilename } from './lib/download';
import type { ChatTurn } from './lib/gemini-shared';
import { DATA_SYSTEM_PROMPT, GUIDE_SYSTEM_PROMPT, localDataAnswer, localGuideAnswer } from './lib/guide';
import { readRaster } from './lib/raster';
import { buildAiContext, formatBytes } from './lib/report';
import { loadReports, saveReports } from './lib/reports';
import { getJSON, removeItem, setJSON } from './lib/storage';
import { useToast } from './lib/toast';
import type { Dataset, RasterMode, ReportRecord } from './lib/types';

// Chart-heavy and rarely needed views load on demand to keep the first load small.
const CoreAnalysisDashboard = lazy(() => import('./components/CoreAnalysisDashboard'));
const RasterPanel = lazy(() => import('./components/RasterPanel'));
const ReportsView = lazy(() => import('./components/ReportsView'));
const SettingsModal = lazy(() => import('./components/SettingsModal'));

const AI_MODE_TEXT: Record<AiMode, string> = {
  'own-key': 'AI on: using your API key from this browser',
  server: 'AI on: using the TerraX server',
  off: 'AI off: statistics only',
};

const Loading = () => <div className="loading-block">Loading…</div>;

const DEFAULT_TARGET: Target = { lat: 25.674, lon: 94.108, name: 'Kohima' };

type View = 'explore' | 'reports';

function summaryJson(ds: Dataset) {
  if (ds.kind === 'raster') {
    const { preview: _preview, ...rest } = ds;
    return rest;
  }
  return {
    filename: ds.filename,
    format: ds.format,
    records: ds.rows.length,
    timeColumn: ds.timeColumn,
    intervalDays: ds.intervalDays,
    columns: ds.columns,
    warnings: ds.warnings,
    variables: numericColumns(ds).map(c => {
      const a = analyzeMetric(ds, c);
      return {
        column: c,
        summary: a.summary,
        trend: a.trend,
        period: ds.times ? { start: a.start, end: a.end } : null,
        classes: { basis: a.classification.basis, note: a.classification.note, counts: a.classification.buckets.map((b, i) => ({ class: b.label, count: a.classCounts[i] })) },
      };
    }),
  };
}

export default function App() {
  const notify = useToast();
  const [session, setSession] = useState<{ operator: string } | null>(() => getJSON('session', null));
  const [view, setView] = useState<View>('explore');
  const [settings, setSettings] = useState<{ open: boolean; tab?: 'settings' | 'guide' | 'gee' | 'about' }>({ open: false });
  const [target, setTarget] = useState<Target>(() => getJSON('target', DEFAULT_TARGET));
  const [aiMode, setAiMode] = useState<AiMode | null>(null);

  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [metric, setMetric] = useState<string | null>(null);
  const [rasterBusy, setRasterBusy] = useState(false);

  const [reports, setReports] = useState<ReportRecord[]>(() => loadReports());
  const [openReportId, setOpenReportId] = useState<string | null>(null);

  const refreshAi = useCallback(() => {
    getAiMode().then(setAiMode);
  }, []);
  useEffect(refreshAi, [refreshAi]);

  const startSession = (operator: string) => {
    const s = { operator };
    setJSON('session', s);
    setSession(s);
  };

  const endSession = () => {
    removeItem('session');
    setSession(null);
    setDataset(null);
    setSourceFile(null);
    setView('explore');
  };

  const onLoaded = (ds: Dataset, file: File) => {
    setDataset(ds);
    setSourceFile(file);
    setMetric(ds.kind === 'table' ? ds.defaultMetric : null);
    setView('explore');
    const warn = ds.warnings.length ? ` ${ds.warnings.length} data note${ds.warnings.length === 1 ? '' : 's'} below.` : '';
    notify(`Loaded ${ds.filename}.${warn}`, 'success');
  };

  const changeRasterView = async (mode: RasterMode) => {
    if (!sourceFile) return;
    setRasterBusy(true);
    try {
      setDataset(await readRaster(sourceFile, mode));
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not read that band.', 'error');
    } finally {
      setRasterBusy(false);
    }
  };

  const persistReports = (next: ReportRecord[]) => {
    setReports(next);
    if (!saveReports(next)) notify('Browser storage is unavailable or full, so reports will be lost when you close this tab. Download them to keep a copy.', 'error');
  };

  const saveReport = (r: ReportRecord) => {
    persistReports([r, ...reports.filter(x => x.id !== r.id)]);
    notify('Report saved. Find it in the Reports view.', 'success');
  };

  const deleteReport = (id: string) => {
    persistReports(reports.filter(r => r.id !== id));
    if (openReportId === id) setOpenReportId(null);
    notify('Report deleted.');
  };

  const updateTarget = (t: Target) => {
    setTarget(t);
    setJSON('target', t);
  };

  const askData = useCallback(
    async (question: string, history: ChatTurn[]): Promise<ChatReply> => {
      try {
        const context = dataset ? buildAiContext(dataset, metric) : 'No dataset is loaded.';
        const result = await generate({
          systemInstruction: `${DATA_SYSTEM_PROMPT}\n\n# Dataset\n${context}`,
          turns: [...history.slice(-8), { role: 'user', text: question }],
          useSearch: true,
          temperature: 0.4,
        });
        return { text: result.text, sources: result.sources };
      } catch (err) {
        if (err instanceof AiUnavailableError) return { text: localDataAnswer(question, dataset, metric) };
        throw err;
      }
    },
    [dataset, metric],
  );

  const askGuide = useCallback(async (question: string, history: ChatTurn[]): Promise<ChatReply> => {
    try {
      const result = await generate({ systemInstruction: GUIDE_SYSTEM_PROMPT, turns: [...history.slice(-8), { role: 'user', text: question }], useSearch: true });
      return { text: result.text, sources: result.sources };
    } catch (err) {
      if (err instanceof AiUnavailableError) return { text: localGuideAnswer(question) };
      throw err;
    }
  }, []);

  const exportSummary = async () => {
    if (!dataset) return;
    try {
      await downloadText(JSON.stringify(summaryJson(dataset), null, 2), `TerraX_${safeFilename(dataset.filename)}_summary.json`, 'application/json');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'The download failed.', 'error');
    }
  };

  const raster = dataset?.kind === 'raster' ? dataset : null;
  const datasetKey = dataset ? `${dataset.id}` : 'none';
  const typeLabel = useMemo(() => {
    if (!dataset) return '';
    if (dataset.kind === 'raster') return `GeoTIFF · ${dataset.width}×${dataset.height} px · ${dataset.bands} band${dataset.bands === 1 ? '' : 's'}`;
    return `${dataset.format} · ${dataset.rows.length.toLocaleString()} rows · ${dataset.columns.length} columns`;
  }, [dataset]);

  if (!session) return <SessionGate onStart={startSession} />;

  return (
    <div className="terrax-app">
      <div className="earth-background" aria-hidden="true" />
      <header className="top-navbar">
        <div className="brand">TERRAX</div>
        <nav className="nav-links" aria-label="Main">
          <button type="button" className={view === 'explore' ? 'active-link' : ''} aria-current={view === 'explore' ? 'page' : undefined} onClick={() => setView('explore')}>
            Explore
          </button>
          <button type="button" className={view === 'reports' ? 'active-link' : ''} aria-current={view === 'reports' ? 'page' : undefined} onClick={() => setView('reports')}>
            Reports{reports.length ? ` (${reports.length})` : ''}
          </button>
          <button type="button" onClick={() => setSettings({ open: true, tab: 'settings' })}>
            Settings
          </button>
        </nav>
        <div className="nav-right">
          <span className={`ai-pill ai-${aiMode ?? 'off'}`} title={aiMode ? AI_MODE_TEXT[aiMode] : 'Checking AI status'}>
            AI {aiMode === 'off' ? 'off' : aiMode ? 'on' : '…'}
          </span>
          {session.operator && <span className="operator">{session.operator}</span>}
          <button type="button" className="link-btn" onClick={endSession}>
            End session
          </button>
        </div>
      </header>

      {__TERRAX_PREVIEW__ && (
        <div className="preview-banner" role="note">
          Preview build: this sandbox blocks map tiles, live space weather and AI, and downloads ask for confirmation. Everything else works. Run TerraX locally for the full app.
        </div>
      )}

      {settings.open && (
        <Suspense fallback={null}>
          <SettingsModal initialTab={settings.tab} target={target} onTargetChange={updateTarget} onAiChange={refreshAi} onClose={() => setSettings({ open: false })} />
        </Suspense>
      )}

      <main className="terrax-workspace">
        <aside className="telemetry-panel">
          <ErrorBoundary area="Telemetry" inline>
            <PlanetaryTelemetry target={target} />
          </ErrorBoundary>
        </aside>

        <div className="center-column">
          {view === 'reports' ? (
            <Suspense fallback={<Loading />}>
              <ReportsView reports={reports} openId={openReportId} onOpen={setOpenReportId} onDelete={deleteReport} onGoExplore={() => setView('explore')} />
            </Suspense>
          ) : (
            <>
              <ErrorBoundary area="Map" inline>
                <MapPanel raster={raster} target={target} />
              </ErrorBoundary>

              <DataUploader onLoaded={onLoaded} onError={msg => notify(msg, 'error')} />

              {dataset && (
                <ErrorBoundary area="Dataset view" inline key={datasetKey}>
                  <section className="intelligence-report-card" aria-label="Loaded dataset">
                    <div className="report-header">
                      <span className="status-dot" aria-hidden="true" />
                      <span className="report-title">{dataset.filename}</span>
                      <span className="muted">
                        {typeLabel} · {formatBytes(dataset.sizeBytes)}
                      </span>
                      <div className="button-row push-right">
                        <button type="button" className="btn btn-small" onClick={exportSummary}>
                          Export summary (JSON)
                        </button>
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => {
                            setDataset(null);
                            setSourceFile(null);
                          }}
                        >
                          Close dataset
                        </button>
                      </div>
                    </div>
                    {dataset.warnings.length > 0 && (
                      <ul className="data-notes" aria-label="Data notes">
                        {dataset.warnings.map(w => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <Suspense fallback={<Loading />}>
                    {dataset.kind === 'table' ? (
                      metric ? (
                        <CoreAnalysisDashboard dataset={dataset} metric={metric} onMetricChange={setMetric} />
                      ) : (
                        <p className="notice">This table has no numeric columns to analyse.</p>
                      )
                    ) : (
                      <RasterPanel dataset={dataset} busy={rasterBusy} onChangeView={changeRasterView} />
                    )}
                  </Suspense>

                  <ReportPanel
                    dataset={dataset}
                    focus={metric}
                    aiMode={aiMode}
                    operator={session.operator}
                    onSave={saveReport}
                    onOpenSettings={() => setSettings({ open: true, tab: 'settings' })}
                  />

                  <ChatPanel
                    key={`chat-${datasetKey}`}
                    id="dataset-chat"
                    title="Dataset assistant"
                    greeting={`Ask about ${dataset.filename}: for example “Is there a trend?” or “When was the peak?”${aiMode === 'off' ? ' AI is off, so answers come from the computed statistics.' : ''}`}
                    placeholder="Ask about this dataset"
                    onAsk={askData}
                  />
                </ErrorBoundary>
              )}
            </>
          )}
        </div>

        <aside className="right-links-panel">
          <ChatPanel
            id="guide-chat"
            variant="guide"
            title="OS Guide"
            greeting="Ask how to use TerraX, for example “How do I compute NDVI?” or “How do I export data from Earth Engine?”"
            placeholder="Ask about TerraX"
            onAsk={askGuide}
          />
          <LiveTelemetryDock />
        </aside>
      </main>
    </div>
  );
}
