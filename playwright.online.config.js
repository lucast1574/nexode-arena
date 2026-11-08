import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: '**/online.spec.js', workers: 1,
  timeout: 180000, expect: { timeout: 20000 }, reporter: 'list',
  outputDir: 'test-results/online',
  use: { baseURL: 'http://127.0.0.1:4320', viewport: { width: 960, height: 640 },
    launchOptions: { args: ['--use-gl=angle', '--use-angle=gl', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] } },
  webServer: { command: 'npm run build && npm start', url: 'http://127.0.0.1:4320/healthz',
    env: { PORT: '4320' }, reuseExistingServer: false, timeout: 120000 }
});
