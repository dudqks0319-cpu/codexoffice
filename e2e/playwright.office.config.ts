import { defineConfig } from '@playwright/test'
import baseConfig from './playwright.config'

/**
 * Explicit manual-QA lane for Office-authored documents. It is intentionally
 * excluded from the default E2E suite because its inputs must be produced by
 * a real Microsoft Office installation and live outside the repository.
 */
export default defineConfig({
  ...baseConfig,
  testMatch: ['office-authored-reopen.spec.ts'],
  testIgnore: [],
  outputDir: './office-test-results',
  reporter: [['list'], ['html', { outputFolder: './office-playwright-report', open: 'never' }]],
})
