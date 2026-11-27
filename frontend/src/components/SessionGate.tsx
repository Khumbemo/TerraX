import { useState, type FormEvent } from 'react';
import { useAccount } from '../lib/account';
import { usePrefs } from '../lib/prefs';
import { LANGUAGES, type Lang } from '../lib/i18n';

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
  const { t, lang, setLang, dir } = usePrefs();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onStart(name.trim());
  };

  return (
    <div className="login-wrapper">
      <form className="login-panel" onSubmit={submit} dir={dir}>
        <div className="login-header">
          <img src="./logo.svg" alt="TerraX logo" className="gate-logo" width={112} height={112} />
          <div className="brand-title">
            TERRA<span className="brand-x">X</span>
          </div>
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
            <p className="login-note">{t('gate.signedIn', '', { email: account.user.email })}</p>
          ) : (
            <p className="login-note">
              <button type="button" id="gate-signin" className="link-btn" onClick={() => account.openDialog('signin')}>
                {t('gate.signin')}
              </button>{' '}
              {t('gate.signinRest')}
            </p>
          ))}
        <label className="lang-switch">
          <span aria-hidden="true">🌐</span>
          <select id="gate-lang" value={lang} aria-label={`${t('prefs.language')} / Language`} onChange={e => setLang(e.target.value as Lang)}>
            {LANGUAGES.map(([code, native, english]) => (
              <option key={code} value={code} lang={code}>
                {code === 'en' ? native : `${native} (${english})`}
              </option>
            ))}
          </select>
        </label>
      </form>
    </div>
  );
}
