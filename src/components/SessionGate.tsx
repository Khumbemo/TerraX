import { useState, type FormEvent } from 'react';
import { usePrefs } from '../lib/prefs';

interface Props {
  onStart: (operator: string) => void;
}

/**
 * Local session screen. TerraX has no account server, so this only records
 * an optional operator name for reports; it is not authentication.
 */
export default function SessionGate({ onStart }: Props) {
  const [name, setName] = useState('');
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
