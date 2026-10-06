// Shared Gemini call used by the server proxy (server/api.ts) and by the
// browser when a user supplies their own key. No DOM or Node-only APIs here.
import { GoogleGenAI } from '@google/genai';
import { DEFAULT_MODEL, type GenerateRequest, type GenerateResult, type Source } from './gemini-shared';

export * from './gemini-shared';

export async function generateWithGemini(apiKey: string, req: GenerateRequest): Promise<GenerateResult> {
  const model = req.model || DEFAULT_MODEL;
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model,
    contents: req.turns.map(t => ({ role: t.role, parts: [{ text: t.text }] })),
    config: {
      systemInstruction: req.systemInstruction,
      temperature: req.temperature ?? 0.4,
      tools: req.useSearch ? [{ googleSearch: {} }] : undefined,
    },
  });

  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const chunk of response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []) {
    const uri = chunk.web?.uri;
    if (uri && !seen.has(uri)) {
      seen.add(uri);
      sources.push({ uri, title: chunk.web?.title || new URL(uri).hostname });
    }
  }
  return { text: response.text ?? '', sources, model };
}
