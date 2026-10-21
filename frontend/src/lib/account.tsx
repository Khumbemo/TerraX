// Accounts on the TerraX server: who is signed in, how the server handles accounts (TERRAX_AUTH), and the
// sign-in dialog, opened from the header or whenever the server answers 401.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { SIGNIN_NEEDED, request } from './api';

export interface AccountUser {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  created: number;
  lastLogin: number | null;
  disabled: boolean;
  emailVerified: boolean;
  twoFactor: boolean;
  singleSignOn: boolean;
  /** False for an account made by single sign-on that never set a password. */
  hasPassword: boolean;
}

/** off: no accounts; optional: guests or accounts; required: sign in for everything. */
export type AuthMode = 'off' | 'optional' | 'required';

interface Me {
  mode: AuthMode;
  signup: 'open' | 'closed';
  user: AccountUser | null;
  claimed?: number;
  /** The server can send e-mail (password-reset links, address confirmation). */
  mail: boolean;
  /** Work needs a confirmed address (TERRAX_VERIFY_EMAIL with mail set up). */
  verifyEmail: boolean;
  /** Single sign-on through an OpenID Connect provider, when set up. */
  sso: { name: string } | null;
  verificationSent?: boolean;
}

/** The password was right and the account has two-factor sign-in: send it again with the code. */
export interface CodeNeeded {
  twoFactor: true;
}

export type AccountTab = 'signin' | 'signup' | 'forgot' | 'reset' | 'history' | 'projects' | 'account' | 'admin';

interface AccountContext {
  /** null until the server answered (or when it cannot be reached). */
  me: Me | null;
  user: AccountUser | null;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string, code?: string) => Promise<Me | CodeNeeded>;
  signUp: (email: string, password: string, name: string) => Promise<Me>;
  signOut: () => Promise<void>;
  dialog: { tab: AccountTab; reason?: string; token?: string } | null;
  openDialog: (tab: AccountTab, reason?: string, token?: string) => void;
  closeDialog: () => void;
}

const Ctx = createContext<AccountContext | null>(null);

export function AccountProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [dialog, setDialog] = useState<AccountContext['dialog']>(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await request<Me>('/api/auth/me'));
    } catch {
      setMe(null); // server unreachable: the app works as before, without account features
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Links that bring the browser back here: a password reset, an address confirmation, the end of a single sign-on.
  useEffect(() => {
    const url = new URL(window.location.href);
    const q = url.searchParams;
    const reset = q.get('reset');
    const verify = q.get('verify');
    const ssoError = q.get('signin_error');
    if (!reset && !verify && !ssoError && !q.has('signin')) return;
    for (const k of ['reset', 'verify', 'signin', 'signin_error']) q.delete(k);
    window.history.replaceState(null, '', url.pathname + (q.toString() ? `?${q}` : '') + url.hash); // the token must not stay in the address bar or history
    if (reset) setDialog({ tab: 'reset', token: reset });
    else if (ssoError) setDialog({ tab: 'signin', reason: ssoError });
    else if (verify)
      request<{ email: string }>('/api/auth/verify', { method: 'POST', json: { token: verify } }).then(
        r => {
          setDialog({ tab: 'account', reason: `The address ${r.email} is confirmed.` });
          refresh();
        },
        (err: Error) => setDialog({ tab: 'account', reason: err.message }),
      );
  }, [refresh]);

  useEffect(() => {
    const onNeeded = (e: Event) => setDialog({ tab: 'signin', reason: (e as CustomEvent<string>).detail });
    window.addEventListener(SIGNIN_NEEDED, onNeeded);
    return () => window.removeEventListener(SIGNIN_NEEDED, onNeeded);
  }, []);

  const signIn = useCallback(async (email: string, password: string, code?: string) => {
    const r = await request<Me | CodeNeeded>('/api/auth/login', { method: 'POST', json: { email, password, ...(code ? { code } : {}) } });
    if (!('twoFactor' in r)) setMe(r);
    return r;
  }, []);
  const signUp = useCallback(async (email: string, password: string, name: string) => {
    const r = await request<Me>('/api/auth/signup', { method: 'POST', json: { email, password, name } });
    setMe(r);
    return r;
  }, []);
  const signOut = useCallback(async () => {
    await request('/api/auth/logout', { method: 'POST', json: {} });
    await refresh();
  }, [refresh]);

  const value = useMemo<AccountContext>(
    () => ({ me, user: me?.user ?? null, refresh, signIn, signUp, signOut, dialog, openDialog: (tab, reason, token) => setDialog({ tab, reason, token }), closeDialog: () => setDialog(null) }),
    [me, refresh, signIn, signUp, signOut, dialog],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAccount(): AccountContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAccount needs an AccountProvider');
  return c;
}
