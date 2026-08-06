import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapLocalDatabase } from "./database-bootstrap.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("bootstrapLocalDatabase", () => {
  it("preserves a valid existing database without attempting restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-bootstrap-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "local", "oloka.db");
    await mkdir(join(root, "local"));
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE marker (value TEXT NOT NULL)");
    database.close();
    const restore = vi.fn();

    await expect(
      bootstrapLocalDatabase({
        databasePath,
        objectStorageRoot: join(root, "objects"),
        mode: "restore-required",
        restore,
      }),
    ).resolves.toEqual({ source: "existing" });
    expect(restore).not.toHaveBeenCalled();
  });

  it("allows a fresh database only when missing replicas are explicitly allowed", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-bootstrap-"));
    temporaryDirectories.push(root);
    const restore = vi.fn().mockResolvedValue(undefined);

    await expect(
      bootstrapLocalDatabase({
        databasePath: join(root, "fresh", "oloka.db"),
        objectStorageRoot: join(root, "objects"),
        mode: "fresh-if-replica-missing",
        restore,
      }),
    ).resolves.toEqual({ source: "fresh" });
    expect(restore).toHaveBeenCalledOnce();
  });

  it("fails closed when restore-required finds no replica", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-bootstrap-"));
    temporaryDirectories.push(root);

    await expect(
      bootstrapLocalDatabase({
        databasePath: join(root, "required", "oloka.db"),
        objectStorageRoot: join(root, "objects"),
        mode: "restore-required",
        restore: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow(/required/i);
  });

  it.each([
    "network restore failed",
    "authentication restore failed",
    "corrupt replica restore failed",
  ])("fails closed on %s", async (message) => {
    const root = await mkdtemp(join(tmpdir(), "oloka-bootstrap-"));
    temporaryDirectories.push(root);
    const restore = vi.fn().mockRejectedValue(new Error(message));

    await expect(
      bootstrapLocalDatabase({
        databasePath: join(root, "failed", "oloka.db"),
        objectStorageRoot: join(root, "objects"),
        mode: "fresh-if-replica-missing",
        restore,
      }),
    ).rejects.toThrow(message);
  });

  it("accepts only an integrity-checked restored database", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-bootstrap-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "restored", "oloka.db");
    const restore = vi.fn(() => {
      const database = new DatabaseSync(databasePath);
      database.exec("CREATE TABLE marker (value TEXT NOT NULL)");
      database.close();
      return Promise.resolve();
    });

    await expect(
      bootstrapLocalDatabase({
        databasePath,
        objectStorageRoot: join(root, "objects"),
        mode: "restore-required",
        restore,
      }),
    ).resolves.toEqual({ source: "restored" });
  });

  it("rejects a corrupt or zero-byte restore result", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-bootstrap-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "corrupt", "oloka.db");

    await expect(
      bootstrapLocalDatabase({
        databasePath,
        objectStorageRoot: join(root, "objects"),
        mode: "restore-required",
        restore: () => writeFile(databasePath, new Uint8Array()),
      }),
    ).rejects.toThrow(/zero bytes/i);
  });

  it("rejects an unexpected rollback journal left by restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-bootstrap-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "journal", "oloka.db");

    await expect(
      bootstrapLocalDatabase({
        databasePath,
        objectStorageRoot: join(root, "objects"),
        mode: "restore-required",
        restore: async () => {
          const database = new DatabaseSync(databasePath);
          database.exec("CREATE TABLE marker (value TEXT NOT NULL)");
          database.close();
          await writeFile(`${databasePath}-journal`, "unexpected");
        },
      }),
    ).rejects.toThrow(/journal/i);
  });
});
