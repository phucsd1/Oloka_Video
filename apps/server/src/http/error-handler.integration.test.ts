import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApplication } from "../app.js";
import { parseEnvironment } from "../config/environment.js";
import { ApplicationError } from "./application-error.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("canonical HTTP error handler", () => {
  it("returns a stable request ID and exact unauthenticated session envelope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-error-handler-"));
    directories.push(directory);
    const app = await buildApplication({
      environment: parseEnvironment({
        NODE_ENV: "test",
        OBJECT_STORAGE_ROOT: join(directory, "objects"),
        DATABASE_PATH: join(directory, "database", "test.db"),
        LOG_LEVEL: "silent",
      }),
      serveFrontend: false,
    });
    app.get("/api/test/rate-limit", () => {
      throw new ApplicationError("RATE_LIMITED", "test_rate_limit", {
        "retry-after": "5",
      });
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/auth/session",
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: {
          code: "AUTHENTICATION_REQUIRED",
          retryable: true,
          messageKey: "error.auth.required",
          suggestedAction: "Sign in again with Google",
          requestId: response.headers["x-request-id"],
        },
      });

      const limited = await app.inject({
        method: "GET",
        url: "/api/test/rate-limit",
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("5");
      expect(limited.json().error).toMatchObject({
        code: "RATE_LIMITED",
        messageKey: "error.rate_limited",
        requestId: limited.headers["x-request-id"],
      });
    } finally {
      await app.close();
    }
  });

  it("maps unexpected failures to INTERNAL_ERROR without leaking the cause", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-internal-error-"));
    directories.push(directory);
    const app = await buildApplication({
      environment: parseEnvironment({
        NODE_ENV: "test",
        OBJECT_STORAGE_ROOT: join(directory, "objects"),
        DATABASE_PATH: join(directory, "database", "test.db"),
        LOG_LEVEL: "silent",
      }),
      serveFrontend: false,
    });
    app.get("/api/test/unexpected", () => {
      throw new Error("database failed at C:\\sensitive\\production.sqlite");
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/test/unexpected",
      });
      expect(response.statusCode).toBe(500);
      expect(response.json().error).toMatchObject({
        code: "INTERNAL_ERROR",
        messageKey: "error.internal",
        requestId: response.headers["x-request-id"],
      });
      expect(response.body).not.toContain("production.sqlite");
      expect(response.body).not.toContain("database failed");
    } finally {
      await app.close();
    }
  });
});
