import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareLocalDatabasePath } from "./database-path.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("prepareLocalDatabasePath", () => {
  it("rejects a live database nested beneath persistent object storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-path-"));
    temporaryDirectories.push(root);

    await expect(
      prepareLocalDatabasePath({
        databasePath: join(root, "data", "database", "oloka.db"),
        objectStorageRoot: join(root, "data"),
      }),
    ).rejects.toThrow(/object storage/i);
  });

  it("rejects traversal segments instead of normalizing them silently", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-path-"));
    temporaryDirectories.push(root);

    await expect(
      prepareLocalDatabasePath({
        databasePath: `${root}${sep}local${sep}..${sep}database${sep}oloka.db`,
        objectStorageRoot: join(root, "objects"),
      }),
    ).rejects.toThrow(/traversal/i);
  });

  it("rejects relative and empty database paths", async () => {
    await expect(
      prepareLocalDatabasePath({
        databasePath: "database/oloka.db",
        objectStorageRoot: "/data",
      }),
    ).rejects.toThrow(/absolute/i);
    await expect(
      prepareLocalDatabasePath({
        databasePath: "",
        objectStorageRoot: "/data",
      }),
    ).rejects.toThrow(/absolute/i);
  });

  it("rejects directories and zero-byte database files", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-path-"));
    temporaryDirectories.push(root);
    const directoryPath = join(root, "directory.db");
    await mkdir(directoryPath);
    await expect(
      prepareLocalDatabasePath({
        databasePath: directoryPath,
        objectStorageRoot: join(root, "objects"),
      }),
    ).rejects.toThrow(/not a file/i);

    const zeroBytePath = join(root, "empty.db");
    await writeFile(zeroBytePath, new Uint8Array());
    await expect(
      prepareLocalDatabasePath({
        databasePath: zeroBytePath,
        objectStorageRoot: join(root, "objects"),
      }),
    ).rejects.toThrow(/zero bytes/i);
  });

  it("rejects a symbolic-link component in the database path", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-path-"));
    temporaryDirectories.push(root);
    const target = join(root, "target");
    const alias = join(root, "alias");
    await mkdir(target);
    await symlink(target, alias, "junction");

    await expect(
      prepareLocalDatabasePath({
        databasePath: join(alias, "oloka.db"),
        objectStorageRoot: join(root, "objects"),
      }),
    ).rejects.toThrow(/symbolic link/i);
  });

  it("creates only the safe local parent and preserves a valid existing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-path-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "local", "database", "oloka.db");
    const objectStorageRoot = join(root, "objects");

    await expect(
      prepareLocalDatabasePath({ databasePath, objectStorageRoot }),
    ).resolves.toEqual({ databasePath, existed: false });
    await writeFile(databasePath, "sqlite-placeholder");
    await expect(
      prepareLocalDatabasePath({ databasePath, objectStorageRoot }),
    ).resolves.toEqual({ databasePath, existed: true });
  });
});
