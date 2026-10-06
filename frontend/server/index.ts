// Production server: serves the built app from dist/ and the /api routes.
// Usage: npm run build && npm start
import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiHandler } from './api';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const port = Number(process.env.PORT) || 3001;

const app = express();
app.disable('x-powered-by');
app.use('/api', createApiHandler());
app.use(express.static(dist, { index: 'index.html', maxAge: '1h' }));
app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')));

app.listen(port, '0.0.0.0', () => {
  const ai = process.env.GEMINI_API_KEY ? 'AI proxy enabled' : 'AI proxy disabled (no GEMINI_API_KEY)';
  console.log(`TerraX running on http://localhost:${port} — ${ai}`);
});
