import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useToast } from '../lib/toast';
import type { ReportRecord } from '../lib/types';
import { exportReport } from './ReportPanel';

interface Props {
  reports: ReportRecord[];
  openId: string | null;
  onOpen: (id: string | null) => void;
  onDelete: (id: string) => void;
  onGoExplore: () => void;
  onExportProject: () => void;
  onImportProject: (file: File) => void;
}

function ProjectBar({ onExportProject, onImportProject }: Pick<Props, 'onExportProject' | 'onImportProject'>) {
  return (
    <div className="project-bar">
      <span className="muted">Project file: the analysis boundary, target location, saved reports and preferences (never your API key).</span>
      <div className="button-row push-right">
        <button type="button" id="project-export" className="btn btn-small" onClick={onExportProject}>
          Export project
        </button>
        <label className="btn btn-small" htmlFor="project-import">
          Import project
        </label>
        <input
          id="project-import"
          type="file"
          accept=".json,.terrax.json,application/json"
          hidden
          onChange={e => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) onImportProject(f);
          }}
        />
      </div>
    </div>
  );
}

export default function ReportsView({ reports, openId, onOpen, onDelete, onGoExplore, onExportProject, onImportProject }: Props) {
  const notify = useToast();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const open = reports.find(r => r.id === openId) ?? reports[0] ?? null;

  if (!reports.length) {
    return (
      <>
      <ProjectBar onExportProject={onExportProject} onImportProject={onImportProject} />
      <div className="empty-state">
        <h2>No saved reports yet</h2>
        <p>Load a dataset in Explore, then choose “Save to Reports” on its report.</p>
        <button type="button" className="btn btn-primary" onClick={onGoExplore}>
          Go to Explore
        </button>
      </div>
      </>
    );
  }

  const download = async (r: ReportRecord, kind: 'md' | 'pdf') => {
    try {
      await exportReport(r, kind);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'The download failed.', 'error');
    }
  };

  return (
    <>
    <ProjectBar onExportProject={onExportProject} onImportProject={onImportProject} />
    <div className="reports-layout">
      <aside className="report-list" aria-label="Saved reports">
        <div className="eyebrow">Saved reports ({reports.length})</div>
        {reports.map(r => (
          <button key={r.id} type="button" className={`report-list-item ${open?.id === r.id ? 'active' : ''}`} onClick={() => onOpen(r.id)}>
            <span className="report-list-name">{r.datasetName}</span>
            <span className="report-list-meta">
              {r.createdAt.slice(0, 16).replace('T', ' ')} UTC · {r.source === 'ai' ? 'with AI' : 'statistics'}
            </span>
          </button>
        ))}
      </aside>
      {open && (
        <article className="report-card">
          <div className="report-card-head">
            <div>
              <div className="eyebrow">{open.source === 'ai' ? `With AI interpretation${open.model ? ` · ${open.model}` : ''}` : 'Computed statistics'}</div>
              <h3>{open.datasetName}</h3>
            </div>
            <div className="button-row">
              <button type="button" className="btn" onClick={() => download(open, 'md')}>
                Markdown
              </button>
              <button type="button" className="btn" onClick={() => download(open, 'pdf')}>
                PDF
              </button>
              {confirmId === open.id ? (
                <>
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => {
                      onDelete(open.id);
                      setConfirmId(null);
                    }}
                  >
                    Confirm delete
                  </button>
                  <button type="button" className="btn" onClick={() => setConfirmId(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" className="btn" onClick={() => setConfirmId(open.id)}>
                  Delete
                </button>
              )}
            </div>
          </div>
          <div className="markdown report-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{open.content.replace(/^# .*\n+/, '')}</ReactMarkdown>
          </div>
          {open.figures && open.figures.length > 0 && (
            <div className="report-figures">
              {open.figures.map((f, i) => (
                <figure key={i}>
                  <img src={f.dataUrl} alt={f.title} width={f.width} height={f.height} />
                  <figcaption>
                    Figure {i + 1}. {f.title}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </article>
      )}
    </div>
    </>
  );
}
