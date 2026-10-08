import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results/pwa',
  testMatch: '**/pwa.spec.ts',
  workers: 1,
  timeout: 60000,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3200',
    headless: true,
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx tsx tests/serve-built.ts',
    url: 'http://localhost:3200/health',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
