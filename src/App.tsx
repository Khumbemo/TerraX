/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import ChatPanel, { type ChatReply } from './components/ChatPanel';
import ErrorBoundary from './components/ErrorBoundary';
import LiveTelemetryDock from './components/LiveTelemetryDock';
import MapPanel, { type DrawState } from './components/MapPanel';
import PlanetaryTelemetry from './components/PlanetaryTelemetry';
import ReportPanel from './components/ReportPanel';
import SessionGate from './components/SessionGate';
import type { Target } from './components/SettingsModal';
import ToolHub from './components/ToolHub';
import { AiUnavailableError, generate, getAiMode, type AiMode } from './lib/ai';
import { analyzeMetric, numericColumns } from './lib/analysis';
import { downloadText, safeFilename } from './lib/download';
import type { ChatTurn } from './lib/gemini-shared';
import { OfflineAssistant, STARTER_SUGGESTIONS, type AssistantContext } from './lib/assistant/engine';
import { DATA_SYSTEM_PROMPT, GUIDE_SYSTEM_PROMPT } from './lib/guide';
import { loadReports, saveReports } from './lib/reports';
import { getJSON, removeItem, setJSON } from './lib/storage';
import { useToast } from './lib/toast';
import { toolInfo, type ToolId, type ToolOutput } from './lib/tools/registry';
import type { Dataset, ReportRecord } from './lib/types';
import type { Boundary } from './lib/zonal';

// Tools and rarely needed views load on demand to keep the first load small.
const ForestLossTool = lazy(() => import('./components/tools/ForestLossTool'));
const CarbonTool = lazy(() => import('./components/tools/CarbonTool'));
const SurveyTool = lazy(() => import('./components/tools/SurveyTool'));
const DataTool = lazy(() => import('./components/tools/DataTool'));
const LandCoverTool = lazy(() => import('./components/tools/LandCoverTool'));
const TerrainTool = lazy(() => import('./components/tools/TerrainTool'));
const PhotoTool = lazy(() => import('./components/tools/PhotoTool'));
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

  const startSession = (operator: string) => {
    const s = { operator };
    setJSON('session', s);
    setSession(s);
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

  // Offline assistants keep short-term memory (last topic) per chat.
  const guideBot = useRef(new OfflineAssistant('guide'));
  const resultsBot = useRef(new OfflineAssistant('results'));
  useEffect(() => resultsBot.current.reset(), [output?.tool, output?.name]);

  const assistantContext = useCallback(
    (): AssistantContext => ({
      operator: session?.operator,
      target,
      results: output ? { toolName: toolInfo(output.tool).name, name: output.name, markdown: output.markdown, dataset: output.dataset, focus: output.focus } : undefined,
    }),
    [session, target, output],
  );

  /** Offline answer, noting when AI was on but failed. */
  const offline = (bot: OfflineAssistant, question: string, aiError?: unknown): ChatReply => {
    const r = bot.reply(question, assistantContext());
    const note = aiError ? `_The AI request failed (${aiError instanceof Error ? aiError.message : 'unknown error'}), so this is the offline answer._\n\n` : '';
    return { text: note + r.text, suggestions: r.suggestions };
  };

  const askData = useCallback(
    async (question: string, history: ChatTurn[]): Promise<ChatReply> => {
      try {
        const context = output ? `Tool: ${toolInfo(output.tool).name}\n\n${output.extraContext ?? output.markdown}` : 'No results yet.';
        const result = await generate({
          systemInstruction: `${DATA_SYSTEM_PROMPT}\n\n# Results\n${context}`,
          turns: [...history.slice(-8), { role: 'user', text: question }],
          useSearch: true,
          temperature: 0.4,
        });
        return { text: result.text, sources: result.sources };
      } catch (err) {
        return offline(resultsBot.current, question, err instanceof AiUnavailableError ? undefined : err);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [output, assistantContext],
  );

  const askGuide = useCallback(async (question: string, history: ChatTurn[]): Promise<ChatReply> => {
    try {
      const result = await generate({ systemInstruction: GUIDE_SYSTEM_PROMPT, turns: [...history.slice(-8), { role: 'user', text: question }], useSearch: true });
      return { text: result.text, sources: result.sources };
    } catch (err) {
      return offline(guideBot.current, question, err instanceof AiUnavailableError ? undefined : err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantContext]);

  const exportSummary = async () => {
    if (!output?.dataset) return;
    try {
      await downloadText(JSON.stringify(summaryJson(output.dataset), null, 2), `TerraX_${safeFilename(output.dataset.filename)}_summary.json`, 'application/json');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'The download failed.', 'error');
    }
  };

  if (!session) return <SessionGate onStart={startSession} />;

  const info = tool ? toolInfo(tool) : null;

  return (
    <div className="terrax-app">
      <div className="earth-background" aria-hidden="true" />
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
            Tools
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
                <MapPanel
                  target={target}
                  bounds={output?.map?.bounds ?? null}
                  geojson={drawPts ? null : (output?.map?.geojson ?? null)}
                  image={output?.map?.image ?? null}
                  boundary={boundary}
                  draw={draw}
                />
              </ErrorBoundary>

              {!tool || !info ? (
                <ToolHub onOpen={openTool} />
              ) : (
                <ErrorBoundary area={info.name} inline key={tool}>
                  <section className="tool-workspace" aria-label={info.name}>
                    <div className="tool-workspace-head">
                      <button type="button" className="link-btn" onClick={() => openTool(null)}>
                        ← All tools
                      </button>
                      <div>
                        <div className="eyebrow">{info.group}</div>
                        <h2>{info.name}</h2>
                      </div>
                      {output?.dataset && (
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
                        greeting={`Ask about these ${info.name.toLowerCase()} results for ${output.name}.${aiMode === 'off' ? ' AI is off, so answers come from the computed results.' : ''}`}
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
            greeting={`Hi${session.operator ? ` ${session.operator.split(/\s+/)[0]}` : ''}! I’m the TerraX assistant. Ask me about the tools, remote-sensing terms, area units or sun times${aiMode === 'off' ? '. I work offline; add a Gemini key in Settings for open-ended questions' : ''}.`}
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
