// /api routes, shared by the Vite dev server (vite.config.ts) and the
// production Express server (server/index.ts). The Gemini key lives only in
// the server's environment and is never sent to the browser.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  RequestValidationError,
  describeGeminiError,
  generateWithGemini,
  sanitizeRequest,
  DEFAULT_MODEL,
} from '../src/lib/gemini-core';

type Next = (err?: unknown) => void;

const MAX_BODY_BYTES = 1_000_000;
const RATE_LIMIT = 20; // requests per window per client
const RATE_WINDOW_MS = 60_000;

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RequestValidationError('Request body is larger than 1 MB.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new RequestValidationError('Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

export function createApiHandler() {
  const hits = new Map<string, number[]>();

  function rateLimited(client: string): boolean {
    const now = Date.now();
    const recent = (hits.get(client) ?? []).filter(t => now - t < RATE_WINDOW_MS);
    recent.push(now);
    hits.set(client, recent);
    return recent.length > RATE_LIMIT;
  }

  return async function apiHandler(req: IncomingMessage, res: ServerResponse, next?: Next) {
    const url = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && url === '/ai/status') {
      sendJson(res, 200, { configured: Boolean(process.env.GEMINI_API_KEY), defaultModel: DEFAULT_MODEL });
      return;
    }

    if (req.method === 'POST' && url === '/ai/generate') {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        sendJson(res, 503, { error: 'The server has no GEMINI_API_KEY configured. Add it to .env.local and restart, or enter your own key in Settings.' });
        return;
      }
      if (rateLimited(req.socket.remoteAddress || 'unknown')) {
        sendJson(res, 429, { error: 'Too many AI requests. Wait a minute and try again.' });
        return;
      }
      try {
        const request = sanitizeRequest(await readJsonBody(req));
        sendJson(res, 200, await generateWithGemini(apiKey, request));
      } catch (err) {
        if (err instanceof RequestValidationError) sendJson(res, 400, { error: err.message });
        else sendJson(res, 502, { error: describeGeminiError(err) });
      }
      return;
    }

    if (next) next();
    else sendJson(res, 404, { error: 'Not found' });
  };
}
