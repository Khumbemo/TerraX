import type { JobState } from '../lib/useJob';

/** Progress of the current server job, with a cancel button. */
export default function JobStatus({ job, onCancel }: { job: JobState; onCancel?: () => void }) {
  if (!job.busy) return null;
  const p = job.progress;
  const pct = p ? Math.round(p.progress * 100) : 0;
  return (
    <div className="job-status" role="status" aria-live="polite">
      <div className="job-bar" aria-hidden="true">
        <span style={{ width: `${p?.state === 'queued' ? 4 : Math.max(4, pct)}%` }} />
      </div>
      <span className="job-text">{p ? (p.state === 'queued' ? 'Waiting for a worker…' : `${p.message} (${pct} %)`) : 'Sending to the server…'}</span>
      {onCancel && (
        <button type="button" className="link-btn" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}
