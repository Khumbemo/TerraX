import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AiMode } from '../lib/ai';
import { interpret as aiInterpret } from '../lib/ai';
import { downloadReportPdf, downloadText, safeFilename } from '../lib/download';
import { collectFigures, type ReportFigure } from '../lib/figures';
import { toolInfo, type ToolOutput } from '../lib/tools/registry';
import { useToast } from '../lib/toast';
import type { ReportRecord } from '../lib/types';

interface Props {
  output: ToolOutput;
  aiMode: AiMode | null;
  operator: string;
  onSave: (report: ReportRecord) => void;
  onOpenSettings: () => void;
}

function composeReport(output: ToolOutput, operator: string, ai: { text: string; model: string } | null): ReportRecord {
  const createdAt = new Date();
  const title = `TerraX ${toolInfo(output.tool).name} report · ${output.name}`;
  const meta = [`Created ${createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`, operator && `by ${operator}`].filter(Boolean).join(' ');
  const parts = [`# ${title}`, '', `_${meta}_`, ''];
  if (ai) parts.push(`## Interpretation (AI, ${ai.model})`, '', ai.text.trim(), '', '_AI-generated from the statistics below; check it against the data._', '');
  parts.push(output.markdown);
  return {
    id: `${createdAt.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title,
    datasetName: output.name,
    createdAt: createdAt.toISOString(),
    source: ai ? 'ai' : 'local',
    model: ai?.model,
    content: parts.join('\n'),
  };
}

export async function exportReport(report: ReportRecord, kind: 'md' | 'pdf', figures: ReportFigure[] = report.figures ?? []) {
  const base = `TerraX_${safeFilename(report.datasetName)}_${report.createdAt.slice(0, 10)}`;
  if (kind === 'md') await downloadText(report.content, `${base}.md`, 'text/markdown;charset=utf-8');
  else await downloadReportPdf(report.title, `${report.datasetName} · ${report.createdAt.slice(0, 10)}`, report.content.replace(/^# .*\n/, ''), `${base}.pdf`, figures);
}

export default function ReportPanel({ output, aiMode, operator, onSave, onOpenSettings }: Props) {
  const notify = useToast();
  const [ai, setAi] = useState<{ text: string; model: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // New results invalidate the previous interpretation.
  useEffect(() => {
    setAi(null);
    setError(null);
    setSaved(false);
  }, [output.markdown]);

  const report = useMemo(() => composeReport(output, operator, ai), [output, operator, ai]);

  const interpret = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await aiInterpret(toolInfo(output.tool).name, output.markdown, output.extraContext);
      if (!result.text.trim()) throw new Error('Gemini returned an empty answer. Try again.');
      setAi({ text: result.text, model: result.model });
      setSaved(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The AI interpretation failed.');
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    let figures: ReportFigure[] = [];
    try {
      figures = await collectFigures(output);
    } catch {
      figures = [];
    }
    onSave({ ...report, figures });
    setSaved(true);
  };

  const download = async (kind: 'md' | 'pdf') => {
    try {
      await exportReport(report, kind, kind === 'pdf' ? await collectFigures(output).catch(() => []) : []);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'The download failed.', 'error');
    }
  };

  return (
    <section className="report-card" aria-label="Report">
      <div className="report-card-head">
        <div>
          <div className="eyebrow">Report</div>
          <h3>{ai ? 'Statistics with AI interpretation' : 'Computed statistics'}</h3>
        </div>
        <div className="button-row">
          {aiMode && aiMode !== 'off' ? (
            <button type="button" className="btn btn-primary" onClick={interpret} disabled={loading}>
              {loading ? 'Interpreting…' : ai ? 'Regenerate interpretation' : 'Add AI interpretation'}
            </button>
          ) : (
            <button type="button" className="btn" onClick={onOpenSettings}>
              Set up AI
            </button>
          )}
          <button type="button" className="btn" onClick={save} disabled={saved}>
            {saved ? 'Saved' : 'Save to Reports'}
          </button>
          <button type="button" className="btn" onClick={() => download('md')}>
            Markdown
          </button>
          <button type="button" className="btn" onClick={() => download('pdf')}>
            PDF
          </button>
        </div>
      </div>
      {error && <p className="notice notice-error">{error}</p>}
      <div className="markdown report-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.content.replace(/^# .*\n+/, '')}</ReactMarkdown>
      </div>
    </section>
  );
}
