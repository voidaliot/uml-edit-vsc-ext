import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('.cache/ms-playwright')) process.env.PLAYWRIGHT_BROWSERS_PATH = resolve('.cache/ms-playwright');
export default defineConfig({
  testDir: './test/web',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  globalSetup: './test/web/global-setup.ts',
  use: { baseURL: 'http://127.0.0.1:4173', viewport: { width: 1440, height: 960 }, headless: true, screenshot: 'only-on-failure' },
});
