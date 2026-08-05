import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dataDir = join(process.cwd(), ".tmp", "playwright-data");

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:7860",
    trace: "on-first-retry",
  },
  webServer: {
    command: "node apps/server/dist/index.js",
    url: "http://127.0.0.1:7860/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      NODE_ENV: "test",
      PORT: "7860",
      DATA_DIR: dataDir,
      DATABASE_URL: pathToFileURL(join(dataDir, "database", "playwright.db"))
        .href,
      APP_VERSION: "0.1.0",
      GIT_COMMIT_SHA: "playwright",
      BUILD_TIMESTAMP: "playwright",
      LOG_LEVEL: "silent",
      OLOKA_APP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
