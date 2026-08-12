import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
    await expect(
      storage.openRange("v1/ab/00000000-0000-4000-8000-000000000001", 0, 1),
    ).rejects.toThrow(/symlink/i);
  });

  it("rejects a symlinked staging root for hash, truncate, delete, and finalize", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-storage-"));
    temporaryDirectories.push(root);
    const outside = await mkdtemp(join(tmpdir(), "oloka-storage-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "upload-1"), "outside");
    await symlink(outside, join(root, "tmp"), "junction");
    const storage = new FilesystemObjectStorage(root);
    const key = "v1/ab/00000000-0000-4000-8000-000000000001";

    await expect(storage.createStagingHash("upload-1")).rejects.toThrow(
      /symlink/i,
    );
    await expect(storage.truncateStaging("upload-1", 0)).rejects.toThrow(
      /symlink/i,
    );
    await expect(storage.delete("staging", "upload-1")).rejects.toThrow(
      /symlink/i,
    );
    await expect(storage.finalize("upload-1", key)).rejects.toThrow(/symlink/i);
  });

  it("rejects a durable target symlink before opening a range", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-storage-"));
    temporaryDirectories.push(root);
    const outside = join(root, "outside.bin");
    await writeFile(outside, "outside");
    const key = "v1/ab/00000000-0000-4000-8000-000000000001";
    const target = join(root, "objects", "v1", "ab", key.split("/").at(-1)!);
    await mkdir(join(root, "objects", "v1", "ab"), { recursive: true });
    await symlink(outside, target, "file");
    const storage = new FilesystemObjectStorage(root);

    await expect(storage.openRange(key, 0, 1)).rejects.toThrow(/symlink/i);
  });

  it("never overwrites an existing durable destination during finalize", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-storage-"));
    temporaryDirectories.push(root);
    const storage = new FilesystemObjectStorage(root);
    const key = "v1/ab/00000000-0000-4000-8000-000000000001";
    await storage.stage("existing");
    await storage.appendAtOffset("existing", 0, Buffer.from("old"));
    await storage.finalize("existing", key);
    await storage.stage("replacement");
    await storage.appendAtOffset("replacement", 0, Buffer.from("new"));

    await expect(storage.finalize("replacement", key)).rejects.toThrow();
    expect(
      await readFile(
        join(root, "objects", "v1", "ab", key.split("/").at(-1)!),
        "utf8",
      ),
    ).toBe("old");
    await expect(storage.statStaging("replacement")).resolves.toMatchObject({
      size: 3,
    });
  });

  it("allows only one concurrent finalize to claim a durable key", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-storage-"));
    temporaryDirectories.push(root);
    const storage = new FilesystemObjectStorage(root);
    const key = "v1/ab/00000000-0000-4000-8000-000000000001";
    await storage.stage("race-a");
    await storage.appendAtOffset("race-a", 0, Buffer.from("aaa"));
    await storage.stage("race-b");
    await storage.appendAtOffset("race-b", 0, Buffer.from("bbb"));

    const results = await Promise.allSettled([
      storage.finalize("race-a", key),
      storage.finalize("race-b", key),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    const durable = await readFile(
      join(root, "objects", "v1", "ab", key.split("/").at(-1)!),
      "utf8",
    );
    expect(["aaa", "bbb"]).toContain(durable);
    const loser = durable === "aaa" ? "race-b" : "race-a";
    await expect(storage.statStaging(loser)).resolves.toMatchObject({
      size: 3,
    });
  });

  it("falls back to an exclusive copy when hard links are unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-storage-copy-"));
    temporaryDirectories.push(root);
    let linkAttempted = false;
    const storage = new FilesystemObjectStorage(root, {
      link: () => {
        linkAttempted = true;
        const error = new Error(
          "Hard links are unsupported",
        ) as NodeJS.ErrnoException;
        error.code = "ENOTSUP";
        return Promise.reject(error);
      },
    });
    const stagingKey = "preview-stage";
    const storageKey = "v1/ab/00000000-0000-4000-8000-000000000001";
    await storage.stage(stagingKey);
    await storage.appendAtOffset(stagingKey, 0, Buffer.from("preview"));
    await storage.finalize(stagingKey, storageKey);
    expect(linkAttempted).toBe(true);
    await expect(storage.head(storageKey)).resolves.toMatchObject({ size: 7 });
    await expect(storage.statStaging(stagingKey)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await storage.close();
  });
});
