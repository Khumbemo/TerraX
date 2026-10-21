import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import { apiUrl, request } from '../lib/api';
import { useAccount, type AccountTab } from '../lib/account';
import type { Project } from '../lib/project';
import { useToast } from '../lib/toast';

const HistoryPanel = lazy(() => import('./account/HistoryPanel'));
const ProjectsPanel = lazy(() => import('./account/ProjectsPanel'));
const AdminPanel = lazy(() => import('./account/AdminPanel'));
const SecurityPanel = lazy(() => import('./account/SecurityPanel'));

interface Props {
  /** The current boundary, target, reports and preferences as a project document. */
  currentProject: () => Project;
  /** Opens a project document (as importing a .terrax.json file does). */
  applyProject: (p: Project, done: string) => void;
  /** Saves a finished job's report into the Reports view. */
  saveReport: (title: string, datasetName: string, markdown: string) => void;
  /** As a full page (the server needs a sign-in before anything else), without a close button. */
  page?: boolean;
}

const TAB_LABEL: Record<AccountTab, string> = {
  signin: 'Sign in',
  signup: 'Create account',
  forgot: 'Forgot password',
  reset: 'New password',
  history: 'History',
  projects: 'Projects',
  account: 'Account',
  admin: 'Admin',
};

export default function AccountDialog({ currentProject, applyProject, saveReport, page }: Props) {
  const acc = useAccount();
  const { me, user, dialog } = acc;
  const [tab, setTab] = useState<AccountTab>(dialog?.tab ?? 'signin');
  useEffect(() => {
    if (dialog?.tab) setTab(dialog.tab);
  }, [dialog?.tab]);
  const signedIn = Boolean(user);
  const tabs: AccountTab[] = signedIn
    ? ['history', 'projects', 'account', ...(user?.role === 'admin' ? (['admin'] as AccountTab[]) : [])]
    : [
        ...(me?.mode === 'required' ? [] : (['history'] as AccountTab[])),
        'signin',
        ...(me?.signup === 'open' ? (['signup'] as AccountTab[]) : []),
        ...(tab === 'forgot' || tab === 'reset' ? [tab] : []), // shown only while in use
      ];
  const active = tabs.includes(tab) ? tab : tabs[0];
  const close = () => acc.closeDialog(); // the full-page form has no close button, but signing in there clears any dialog asked for meanwhile

  const body = (
    <div className={page ? 'login-panel account-page' : 'modal account-modal'} role="dialog" aria-modal={!page} aria-labelledby="account-title">
      <div className="modal-head">
        <h2 id="account-title">{page ? 'TERRAX' : signedIn ? user!.email : 'Your TerraX account'}</h2>
        {!page && (
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            ×
          </button>
        )}
      </div>
      {page && <p className="field-hint">This TerraX server needs an account. Sign in{me?.signup === 'open' ? ' or create one' : ''} to continue.</p>}
      {dialog?.reason && (!signedIn || dialog.tab === 'account') && <p className="notice">{dialog.reason}</p>}
      {signedIn && me?.verifyEmail && !user!.emailVerified && <VerifyBanner />}
      <div className="view-toggles account-tabs" role="tablist">
        {tabs.map(t => (
          <button key={t} type="button" role="tab" id={`account-tab-${t}`} aria-selected={active === t} className={active === t ? 'active' : ''} onClick={() => setTab(t)}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      <div className="account-body">
        <Suspense fallback={<div className="loading-block">Loading…</div>}>
          {active === 'signin' && <SignInForm onDone={close} onForgot={() => setTab('forgot')} />}
          {active === 'forgot' && <ForgotForm onBack={() => setTab('signin')} />}
          {active === 'reset' && <ResetForm token={dialog?.token ?? ''} onDone={() => setTab('signin')} />}
          {active === 'signup' && <SignUpForm onDone={close} />}
          {active === 'history' && <HistoryPanel saveReport={saveReport} guest={!signedIn} />}
          {active === 'projects' && <ProjectsPanel currentProject={currentProject} applyProject={applyProject} />}
          {active === 'account' && <AccountPanel />}
          {active === 'admin' && <AdminPanel />}
        </Suspense>
      </div>
    </div>
  );
  if (page) return <div className="login-wrapper">{body}</div>;
  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && close()}>
      {body}
    </div>
  );
}

function SignInForm({ onDone, onForgot }: { onDone: () => void; onForgot: () => void }) {
  const { signIn, me } = useAccount();
  const notify = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState<string | null>(null); // null until the server asks for the second factor
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await signIn(email, password, code ?? undefined);
      if ('twoFactor' in r) {
        setCode('');
        return;
      }
      notify(`Signed in as ${r.user?.email}.${r.claimed ? ` Your ${r.claimed} upload${r.claimed === 1 ? '' : 's'} and analyses from this browser moved to your account.` : ''}`, 'success');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="account-form" onSubmit={submit}>
      <label className="input-group">
        <span>E-mail</span>
        <input id="signin-email" type="email" autoComplete="username" required readOnly={code !== null} value={email} onChange={e => setEmail(e.target.value)} />
      </label>
      <label className="input-group">
        <span>Password</span>
        <input id="signin-password" type="password" autoComplete="current-password" required readOnly={code !== null} value={password} onChange={e => setPassword(e.target.value)} />
      </label>
      {code !== null && (
        <label className="input-group">
          <span>Code from your authenticator app (or a recovery code)</span>
          <input id="signin-code" type="text" inputMode="numeric" autoComplete="one-time-code" required autoFocus maxLength={32} value={code} onChange={e => setCode(e.target.value)} />
        </label>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" id="signin-submit" className="btn btn-primary" disabled={busy}>
        {busy ? 'Signing in…' : code !== null ? 'Confirm code' : 'Sign in'}
      </button>
      {me?.sso && (
        <a id="signin-sso" className="btn" href={apiUrl('/api/auth/oidc/start')}>
          Sign in with {me.sso.name}
        </a>
      )}
      {me?.mail ? (
        <button type="button" id="signin-forgot" className="btn-link" onClick={onForgot}>
          Forgot your password?
        </button>
      ) : (
        <p className="field-hint">Forgot your password? An administrator of this server can set a new one.</p>
      )}
    </form>
  );
}

function ForgotForm({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await request('/api/auth/forgot', { method: 'POST', json: { email } });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The link could not be sent.');
    } finally {
      setBusy(false);
    }
  };
  if (sent)
    return (
      <div className="account-form" id="forgot-sent">
        <p>If {email} has an account here, a link to choose a new password is on its way. It works once, for one hour.</p>
        <button type="button" className="btn" onClick={onBack}>
          Back to sign-in
        </button>
      </div>
    );
  return (
    <form className="account-form" onSubmit={submit}>
      <p className="field-hint">Enter the address of your account and TerraX e-mails you a link to choose a new password.</p>
      <label className="input-group">
        <span>E-mail</span>
        <input id="forgot-email" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" id="forgot-submit" className="btn btn-primary" disabled={busy}>
        {busy ? 'Sending…' : 'Send the link'}
      </button>
      <button type="button" className="btn-link" onClick={onBack}>
        Back to sign-in
      </button>
    </form>
  );
}

function ResetForm({ token, onDone }: { token: string; onDone: () => void }) {
  const notify = useToast();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await request<{ email: string }>('/api/auth/reset', { method: 'POST', json: { token, password } });
      notify(`New password set for ${r.email}. Every device was signed out; sign in with the new password.`, 'success');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The password could not be set.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="account-form" onSubmit={submit}>
      <label className="input-group">
        <span>New password (at least 8 characters)</span>
        <input id="reset-password" type="password" autoComplete="new-password" required minLength={8} autoFocus value={password} onChange={e => setPassword(e.target.value)} />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" id="reset-submit" className="btn btn-primary" disabled={busy || !token}>
        {busy ? 'Saving…' : 'Set the new password'}
      </button>
    </form>
  );
}

function VerifyBanner() {
  const { user } = useAccount();
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const resend = async () => {
    setBusy(true);
    try {
      await request('/api/auth/verify/resend', { method: 'POST', json: {} });
      notify(`A new confirmation link was sent to ${user?.email}.`, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'The link could not be sent.', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <p className="notice" id="verify-banner">
      Confirm your address to start working: open the link sent to {user?.email}.{' '}
      <button type="button" className="btn-link" disabled={busy} onClick={resend}>
        Send a new link
      </button>
    </p>
  );
}

function SignUpForm({ onDone }: { onDone: () => void }) {
  const { signUp } = useAccount();
  const notify = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await signUp(email, password, name);
      notify(`Account created.${r.verificationSent ? ` A link to confirm ${email} is on its way.` : ''}${r.claimed ? ` Your ${r.claimed} upload${r.claimed === 1 ? '' : 's'} and analyses from this browser are now in it.` : ''}`, 'success');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The account could not be created.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="account-form" onSubmit={submit}>
      <label className="input-group">
        <span>Name (optional)</span>
        <input id="signup-name" type="text" autoComplete="name" maxLength={120} value={name} onChange={e => setName(e.target.value)} />
      </label>
      <label className="input-group">
        <span>E-mail</span>
        <input id="signup-email" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} />
      </label>
      <label className="input-group">
        <span>Password (at least 8 characters)</span>
        <input id="signup-password" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={e => setPassword(e.target.value)} />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" id="signup-submit" className="btn btn-primary" disabled={busy}>
        {busy ? 'Creating…' : 'Create account'}
      </button>
      <p className="field-hint">With an account your analyses, uploads and projects are kept on this server and open on any device; as a guest they stay with this browser and expire.</p>
    </form>
  );
}

function AccountPanel() {
  const { user, signOut, refresh } = useAccount();
  const notify = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [del, setDel] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      notify(done, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'That did not work.', 'error');
    } finally {
      setBusy(false);
    }
  };
  if (!user) return null;
  return (
    <div className="account-form">
      <p>
        Signed in as <strong>{user.email}</strong>
        {user.name ? ` (${user.name})` : ''}, {user.role === 'admin' ? 'administrator' : 'user'}. Account created {new Date(user.created * 1000).toLocaleDateString()}.
      </p>
      <button type="button" id="signout" className="btn" disabled={busy} onClick={() => run(signOut, 'Signed out.')}>
        Sign out
      </button>
      <SecurityPanel />
      <h3>Change password</h3>
      {!user.hasPassword && <p className="field-hint">You sign in with single sign-on. To add a password as well, use “Forgot your password?” on the sign-in form.</p>}
      <form
        hidden={!user.hasPassword}
        onSubmit={e => {
          e.preventDefault();
          run(async () => {
            await request('/api/auth/password', { method: 'POST', json: { current, new: next } });
            setCurrent('');
            setNext('');
            await refresh();
          }, 'Password changed. Other devices were signed out.');
        }}
      >
        <label className="input-group">
          <span>Current password</span>
          <input id="pw-current" type="password" autoComplete="current-password" required value={current} onChange={e => setCurrent(e.target.value)} />
        </label>
        <label className="input-group">
          <span>New password</span>
          <input id="pw-new" type="password" autoComplete="new-password" required minLength={8} value={next} onChange={e => setNext(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-small" disabled={busy}>
          Change password
        </button>
      </form>
      <h3>Delete account</h3>
      <p className="field-hint">Deletes your account with its uploads, results, history and projects from this server. Reports saved in this browser stay.</p>
      <form
        onSubmit={e => {
          e.preventDefault();
          if (!window.confirm('Delete your TerraX account and everything stored with it? This cannot be undone.')) return;
          run(async () => {
            await request('/api/auth/delete-account', { method: 'POST', json: { password: del } });
            await refresh();
          }, 'Your account was deleted.');
        }}
      >
        <label className="input-group">
          <span>{user.hasPassword ? 'Password' : 'Your e-mail address, to confirm'}</span>
          <input id="delete-password" type={user.hasPassword ? 'password' : 'email'} autoComplete={user.hasPassword ? 'current-password' : 'off'} required value={del} onChange={e => setDel(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-small btn-danger" disabled={busy}>
          Delete my account
        </button>
      </form>
    </div>
  );
}
