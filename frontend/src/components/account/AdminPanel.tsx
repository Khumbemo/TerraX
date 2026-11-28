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

interface SiteSettings {
  signup?: 'open' | 'closed';
  announcement?: string;
  maintenance?: boolean;
  maintenanceMessage?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  supportEmail?: string;
  supportUrl?: string;
  /** Never the key itself: the server sends whether one is saved and its last four characters. */
  firmsMapKey?: { set: boolean; last4: string };
}

interface SystemInfo {
  version: string;
  python: string;
  uptimeSeconds: number;
  ok: boolean;
  checks: Record<string, boolean>;
  config: { name: string; value: string; env: string }[];
}

interface JobRow {
  id: string;
  tool: string;
  state: string;
  name: string;
  created: number;
  seconds: number | null;
  message: string;
  who: string;
}

interface Backup {
  name: string;
  created: number;
  size: number | null;
}

type Section = 'overview' | 'accounts' | 'jobs' | 'site' | 'system' | 'audit' | 'errors';
const SECTIONS: [Section, string][] = [
  ['overview', 'Overview'],
  ['accounts', 'Accounts'],
  ['jobs', 'Analyses'],
  ['site', 'Site settings'],
  ['system', 'System & backups'],
  ['audit', 'Audit log'],
  ['errors', 'Errors'],
];
const CHECK_NAMES: Record<string, string> = { database: 'Database', storage: 'Storage folder', objectStore: 'Bucket', redis: 'Redis (job queue)' };

function uptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
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
  const [section, setSection] = useState<Section>('overview');
  const [userQuery, setUserQuery] = useState('');
  const [site, setSite] = useState<SiteSettings | null>(null);
  const [siteDraft, setSiteDraft] = useState<SiteSettings>({});
  const [signupDefault, setSignupDefault] = useState('open');
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [jobFilter, setJobFilter] = useState({ state: '', tool: '' });
  const [backups, setBackups] = useState<{ backups: Backup[]; everyHours: number; keep: number } | null>(null);
  const [working, setWorking] = useState('');
  const [firmsKey, setFirmsKey] = useState('');
  const [firmsEnvKey, setFirmsEnvKey] = useState(false);
  const [firmsCheck, setFirmsCheck] = useState<string | null>(null);
  const fail = useCallback((err: unknown) => notify(err instanceof Error ? err.message : 'That did not work.', 'error'), [notify]);

  const load = useCallback(() => {
    request<Stats>('/api/admin/stats').then(setStats, fail);
    request<{ users: AdminUser[] }>(`/api/admin/users${userQuery.trim() ? `?q=${encodeURIComponent(userQuery.trim())}` : ''}`).then(r => setUsers(r.users), fail);
  }, [fail, userQuery]);
  const loadSite = useCallback(() => {
    request<{ settings: SiteSettings; defaults: { signup: string; firmsMapKey?: boolean } }>('/api/admin/settings').then(r => {
      setSite(r.settings);
      setSiteDraft(r.settings);
      setSignupDefault(r.defaults.signup);
      setFirmsEnvKey(Boolean(r.defaults.firmsMapKey));
    }, fail);
  }, [fail]);
  const loadSystem = useCallback(() => {
    request<SystemInfo>('/api/admin/system').then(setSystem, fail);
    request<{ backups: Backup[]; everyHours: number; keep: number }>('/api/admin/backups').then(setBackups, fail);
  }, [fail]);
  const loadJobs = useCallback(() => {
    const q = new URLSearchParams({ limit: '200', ...(jobFilter.state ? { state: jobFilter.state } : {}), ...(jobFilter.tool ? { tool: jobFilter.tool } : {}) });
    request<{ jobs: JobRow[] }>(`/api/admin/jobs?${q}`).then(r => setJobs(r.jobs), fail);
  }, [jobFilter, fail]);
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
  useEffect(loadSite, [loadSite]);
  useEffect(loadSystem, [loadSystem]);
  useEffect(loadJobs, [loadJobs]);

  const saveSite = async () => {
    const keys: (keyof SiteSettings)[] = ['signup', 'announcement', 'maintenance', 'maintenanceMessage', 'contactName', 'contactEmail', 'contactPhone', 'supportEmail', 'supportUrl'];
    const changes = Object.fromEntries(keys.filter(k => (siteDraft[k] ?? null) !== (site?.[k] ?? null)).map(k => [k, siteDraft[k] ?? null]));
    if (!Object.keys(changes).length) return notify('Nothing changed.');
    try {
      const r = await request<{ settings: SiteSettings }>('/api/admin/settings', { method: 'PUT', json: changes });
      setSite(r.settings);
      setSiteDraft(r.settings);
      notify('Site settings saved. Everyone sees them within a few seconds.', 'success');
      loadAudit();
    } catch (err) {
      fail(err);
    }
  };
  const saveFirmsKey = async (value: string | null) => {
    try {
      const r = await request<{ settings: SiteSettings }>('/api/admin/settings', { method: 'PUT', json: { firmsMapKey: value } });
      setSite(r.settings);
      setSiteDraft(d => ({ ...d, firmsMapKey: r.settings.firmsMapKey }));
      setFirmsKey('');
      setFirmsCheck(null);
      notify(value ? 'MAP_KEY saved: the map’s fire layer can be turned on.' : 'MAP_KEY removed.', 'success');
      loadAudit();
    } catch (err) {
      fail(err);
    }
  };
  const checkFirmsKey = async () => {
    setFirmsCheck('Asking FIRMS…');
    try {
      const r = await request<{ ok: boolean; limit?: number; used?: number; interval?: string; message?: string }>('/api/admin/settings/firms-check', {
        method: 'POST',
        json: { key: firmsKey.trim() || null },
      });
      setFirmsCheck(r.ok ? `FIRMS accepts the key: ${r.used ?? '?'} of ${r.limit ?? '?'} transactions used in the current ${r.interval ?? 'interval'}.` : `FIRMS says: ${r.message}`);
    } catch (err) {
      setFirmsCheck(err instanceof Error ? err.message : 'The check did not work.');
    }
  };
  const action = async (name: string, path: string, done: (r: Record<string, number | string>) => string) => {
    setWorking(name);
    try {
      const r = await request<Record<string, number | string>>(path, { method: 'POST' });
      notify(done(r), 'success');
      loadSystem();
      load();
      loadAudit();
    } catch (err) {
      fail(err);
    } finally {
      setWorking('');
    }
  };
  const backupNow = () => action('backup', '/api/admin/backups', r => `Backed up ${Number(r.rows).toLocaleString()} rows to ${r.name}.`);
  const cleanupNow = () =>
    action('cleanup', '/api/admin/cleanup', r => `Clean-up done: ${r.files} expired folder(s), ${r.errors} old error(s), ${r.audit} old audit entr${r.audit === 1 ? 'y' : 'ies'} removed.`);
  const setDraft = (patchDraft: Partial<SiteSettings>) => setSiteDraft(d => ({ ...d, ...patchDraft }));
  const show = (id: Section) => section === id;

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
      <div className="mode-switch admin-sections" role="tablist" aria-label="Administration">
        {SECTIONS.map(([id, label]) => (
          <button key={id} type="button" role="tab" id={`admin-section-${id}`} aria-selected={section === id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}>
            {label}
            {id === 'errors' && stats?.errorsLastDay ? ` (${stats.errorsLastDay})` : ''}
          </button>
        ))}
      </div>
      {show('overview') && (
        <section aria-label="Overview">
          {stats && (
            <div className="stat-grid" id="admin-stats">
              <div className="stat"><div className="stat-label">Accounts</div><div className="stat-value">{stats.users}</div></div>
              <div className="stat" title="Browsers and devices signed in whose session has not expired or been signed out; not the people online right now"><div className="stat-label">Active sign-ins</div><div className="stat-value">{stats.activeSessions}</div></div>
              <div className="stat"><div className="stat-label">Stored</div><div className="stat-value">{mb(stats.storedBytes)} in {stats.files} files</div></div>
              <div className="stat"><div className="stat-label">Analyses, last 24 h</div><div className="stat-value">{Object.values(stats.jobsLastDay).reduce((a, b) => a + b, 0)} ({stats.jobsLastDay.error ?? 0} failed)</div></div>
              <div className="stat"><div className="stat-label">Errors, last 24 h</div><div className="stat-value">{stats.errorsLastDay}</div></div>
              <div className="stat"><div className="stat-label">Projects</div><div className="stat-value">{stats.projects}</div></div>
            </div>
          )}

          {system && (
            <div className={`admin-health ${system.ok ? 'ok' : 'bad'}`} id="admin-health" role="status">
              <strong>{system.ok ? 'Everything is working' : 'Something needs attention'}</strong>
              {Object.entries(system.checks).map(([k, v]) => (
                <span key={k} className={v ? 'check-ok' : 'check-bad'}>
                  {v ? '✓' : '✗'} {CHECK_NAMES[k] ?? k}
                </span>
              ))}
              <span className="field-hint">
                TerraX {system.version} · up {uptime(system.uptimeSeconds)}
              </span>
            </div>
          )}
          {site?.maintenance && <p className="notice">Maintenance is on: new analyses are paused for everyone but administrators (Site settings).</p>}
          <div className="button-row">
            <button type="button" className="btn btn-small" disabled={Boolean(working)} onClick={backupNow}>
              {working === 'backup' ? 'Backing up…' : 'Back up the database now'}
            </button>
            <button type="button" className="btn btn-small" disabled={Boolean(working)} onClick={cleanupNow}>
              {working === 'cleanup' ? 'Cleaning up…' : 'Run the clean-up now'}
            </button>
          </div>
          {stats && Object.keys(stats.toolsLastDay).length > 0 && (
            <p className="field-hint">
              Analyses in the last 24 hours by tool:{' '}
              {Object.entries(stats.toolsLastDay)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => `${k} ${v}`)
                .join(' · ')}
            </p>
          )}
        </section>
      )}
      {show('accounts') && (
        <section aria-label="Accounts">
          <h3>Accounts</h3>
          <div className="param-row">
            <label className="param grow">
              <span>Find</span>
              <input id="admin-user-q" type="search" placeholder="e-mail contains…" value={userQuery} onChange={e => setUserQuery(e.target.value)} />
            </label>
          </div>
          <h4>Add an account</h4>
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
                        <div className="admin-email" title={u.email}>
                          {u.email}
                        </div>
                        {(u.disabled || u.twoFactor || u.singleSignOn || !u.emailVerified) && (
                          <div className="admin-tags">
                            {[u.disabled && 'disabled', u.twoFactor && '2FA', u.singleSignOn && 'SSO', !u.emailVerified && 'unconfirmed'].filter(Boolean).join(' · ')}
                          </div>
                        )}
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

        </section>
      )}
      {show('jobs') && (
        <section aria-label="Analyses">
          <h3>Analyses by everyone</h3>
          <div className="param-row">
            <label className="param">
              <span>State</span>
              <select id="admin-job-state" value={jobFilter.state} onChange={e => setJobFilter({ ...jobFilter, state: e.target.value })}>
                <option value="">all</option>
                <option value="queued">queued</option>
                <option value="running">running</option>
                <option value="done">done</option>
                <option value="error">failed</option>
              </select>
            </label>
            <label className="param">
              <span>Tool</span>
              <select id="admin-job-tool" value={jobFilter.tool} onChange={e => setJobFilter({ ...jobFilter, tool: e.target.value })}>
                <option value="">all</option>
                {['forest', 'carbon', 'survey', 'residential', 'table', 'raster', 'stack', 'landcover', 'radar', 'water', 'canopy', 'terrain', 'hydrology', 'contours', 'photo'].map(t => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn btn-small" onClick={loadJobs}>
              Refresh
            </button>
          </div>
          <p className="field-hint">The newest 200. Who ran them: the account's e-mail, or “guest”. A failed analysis shows its error; the Errors section has the details.</p>
          {jobs && !jobs.length && <p className="empty-note">No analyses match.</p>}
          {jobs && jobs.length > 0 && (
            <div className="tabular-view">
              <table id="admin-jobs">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Tool</th>
                    <th>State</th>
                    <th>Who</th>
                    <th className="num">Took</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map(j => (
                    <tr key={j.id} className={j.state === 'error' ? 'row-bad' : undefined}>
                      <td>{when(j.created)}</td>
                      <td>{j.tool}</td>
                      <td>{j.state === 'error' ? 'failed' : j.state}</td>
                      <td className="admin-email" title={j.who}>
                        {j.who}
                      </td>
                      <td className="num">{j.seconds == null ? '—' : `${j.seconds < 10 ? j.seconds.toFixed(1) : Math.round(j.seconds)} s`}</td>
                      <td className="audit-detail">{j.state === 'error' ? j.message : j.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {show('site') && site && (
        <section aria-label="Site settings" className="account-form admin-site">
          <h3>Who can join</h3>
          <label className="param">
            <span>Sign-up</span>
            <select id="admin-site-signup" value={siteDraft.signup ?? ''} onChange={e => setDraft({ signup: (e.target.value || undefined) as SiteSettings['signup'] })}>
              <option value="">server default ({signupDefault})</option>
              <option value="open">open: anyone can create an account</option>
              <option value="closed">closed: only administrators add accounts</option>
            </select>
          </label>
          <h3>Announcement</h3>
          <label className="input-group">
            <span>Shown to everyone at the top of the app (empty: none)</span>
            <textarea id="admin-site-announcement" rows={2} maxLength={500} value={siteDraft.announcement ?? ''} onChange={e => setDraft({ announcement: e.target.value })} />
          </label>
          <h3>Maintenance</h3>
          <label className="inline-check">
            <input id="admin-site-maintenance" type="checkbox" checked={Boolean(siteDraft.maintenance)} onChange={e => setDraft({ maintenance: e.target.checked })} /> Pause new analyses for
            everyone but administrators
          </label>
          <label className="input-group">
            <span>Message shown while paused (empty: a standard message)</span>
            <input id="admin-site-maintenance-message" maxLength={300} value={siteDraft.maintenanceMessage ?? ''} onChange={e => setDraft({ maintenanceMessage: e.target.value })} />
          </label>
          <h3>Contact and support</h3>
          <p className="field-hint">Shown to everyone in Settings → About. Leave a field empty to hide it.</p>
          <label className="input-group">
            <span>Owner or organisation</span>
            <input id="admin-site-contact-name" maxLength={120} value={siteDraft.contactName ?? ''} onChange={e => setDraft({ contactName: e.target.value })} />
          </label>
          <label className="input-group">
            <span>E-mail for enquiries</span>
            <input id="admin-site-contact-email" type="email" maxLength={254} value={siteDraft.contactEmail ?? ''} onChange={e => setDraft({ contactEmail: e.target.value })} />
          </label>
          <label className="input-group">
            <span>Phone numbers (separate several with commas)</span>
            <input
              id="admin-site-contact-phone"
              type="tel"
              maxLength={80}
              placeholder="+91 …, +91 …"
              value={siteDraft.contactPhone ?? ''}
              onChange={e => setDraft({ contactPhone: e.target.value })}
            />
          </label>
          <label className="input-group">
            <span>E-mail for technical support</span>
            <input id="admin-site-support-email" type="email" maxLength={254} value={siteDraft.supportEmail ?? ''} onChange={e => setDraft({ supportEmail: e.target.value })} />
          </label>
          <label className="input-group">
            <span>Support or help page (https://…)</span>
            <input id="admin-site-support-url" type="url" maxLength={300} value={siteDraft.supportUrl ?? ''} onChange={e => setDraft({ supportUrl: e.target.value })} />
          </label>
          <h3>Live map data</h3>
          <p className="field-hint">
            Earthquakes (USGS), today’s weather and elevation (Open-Meteo) need no key. Active fires come from NASA FIRMS, which needs a free MAP_KEY:{' '}
            <a href="https://firms.modaps.eosdis.nasa.gov/api/map_key/" target="_blank" rel="noopener noreferrer">
              request one
            </a>{' '}
            and it is sent by e-mail. FIRMS allows 5000 transactions per 10 minutes per key; each TerraX server process asks at most once per satellite and period every 10 minutes
            and shares the answer with every viewer.
          </p>
          <p id="admin-firms-state" className="muted">
            {site.firmsMapKey?.set
              ? `A MAP_KEY is saved (ending in ${site.firmsMapKey.last4}).`
              : firmsEnvKey
                ? 'The server’s TERRAX_FIRMS_MAP_KEY is used (none saved here).'
                : 'No MAP_KEY yet: the fire layer is off for everyone.'}
          </p>
          <label className="input-group">
            <span>{site.firmsMapKey?.set ? 'Replace the MAP_KEY' : 'NASA FIRMS MAP_KEY'}</span>
            <input id="admin-firms-key" type="password" autoComplete="off" spellCheck={false} maxLength={64} value={firmsKey} onChange={e => setFirmsKey(e.target.value)} />
          </label>
          <div className="button-row">
            <button type="button" id="admin-firms-save" className="btn" disabled={!firmsKey.trim()} onClick={() => saveFirmsKey(firmsKey.trim())}>
              Save MAP_KEY
            </button>
            <button type="button" id="admin-firms-check" className="btn" disabled={!firmsKey.trim() && !site.firmsMapKey?.set && !firmsEnvKey} onClick={checkFirmsKey}>
              Check with FIRMS
            </button>
            {site.firmsMapKey?.set && (
              <button type="button" id="admin-firms-remove" className="btn" onClick={() => saveFirmsKey(null)}>
                Remove
              </button>
            )}
          </div>
          {firmsCheck && (
            <p id="admin-firms-check-result" className="field-hint" role="status">
              {firmsCheck}
            </p>
          )}
          <div className="button-row">
            <button type="button" id="admin-site-save" className="btn btn-primary" onClick={saveSite}>
              Save site settings
            </button>
            <button type="button" className="btn" onClick={() => setSiteDraft(site)}>
              Undo changes
            </button>
          </div>
        </section>
      )}
      {show('system') && (
        <section aria-label="System and backups">
          {system && (
            <>
              <h3>System</h3>
              <p className="field-hint">
                TerraX {system.version} on Python {system.python}, running for {uptime(system.uptimeSeconds)}. Settings come from the server's environment variables (shown on the right);
                change them where the server is set up (.env for Docker) and restart it.
              </p>
              <div className="tabular-view">
                <table id="admin-config">
                  <tbody>
                    {Object.entries(system.checks).map(([k, v]) => (
                      <tr key={k}>
                        <th>{CHECK_NAMES[k] ?? k}</th>
                        <td className={v ? 'check-ok' : 'check-bad'}>{v ? '✓ working' : '✗ not answering'}</td>
                        <td className="field-hint">health check</td>
                      </tr>
                    ))}
                    {system.config.map(c => (
                      <tr key={c.name}>
                        <th>{c.name}</th>
                        <td>{c.value}</td>
                        <td className="field-hint">{c.env}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <h3>Backups</h3>
          <p className="field-hint">
            A backup holds accounts, history, projects and these settings (not the uploaded files).{' '}
            {backups && backups.everyHours > 0 ? `Made every ${backups.everyHours} hours; the newest ${backups.keep} are kept.` : 'Automatic backups are off (TERRAX_BACKUP_HOURS).'} Restoring is
            done from the server's command line: python -m terrax.manage restore NAME --yes.
          </p>
          <div className="button-row">
            <button type="button" id="admin-backup-now" className="btn btn-small" disabled={Boolean(working)} onClick={backupNow}>
              {working === 'backup' ? 'Backing up…' : 'Back up now'}
            </button>
            <button type="button" id="admin-cleanup-now" className="btn btn-small" disabled={Boolean(working)} onClick={cleanupNow}>
              {working === 'cleanup' ? 'Cleaning up…' : 'Run the clean-up now'}
            </button>
          </div>
          {backups && !backups.backups.length && <p className="empty-note">No backups yet.</p>}
          {backups && backups.backups.length > 0 && (
            <div className="tabular-view">
              <table id="admin-backups">
                <thead>
                  <tr>
                    <th>Backup</th>
                    <th>Made</th>
                    <th className="num">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {backups.backups.map(b => (
                    <tr key={b.name}>
                      <td>{b.name}</td>
                      <td>{when(b.created)}</td>
                      <td className="num">{b.size == null ? '—' : `${(b.size / 1024).toLocaleString(undefined, { maximumFractionDigits: 0 })} KB`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {show('audit') && (
        <section aria-label="Audit log">
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

        </section>
      )}
      {show('errors') && (
        <section aria-label="Errors">
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
        </section>
      )}
    </div>
  );
}
