import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: 'test-results',
});
