import { defineConfig } from '@playwright/test'
import { iphone18ProSafari } from './e2e/device'

const PORT = 4173

export default defineConfig({
  testDir: 'e2e',
  // Each page runs an AI worker plus a review pool, so keep few pages at once.
  workers: 2,
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'webkit', use: { ...iphone18ProSafari, browserName: 'webkit' } },
    { name: 'chromium', use: { ...iphone18ProSafari, browserName: 'chromium' } },
  ],
  // Test what deploys: the staged site, service worker included.
  webServer: {
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
  },
})
