import {defineConfig} from 'playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  globalTimeout: 8*60_000,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI?1:0,
  reporter: [['list'],['html',{open:'never'}]],
  use: {
    baseURL: 'http://127.0.0.1:3100',
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce',
  },
  projects: [
    {name:'desktop',use:{viewport:{width:1440,height:1000}}},
    {name:'mobile',use:{viewport:{width:320,height:800},isMobile:true,hasTouch:true}},
  ],
  webServer: {
    command: 'pnpm start',
    url: 'http://127.0.0.1:3100/api/health',
    env: {PORT:'3100',FIRST_PRESS_HOST:'127.0.0.1'},
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
