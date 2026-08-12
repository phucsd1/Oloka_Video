import { constants } from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  open,
  unlink,
  lstat,
  readdir,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ObjectStorage, ReadinessResult } from "./object-storage.js";
import type { StoredObjectStat } from "./object-storage.js";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

interface FilesystemObjectStorageOperations {
  link(source: string, destination: string): Promise<void>;
  copyFile(source: string, destination: string, mode: number): Promise<void>;
}

const DEFAULT_OPERATIONS: FilesystemObjectStorageOperations = {
  link,
  copyFile,
};

export class FilesystemObjectStorage implements ObjectStorage {
  readonly #probePath: string;
  readonly #tmpRoot: string;
  readonly #objectsRoot: string;
  #readinessQueue: Promise<ReadinessResult> = Promise.resolve({
    status: "ready",
  });

  constructor(
    private readonly rootPath: string,
    operations: Partial<FilesystemObjectStorageOperations> = {},
  ) {
    this.operations = { ...DEFAULT_OPERATIONS, ...operations };
    this.#probePath = join(rootPath, ".oloka-readiness");
    this.#tmpRoot = join(rootPath, "tmp");
    this.#objectsRoot = join(rootPath, "objects");
  }

  private readonly operations: FilesystemObjectStorageOperations;

  async stage(stagingKey: string): Promise<void> {
    const target = await this.resolveContained("staging", stagingKey);
    await mkdir(dirname(target), { recursive: true });
    const handle = await open(target, "wx");
    await handle.close();
  }

  async appendAtOffset(
    stagingKey: string,
    offset: number,
    bytes: Uint8Array,
  ): Promise<void> {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid append offset");
    const target = await this.resolveContained("staging", stagingKey);
    const handle = await this.openRegularFile(target, constants.O_RDWR);
    try {
      const current = await handle.stat();
      if (current.size !== offset) throw new Error("Staging offset conflict");
      let written = 0;
      while (written < bytes.byteLength) {
        const result = await handle.write(
          bytes,
          written,
          bytes.byteLength - written,
          offset + written,
        );
        written += result.bytesWritten;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async statStaging(stagingKey: string): Promise<StoredObjectStat> {
    return this.statContained("staging", stagingKey);
  }

  async truncateStaging(stagingKey: string, size: number): Promise<void> {
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error("Invalid truncate size");
    const target = await this.resolveContained("staging", stagingKey);
    const handle = await this.openRegularFile(target, constants.O_RDWR);
    try {
      await handle.truncate(size);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async finalize(stagingKey: string, storageKey: string): Promise<void> {
    const source = await this.resolveContained("staging", stagingKey);
    const destination = await this.resolveContained("durable", storageKey);
    await mkdir(dirname(destination), { recursive: true });
    const sourceHandle = await this.openRegularFile(source, constants.O_RDONLY);
    await sourceHandle.close();
    try {
      await this.operations.link(source, destination);
    } catch (error) {
      if (!isHardLinkUnsupported(error)) throw error;
      await this.operations.copyFile(
        source,
        destination,
        constants.COPYFILE_EXCL,
      );
    }
    const destinationHandle = await this.openRegularFile(
      destination,
      constants.O_RDWR,
    );
    try {
      await destinationHandle.sync();
    } finally {
      await destinationHandle.close();
    }
    await unlink(source);
  }

  async rollbackFinalize(
    stagingKey: string,
    storageKey: string,
  ): Promise<void> {
    const staging = await this.resolveContained("staging", stagingKey);
    const durable = await this.resolveContained("durable", storageKey);
    const stagingEntry = await lstat(staging).catch(() => undefined);
    const durableEntry = await lstat(durable).catch(() => undefined);
    if (stagingEntry !== undefined && durableEntry === undefined) {
      await this.openRegularFile(staging, constants.O_RDONLY).then((handle) =>
        handle.close(),
      );
      return;
    }
    if (stagingEntry !== undefined && durableEntry !== undefined)
      throw new Error("Finalize rollback collision");
    if (stagingEntry === undefined && durableEntry === undefined)
      throw new Error("Finalized object missing");
    await this.openRegularFile(durable, constants.O_RDONLY).then((handle) =>
      handle.close(),
    );
    await mkdir(dirname(staging), { recursive: true });
    await link(durable, staging);
    await unlink(durable);
  }

  async openRange(
    storageKey: string,
    start: number,
    end: number,
  ): Promise<NodeJS.ReadableStream> {
    const target = await this.resolveContained("durable", storageKey);
    const handle = await this.openRegularFile(target, constants.O_RDONLY);
    return handle.createReadStream({ start, end, autoClose: true });
  }

  async head(storageKey: string): Promise<StoredObjectStat> {
    return this.statContained("durable", storageKey);
  }

  async delete(kind: "staging" | "durable", key: string): Promise<void> {
    const target = await this.resolveContained(kind, key);
    const entry = await lstat(target).catch(() => undefined);
    if (entry === undefined) return;
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error("Storage symlink rejected");
    await unlink(target);
  }

  async listForReconciliation(): Promise<{
    staging: string[];
    durable: string[];
  }> {
    await mkdir(this.#tmpRoot, { recursive: true });
    await mkdir(this.#objectsRoot, { recursive: true });
    return {
      staging: await this.listRelative(this.#tmpRoot),
      durable: await this.listRelative(this.#objectsRoot),
    };
  }

  async readPrefix(storageKey: string, length: number): Promise<Buffer> {
    return this.readPrefixFor("durable", storageKey, length);
  }

  async readStagingPrefix(stagingKey: string, length: number): Promise<Buffer> {
    return this.readPrefixFor("staging", stagingKey, length);
  }

  private async readPrefixFor(
    kind: "staging" | "durable",
    key: string,
    length: number,
  ): Promise<Buffer> {
    const target = await this.resolveContained(kind, key);
    const handle = await this.openRegularFile(target, constants.O_RDONLY);
    try {
      const buffer = Buffer.alloc(length);
      const result = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, result.bytesRead);
    } finally {
      await handle.close();
    }
  }

  async createHash(storageKey: string): Promise<string> {
    return this.createHashFor("durable", storageKey);
  }

  async createStagingHash(stagingKey: string): Promise<string> {
    return this.createHashFor("staging", stagingKey);
  }

  private async createHashFor(
    kind: "staging" | "durable",
    key: string,
  ): Promise<string> {
    const target = await this.resolveContained(kind, key);
    const handle = await this.openRegularFile(target, constants.O_RDONLY);
    const digest = createHash("sha256");
    try {
      const stream = handle.createReadStream({ autoClose: false });
      for await (const chunk of stream) digest.update(chunk as Buffer);
      return digest.digest("hex");
    } finally {
      await handle.close();
    }
  }

  checkReadiness(): Promise<ReadinessResult> {
    this.#readinessQueue = this.#readinessQueue.then(
      () => this.runReadinessCheck(),
      () => this.runReadinessCheck(),
    );
    return this.#readinessQueue;
  }

  async close(): Promise<void> {
    await this.#readinessQueue.catch(() => undefined);
    await unlink(this.#probePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private async runReadinessCheck(): Promise<ReadinessResult> {
    try {
      await mkdir(this.rootPath, { recursive: true });
      const handle = await open(this.#probePath, "w+");
      try {
        const marker = Buffer.from("1");
        await handle.write(marker, 0, marker.length, 0);
        await handle.sync();
        const verification = Buffer.alloc(1);
        const result = await handle.read(verification, 0, 1, 0);
        if (result.bytesRead !== 1 || verification.toString() !== "1") {
          throw new Error("Storage write verification failed");
        }
      } finally {
        await handle.close();
      }
      return { status: "ready" };
    } catch (error) {
      return {
        status: "not_ready",
        message:
          error instanceof Error ? error.message : "Unknown storage error",
      };
    }
  }

  private async statContained(
    kind: "staging" | "durable",
    key: string,
  ): Promise<StoredObjectStat> {
    const target = await this.resolveContained(kind, key);
    const handle = await this.openRegularFile(target, constants.O_RDONLY);
    try {
      const result = await handle.stat();
      return { size: result.size, modifiedAt: result.mtime };
    } finally {
      await handle.close();
    }
  }

  private async resolveContained(
    kind: "staging" | "durable",
    key: string,
  ): Promise<string> {
    const target = this.resolveContainedSync(kind, key);
    await this.assertNoSymlinkParents(target, this.rootPath);
    return target;
  }

  private resolveContainedSync(
    kind: "staging" | "durable",
    key: string,
  ): string {
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.includes("\0") ||
      isAbsolute(key)
    )
      throw new Error("Storage key containment violation");
    const valid =
      kind === "staging"
        ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key) && !key.includes("..")
        : /^v1\/[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            key,
          );
    if (!valid) throw new Error("Storage key containment violation");
    const base = kind === "staging" ? this.#tmpRoot : this.#objectsRoot;
    const target = resolve(base, key);
    const rel = relative(resolve(base), target);
    if (
      rel === "" ||
      rel.startsWith(".." + sep) ||
      rel === ".." ||
      isAbsolute(rel)
    )
      throw new Error("Storage key containment violation");
    return target;
  }

  private async assertNoSymlinkParents(
    target: string,
    base: string,
  ): Promise<void> {
    const resolvedBase = resolve(base);
    const resolvedTarget = resolve(target);
    if (
      resolvedTarget !== resolvedBase &&
      !resolvedTarget.startsWith(resolvedBase + sep)
    )
      throw new Error("Storage key containment violation");
    let current = resolvedTarget;
    const parents: string[] = [];
    while (current !== resolvedBase) {
      parents.push(current);
      current = dirname(current);
    }
    parents.push(resolvedBase);
    for (const path of parents.reverse()) {
      const entry = await lstat(path).catch(() => undefined);
      if (entry?.isSymbolicLink()) throw new Error("Storage symlink rejected");
    }
  }

  private async openRegularFile(target: string, flags: number) {
    const handle = await open(target, flags | NO_FOLLOW);
    try {
      const entry = await handle.stat();
      if (!entry.isFile())
        throw new Error("Storage target is not a regular file");
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async listRelative(root: string): Promise<string[]> {
    const result: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await visit(full);
        else if (entry.isFile())
          result.push(relative(root, full).split(sep).join("/"));
      }
    };
    await visit(root);
    return result.sort();
  }
}

function isHardLinkUnsupported(error: unknown): boolean {
  return (
    error instanceof Error &&
    ["EXDEV", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(
      (error as NodeJS.ErrnoException).code ?? "",
    )
  );
}
