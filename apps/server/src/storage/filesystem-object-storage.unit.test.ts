import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
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

  it("rejects traversal and appends only at the acknowledged offset", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-storage-"));
    temporaryDirectories.push(root);
    const storage = new FilesystemObjectStorage(root);
    await storage.stage("upload-1");

    await expect(
      storage.appendAtOffset("../escape", 0, Buffer.from("x")),
    ).rejects.toThrow(/containment/i);
    await storage.appendAtOffset("upload-1", 0, Buffer.from("hello"));
    await expect(
      storage.appendAtOffset("upload-1", 0, Buffer.from("x")),
    ).rejects.toThrow(/offset/i);
    await expect(storage.statStaging("upload-1")).resolves.toMatchObject({
      size: 5,
    });
    await storage.close();
  });

  it.each([
    "../escape",
    "..\\escape",
    "/absolute",
    "C:\\absolute",
    "\\\\server\\share",
    "mixed/../escape",
    "%2e%2e%2fescape",
    "%252e%252e%252fescape",
    "nul\0escape",
  ])("rejects hostile staging key %s", async (key) => {
    const root = await mkdtemp(join(tmpdir(), "oloka-storage-"));
    temporaryDirectories.push(root);
    const storage = new FilesystemObjectStorage(root);
    await expect(storage.stage(key)).rejects.toThrow(/containment/i);
  });

  it("rejects a symlink parent beneath the staging root", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-storage-"));
    temporaryDirectories.push(root);
    const outside = await mkdtemp(join(tmpdir(), "oloka-storage-outside-"));
    temporaryDirectories.push(outside);
    await mkdir(join(root, "objects"), { recursive: true });
    await symlink(outside, join(root, "objects", "v1"), "junction");
    const storage = new FilesystemObjectStorage(root);
    await expect(
      storage.head("v1/ab/00000000-0000-4000-8000-000000000001"),
    ).rejects.toThrow(/symlink/i);
  });
});
