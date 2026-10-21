import { useCallback, useEffect, useState } from 'react';
import { request } from '../../lib/api';
import type { AccountUser } from '../../lib/account';
import { useToast } from '../../lib/toast';

type AdminUser = AccountUser & { usedBytes: number; jobs: number };

interface RecordedError {
  id: number;
  at: number;
  source: 'server' | 'worker' | 'client';
  kind: string;
  message: string;
  detail: string;
  path: string;
  requestId: string;
  owner: string;
}

interface Stats {
  users: number;
  activeSessions: number;
  storedBytes: number;
  files: number;
  projects: number;
  jobsLastDay: Record<string, number>;
  toolsLastDay: Record<string, number>;
  errorsLastDay: number;
}

interface AuditEntry {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string;
  detail: string;
  ip: string;
}

const mb = (b: number) => `${(b / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });

/** Usage, accounts and recorded errors, for administrators. */
export default function AdminPanel() {
  const notify = useToast();
  const [stats, setStats] = useState<Stats | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [errors, setErrors] = useState<RecordedError[] | null>(null);
  const [source, setSource] = useState('');
  const [openError, setOpenError] = useState<number | null>(null);
  const [newUser, setNewUser] = useState({ email: '', password: '', role: 'user' });
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [auditFilter, setAuditFilter] = useState({ action: '', q: '' });
  const fail = useCallback((err: unknown) => notify(err instanceof Error ? err.message : 'That did not work.', 'error'), [notify]);

  const load = useCallback(() => {
    request<Stats>('/api/admin/stats').then(setStats, fail);
    request<{ users: AdminUser[] }>('/api/admin/users').then(r => setUsers(r.users), fail);
  }, [fail]);
  const loadErrors = useCallback(() => {
    request<{ errors: RecordedError[] }>(`/api/admin/errors?limit=200${source ? `&source=${source}` : ''}`).then(r => setErrors(r.errors), fail);
  }, [source, fail]);
  const loadAudit = useCallback(() => {
    const q = new URLSearchParams({ limit: '200', ...(auditFilter.action ? { action: auditFilter.action } : {}), ...(auditFilter.q.trim() ? { q: auditFilter.q.trim() } : {}) });
    request<{ entries: AuditEntry[] }>(`/api/admin/audit?${q}`).then(r => setAudit(r.entries), fail);
  }, [auditFilter, fail]);
  useEffect(load, [load]);
  useEffect(loadErrors, [loadErrors]);
  useEffect(loadAudit, [loadAudit]);

  const patch = async (u: AdminUser, body: Record<string, unknown>) => {
    try {
      await request(`/api/admin/users/${u.id}`, { method: 'PATCH', json: body });
      load();
      loadAudit();
    } catch (err) {
      fail(err);
    }
  };
  const add = async () => {
    try {
      await request('/api/admin/users', { method: 'POST', json: newUser });
      setNewUser({ email: '', password: '', role: 'user' });
      notify('Account created.', 'success');
      load();
    } catch (err) {
      fail(err);
    }
  };
  const resetPassword = async (u: AdminUser) => {
    const pw = window.prompt(`New password for ${u.email} (at least 8 characters). It signs them out everywhere.`);
    if (pw) patch(u, { password: pw });
  };
  const remove = async (u: AdminUser) => {
    if (!window.confirm(`Delete ${u.email} with all their uploads, results, history and projects?`)) return;
    try {
      await request(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <div className="admin-panel">
      {stats && (
        <div className="stat-grid" id="admin-stats">
          <div className="stat"><div className="stat-label">Accounts</div><div className="stat-value">{stats.users}</div></div>
          <div className="stat"><div className="stat-label">Signed in now</div><div className="stat-value">{stats.activeSessions}</div></div>
          <div className="stat"><div className="stat-label">Stored</div><div className="stat-value">{mb(stats.storedBytes)} in {stats.files} files</div></div>
          <div className="stat"><div className="stat-label">Analyses, last 24 h</div><div className="stat-value">{Object.values(stats.jobsLastDay).reduce((a, b) => a + b, 0)} ({stats.jobsLastDay.error ?? 0} failed)</div></div>
          <div className="stat"><div className="stat-label">Errors, last 24 h</div><div className="stat-value">{stats.errorsLastDay}</div></div>
          <div className="stat"><div className="stat-label">Projects</div><div className="stat-value">{stats.projects}</div></div>
        </div>
      )}

      <h3>Accounts</h3>
      <div className="param-row">
        <label className="param grow">
          <span>E-mail</span>
          <input type="email" value={newUser.email} onChange={e => setNewUser({ ...newUser, email: e.target.value })} />
        </label>
        <label className="param">
          <span>Password</span>
          <input type="password" autoComplete="new-password" value={newUser.password} onChange={e => setNewUser({ ...newUser, password: e.target.value })} />
        </label>
        <label className="param">
          <span>Role</span>
          <select value={newUser.role} onChange={e => setNewUser({ ...newUser, role: e.target.value })}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <button type="button" className="btn btn-small" disabled={!newUser.email || newUser.password.length < 8} onClick={add}>
          Add account
        </button>
      </div>
      {users && (
        <div className="tabular-view">
          <table id="admin-users">
            <thead>
              <tr>
                <th>Account</th>
                <th>Role</th>
                <th>Last sign-in</th>
                <th className="num">Analyses</th>
                <th className="num">Stored</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className={u.disabled ? 'muted' : undefined}>
                  <td className="admin-user">
                    <div className="admin-email">
                      {u.email}
                      {u.disabled ? ' (disabled)' : ''}
                      {u.twoFactor ? ' · 2FA' : ''}
                      {u.singleSignOn ? ' · SSO' : ''}
                      {!u.emailVerified ? ' · unconfirmed' : ''}
                    </div>
                    <div className="admin-actions">
                      <button type="button" className="btn btn-small" onClick={() => patch(u, { disabled: !u.disabled })}>
                        {u.disabled ? 'Enable' : 'Disable'}
                      </button>
                      <button type="button" className="btn btn-small" onClick={() => resetPassword(u)}>
                        Password…
                      </button>
                      {u.twoFactor && (
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => window.confirm(`Turn off two-factor sign-in for ${u.email}? Do this only after checking it is really them (they lost their phone and recovery codes).`) && patch(u, { twoFactor: false })}
                        >
                          2FA off
                        </button>
                      )}
                      {!u.emailVerified && (
                        <button type="button" className="btn btn-small" onClick={() => patch(u, { emailVerified: true })}>
                          Confirm address
                        </button>
                      )}
                      <button type="button" className="btn btn-small btn-danger" onClick={() => remove(u)}>
                        Delete
                      </button>
                    </div>
                  </td>
                  <td>
                    <select value={u.role} aria-label={`Role of ${u.email}`} onChange={e => patch(u, { role: e.target.value })}>
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td>{u.lastLogin ? when(u.lastLogin) : 'never'}</td>
                  <td className="num">{u.jobs}</td>
                  <td className="num">{mb(u.usedBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Audit log</h3>
      <div className="param-row">
        <label className="param">
          <span>Events</span>
          <select id="admin-audit-action" value={auditFilter.action} onChange={e => setAuditFilter({ ...auditFilter, action: e.target.value })}>
            <option value="">all</option>
            <option value="auth.">sign-ins and account security</option>
            <option value="auth.login_failed">failed sign-ins</option>
            <option value="admin.">administrator actions</option>
          </select>
        </label>
        <label className="param grow">
          <span>E-mail contains</span>
          <input id="admin-audit-q" type="search" value={auditFilter.q} onChange={e => setAuditFilter({ ...auditFilter, q: e.target.value })} />
        </label>
        <button type="button" className="btn btn-small" onClick={loadAudit}>
          Refresh
        </button>
      </div>
      <p className="field-hint">Sign-ins (and failed ones), password, two-factor and session changes, and every administrator action, kept for 365 days (TERRAX_AUDIT_RETENTION_DAYS). Passwords and codes are never recorded.</p>
      {audit && !audit.length && <p className="empty-note">No matching entries.</p>}
      {audit && audit.length > 0 && (
        <div className="tabular-view">
          <table id="admin-audit">
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>By</th>
                <th>Account</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {audit.map(a => (
                <tr key={a.id} className={a.action.endsWith('_failed') ? 'muted' : undefined}>
                  <td>{when(a.at)}</td>
                  <td>{a.action}</td>
                  <td>
                    {a.actor || '—'}
                    {a.ip ? ` (${a.ip})` : ''}
                  </td>
                  <td>{a.target}</td>
                  <td className="audit-detail">{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Recorded errors</h3>
      <div className="param-row">
        <label className="param">
          <span>From</span>
          <select id="admin-error-source" value={source} onChange={e => setSource(e.target.value)}>
            <option value="">everywhere</option>
            <option value="server">the API</option>
            <option value="worker">analyses (workers)</option>
            <option value="client">browsers</option>
          </select>
        </label>
        <button type="button" className="btn btn-small" onClick={loadErrors}>
          Refresh
        </button>
        <button
          type="button"
          className="btn btn-small"
          onClick={async () => {
            if (!window.confirm('Clear every recorded error?')) return;
            await request('/api/admin/errors', { method: 'DELETE' }).catch(fail);
            loadErrors();
          }}
        >
          Clear
        </button>
      </div>
      <p className="field-hint">
        Unexpected errors in the API, in analyses and in browsers are kept here for 30 days (TERRAX_ERROR_RETENTION_DAYS) and sent to Sentry when the server has SENTRY_DSN. Prometheus
        metrics are at /api/metrics (for admins, or with TERRAX_METRICS_TOKEN).
      </p>
      {errors && !errors.length && <p className="empty-note">No errors recorded.</p>}
      <ul className="history-list" id="admin-errors">
        {errors?.map(e => (
          <li key={e.id} className="history-item state-error">
            <button type="button" className="history-row" aria-expanded={openError === e.id} onClick={() => setOpenError(openError === e.id ? null : e.id)}>
              <span className="history-tool">{e.source}</span>
              <span className="history-name">
                {e.kind}: {e.message}
              </span>
              <span className="history-when">{when(e.at)}</span>
            </button>
            {openError === e.id && (
              <div className="history-detail">
                <p className="field-hint">
                  {e.path}
                  {e.requestId ? ` · request ${e.requestId}` : ''}
                  {e.owner ? ` · ${e.owner}` : ''}
                </p>
                {e.detail && <pre className="error-detail">{e.detail}</pre>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
