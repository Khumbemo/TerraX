import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import qrcode from 'qrcode-generator';
import { request } from '../../lib/api';
import { useAccount } from '../../lib/account';
import { useToast } from '../../lib/toast';

interface Session {
  id: string;
  created: number;
  lastSeen: number;
  expires: number;
  ip: string;
  userAgent: string;
  current: boolean;
}

const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A rough device label from the browser's user-agent string (shown next to the full string). */
function device(ua: string): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** The otpauth:// link as a QR code (drawn as SVG squares, so it stays sharp and needs no image request). */
function QrCode({ text }: { text: string }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { n: n + 8, d }; // a four-module quiet zone, as the standard asks
  }, [text]);
  return (
    <svg className="qr-code" viewBox={`0 0 ${cells.n} ${cells.n}`} width={200} height={200} role="img" aria-label="QR code for your authenticator app" shapeRendering="crispEdges">
      <rect width={cells.n} height={cells.n} fill="#fff" />
      <path d={cells.d} fill="#000" />
    </svg>
  );
}

/** Two-factor sign-in and the devices signed in to the account. */
export default function SecurityPanel() {
  const { user, refresh } = useAccount();
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [off, setOff] = useState({ password: '', code: '' });
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const fail = useCallback((err: unknown) => notify(err instanceof Error ? err.message : 'That did not work.', 'error'), [notify]);
  const loadSessions = useCallback(() => {
    request<{ sessions: Session[] }>('/api/auth/sessions').then(r => setSessions(r.sessions), fail);
  }, [fail]);
  useEffect(loadSessions, [loadSessions]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const enable = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await request<{ recoveryCodes: string[] }>('/api/auth/2fa/enable', { method: 'POST', json: { code } });
      setCodes(r.recoveryCodes);
      setSetup(null);
      setCode('');
      await refresh();
      notify('Two-factor sign-in is on.', 'success');
    });
  };
  const disable = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await request('/api/auth/2fa/disable', { method: 'POST', json: off });
      setOff({ password: '', code: '' });
      setCodes(null);
      await refresh();
      notify('Two-factor sign-in is off.', 'success');
    });
  };
  if (!user) return null;

  return (
    <>
      <h3>Two-factor sign-in</h3>
      {codes && (
        <div className="notice" id="recovery-codes">
          <p>
            <strong>Recovery codes.</strong> Each one signs you in once if you lose your phone. Keep them somewhere safe; they are not shown again.
          </p>
          <pre className="recovery-codes">{codes.join('\n')}</pre>
          <button type="button" className="btn btn-small" onClick={() => navigator.clipboard?.writeText(codes.join('\n')).then(() => notify('Copied.', 'success'), fail)}>
            Copy
          </button>
        </div>
      )}
      {user.twoFactor ? (
        <>
          <p className="field-hint">On: signing in asks for a code from your authenticator app after the password.</p>
          <form onSubmit={disable}>
            <div className="param-row">
              <label className="param grow">
                <span>{user.hasPassword ? 'Password' : 'Your e-mail address'}</span>
                <input id="totp-off-password" type={user.hasPassword ? 'password' : 'email'} autoComplete={user.hasPassword ? 'current-password' : 'off'} required value={off.password} onChange={e => setOff({ ...off, password: e.target.value })} />
              </label>
              <label className="param">
                <span>Code</span>
                <input id="totp-off-code" type="text" inputMode="numeric" autoComplete="one-time-code" required maxLength={32} value={off.code} onChange={e => setOff({ ...off, code: e.target.value })} />
              </label>
            </div>
            <div className="param-row">
              <button type="submit" className="btn btn-small" disabled={busy}>
                Turn off
              </button>
              <button
                type="button"
                className="btn btn-small"
                disabled={busy || !off.code}
                title="Uses the code in the box above"
                onClick={() =>
                  run(async () => {
                    const r = await request<{ recoveryCodes: string[] }>('/api/auth/2fa/recovery-codes', { method: 'POST', json: { code: off.code } });
                    setCodes(r.recoveryCodes);
                    setOff({ ...off, code: '' });
                  })
                }
              >
                New recovery codes
              </button>
            </div>
          </form>
        </>
      ) : setup ? (
        <form onSubmit={enable} id="totp-setup">
          <p className="field-hint">Scan the code with an authenticator app (Google or Microsoft Authenticator, Aegis, 1Password, …), or type the key in, then enter the 6-digit code it shows.</p>
          <QrCode text={setup.uri} />
          <p className="field-hint">
            Key: <code id="totp-secret">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
          </p>
          <label className="input-group">
            <span>Code from the app</span>
            <input id="totp-code" type="text" inputMode="numeric" autoComplete="one-time-code" required maxLength={8} value={code} onChange={e => setCode(e.target.value)} />
          </label>
          <div className="param-row">
            <button type="submit" id="totp-enable" className="btn btn-small btn-primary" disabled={busy}>
              Turn on
            </button>
            <button type="button" className="btn btn-small" onClick={() => setSetup(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="field-hint">Off. With it on, a stolen password alone is not enough to sign in.</p>
          <button type="button" id="totp-start" className="btn btn-small" disabled={busy} onClick={() => run(async () => setSetup(await request('/api/auth/2fa/setup', { method: 'POST', json: {} })))}>
            Set up…
          </button>
        </>
      )}

      <h3>Signed-in devices</h3>
      {sessions && (
        <ul className="history-list" id="sessions">
          {sessions.map(s => (
            <li key={s.id} className="history-item">
              <div className="history-row session-row">
                <span className="history-name" title={s.userAgent}>
                  {device(s.userAgent)}
                  {s.current ? ' (this device)' : ''}
                </span>
                <span className="history-when">
                  {s.ip || 'unknown address'} · last used {when(s.lastSeen)}
                </span>
                {!s.current && (
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await request(`/api/auth/sessions/${s.id}`, { method: 'DELETE' });
                        loadSessions();
                      })
                    }
                  >
                    Sign out
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {sessions && sessions.length > 1 && (
        <button
          type="button"
          id="sessions-end-others"
          className="btn btn-small"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const r = await request<{ ended: number }>('/api/auth/sessions/end-others', { method: 'POST', json: {} });
              notify(`Signed out ${r.ended} other device${r.ended === 1 ? '' : 's'}.`, 'success');
              loadSessions();
            })
          }
        >
          Sign out everywhere else
        </button>
      )}
    </>
  );
}
