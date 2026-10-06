// React state for one tool's server work: uploads and jobs, with progress,
// cancellation on unmount and readable errors.
import { useCallback, useEffect, useRef, useState } from 'react';
import { type JobProgress } from './api';

export interface JobState {
  /** What is running ('a', 'run', 'sample' …), or null when idle. */
  busy: string | null;
  progress: JobProgress | null;
}

export function useJob() {
  const [state, setState] = useState<JobState>({ busy: null, progress: null });
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => () => ctrl.current?.abort(), []);

  /**
   * Runs `work` under a label. Resolves with its value, or with null when it
   * failed (onError gets the message) or was replaced by newer work.
   */
  const run = useCallback(async <T,>(label: string, work: (signal: AbortSignal, onProgress: (p: JobProgress) => void) => Promise<T>, onError?: (message: string) => void): Promise<T | null> => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setState({ busy: label, progress: null });
    try {
      const out = await work(c.signal, p => !c.signal.aborted && setState({ busy: label, progress: p }));
      return c.signal.aborted ? null : out;
    } catch (err) {
      if (!c.signal.aborted && (err as Error)?.name !== 'AbortError') onError?.(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      if (ctrl.current === c) {
        ctrl.current = null;
        setState({ busy: null, progress: null });
      }
    }
  }, []);

  const cancel = useCallback(() => {
    ctrl.current?.abort();
    ctrl.current = null;
    setState({ busy: null, progress: null });
  }, []);

  return { ...state, run, cancel };
}
