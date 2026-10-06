// Chooses how to reach Gemini:
//  1. "own-key": the user saved their own API key in Settings (kept in this
//     browser only) — calls go straight from the browser to Google.
//  2. "server": the TerraX server has GEMINI_API_KEY set — calls go through
//     /api, and the key never reaches the browser.
//  3. "off": neither is available — the app uses computed statistics only.
import { DEFAULT_MODEL, describeGeminiError, type GenerateRequest, type GenerateResult } from './gemini-shared';
import { getItem, removeItem, setItem } from './storage';

export type AiMode = 'own-key' | 'server' | 'off';

export class AiUnavailableError extends Error {
  constructor() {
    super('AI is not set up. Add your Gemini API key in Settings, or set GEMINI_API_KEY on the TerraX server.');
  }
}

const apiUrl = (path: string) => new URL(`api/${path}`, document.baseURI).toString();

export function getOwnKey(): string {
  return getItem('api_key') ?? '';
}

export function setOwnKey(key: string): void {
  if (key.trim()) setItem('api_key', key.trim());
  else removeItem('api_key');
}

export function getModel(): string {
  return getItem('model') || DEFAULT_MODEL;
}

export function setModel(model: string): void {
  if (model.trim()) setItem('model', model.trim());
  else removeItem('model');
}

let serverStatus: Promise<boolean> | null = null;

async function serverConfigured(): Promise<boolean> {
  if (__TERRAX_PREVIEW__) return false;
  if (!serverStatus) {
    serverStatus = (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(apiUrl('ai/status'), { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) return false;
        const json = await res.json();
        return json?.configured === true;
      } catch {
        return false;
      }
    })();
  }
  return serverStatus;
}

export async function getAiMode(): Promise<AiMode> {
  if (getOwnKey()) return 'own-key';
  return (await serverConfigured()) ? 'server' : 'off';
}

/** Forget the cached server status (e.g. after the user changes settings). */
export function refreshAiStatus(): void {
  serverStatus = null;
}

export async function generate(req: Omit<GenerateRequest, 'model'>): Promise<GenerateResult> {
  const mode = await getAiMode();
  const request: GenerateRequest = { ...req, model: getModel() };
  if (mode === 'own-key') {
    const core = await import('./gemini-core');
    try {
      return await core.generateWithGemini(getOwnKey(), request);
    } catch (err) {
      throw new Error(describeGeminiError(err));
    }
  }
  if (mode === 'server') {
    let res: Response;
    try {
      res = await fetch(apiUrl('ai/generate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
    } catch {
      throw new Error('Could not reach the TerraX server. Check your connection and try again.');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || `The AI request failed (HTTP ${res.status}).`);
    return json as GenerateResult;
  }
  throw new AiUnavailableError();
}
