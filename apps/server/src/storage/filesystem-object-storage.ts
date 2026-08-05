import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ObjectStorage, ReadinessResult } from "./object-storage.js";

export class FilesystemObjectStorage implements ObjectStorage {
  readonly #probePath: string;
  #readinessQueue: Promise<ReadinessResult> = Promise.resolve({
    status: "ready",
  });

  constructor(private readonly rootPath: string) {
    this.#probePath = join(rootPath, ".oloka-readiness");
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
}
