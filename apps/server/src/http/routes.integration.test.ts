import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApplication } from "../app.js";
import { parseEnvironment } from "../config/environment.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createTestApplication() {
  const dataDir = await mkdtemp(join(tmpdir(), "oloka-api-"));
  temporaryDirectories.push(dataDir);
  return buildApplication({
    environment: parseEnvironment({
      NODE_ENV: "test",
      OBJECT_STORAGE_ROOT: join(dataDir, "objects"),
      DATABASE_PATH: join(dataDir, "database", "test.db"),
      OLOKA_DATABASE_BOOTSTRAP_MODE: "fresh-if-replica-missing",
      APP_VERSION: "1.2.3",
      GIT_COMMIT_SHA: "abc123",
      BUILD_TIMESTAMP: "2026-08-05T01:00:00.000Z",
      LOG_LEVEL: "silent",
    }),
    serveFrontend: false,
  });
}

describe("system API", () => {
  it("GET /api/health confirms the process is running", async () => {
    const app = await createTestApplication();
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });

    await app.close();
  });

  it("GET /api/ready checks the database, storage, and configuration", async () => {
    const app = await createTestApplication();
    const response = await app.inject({ method: "GET", url: "/api/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      checks: {
        database: { status: "ready" },
        storage: { status: "ready" },
        configuration: { status: "ready" },
      },
    });
    expect(response.body).not.toContain("test.db");
    expect(response.body).not.toContain("/var/lib/oloka");

    await app.close();
  });

  it("GET /api/version returns immutable build metadata", async () => {
    const app = await createTestApplication();
    const response = await app.inject({ method: "GET", url: "/api/version" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      name: "Oloka Video",
      version: "1.2.3",
      environment: "test",
      gitCommitSha: "abc123",
      buildTimestamp: "2026-08-05T01:00:00.000Z",
    });

    await app.close();
  });
});
