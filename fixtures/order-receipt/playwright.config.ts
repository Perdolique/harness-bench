import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  expect: { timeout: 2_000 },
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: 'line',
  timeout: 10_000,

  use: {
    actionTimeout: 2_000,
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure'
  },

  projects: [
    {
      name: 'chromium',
      use: devices['Desktop Chrome']
    },
    {
      name: 'webkit',
      use: devices['Desktop Safari']
    }
  ],

  webServer: {
    command: 'node node_modules/vite/bin/vite.js preview --host 0.0.0.0 --port 4173',
    port: 4173,
    reuseExistingServer: false
  }
})
