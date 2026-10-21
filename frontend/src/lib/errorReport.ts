// Sends errors the browser catches (uncaught exceptions, rejected promises, crashed views) to the TerraX server,
// which keeps them for the admin panel and forwards them to Sentry when the server has SENTRY_DSN. Only the error,
// its stack and the page path are sent; no file contents or form values.
import { apiUrl } from './api';

const seen = new Set<string>();
let sent = 0;
const MAX_PER_PAGE = 20;

export function reportError(error: unknown, kind?: string): void {
  if (typeof window === 'undefined' || sent >= MAX_PER_PAGE) return;
  const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error ?? 'Unknown error'));
  if (e.name === 'AbortError') return; // a cancelled request is not a fault
  const key = `${e.name}:${e.message}`;
  if (seen.has(key)) return; // once per page per distinct error
  seen.add(key);
  sent++;
  const body = JSON.stringify({ kind: (kind ?? e.name).slice(0, 120), message: e.message.slice(0, 4000) || e.name, stack: (e.stack ?? '').slice(0, 8000), page: location.origin + location.pathname });
  fetch(apiUrl('/api/client-errors'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, credentials: 'include', keepalive: true }).catch(() => undefined);
}

/** Reports uncaught errors and unhandled promise rejections from now on (once per page). */
export function installErrorReporting(): void {
  if (typeof window === 'undefined' || (window as { __terraxErrors?: boolean }).__terraxErrors) return;
  (window as { __terraxErrors?: boolean }).__terraxErrors = true;
  window.addEventListener('error', e => {
    if (e.error || e.message) reportError(e.error ?? e.message);
  });
  window.addEventListener('unhandledrejection', e => reportError(e.reason, 'UnhandledRejection'));
}
