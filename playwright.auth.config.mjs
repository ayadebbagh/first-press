import {defineConfig} from 'playwright/test';
const url=process.env.TEST_AUTH_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('_auth_test'))throw Error('An isolated auth test database is required.');
export default defineConfig({
  testDir:'./tests/auth-browser',workers:1,fullyParallel:false,forbidOnly:Boolean(process.env.CI),retries:0,
  timeout:60000,globalTimeout:8*60000,reporter:[['list'],['html',{outputFolder:'auth-playwright-report',open:'never'}]],
  outputDir:'auth-test-results',
  use:{baseURL:'http://127.0.0.1:3101',browserName:'chromium',headless:true,trace:'retain-on-failure',screenshot:'only-on-failure',reducedMotion:'reduce'},
  projects:[{name:'desktop',use:{viewport:{width:1440,height:1000}}},{name:'mobile',use:{viewport:{width:320,height:800},isMobile:true,hasTouch:true}}],
  webServer:[
    {command:'pnpm start',url:'http://127.0.0.1:3101/api/health',env:{PORT:'3101',FIRST_PRESS_HOST:'127.0.0.1',DATABASE_URL:url,FIRST_PRESS_AUTH_ENABLED:'true',BETTER_AUTH_URL:'http://127.0.0.1:3101',BETTER_AUTH_SECRET:'isolated-browser-test-secret-at-least-32-characters',GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:''},timeout:30000,reuseExistingServer:false},
    {command:'node tests/auth/smtp-fixture.mjs',url:'http://127.0.0.1:8026/health',timeout:10000,reuseExistingServer:false},
  ],
});
