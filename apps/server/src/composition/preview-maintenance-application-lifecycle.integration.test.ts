import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApplication } from "../app.js";
import { parseEnvironment } from "../config/environment.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Preview maintenance application lifecycle", () => {
  it("settles an active pass before shared database and storage close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-preview-close-"));
    temporaryDirectories.push(directory);
    const environment = parseEnvironment({
      NODE_ENV: "test",
      OBJECT_STORAGE_ROOT: join(directory, "objects"),
      DATABASE_PATH: join(directory, "database", "test.db"),
      OLOKA_DATABASE_BOOTSTRAP_MODE: "fresh-if-replica-missing",
      OLOKA_APP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      LOG_LEVEL: "silent",
    });
    let calls = 0;
    let release: (() => void) | undefined;
    let activeStarted: (() => void) | undefined;
    const active = new Promise<void>((resolve) => {
      activeStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let transactions:
      | import("../database/database.js").TransactionRunner
      | undefined;
    const app = await buildApplication({
      environment,
      serveFrontend: false,
      previewMaintenance: {
        pollIntervalMs: 5,
        serviceFactory: (dependencies) => {
          transactions = dependencies.transactions;
          return {
            run: vi.fn(async () => {
              calls += 1;
              dependencies.transactions.run("read", () => undefined);
              if (calls === 1) return { scheduled: 0, purged: 0, failed: 0 };
              activeStarted?.();
              await blocked;
              dependencies.transactions.run("read", () => undefined);
              await dependencies.storage.checkReadiness();
              return { scheduled: 0, purged: 0, failed: 0 };
            }),
          };
        },
      },
    });

    await active;
    let closed = false;
    const close = app.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(() => transactions?.run("read", () => undefined)).not.toThrow();

    release?.();
    await close;
    expect(closed).toBe(true);
    expect(() => transactions?.run("read", () => undefined)).toThrow();
    const callsAtClose = calls;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(callsAtClose);
  });
});
