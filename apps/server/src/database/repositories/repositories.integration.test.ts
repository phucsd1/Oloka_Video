import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../sqlite-system-database.js";
import { AuditEventRepository } from "./audit-event-repository.js";
import { IdempotencyRepository } from "./idempotency-repository.js";
import { OutboxRepository } from "./outbox-repository.js";
import { SystemMetadataRepository } from "./system-metadata-repository.js";
import {
  OutboxConsumer,
  OutboxHandlerRegistry,
} from "../../outbox/consumer.js";

const temporaryDirectories: string[] = [];
const userId = "00000000-0000-4000-8000-000000000001";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "oloka-repository-"));
  temporaryDirectories.push(directory);
  const database = await SqliteSystemDatabase.connect(
    pathToFileURL(join(directory, "database.sqlite")).href,
  );
  await database.migrate();
  database.transactions.run("immediate", ({ database: connection }) =>
    connection
      .prepare(
        `INSERT INTO users
          (id, email_normalized, display_name, role, status, created_at, updated_at, version)
         VALUES (?, 'member@example.test', 'Member', 'member', 'pending', 1, 1, 1)`,
      )
      .run(userId),
  );
  return database;
}

describe("Slice 3A repositories", () => {
  it("guards typed system metadata with optimistic versions", async () => {
    const database = await createDatabase();
    const repository = new SystemMetadataRepository();
    const first = database.transactions.run("immediate", (context) =>
      repository.put(context, {
        key: "kernel.schema",
        value: { version: 2 },
        updatedAt: 10,
        expectedVersion: null,
      }),
    );
    expect(first.version).toBe(1);
    expect(() =>
      database.transactions.run("immediate", (context) =>
        repository.put(context, {
          key: "kernel.schema",
          value: { version: 3 },
          updatedAt: 11,
          expectedVersion: 7,
        }),
      ),
    ).toThrow(/version conflict/i);
    await database.close();
  });

  it("rejects forbidden nested audit metadata and enforces append-only rows", async () => {
    const database = await createDatabase();
    const repository = new AuditEventRepository({
      generate: () => "00000000-0000-4000-8000-000000000002",
    });
    expect(() =>
      database.transactions.run("immediate", (context) =>
        repository.append(context, {
          actorType: "system",
          action: "kernel.test",
          resourceType: "system",
          outcome: "success",
          metadata: { nested: { Api_Key: "must-not-persist" } },
          createdAt: 10,
        }),
      ),
    ).toThrow(/forbidden/i);
    const eventId = database.transactions.run("immediate", (context) =>
      repository.append(context, {
        actorType: "system",
        action: "kernel.test",
        resourceType: "system",
        outcome: "success",
        metadata: { schemaVersion: 1 },
        createdAt: 10,
      }),
    );
    expect(() =>
      database.transactions.run("immediate", ({ database: connection }) =>
        connection
          .prepare("UPDATE audit_events SET action = 'changed' WHERE id = ?")
          .run(eventId),
      ),
    ).toThrow(/append-only/i);
    await database.close();
  });

  it("replays a completed idempotent response without storing the raw key", async () => {
    const database = await createDatabase();
    const repository = new IdempotencyRepository({
      generate: () => "00000000-0000-4000-8000-000000000003",
    });
    const requestHash = "a".repeat(64);
    const started = database.transactions.run("immediate", (context) =>
      repository.begin(context, {
        userId,
        operation: "kernel.test",
        idempotencyKey: "raw-client-key",
        semanticRequestHashSha256: requestHash,
        createdAt: 10,
        expiresAt: 100,
      }),
    );
    expect(started.kind).toBe("started");
    database.transactions.run("immediate", (context) =>
      repository.complete(context, {
        recordId: "00000000-0000-4000-8000-000000000003",
        responseStatus: 202,
        response: { accepted: true },
      }),
    );
    const replay = database.transactions.run("read", (context) =>
      repository.lookup(context, {
        userId,
        operation: "kernel.test",
        idempotencyKey: "raw-client-key",
        semanticRequestHashSha256: requestHash,
      }),
    );
    expect(replay).toMatchObject({
      kind: "replay",
      responseStatus: 202,
      response: { accepted: true },
    });
    const rawKeyMatches = database.transactions.run(
      "read",
      ({ database: connection }) =>
        connection
          .prepare(
            "SELECT COUNT(*) AS count FROM idempotency_records WHERE CAST(idempotency_key_hash_sha256 AS TEXT) = ?",
          )
          .get("raw-client-key"),
    );
    expect(rawKeyMatches).toEqual({ count: 0 });
    await database.close();
  });

  it("looks up absent idempotency keys without creating a record", async () => {
    const database = await createDatabase();
    const repository = new IdempotencyRepository({
      generate: () => "00000000-0000-4000-8000-000000000099",
    });
    const lookup = database.transactions.run("read", (context) =>
      repository.lookup(context, {
        userId,
        operation: "kernel.lookup",
        idempotencyKey: "lookup-only-key",
        semanticRequestHashSha256: "b".repeat(64),
      }),
    );

    expect(lookup).toEqual({ kind: "absent" });
    expect(
      database.transactions.run("read", ({ database: connection }) =>
        connection
          .prepare("SELECT COUNT(*) AS count FROM idempotency_records")
          .get(),
      ),
    ).toEqual({ count: 0 });
    await database.close();
  });

  it("claims outbox events in order and guards lease ownership", async () => {
    const database = await createDatabase();
    let nextId = 4;
    const repository = new OutboxRepository({
      generate: () =>
        `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    });
    database.transactions.run("immediate", (context) => {
      repository.enqueue(context, {
        topic: "kernel.one",
        aggregateType: "system",
        aggregateId: "a",
        payload: { order: 1 },
        availableAt: 10,
        createdAt: 10,
      });
      repository.enqueue(context, {
        topic: "kernel.two",
        aggregateType: "system",
        aggregateId: "b",
        payload: { order: 2 },
        availableAt: 11,
        createdAt: 11,
      });
    });
    const claimed = database.transactions.run("immediate", (context) =>
      repository.claimBatch(context, {
        leaseOwner: "worker-1",
        now: 20,
        leaseExpiresAt: 30,
        limit: 2,
      }),
    );
    expect(claimed.map((event) => event.topic)).toEqual([
      "kernel.one",
      "kernel.two",
    ]);
    expect(() =>
      database.transactions.run("immediate", (context) =>
        repository.markPublished(context, claimed[0]!.id, "worker-2", 21),
      ),
    ).toThrow(/lease/i);
    database.transactions.run("immediate", (context) =>
      repository.markPublished(context, claimed[0]!.id, "worker-1", 21),
    );
    await database.close();
  });

  it("runs a bounded at-least-once outbox consumer with retry", async () => {
    const database = await createDatabase();
    const repository = new OutboxRepository({
      generate: () => "00000000-0000-4000-8000-000000000006",
    });
    database.transactions.run("immediate", (context) =>
      repository.enqueue(context, {
        topic: "kernel.retry",
        aggregateType: "system",
        aggregateId: "a",
        payload: { safe: true },
        availableAt: 10,
        createdAt: 10,
      }),
    );
    let now = 10;
    let deliveries = 0;
    const registry = new OutboxHandlerRegistry();
    registry.register("kernel.retry", () => {
      deliveries += 1;
      return deliveries === 1
        ? Promise.reject(new Error("retry"))
        : Promise.resolve();
    });
    const consumer = new OutboxConsumer(
      database.transactions,
      repository,
      registry,
      { now: () => now },
      {
        leaseOwner: "worker-1",
        batchSize: 5,
        concurrency: 2,
        leaseDurationMs: 100,
        maxAttempts: 3,
        retryDelayMs: () => 5,
      },
    );
    await consumer.runOnce();
    now = 15;
    await consumer.runOnce();
    expect(deliveries).toBe(2);
    const state = database.transactions.run(
      "read",
      ({ database: connection }) =>
        connection
          .prepare("SELECT status, attempt_count FROM outbox_events")
          .get(),
    );
    expect(state).toEqual({ status: "published", attempt_count: 2 });
    consumer.shutdown();
    expect(await consumer.runOnce()).toBe(0);
    await database.close();
  });

  it("redelivers an expired event while an idempotent effect executes once", async () => {
    const database = await createDatabase();
    const repository = new OutboxRepository({
      generate: () => "00000000-0000-4000-8000-000000000007",
    });
    database.transactions.run("immediate", (context) =>
      repository.enqueue(context, {
        topic: "job.state.changed",
        aggregateType: "job",
        aggregateId: "job-1",
        payload: { status: "running" },
        availableAt: 10,
        createdAt: 10,
      }),
    );
    const firstClaim = database.transactions.run("immediate", (context) =>
      repository.claimBatch(context, {
        leaseOwner: "worker-a",
        now: 10,
        leaseExpiresAt: 20,
        limit: 1,
      }),
    );
    const effects = new Set<string>();
    let effectCalls = 1;
    // Worker A applied the idempotent effect, then died before marking publish.
    effects.add(firstClaim[0]!.aggregateId);
    const registry = new OutboxHandlerRegistry();
    registry.register("job.state.changed", (event) => {
      effectCalls += 1;
      effects.add(event.aggregateId);
      return Promise.resolve();
    });
    const consumer = new OutboxConsumer(
      database.transactions,
      repository,
      registry,
      { now: () => 30 },
      {
        leaseOwner: "worker-b",
        batchSize: 1,
        concurrency: 1,
        leaseDurationMs: 100,
        maxAttempts: 3,
        retryDelayMs: () => 1,
      },
    );
    expect(firstClaim).toHaveLength(1);
    expect(await consumer.runOnce()).toBe(1);
    expect(effects).toEqual(new Set(["job-1"]));
    expect(effectCalls).toBe(2);
    expect(
      database.transactions.run("read", ({ database: connection }) =>
        connection
          .prepare("SELECT status, attempt_count FROM outbox_events")
          .get(),
      ),
    ).toEqual({ status: "published", attempt_count: 2 });
    await database.close();
  });

  it("marks exhausted outbox delivery dead and exposes the operational count", async () => {
    const database = await createDatabase();
    const repository = new OutboxRepository({
      generate: () => "00000000-0000-4000-8000-000000000008",
    });
    database.transactions.run("immediate", (context) =>
      repository.enqueue(context, {
        topic: "missing.topic",
        aggregateType: "job",
        aggregateId: "job-dead",
        payload: { schemaVersion: 1 },
        availableAt: 10,
        createdAt: 10,
      }),
    );
    const consumer = new OutboxConsumer(
      database.transactions,
      repository,
      new OutboxHandlerRegistry(),
      { now: () => 10 },
      {
        leaseOwner: "dead-worker",
        batchSize: 1,
        concurrency: 1,
        leaseDurationMs: 100,
        maxAttempts: 1,
        retryDelayMs: () => 1,
      },
    );
    expect(await consumer.runOnce()).toBe(1);
    expect(
      database.transactions.run("read", ({ database: connection }) =>
        connection
          .prepare("SELECT status, last_error_code FROM outbox_events")
          .get(),
      ),
    ).toEqual({ status: "dead", last_error_code: "OUTBOX_HANDLER_MISSING" });
    expect(
      database.transactions.run("read", ({ database: connection }) =>
        connection
          .prepare(
            "SELECT COUNT(*) AS count FROM outbox_events WHERE status = 'dead'",
          )
          .get(),
      ),
    ).toEqual({ count: 1 });
    await database.close();
  });

  it("dead-letters a known handler after its configured attempts are exhausted", async () => {
    const database = await createDatabase();
    const repository = new OutboxRepository({
      generate: () => "00000000-0000-4000-8000-000000000009",
    });
    database.transactions.run("immediate", (context) =>
      repository.enqueue(context, {
        topic: "kernel.exhausted",
        aggregateType: "system",
        aggregateId: "exhausted",
        payload: { schemaVersion: 1 },
        availableAt: 10,
        createdAt: 10,
      }),
    );
    const registry = new OutboxHandlerRegistry();
    registry.register("kernel.exhausted", () =>
      Promise.reject(new Error("transient detail must not persist")),
    );
    const consumer = new OutboxConsumer(
      database.transactions,
      repository,
      registry,
      { now: () => 10 },
      {
        leaseOwner: "dead-letter-worker",
        batchSize: 1,
        concurrency: 1,
        leaseDurationMs: 100,
        maxAttempts: 2,
        retryDelayMs: () => 0,
      },
    );

    expect(await consumer.runOnce()).toBe(1);
    expect(await consumer.runOnce()).toBe(1);
    expect(
      database.transactions.run("read", ({ database: connection }) =>
        connection
          .prepare(
            "SELECT status, attempt_count, last_error_code FROM outbox_events",
          )
          .get(),
      ),
    ).toEqual({
      status: "dead",
      attempt_count: 2,
      last_error_code: "OUTBOX_HANDLER_FAILED",
    });
    await database.close();
  });
});
