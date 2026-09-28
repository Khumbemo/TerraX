// Gemini request types, validation and error text. Imports no SDK, so the
// browser can use it without loading @google/genai.

export const DEFAULT_MODEL = 'gemini-2.5-flash';

export interface ChatTurn {
  role: 'user' | 'model';
  text: string;
}

export interface GenerateRequest {
  turns: ChatTurn[];
  systemInstruction?: string;
  useSearch?: boolean;
  model?: string;
  temperature?: number;
}

export interface Source {
  title: string;
  uri: string;
}

export interface GenerateResult {
  text: string;
  sources: Source[];
  model: string;
}

const MAX_TURNS = 30;
const MAX_CHARS = 150_000;
const MODEL_PATTERN = /^gemini-[a-z0-9.\-]+$/i;



export class RequestValidationError extends Error {}

/** Validates and normalises an untrusted request body. Throws RequestValidationError. */
export function sanitizeRequest(input: unknown): GenerateRequest {
  if (!input || typeof input !== 'object') throw new RequestValidationError('Request body must be a JSON object.');
  const body = input as Record<string, unknown>;
  if (!Array.isArray(body.turns) || body.turns.length === 0) {
    throw new RequestValidationError('"turns" must be a non-empty array.');
  }
  const turns = body.turns.slice(-MAX_TURNS).map((t, i) => {
    const turn = t as Record<string, unknown>;
    if ((turn.role !== 'user' && turn.role !== 'model') || typeof turn.text !== 'string') {
      throw new RequestValidationError(`Turn ${i} must have role "user" or "model" and a text string.`);
    }
    return { role: turn.role, text: turn.text } as ChatTurn;
  });
  if (turns[turns.length - 1].role !== 'user') throw new RequestValidationError('The last turn must come from the user.');

  const systemInstruction = typeof body.systemInstruction === 'string' ? body.systemInstruction : undefined;
  const totalChars = turns.reduce((n, t) => n + t.text.length, 0) + (systemInstruction?.length ?? 0);
  if (totalChars > MAX_CHARS) throw new RequestValidationError(`Request is too large (${totalChars} characters, limit ${MAX_CHARS}).`);

  const model = typeof body.model === 'string' && MODEL_PATTERN.test(body.model) ? body.model : DEFAULT_MODEL;
  const temperature = typeof body.temperature === 'number' && body.temperature >= 0 && body.temperature <= 2 ? body.temperature : 0.4;

  return { turns, systemInstruction, useSearch: body.useSearch === true, model, temperature };
}

/** Turns an SDK/API error into a message a user can act on. */
export function describeGeminiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  let message = raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.error?.message) message = parsed.error.message;
  } catch {
    /* not JSON */
  }
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(raw)) return 'The Gemini API rate limit or quota was reached. Wait a minute, or check the quota for your API key.';
  if (/API key not valid|API_KEY_INVALID|401|403|PERMISSION_DENIED/i.test(raw)) return 'The Gemini API rejected the API key. Check that the key is correct and has the Generative Language API enabled.';
  if (/404|NOT_FOUND|is not found/i.test(raw)) return 'The selected Gemini model is not available for this key. Choose another model in Settings.';
  return `Gemini request failed: ${message}`;
}
