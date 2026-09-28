import { useState, type FormEvent } from 'react';

interface Props {
  onStart: (operator: string) => void;
}

/**
 * Local session screen. TerraX has no account server, so this only records
 * an optional operator name for reports; it is not authentication.
 */
export default function SessionGate({ onStart }: Props) {
  const [name, setName] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onStart(name.trim());
  };

  return (
    <div className="login-wrapper">
      <form className="login-panel" onSubmit={submit}>
        <div className="login-header">
          <div className="brand-title">TERRAX</div>
          <div className="brand-subtitle">Earth observation workbench</div>
        </div>

        <div className="input-group">
          <label htmlFor="operator-name">Your name (optional)</label>
          <input
            id="operator-name"
            type="text"
            autoComplete="name"
            maxLength={80}
            placeholder="e.g. A. Researcher"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <p className="field-hint">Shown on the reports you create.</p>
        </div>

        <button type="submit" className="uplink-btn">
          Start session
        </button>

        <p className="login-note">
          TerraX runs in your browser and has no user accounts. Your files are read on this device. If you set up AI, a summary of the loaded dataset is sent to
          Google's Gemini API when you ask for an interpretation.
        </p>
      </form>
    </div>
  );
}
