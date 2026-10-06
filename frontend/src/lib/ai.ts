// AI through the TerraX server (Python agents, google-genai):
//  1. "own-key": the user saved their own Gemini key in Settings (kept in this
//     browser); it is sent with each AI request and the server passes it to
//     Google without storing it.
//  2. "server": the TerraX server has GEMINI_API_KEY set.
//  3. "off": neither; the built-in assistant (no AI model) answers.
import { request } from './api';
import { getItem, removeItem, setItem } from './storage';

export type AiMode = 'own-key' | 'server' | 'off';

export const DEFAULT_MODEL = 'gemini-2.5-flash';

export interface ChatTurn {
  role: 'user' | 'model';
  text: string;
}

export interface Source {
  title: string;
  uri: string;
}

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
  serverStatus ??= request<{ configured: boolean }>('/api/agents/status')
    .then(j => j.configured === true)
    .catch(() => false);
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

const keyHeader = (): Record<string, string> => (getOwnKey() ? { 'X-Gemini-Key': getOwnKey() } : {});

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
  engine: 'gemini' | 'built-in';
  model?: string;
}

/** One assistant turn: Gemini when available, otherwise (or when it fails) the built-in assistant. */
export function chat(req: ChatRequest): Promise<ChatResponse> {
  return request<ChatResponse>('/api/agents/chat', {
    method: 'POST',
    headers: keyHeader(),
    json: { ...req, history: req.history.slice(-8), tzOffsetMinutes: -new Date().getTimezoneOffset(), model: getModel() },
  });
}

/** A short AI interpretation of a report. */
export function interpret(toolName: string, markdown: string, extraContext?: string): Promise<{ text: string; model: string; sources: Source[] }> {
  return request('/api/agents/interpret', { method: 'POST', headers: keyHeader(), json: { toolName, markdown, extraContext, model: getModel() } });
}
