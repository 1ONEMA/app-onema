import { defineConfig, devices } from '@playwright/test';

/** E2E contra o servidor local (API + PWA compilado) com banco de demonstração isolado. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8799',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    launchOptions: { executablePath: process.env.PW_CHROMIUM ?? undefined },
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
    { name: 'desktop', use: { viewport: { width: 1366, height: 900 } } },
  ],
  webServer: {
    command: 'rm -rf data/e2e && SEED_DEMO=true DATABASE_PATH=data/e2e/pglite MEDIA_DIR=data/e2e/media PORT=8799 PUBLIC_ORIGIN=http://127.0.0.1:8799 NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx server/src/index.ts',
    url: 'http://127.0.0.1:8799/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
