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
  const fail = useCallback((err: unknown) => notify(err instanceof Error ? err.message : 'That did not work.', 'error'), [notify]);

  const load = useCallback(() => {
    request<Stats>('/api/admin/stats').then(setStats, fail);
    request<{ users: AdminUser[] }>('/api/admin/users').then(r => setUsers(r.users), fail);
  }, [fail]);
  const loadErrors = useCallback(() => {
    request<{ errors: RecordedError[] }>(`/api/admin/errors?limit=200${source ? `&source=${source}` : ''}`).then(r => setErrors(r.errors), fail);
  }, [source, fail]);
  useEffect(load, [load]);
  useEffect(loadErrors, [loadErrors]);

  const patch = async (u: AdminUser, body: Record<string, unknown>) => {
    try {
      await request(`/api/admin/users/${u.id}`, { method: 'PATCH', json: body });
      load();
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
                <th>E-mail</th>
                <th>Role</th>
                <th>Last sign-in</th>
                <th className="num">Analyses</th>
                <th className="num">Stored</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className={u.disabled ? 'muted' : undefined}>
                  <td>{u.email}{u.disabled ? ' (disabled)' : ''}</td>
                  <td>
                    <select value={u.role} aria-label={`Role of ${u.email}`} onChange={e => patch(u, { role: e.target.value })}>
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td>{u.lastLogin ? when(u.lastLogin) : 'never'}</td>
                  <td className="num">{u.jobs}</td>
                  <td className="num">{mb(u.usedBytes)}</td>
                  <td className="button-row">
                    <button type="button" className="btn btn-small" onClick={() => patch(u, { disabled: !u.disabled })}>
                      {u.disabled ? 'Enable' : 'Disable'}
                    </button>
                    <button type="button" className="btn btn-small" onClick={() => resetPassword(u)}>
                      Password…
                    </button>
                    <button type="button" className="btn btn-small btn-danger" onClick={() => remove(u)}>
                      Delete
                    </button>
                  </td>
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
