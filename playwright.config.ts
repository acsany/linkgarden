import { defineConfig, devices } from '@playwright/test';
import { hashPassword } from './server/auth.js';
const hash = await hashPassword('test-only-password-123');
export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results/e2e',
  testIgnore: '**/pwa.spec.ts',
  workers: 1,
  timeout: 60000,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  projects: [
    {
      name: 'chromium',
      testMatch: ['**/app.spec.ts', '**/icons.spec.ts', '**/reorder.spec.ts'],
      use: { browserName: 'chromium' },
    },
    {
      name: 'mobile-chromium',
      testMatch: ['**/mobile.spec.ts', '**/icons.spec.ts', '**/reorder.spec.ts'],
      use: { ...devices['Pixel 5'], browserName: 'chromium' },
    },
    {
      name: 'mobile-webkit',
      testMatch: ['**/mobile.spec.ts', '**/icons.spec.ts', '**/reorder.spec.ts'],
      use: {
        ...devices['iPhone 13'],
        browserName: 'webkit',
      },
    },
  ],
  use: {
    baseURL: 'http://localhost:3100',
    headless: true,
    userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36',
    trace: 'off',
    screenshot: 'only-on-failure',
    // Once the PWA worker controls a page, WebKit sends its requests past page.route
    // mocks. The worker has its own suite (playwright.pwa.config.ts).
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3100/health',
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      NODE_ENV: 'development',
      PORT: '3100',
      APP_ORIGIN: 'http://localhost:3100',
      HOST: '127.0.0.1',
      DATA_DIR: `.test-data/e2e-${Date.now()}`,
      DATABASE_URL: '',
      ADMIN_EMAIL: 'browser@example.com',
      ADMIN_PASSWORD_HASH: hash,
    },
  },
});
