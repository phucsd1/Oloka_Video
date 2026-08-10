import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import { OutboxRepository } from "../database/repositories/outbox-repository.js";
import { OutboxConsumer, OutboxHandlerRegistry } from "./consumer.js";
import { OutboxRuntime } from "./runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("OutboxRuntime integration", () => {
  it("finishes every claimed event before shutdown completes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-outbox-runtime-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    let nextId = 1;
    const repository = new OutboxRepository({
      generate: () =>
        `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    });
    database.transactions.run("immediate", (context) => {
      for (const aggregateId of ["job-1", "job-2"]) {
        repository.enqueue(context, {
          topic: "job.state.changed",
          aggregateType: "job",
          aggregateId,
          payload: { schemaVersion: 1 },
          availableAt: 0,
          createdAt: 0,
        });
      }
    });
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const registry = new OutboxHandlerRegistry();
    let deliveries = 0;
    registry.register("job.state.changed", async () => {
      deliveries += 1;
      if (deliveries !== 1) return;
      firstStarted?.();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    const consumer = new OutboxConsumer(
      database.transactions,
      repository,
      registry,
      { now: () => 10 },
      {
        leaseOwner: "runtime-worker",
        batchSize: 2,
        concurrency: 1,
        leaseDurationMs: 100,
        maxAttempts: 3,
        retryDelayMs: () => 1,
      },
    );
    const runtime = new OutboxRuntime(consumer, { pollIntervalMs: 1_000 });

    try {
      const starting = runtime.start();
      await firstStartedPromise;
      const stopping = runtime.stop();
      releaseFirst?.();
      await Promise.all([starting, stopping]);

      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection
            .prepare(
              "SELECT status, COUNT(*) AS count FROM outbox_events GROUP BY status",
            )
            .all(),
        ),
      ).toEqual([{ status: "published", count: 2 }]);
    } finally {
      await database.close();
    }
  });

  it("coalesces direct concurrent runOnce calls for one consumer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-outbox-consumer-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    let nextId = 10;
    const repository = new OutboxRepository({
      generate: () =>
        `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    });
    database.transactions.run("immediate", (context) => {
      for (const aggregateId of ["job-10", "job-11"]) {
        repository.enqueue(context, {
          topic: "job.state.changed",
          aggregateType: "job",
          aggregateId,
          payload: { schemaVersion: 1 },
          availableAt: 0,
          createdAt: 0,
        });
      }
    });
    let active = 0;
    let maximumActive = 0;
    let deliveries = 0;
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const registry = new OutboxHandlerRegistry();
    registry.register("job.state.changed", async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      deliveries += 1;
      if (deliveries === 1) {
        firstStarted?.();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      active -= 1;
    });
    const consumer = new OutboxConsumer(
      database.transactions,
      repository,
      registry,
      { now: () => 10 },
      {
        leaseOwner: "consumer-worker",
        batchSize: 1,
        concurrency: 1,
        leaseDurationMs: 100,
        maxAttempts: 3,
        retryDelayMs: () => 1,
      },
    );

    try {
      const first = consumer.runOnce();
      await firstStartedPromise;
      const second = consumer.runOnce();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(maximumActive).toBe(1);
      releaseFirst?.();
      await Promise.all([first, second]);
      expect(deliveries).toBe(1);
    } finally {
      consumer.shutdown();
      await database.close();
    }
  });
});
