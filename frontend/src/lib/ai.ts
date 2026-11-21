// AI through the TerraX server (backend: terrax/agents/llm.py), with a key from any provider:
//  1. "own-key": the user added up to three keys in Settings (kept in this browser). The server recognises each key's
//     provider (Gemini, Claude, OpenAI, Groq, …, a local Ollama or any OpenAI-compatible server) and lists its models.
//     The keys go with each AI request, in order, and the server passes them on without storing them.
//  2. "server": the TerraX server has its own key (TERRAX_AI_KEY or GEMINI_API_KEY).
//  3. "off": neither; the built-in assistant (no AI model) answers.
// A request tries the user's keys in order, then the server's, then the built-in assistant; each key has its own limit.
import { request } from './api';
import { getItem, removeItem, setItem } from './storage';

export type AiMode = 'own-key' | 'server' | 'off';

export const MAX_KEYS = 3;

export interface ChatTurn {
  role: 'user' | 'model';
  text: string;
}

export interface Source {
  title: string;
  uri: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  needsKey: boolean;
  userUrl: boolean;
  search: boolean;
  baseUrl: string;
}

export interface AiStatus {
  configured: boolean;
  provider: string | null;
  providerName: string | null;
  defaultModel: string;
  allowPrivate: boolean;
  providers: ProviderInfo[];
}

/** A key saved in this browser, with what the server found out about it. */
export interface AiKey {
  key: string;
  provider: string;
  providerName: string;
  model: string;
  models: string[];
  baseUrl?: string;
}

const STORE = 'ai_keys';

function readKeys(): AiKey[] {
  try {
    const raw = getItem(STORE);
    if (raw) {
      const list = JSON.parse(raw) as AiKey[];
      if (Array.isArray(list)) return list.filter(k => k && typeof k.provider === 'string').slice(0, MAX_KEYS);
    }
  } catch {
    // unreadable: start again below
  }
  // A Gemini key saved by an earlier version of TerraX.
  const legacy = getItem('api_key');
  if (legacy) {
    const migrated: AiKey[] = [{ key: legacy, provider: 'gemini', providerName: 'Google Gemini', model: getItem('model') || 'gemini-2.5-flash', models: [] }];
    writeKeys(migrated);
    removeItem('api_key');
    removeItem('model');
    return migrated;
  }
  return [];
}

function writeKeys(keys: AiKey[]): void {
  if (keys.length) setItem(STORE, JSON.stringify(keys.slice(0, MAX_KEYS)));
  else removeItem(STORE);
}

export function getKeys(): AiKey[] {
  return readKeys();
}

export function saveKeys(keys: AiKey[]): void {
  writeKeys(keys);
  refreshAiStatus();
}

/** Masks a key for display: its first six characters (the provider prefix) and last four, if it is long enough
 *  that this shows well under half of it; real keys are 30 or more characters. */
export function maskKey(key: string): string {
  if (!key) return 'no key';
  return key.length < 24 ? `••••${key.slice(-2)}` : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

let statusPromise: Promise<AiStatus | null> | null = null;

export function getAiStatus(): Promise<AiStatus | null> {
  statusPromise ??= request<AiStatus>('/api/agents/status').catch(() => null);
  return statusPromise;
}

export async function getAiMode(): Promise<AiMode> {
  if (readKeys().length) return 'own-key';
  return (await getAiStatus())?.configured ? 'server' : 'off';
}

/** Forget the cached server status (e.g. after the user changes settings). */
export function refreshAiStatus(): void {
  statusPromise = null;
}

export interface Detected {
  provider: string;
  name: string;
  kind: string;
  search: boolean;
  models: string[];
  model: string;
  baseUrl: string;
}

/** Asks the server which provider a key belongs to (or checks the chosen one) and which models it can use. */
export function detectKey(key: string, provider = 'auto', baseUrl = '', model = ''): Promise<Detected> {
  return request<Detected>('/api/agents/detect', {
    method: 'POST',
    headers: key.trim() ? { 'X-AI-Key': key.trim() } : {},
    json: { provider, baseUrl: baseUrl.trim() || null, model: model.trim() || null },
  });
}

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  bytes.forEach(b => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function keyHeaders(): Record<string, string> {
  const keys = readKeys();
  if (!keys.length) return {};
  const list = keys.map(k => ({ key: k.key, provider: k.provider, model: k.model, ...(k.baseUrl ? { baseUrl: k.baseUrl } : {}) }));
  return { 'X-AI-Credentials': base64url(JSON.stringify(list)) };
}

export interface ChatRequest {
  agent: 'guide' | 'results';
  question: string;
  history: ChatTurn[];
  target: { lat: number; lon: number; name: string };
  operator?: string;
  results?: { toolName: string; name: string; markdown: string; extraContext?: string; fileId?: string; focus?: string | null };
  /** The built-in assistant's memory from its previous reply. */
  state: Record<string, unknown>;
}

export interface ChatResponse {
  text: string;
  sources: Source[];
  suggestions: string[];
  state: Record<string, unknown>;
  /** The provider that answered (gemini, anthropic, groq, …) or built-in. */
  engine: string;
  providerName?: string;
  model?: string;
}

/** One assistant turn: the first key that answers, otherwise the built-in assistant. */
export function chat(req: ChatRequest): Promise<ChatResponse> {
  return request<ChatResponse>('/api/agents/chat', {
    method: 'POST',
    headers: keyHeaders(),
    json: { ...req, history: req.history.slice(-8), tzOffsetMinutes: -new Date().getTimezoneOffset() },
  });
}

/** A short AI interpretation of a report. */
export function interpret(toolName: string, markdown: string, extraContext?: string): Promise<{ text: string; model: string; providerName?: string; sources: Source[] }> {
  return request('/api/agents/interpret', { method: 'POST', headers: keyHeaders(), json: { toolName, markdown, extraContext } });
}
