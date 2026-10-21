import { useState, type FormEvent } from 'react';
import { useAccount } from '../lib/account';
import { usePrefs } from '../lib/prefs';

interface Props {
  onStart: (operator: string) => void;
  /** The server's accounts, when it has them (TERRAX_AUTH optional): offers signing in as well as starting as a guest. */
  account?: ReturnType<typeof useAccount> | null;
}

/**
 * Start screen: an optional operator name for reports. Signing in (when the server has accounts) is separate, from
 * this screen or the header; a guest's work stays with this browser.
 */
export default function SessionGate({ onStart, account }: Props) {
  const [name, setName] = useState(() => account?.user?.name ?? '');
  const { t, lang, setLang } = usePrefs();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onStart(name.trim());
  };

  return (
    <div className="login-wrapper">
      <form className="login-panel" onSubmit={submit}>
        <div className="login-header">
          <div className="brand-title">TERRAX</div>
          <div className="brand-subtitle">{t('session.subtitle')}</div>
        </div>

        <div className="input-group">
          <label htmlFor="operator-name">{t('session.name')}</label>
          <input
            id="operator-name"
            type="text"
            autoComplete="name"
            maxLength={80}
            placeholder="e.g. A. Researcher"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <p className="field-hint">{t('session.hint')}</p>
        </div>

        <button type="submit" className="uplink-btn">
          {t('session.start')}
        </button>

        <p className="login-note">{t('session.note')}</p>
        {account &&
          (account.user ? (
            <p className="login-note">Signed in as {account.user.email}.</p>
          ) : (
            <p className="login-note">
              <button type="button" id="gate-signin" className="link-btn" onClick={() => account.openDialog('signin')}>
                Sign in
              </button>{' '}
              to keep your analyses and projects on the server, or start as a guest.
            </p>
          ))}
        <div className="lang-switch" role="group" aria-label="Language / भाषा">
          <button type="button" aria-pressed={lang === 'en'} className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>
            English
          </button>
          <button type="button" aria-pressed={lang === 'hi'} className={lang === 'hi' ? 'active' : ''} onClick={() => setLang('hi')}>
            हिन्दी
          </button>
        </div>
      </form>
    </div>
  );
}
