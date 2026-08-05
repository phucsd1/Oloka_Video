import {
  canonicalizeJson,
  type JsonValue,
} from "../../kernel/canonical-json.js";
import type { IdGenerator } from "../../kernel/id-generator.js";
import type { TransactionContext } from "../database.js";

export interface ClaimedOutboxEvent {
  id: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: JsonValue;
  attemptCount: number;
}

export class OutboxRepository {
  constructor(private readonly idGenerator: IdGenerator) {}

  enqueue(
    context: TransactionContext,
    input: {
      topic: string;
      aggregateType: string;
      aggregateId: string;
      payload: JsonValue;
      availableAt: number;
      createdAt: number;
    },
  ): string {
    const id = this.idGenerator.generate();
    context.database
      .prepare(
        `INSERT INTO outbox_events
          (id, topic, aggregate_type, aggregate_id, payload_json, status, available_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        input.topic,
        input.aggregateType,
        input.aggregateId,
        canonicalizeJson(input.payload),
        input.availableAt,
        input.createdAt,
      );
    return id;
  }

  claimBatch(
    context: TransactionContext,
    input: {
      leaseOwner: string;
      now: number;
      leaseExpiresAt: number;
      limit: number;
    },
  ): ClaimedOutboxEvent[] {
    const rows = context.database
      .prepare(
        `SELECT id FROM outbox_events
         WHERE status = 'pending' AND available_at <= ?
         ORDER BY available_at, created_at, id LIMIT ?`,
      )
      .all(input.now, input.limit) as { id: string }[];
    const claimed: ClaimedOutboxEvent[] = [];
    const update = context.database.prepare(
      `UPDATE outbox_events SET status = 'processing', lease_owner = ?, lease_expires_at = ?,
       attempt_count = attempt_count + 1
       WHERE id = ? AND status = 'pending' AND available_at <= ?
       RETURNING id, topic, aggregate_type, aggregate_id, payload_json, attempt_count`,
    );
    for (const row of rows) {
      const value = update.get(
        input.leaseOwner,
        input.leaseExpiresAt,
        row.id,
        input.now,
      ) as
        | {
            id: string;
            topic: string;
            aggregate_type: string;
            aggregate_id: string;
            payload_json: string;
            attempt_count: number;
          }
        | undefined;
      if (value !== undefined) {
        claimed.push({
          id: value.id,
          topic: value.topic,
          aggregateType: value.aggregate_type,
          aggregateId: value.aggregate_id,
          payload: JSON.parse(value.payload_json) as JsonValue,
          attemptCount: value.attempt_count,
        });
      }
    }
    return claimed;
  }

  markPublished(
    context: TransactionContext,
    id: string,
    leaseOwner: string,
    now: number,
  ): void {
    this.guardedUpdate(
      context,
      `UPDATE outbox_events SET status = 'published', published_at = ?, lease_owner = NULL,
       lease_expires_at = NULL WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
      [now, id, leaseOwner],
    );
  }

  reschedule(
    context: TransactionContext,
    input: {
      id: string;
      leaseOwner: string;
      availableAt: number;
      errorCode: string;
    },
  ): void {
    this.guardedUpdate(
      context,
      `UPDATE outbox_events SET status = 'pending', available_at = ?, last_error_code = ?,
       lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
      [input.availableAt, input.errorCode, input.id, input.leaseOwner],
    );
  }

  markDead(
    context: TransactionContext,
    id: string,
    leaseOwner: string,
    errorCode: string,
  ): void {
    this.guardedUpdate(
      context,
      `UPDATE outbox_events SET status = 'dead', last_error_code = ?, lease_owner = NULL,
       lease_expires_at = NULL WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
      [errorCode, id, leaseOwner],
    );
  }

  releaseExpiredLease(
    context: TransactionContext,
    now: number,
    limit = 100,
  ): number {
    return Number(
      context.database
        .prepare(
          `UPDATE outbox_events SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL
           WHERE id IN (SELECT id FROM outbox_events WHERE status = 'processing'
           AND lease_expires_at <= ? ORDER BY lease_expires_at, id LIMIT ?)`,
        )
        .run(now, limit).changes,
    );
  }

  private guardedUpdate(
    context: TransactionContext,
    sql: string,
    values: (number | string)[],
  ): void {
    if (context.database.prepare(sql).run(...values).changes !== 1) {
      throw new Error("Outbox lease or state conflict");
    }
  }
}
