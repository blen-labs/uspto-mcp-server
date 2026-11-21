import { defineConfig, devices } from '@playwright/test';

// Browser tests of the portal (web/). `pnpm test:web` builds it, serves dist/web with Vite's
// preview server (client-side routes fall back to index.html) and mocks the portal and auth
// APIs per test (web/e2e/fixtures.ts), so every page state can be checked without a server.
export default defineConfig({
  testDir: 'web/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm exec vite preview --config web/vite.config.ts --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});
