import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e-preview",
  fullyParallel: false,
  timeout: 30_000,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4178",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npx vite --config tests/preview-compat/vite.config.ts",
    url: "http://127.0.0.1:4178",
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
