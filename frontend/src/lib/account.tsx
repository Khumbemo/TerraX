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
}

/** off: no accounts; optional: guests or accounts; required: sign in for everything. */
export type AuthMode = 'off' | 'optional' | 'required';

interface Me {
  mode: AuthMode;
  signup: 'open' | 'closed';
  user: AccountUser | null;
  claimed?: number;
}

export type AccountTab = 'signin' | 'signup' | 'history' | 'projects' | 'account' | 'admin';

interface AccountContext {
  /** null until the server answered (or when it cannot be reached). */
  me: Me | null;
  user: AccountUser | null;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<Me>;
  signUp: (email: string, password: string, name: string) => Promise<Me>;
  signOut: () => Promise<void>;
  dialog: { tab: AccountTab; reason?: string } | null;
  openDialog: (tab: AccountTab, reason?: string) => void;
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

  useEffect(() => {
    const onNeeded = (e: Event) => setDialog({ tab: 'signin', reason: (e as CustomEvent<string>).detail });
    window.addEventListener(SIGNIN_NEEDED, onNeeded);
    return () => window.removeEventListener(SIGNIN_NEEDED, onNeeded);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const r = await request<Me>('/api/auth/login', { method: 'POST', json: { email, password } });
    setMe(r);
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
    () => ({ me, user: me?.user ?? null, refresh, signIn, signUp, signOut, dialog, openDialog: (tab, reason) => setDialog({ tab, reason }), closeDialog: () => setDialog(null) }),
    [me, refresh, signIn, signUp, signOut, dialog],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAccount(): AccountContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAccount needs an AccountProvider');
  return c;
}
