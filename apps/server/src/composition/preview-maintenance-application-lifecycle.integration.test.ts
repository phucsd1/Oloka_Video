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
    let storageClosed = false;
    let postCloseDatabaseAccess = 0;
    let postCloseStorageAccess = 0;
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
          const closeStorage = dependencies.storage.close.bind(
            dependencies.storage,
          );
          dependencies.storage.close = async () => {
            storageClosed = true;
            await closeStorage();
          };
          return {
            run: vi.fn(async () => {
              calls += 1;
              try {
                dependencies.transactions.run("read", () => undefined);
              } catch (error) {
                postCloseDatabaseAccess += 1;
                throw error;
              }
              if (calls === 1) return { scheduled: 0, purged: 0, failed: 0 };
              activeStarted?.();
              await blocked;
              try {
                dependencies.transactions.run("read", () => undefined);
              } catch (error) {
                postCloseDatabaseAccess += 1;
                throw error;
              }
              try {
                if (storageClosed) postCloseStorageAccess += 1;
                await dependencies.storage.checkReadiness();
              } catch (error) {
                postCloseStorageAccess += 1;
                throw error;
              }
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
    expect(postCloseDatabaseAccess).toBe(0);
    expect(postCloseStorageAccess).toBe(0);
    const callsAtClose = calls;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(callsAtClose);
  });

  it("fails closed on timeout and closes resources only after the pass settles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-preview-timeout-"));
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
    let postCloseDatabaseAccess = 0;
    let postCloseStorageAccess = 0;
    let storageClosed = false;
    let storageCloseCount = 0;
    let transactions:
      | import("../database/database.js").TransactionRunner
      | undefined;
    let storage:
      | import("../storage/object-storage.js").ObjectStorage
      | undefined;
    const app = await buildApplication({
      environment,
      serveFrontend: false,
      previewMaintenance: {
        pollIntervalMs: 5,
        shutdownGraceMs: 10,
        serviceFactory: (dependencies) => {
          transactions = dependencies.transactions;
          storage = dependencies.storage;
          const closeStorage = dependencies.storage.close.bind(
            dependencies.storage,
          );
          dependencies.storage.close = async () => {
            storageCloseCount += 1;
            storageClosed = true;
            await closeStorage();
          };
          return {
            run: vi.fn(async () => {
              calls += 1;
              if (calls === 1) return { scheduled: 0, purged: 0, failed: 0 };
              dependencies.transactions.run("read", () => undefined);
              await dependencies.storage.checkReadiness();
              activeStarted?.();
              await blocked;
              try {
                dependencies.transactions.run("read", () => undefined);
              } catch (error) {
                postCloseDatabaseAccess += 1;
                throw error;
              }
              try {
                if (storageClosed) postCloseStorageAccess += 1;
                await dependencies.storage.checkReadiness();
              } catch (error) {
                postCloseStorageAccess += 1;
                throw error;
              }
              return { scheduled: 0, purged: 0, failed: 0 };
            }),
          };
        },
      },
    });

    await active;
    await expect(app.close()).rejects.toMatchObject({
      name: "PreviewMaintenanceShutdownTimeoutError",
    });
    expect(() => transactions?.run("read", () => undefined)).not.toThrow();
    expect(storageCloseCount).toBe(0);
    expect(storageClosed).toBe(false);
    await expect(storage?.checkReadiness()).resolves.toMatchObject({
      status: "ready",
    });

    release?.();
    await vi.waitFor(() =>
      expect(() => transactions?.run("read", () => undefined)).toThrow(),
    );
    await app.close();
    expect(postCloseDatabaseAccess).toBe(0);
    expect(postCloseStorageAccess).toBe(0);
    expect(storageCloseCount).toBe(1);
    const callsAtClose = calls;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(callsAtClose);
  });
});
