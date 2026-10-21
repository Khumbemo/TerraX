import { useCallback, useEffect, useState } from 'react';
import { apiUrl, request, type Download } from '../../lib/api';
import { useToast } from '../../lib/toast';

interface HistoryJob {
  id: string;
  tool: string;
  state: 'queued' | 'running' | 'done' | 'error';
  message: string;
  name: string;
  created: number;
  seconds: number | null;
  expires: number | null;
  expired: boolean;
}

interface JobDetail {
  result?: { name?: string; markdown?: string; downloads?: Download[] };
}

const TOOL_NAME: Record<string, string> = {
  forest: 'Forest loss', carbon: 'Carbon & biomass', survey: 'Land survey', residential: 'Residential plot', table: 'Weather & climate', raster: 'Satellite imagery',
  stack: 'Satellite series', sentinel: 'Sentinel-2 scene', sentinel1: 'Sentinel-1 scene', landcover: 'Land cover', terrain: 'Terrain', hydrology: 'Hydrology',
  contours: 'Contours', photo: 'Photos', radar: 'Radar (Sentinel-1)', canopy: 'Canopy height',
};

const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The caller's analyses on this server, newest first: reopen their downloads, keep a report, or delete them. */
export default function HistoryPanel({ saveReport, guest }: { saveReport: (title: string, dataset: string, markdown: string) => void; guest: boolean }) {
  const notify = useToast();
  const [jobs, setJobs] = useState<HistoryJob[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, JobDetail>>({});
  const load = useCallback(() => {
    request<{ jobs: HistoryJob[] }>('/api/jobs?limit=100')
      .then(r => setJobs(r.jobs))
      .catch(err => notify(err instanceof Error ? err.message : 'Could not load the history.', 'error'));
  }, [notify]);
  useEffect(load, [load]);

  const expand = async (j: HistoryJob) => {
    if (open === j.id) return setOpen(null);
    setOpen(j.id);
    if (j.expired || j.state !== 'done' || detail[j.id]) return;
    try {
      const d = await request<JobDetail>(`/api/jobs/${j.id}`);
      setDetail(x => ({ ...x, [j.id]: d }));
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not open this result.', 'error');
    }
  };
  const remove = async (j: HistoryJob) => {
    try {
      await request(`/api/jobs/${j.id}`, { method: 'DELETE' });
      setJobs(js => js?.filter(x => x.id !== j.id) ?? js);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not delete it.', 'error');
    }
  };

  if (!jobs) return <div className="loading-block">Loading…</div>;
  return (
    <div className="history-panel">
      <p className="field-hint">
        {guest
          ? 'Analyses run from this browser. As a guest they expire after a few days and nobody else can see them; sign in to keep them and open them on other devices.'
          : 'Your analyses on this server. Results are kept for a while (see each one); the list itself stays.'}
      </p>
      {!jobs.length && <p className="empty-note">No analyses yet.</p>}
      <ul className="history-list">
        {jobs.map(j => {
          const d = detail[j.id]?.result;
          return (
            <li key={j.id} className={`history-item state-${j.state}${j.expired ? ' expired' : ''}`}>
              <button type="button" className="history-row" aria-expanded={open === j.id} onClick={() => expand(j)}>
                <span className="history-tool">{TOOL_NAME[j.tool] ?? j.tool}</span>
                <span className="history-name">{j.name || '—'}</span>
                <span className="history-when">{when(j.created)}</span>
                <span className="history-state">{j.expired ? 'expired' : j.state === 'done' ? `done${j.seconds != null ? `, ${j.seconds.toFixed(1)} s` : ''}` : j.state}</span>
              </button>
              {open === j.id && (
                <div className="history-detail">
                  {j.state === 'error' && <p className="notice notice-error">{j.message}</p>}
                  {j.expired && <p className="field-hint">The result files were removed when they expired; run the analysis again to see it.</p>}
                  {!j.expired && j.expires && <p className="field-hint">Kept until {when(j.expires)}.</p>}
                  {d?.downloads?.length ? (
                    <div className="button-row">
                      {d.downloads.map(x => (
                        <a key={x.url} className="btn btn-small" href={apiUrl(x.url)} download={x.filename}>
                          {x.label}
                        </a>
                      ))}
                    </div>
                  ) : null}
                  <div className="button-row">
                    {d?.markdown && (
                      <button type="button" className="btn btn-small" onClick={() => saveReport(`${TOOL_NAME[j.tool] ?? j.tool}: ${d.name ?? j.name}`, d.name ?? j.name, d.markdown!)}>
                        Save to Reports
                      </button>
                    )}
                    <button type="button" className="btn btn-small btn-danger" onClick={() => remove(j)}>
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
