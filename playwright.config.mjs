import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: './tests/browser', use: { headless: true } })
