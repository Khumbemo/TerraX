import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { createApiHandler } from './server/api';

// Serves /api (the Gemini proxy) from the Vite dev and preview servers, so
// `npm run dev` works without a second process. The key stays server-side.
function terraxApi(): Plugin {
  const handler = createApiHandler();
  return {
    name: 'terrax-api',
    configureServer(server) {
      server.middlewares.use('/api', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api', handler);
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load .env / .env.local into the Node process only. Nothing here is
  // exposed to client code (no `define` of secrets).
  const env = loadEnv(mode, process.cwd(), '');
  if (env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = env.GEMINI_API_KEY;

  // `npm run build:preview` makes a single self-contained HTML file for
  // sandboxed previews (no server, no /api).
  const isPreviewBuild = mode === 'preview-artifact';

  return {
    base: './',
    plugins: [react(), terraxApi(), ...(isPreviewBuild ? [viteSingleFile()] : [])],
    define: {
      __TERRAX_PREVIEW__: JSON.stringify(isPreviewBuild),
    },
    server: {
      port: 3001,
      host: '0.0.0.0',
      // HMR can be disabled in hosted editors via DISABLE_HMR=true.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
    build: {
      outDir: isPreviewBuild ? 'dist-preview' : 'dist',
      chunkSizeWarningLimit: 1000,
      // Lists every built file so the service worker can precache the whole app.
      manifest: isPreviewBuild ? false : 'asset-manifest.json',
    },
  };
});
