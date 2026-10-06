/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import ChatPanel, { type ChatReply } from './components/ChatPanel';
import ErrorBoundary from './components/ErrorBoundary';
import LiveTelemetryDock from './components/LiveTelemetryDock';
import type { DrawState } from './components/map/MapController';
import PlanetaryTelemetry from './components/PlanetaryTelemetry';
import ReportPanel from './components/ReportPanel';
import SessionGate from './components/SessionGate';
import type { Target } from './components/SettingsModal';
import ToolHub from './components/ToolHub';
import { chat, getAiMode, type AiMode, type ChatTurn } from './lib/ai';
import { downloadText, safeFilename } from './lib/download';
import { usePrefs } from './lib/prefs';
import { buildProject, mergeReports, parseProject } from './lib/project';
import { loadReports, saveReports } from './lib/reports';
import { getJSON, removeItem, setJSON } from './lib/storage';
import { useToast } from './lib/toast';
import { toolInfo, type ToolId, type ToolOutput } from './lib/tools/registry';
import type { ReportRecord } from './lib/types';
import type { Boundary } from './lib/zonal';

// Tools and rarely needed views load on demand to keep the first load small.
const MapPanel = lazy(() => import('./components/MapPanel'));
const ForestLossTool = lazy(() => import('./components/tools/ForestLossTool'));
const ResidentialPlotTool = lazy(() => import('./components/tools/ResidentialPlotTool'));
const CarbonTool = lazy(() => import('./components/tools/CarbonTool'));
const SurveyTool = lazy(() => import('./components/tools/SurveyTool'));
const DataTool = lazy(() => import('./components/tools/DataTool'));
const LandCoverTool = lazy(() => import('./components/tools/LandCoverTool'));
const TerrainTool = lazy(() => import('./components/tools/TerrainTool'));
const PhotoTool = lazy(() => import('./components/tools/PhotoTool'));
const ReportsView = lazy(() => import('./components/ReportsView'));
const SettingsModal = lazy(() => import('./components/SettingsModal'));
const Tour = lazy(() => import('./components/Tour'));
import SpaceBackground from './components/SpaceBackground';

const AI_MODE_TEXT: Record<AiMode, string> = {
  'own-key': 'AI on: using your API key from this browser',
  server: 'AI on: using the TerraX server',
  off: 'AI off: built-in assistant only',
};

const Loading = () => <div className="loading-block">Loading…</div>;

const DEFAULT_TARGET: Target = { lat: 25.674, lon: 94.108, name: 'Kohima' };

type View = 'explore' | 'reports';

const STARTER_SUGGESTIONS = ['What can you do?', 'How do I estimate forest loss?', 'How do I measure a plot?', 'What is NDVI?'];

export default function App() {
  const notify = useToast();
  const { t } = usePrefs();
  const [session, setSession] = useState<{ operator: string } | null>(() => getJSON('session', null));
  const [view, setView] = useState<View>('explore');
  const [settings, setSettings] = useState<{ open: boolean; tab?: 'settings' | 'map' | 'guide' | 'gee' | 'about' }>({ open: false });
  const [target, setTarget] = useState<Target>(() => getJSON('target', DEFAULT_TARGET));
  const [aiMode, setAiMode] = useState<AiMode | null>(null);

  const [tool, setTool] = useState<ToolId | null>(null);
  const [output, setOutput] = useState<ToolOutput | null>(null);
  const [boundary, setBoundaryState] = useState<Boundary | null>(() => getJSON('boundary', null));
  const [drawPts, setDrawPts] = useState<[number, number][] | null>(null);

  const setBoundary = (b: Boundary | null) => {
    setBoundaryState(b);
    if (b) setJSON('boundary', b);
    else removeItem('boundary');
  };

  const draw: DrawState | null = drawPts
    ? {
        points: drawPts,
        onAdd: p => setDrawPts(pts => (pts ? [...pts, p] : pts)),
        onMove: (i, p) => setDrawPts(pts => (pts ? pts.map((q, j) => (j === i ? p : q)) : pts)),
        onRemove: i => setDrawPts(pts => (pts ? pts.filter((_, j) => j !== i) : pts)),
      }
    : null;

  const [reports, setReports] = useState<ReportRecord[]>(() => loadReports());
  const [openReportId, setOpenReportId] = useState<string | null>(null);

  const refreshAi = useCallback(() => {
    getAiMode().then(setAiMode);
  }, []);
  useEffect(refreshAi, [refreshAi]);

  const [tour, setTour] = useState(false);
  const endTour = useCallback(() => {
    setTour(false);
    setJSON('tour_done', true);
  }, []);

  const startSession = (operator: string) => {
    const s = { operator };
    setJSON('session', s);
    setSession(s);
    // First visit: offer the guided tour once (not in automated browsers).
    if (!getJSON('tour_done', false) && !navigator.webdriver) setTour(true);
  };

  const endSession = () => {
    removeItem('session');
    setSession(null);
    setTool(null);
    setOutput(null);
    setDrawPts(null);
    setView('explore');
  };

  const openTool = (id: ToolId | null) => {
    setTool(id);
    setDrawPts(null);
    setOutput(null);
    setView('explore');
  };

  const persistReports = (next: ReportRecord[]) => {
    setReports(next);
    if (!saveReports(next)) notify('Browser storage is unavailable or full, so reports will be lost when you close this tab. Download them to keep a copy.', 'error');
  };

  const saveReport = (r: ReportRecord) => {
    const next = [r, ...reports.filter(x => x.id !== r.id)];
    if (r.figures?.length && !saveReports(next)) {
      // Figures are the bulky part; keep the text if storage is short.
      const { figures: _f, ...text } = r;
      persistReports([text, ...reports.filter(x => x.id !== r.id)]);
      notify('Report saved without its figures: browser storage is nearly full. Download the PDF to keep them.');
      return;
    }
    persistReports(next);
    notify('Report saved. Find it in the Reports view.', 'success');
  };

  const PREF_KEYS = ['declination', 'units', 'theme', 'lang'];
  const exportProject = () => {
    const preferences: Record<string, unknown> = {};
    for (const k of PREF_KEYS) {
      const v = getJSON<unknown>(k, null);
      if (v !== null) preferences[k] = v;
    }
    const p = buildProject({ target, boundary, reports, preferences });
    downloadText(JSON.stringify(p), `TerraX_project_${new Date().toISOString().slice(0, 10)}.terrax.json`, 'application/json').catch(err =>
      notify(err instanceof Error ? err.message : 'The download failed.', 'error'),
    );
  };

  const importProject = async (file: File) => {
    try {
      const p = parseProject(JSON.parse(await file.text()));
      const { reports: merged, added } = mergeReports(reports, p.reports);
      persistReports(merged);
      if (p.target) updateTarget(p.target);
      if (p.boundary) setBoundary(p.boundary);
      for (const k of PREF_KEYS) if (k in p.preferences) setJSON(k, p.preferences[k]);
      notify(`Project imported: ${added} new report${added === 1 ? '' : 's'}${p.boundary ? ', analysis boundary' : ''}${p.target ? ', target location' : ''}. Reload to apply display preferences.`, 'success');
    } catch (err) {
      notify(err instanceof SyntaxError ? `${file.name} is not valid JSON.` : err instanceof Error ? err.message : 'Could not import the project.', 'error');
    }
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

  // The built-in assistant keeps a little memory (last topic) per chat; the server sends it back with each reply.
  const guideState = useRef<Record<string, unknown>>({});
  const resultsState = useRef<Record<string, unknown>>({});
  useEffect(() => {
    resultsState.current = {};
  }, [output?.tool, output?.name]);

  const ask = useCallback(
    async (agent: 'guide' | 'results', question: string, history: ChatTurn[]): Promise<ChatReply> => {
      const state = agent === 'guide' ? guideState : resultsState;
      const r = await chat({
        agent,
        question,
        history,
        target,
        operator: session?.operator,
        results: agent === 'results' && output ? { toolName: toolInfo(output.tool).name, name: output.name, markdown: output.markdown, extraContext: output.extraContext, fileId: output.fileId, focus: output.focus } : undefined,
        state: state.current,
      });
      state.current = r.state;
      return { text: r.text, sources: r.sources, suggestions: r.suggestions };
    },
    [target, session, output],
  );
  const askData = useCallback((q: string, h: ChatTurn[]) => ask('results', q, h), [ask]);
  const askGuide = useCallback((q: string, h: ChatTurn[]) => ask('guide', q, h), [ask]);

  const exportSummary = async () => {
    if (!output?.summary) return;
    try {
      await downloadText(JSON.stringify(output.summary, null, 2), `TerraX_${safeFilename(output.name)}_summary.json`, 'application/json');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'The download failed.', 'error');
    }
  };

  if (!session)
    return (
      <>
        <SpaceBackground target={target} />
        <SessionGate onStart={startSession} />
      </>
    );

  const info = tool ? toolInfo(tool) : null;

  return (
    <div className="terrax-app">
      <SpaceBackground target={target} />
      <header className="top-navbar">
        <div className="brand">TERRAX</div>
        <nav className="nav-links" aria-label="Main">
          <button
            type="button"
            className={view === 'explore' ? 'active-link' : ''}
            aria-current={view === 'explore' ? 'page' : undefined}
            onClick={() => {
              if (view === 'explore') openTool(null);
              else setView('explore');
            }}
          >
            {t('nav.tools')}
          </button>
          <button type="button" id="nav-reports" className={view === 'reports' ? 'active-link' : ''} aria-current={view === 'reports' ? 'page' : undefined} onClick={() => setView('reports')}>
            {t('nav.reports')}
            {reports.length ? ` (${reports.length})` : ''}
          </button>
          <button type="button" id="nav-settings" onClick={() => setSettings({ open: true, tab: 'settings' })}>
            {t('nav.settings')}
          </button>
        </nav>
        <div className="nav-right">
          <span className={`ai-pill ai-${aiMode ?? 'off'}`} title={aiMode ? AI_MODE_TEXT[aiMode] : 'Checking AI status'}>
            AI {aiMode === 'off' ? 'off' : aiMode ? 'on' : '…'}
          </span>
          {session.operator && <span className="operator">{session.operator}</span>}
          <button type="button" className="link-btn" onClick={endSession}>
            {t('nav.end')}
          </button>
        </div>
      </header>


      {settings.open && (
        <Suspense fallback={null}>
          <SettingsModal
            initialTab={settings.tab}
            target={target}
            onTargetChange={updateTarget}
            onAiChange={refreshAi}
            onClose={() => setSettings({ open: false })}
            onStartTour={() => {
              setSettings({ open: false });
              setView('explore');
              setTour(true);
            }}
          />
        </Suspense>
      )}

      {tour && (
        <Suspense fallback={null}>
          <Tour onClose={endTour} />
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
              <ReportsView
                reports={reports}
                openId={openReportId}
                onOpen={setOpenReportId}
                onDelete={deleteReport}
                onGoExplore={() => setView('explore')}
                onExportProject={exportProject}
                onImportProject={importProject}
              />
            </Suspense>
          ) : (
            <>
              <ErrorBoundary area="Map" inline>
                <Suspense fallback={<div className="map-container map-loading" aria-busy="true" />}>
                <MapPanel
                  target={target}
                  bounds={output?.map?.bounds ?? null}
                  geojson={drawPts ? null : (output?.map?.geojson ?? null)}
                  image={output?.map?.image ?? null}
                  boundary={boundary}
                  draw={draw}
                />
                </Suspense>
              </ErrorBoundary>

              {!tool || !info ? (
                <ToolHub onOpen={openTool} />
              ) : (
                <ErrorBoundary area={info.name} inline key={tool}>
                  <section className="tool-workspace" aria-label={info.name}>
                    <div className="tool-workspace-head">
                      <button type="button" className="link-btn" onClick={() => openTool(null)}>
                        {t('workspace.all')}
                      </button>
                      <div>
                        <div className="eyebrow">{t(`tool.${info.id}.group`, info.group)}</div>
                        <h2 data-name={info.name}>{t(`tool.${info.id}.name`, info.name)}</h2>
                      </div>
                      {output?.summary != null && (
                        <button type="button" className="btn btn-small push-right" onClick={exportSummary}>
                          Export summary (JSON)
                        </button>
                      )}
                    </div>
                    {boundary && tool !== 'photo' && tool !== 'carbon' && (
                      <div className="boundary-banner" role="status">
                        <span>
                          Analysis boundary: <strong>{boundary.name}</strong> ({(boundary.areaM2 / 10_000).toFixed(2)} ha).{' '}
                          {tool === 'survey' ? 'Raster tools count only the pixels inside it.' : tool === 'weather' ? 'Applies to GeoTIFF grids, not to tables.' : 'Only pixels inside it are analysed.'}
                        </span>
                        <button type="button" id="boundary-clear" className="btn btn-small push-right" onClick={() => setBoundary(null)}>
                          Clear boundary
                        </button>
                      </div>
                    )}
                    <Suspense fallback={<Loading />}>
                      {tool === 'forest' && <ForestLossTool onOutput={setOutput} boundary={boundary} />}
                      {tool === 'carbon' && <CarbonTool onOutput={setOutput} />}
                      {tool === 'residential' && <ResidentialPlotTool onOutput={setOutput} boundary={boundary} onBoundary={setBoundary} />}
                      {tool === 'survey' && <SurveyTool onOutput={setOutput} boundary={boundary} onBoundary={setBoundary} drawPoints={drawPts} onDraw={setDrawPts} />}
                      {(tool === 'weather' || tool === 'satellite') && <DataTool key={tool} variant={tool} onOutput={setOutput} boundary={boundary} target={target} />}
                      {tool === 'landcover' && <LandCoverTool onOutput={setOutput} boundary={boundary} />}
                      {tool === 'terrain' && <TerrainTool onOutput={setOutput} boundary={boundary} onBoundary={setBoundary} />}
                      {tool === 'photo' && <PhotoTool onOutput={setOutput} />}
                    </Suspense>
                  </section>

                  {output && (
                    <>
                      <ReportPanel output={output} aiMode={aiMode} operator={session.operator} onSave={saveReport} onOpenSettings={() => setSettings({ open: true, tab: 'settings' })} />
                      <ChatPanel
                        key={`chat-${output.tool}-${output.name}`}
                        id="dataset-chat"
                        title="Results assistant"
                        greeting={`Ask about these ${info.name.toLowerCase()} results for ${output.name}.${aiMode === 'off' ? ' AI is off, so the built-in assistant answers from the computed results.' : ''}`}
                        placeholder="Ask about these results"
                        onAsk={askData}
                        starters={['Summarise the results', 'How was this calculated?', 'How reliable is this?']}
                      />
                    </>
                  )}
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
            greeting={`Hi${session.operator ? ` ${session.operator.split(/\s+/)[0]}` : ''}! I’m the TerraX assistant. Ask me about the tools, remote-sensing terms, area units or sun times${aiMode === 'off' ? '; for open-ended questions add a Gemini key in Settings' : ''}.`}
            placeholder="Ask about TerraX"
            onAsk={askGuide}
            starters={STARTER_SUGGESTIONS}
          />
          <LiveTelemetryDock />
        </aside>
      </main>
    </div>
  );
}
