import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// The Python API (FastAPI) serves /api. In development Vite proxies it, so the
// browser talks to one origin; in production nginx does the same (see the
// frontend Dockerfile). TERRAX_API points the proxy at another API address.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const api = env.TERRAX_API || 'http://127.0.0.1:8000';
  const proxy = { '/api': { target: api, changeOrigin: false, ws: false } };
  return {
    base: './',
    plugins: [react()],
    server: { port: 5173, host: '0.0.0.0', proxy, hmr: process.env.DISABLE_HMR !== 'true' },
    preview: { port: 4173, host: '0.0.0.0', proxy },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1500,
      // Lists every built file so the service worker can precache the app shell.
      manifest: 'asset-manifest.json',
    },
  };
});
