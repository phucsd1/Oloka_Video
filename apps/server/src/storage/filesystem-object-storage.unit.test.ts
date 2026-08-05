import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemObjectStorage } from "./filesystem-object-storage.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("FilesystemObjectStorage", () => {
  it("proves the configured storage is writable and cleans up its fixed probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-storage-"));
    temporaryDirectories.push(root);
    const storage = new FilesystemObjectStorage(root);

    await expect(storage.checkReadiness()).resolves.toEqual({
      status: "ready",
    });
    await storage.close();

    expect(await readdir(root)).toEqual([]);
  });
});
