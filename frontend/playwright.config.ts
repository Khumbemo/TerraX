import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run the production build against the real Python API.
// By default Playwright starts both: the API with jobs in-process
// (TERRAX_EAGER=true, no Redis needed) and `vite preview`, which proxies
// /api to it. Set TERRAX_URL to test a running deployment instead, for
// example the docker compose stack: TERRAX_URL=http://localhost:8080.
const external = process.env.TERRAX_URL;
const python = process.env.PYTHON ?? 'python3';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: external ?? 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: external
    ? undefined
    : [
        {
          command: `${python} -m uvicorn terrax.api.main:app --host 127.0.0.1 --port 8000`,
          cwd: '../backend',
          url: 'http://127.0.0.1:8000/api/health',
          env: { TERRAX_EAGER: 'true', TERRAX_STORAGE: process.env.TERRAX_STORAGE ?? '/tmp/terrax-e2e-storage', TERRAX_RETENTION_HOURS: '0' },
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        {
          command: 'npm run build && npx vite preview --port 4173 --strictPort --host 127.0.0.1',
          url: 'http://127.0.0.1:4173',
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
        },
      ],
});
