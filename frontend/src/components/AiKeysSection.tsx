// AI keys from any provider (lib/ai.ts, backend agents/llm.py): add a key and the server recognises its provider and
// lists its models; up to three keys, tried in order, then the server's key, then the built-in assistant.
import { useEffect, useState, type FormEvent } from 'react';
import { detectKey, getAiMode, getAiStatus, getKeys, maskKey, MAX_KEYS, saveKeys, type AiKey, type AiMode, type AiStatus } from '../lib/ai';
import { useToast } from '../lib/toast';

const MODE_TEXT: Record<AiMode, string> = {
  'own-key': 'On — using your key(s) from this browser',
  server: 'On — using the TerraX server’s key',
  off: 'Off — statistics and the built-in assistant only',
};

export default function AiKeysSection({ onAiChange }: { onAiChange: () => void }) {
  const notify = useToast();
  const [keys, setKeys] = useState<AiKey[]>(getKeys());
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [mode, setMode] = useState<AiMode | null>(null);
  const [provider, setProvider] = useState('auto');
  const [keyInput, setKeyInput] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getAiStatus().then(setStatus);
  }, []);
  useEffect(() => {
    getAiMode().then(setMode);
  }, [keys]);

  const spec = status?.providers.find(p => p.id === provider);
  const userUrl = Boolean(spec?.userUrl);
  const needsKey = provider === 'auto' || (spec?.needsKey ?? true);

  const update = (next: AiKey[], message?: string) => {
    saveKeys(next);
    setKeys(next);
    onAiChange();
    if (message) notify(message, 'success');
  };

  const chooseProvider = (id: string) => {
    setProvider(id);
    setBaseUrl(status?.providers.find(p => p.id === id)?.baseUrl ?? '');
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (needsKey && !keyInput.trim()) return notify('Paste an API key first.', 'error');
    if (userUrl && !baseUrl.trim()) return notify('Give the server’s base URL, for example https://example.com/v1.', 'error');
    if (keys.length >= MAX_KEYS) return notify(`At most ${MAX_KEYS} keys: remove one first.`, 'error');
    setBusy(true);
    try {
      const d = await detectKey(keyInput, provider, userUrl ? baseUrl : '');
      const entry: AiKey = { key: keyInput.trim(), provider: d.provider, providerName: d.name, model: d.model, models: d.models, ...(d.baseUrl ? { baseUrl: d.baseUrl } : {}) };
      const same = (k: AiKey) => k.provider === entry.provider && k.key === entry.key && (k.baseUrl ?? '') === (entry.baseUrl ?? '');
      const next = keys.some(same) ? keys.map(k => (same(k) ? entry : k)) : [...keys, entry];
      update(next, d.model ? `${d.name} key added · model ${d.model}.` : `${d.name} added: type the model name to use.`);
      setKeyInput('');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'The key could not be checked.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const setModelAt = (i: number, model: string) => update(keys.map((k, j) => (j === i ? { ...k, model: model.trim() } : k)));
  const remove = (i: number) => update(keys.filter((_, j) => j !== i), 'Key removed from this browser.');
  const raise = (i: number) => update(keys.map((k, j) => (j === i - 1 ? keys[i] : j === i ? keys[i - 1] : k)));

  return (
    <section aria-label="AI">
      <h3>AI (any provider)</h3>
      <p className="status-line">
        Status: <strong>{mode ? MODE_TEXT[mode] : 'Checking…'}</strong>
        {status?.configured && status.providerName ? ` · server key: ${status.providerName}` : ''}
      </p>

      {keys.length > 0 && (
        <ol id="ai-keys" className="ai-keys">
          {keys.map((k, i) => (
            <li key={`${k.provider}-${i}`} className="ai-key-row">
              <span className="ai-key-name">
                <strong>{k.providerName}</strong> <code>{maskKey(k.key)}</code>
                {k.baseUrl ? <span className="field-hint"> · {k.baseUrl}</span> : null}
              </span>
              <label className="inline-select">
                <span>Model</span>
                {k.models.length > 0 ? (
                  <select id={`ai-model-${i}`} value={k.model} onChange={e => setModelAt(i, e.target.value)}>
                    {!k.models.includes(k.model) && <option value={k.model}>{k.model || 'choose…'}</option>}
                    {k.models.map(m => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input id={`ai-model-${i}`} defaultValue={k.model} placeholder="model name" onBlur={e => setModelAt(i, e.target.value)} />
                )}
              </label>
              {i > 0 && (
                <button type="button" className="btn btn-small" aria-label={`Use ${k.providerName} first`} onClick={() => raise(i)}>
                  ↑
                </button>
              )}
              <button type="button" className="btn btn-small" onClick={() => remove(i)}>
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}

      <form onSubmit={add} className="field-row ai-add">
        <label className="inline-select">
          <span>Provider</span>
          <select id="ai-provider" value={provider} onChange={e => chooseProvider(e.target.value)}>
            <option value="auto">Recognise from the key</option>
            {(status?.providers ?? []).map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="api-key" className="visually-hidden">
          API key
        </label>
        <input
          id="api-key"
          type="password"
          autoComplete="off"
          value={keyInput}
          onChange={e => setKeyInput(e.target.value)}
          placeholder={needsKey ? 'Paste an API key from any AI provider' : 'API key (optional)'}
        />
        {userUrl && (
          <input id="ai-base-url" type="url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://example.com/v1" aria-label="Base URL" />
        )}
        <button id="ai-add" type="submit" className="btn btn-primary" disabled={busy || keys.length >= MAX_KEYS}>
          {busy ? 'Checking…' : 'Add key'}
        </button>
      </form>
      <p className="field-hint">
        Gemini, Claude, OpenAI, DeepSeek, Groq, OpenRouter, xAI, Mistral and Together keys are recognised automatically; other services work as a custom
        OpenAI-compatible server{status?.allowPrivate ? ', and a local Ollama' : ''}. Up to {MAX_KEYS} keys are tried in order, each within its own limit, then
        the server’s key, then the built-in assistant.
      </p>
      <p className="field-hint">
        Keys are stored in this browser’s local storage and sent with each AI request to the TerraX server, which passes them to the provider and does not
        store them. Anyone with access to this browser profile can read them. To keep keys off user devices, set <code>TERRAX_AI_KEY</code> on the server
        instead.
      </p>
    </section>
  );
}
