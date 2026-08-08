import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  unlink,
  stat,
  lstat,
  realpath,
  rename,
  readdir,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ObjectStorage, ReadinessResult } from "./object-storage.js";
import type { StoredObjectStat } from "./object-storage.js";

export class FilesystemObjectStorage implements ObjectStorage {
  readonly #probePath: string;
  readonly #tmpRoot: string;
  readonly #objectsRoot: string;
  #readinessQueue: Promise<ReadinessResult> = Promise.resolve({
    status: "ready",
  });

  constructor(private readonly rootPath: string) {
    this.#probePath = join(rootPath, ".oloka-readiness");
    this.#tmpRoot = join(rootPath, "tmp");
    this.#objectsRoot = join(rootPath, "objects");
  }

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
    const current = await stat(target);
    if (current.size !== offset) throw new Error("Staging offset conflict");
    const handle = await open(target, "r+");
    try {
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
    const handle = await open(target, "r+");
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
    try {
      await lstat(destination);
      throw new Error("Durable object already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(source, destination);
  }

  openRange(
    storageKey: string,
    start: number,
    end: number,
  ): NodeJS.ReadableStream {
    const target = this.resolveContainedSync("durable", storageKey);
    return createReadStream(target, { start, end });
  }

  async head(storageKey: string): Promise<StoredObjectStat> {
    return this.statContained("durable", storageKey);
  }

  async delete(kind: "staging" | "durable", key: string): Promise<void> {
    const target = await this.resolveContained(kind, key);
    await rm(target, { force: true });
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
    const handle = await open(target, "r");
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
    const digest = createHash("sha256");
    const stream = createReadStream(target);
    for await (const chunk of stream) digest.update(chunk as Buffer);
    return digest.digest("hex");
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
    const result = await stat(target);
    return { size: result.size, modifiedAt: result.mtime };
  }

  private async resolveContained(
    kind: "staging" | "durable",
    key: string,
  ): Promise<string> {
    const target = this.resolveContainedSync(kind, key);
    await this.assertNoSymlinkParents(
      target,
      kind === "staging" ? this.#tmpRoot : this.#objectsRoot,
    );
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
    const realBase = await realpath(base).catch(() => resolve(base));
    let current = resolve(target);
    const parents: string[] = [];
    while (current !== realBase && current.startsWith(realBase + sep)) {
      parents.push(current);
      current = dirname(current);
    }
    for (const path of parents.reverse()) {
      const entry = await lstat(path).catch(() => undefined);
      if (entry?.isSymbolicLink()) throw new Error("Storage symlink rejected");
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
