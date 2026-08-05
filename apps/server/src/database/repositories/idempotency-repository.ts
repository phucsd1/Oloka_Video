import { createHash } from "node:crypto";
import {
  canonicalizeJson,
  type JsonValue,
} from "../../kernel/canonical-json.js";
import type { IdGenerator } from "../../kernel/id-generator.js";
import type { TransactionContext } from "../database.js";

export type IdempotencyBeginResult =
  | { kind: "started"; recordId: string }
  | {
      kind: "replay";
      responseStatus: number;
      response: JsonValue;
      resourceId?: string;
    }
  | { kind: "in_progress" }
  | { kind: "retryable"; recordId: string }
  | { kind: "conflict" };

export class IdempotencyRepository {
  constructor(private readonly idGenerator: IdGenerator) {}

  begin(
    context: TransactionContext,
    input: {
      userId: string;
      operation: string;
      idempotencyKey: string;
      semanticRequestHashSha256: string;
      createdAt: number;
      expiresAt: number;
    },
  ): IdempotencyBeginResult {
    const keyHash = hashKey(input.idempotencyKey);
    const existing = context.database
      .prepare(
        `SELECT id, semantic_request_hash_sha256, status, response_status, response_json, resource_id
         FROM idempotency_records
         WHERE user_id = ? AND operation = ? AND idempotency_key_hash_sha256 = ?`,
      )
      .get(input.userId, input.operation, keyHash) as
      | {
          id: string;
          semantic_request_hash_sha256: string;
          status: "in_progress" | "completed" | "failed_retryable";
          response_status: number | null;
          response_json: string | null;
          resource_id: string | null;
        }
      | undefined;
    if (existing !== undefined) {
      if (
        existing.semantic_request_hash_sha256 !==
        input.semanticRequestHashSha256
      ) {
        return { kind: "conflict" };
      }
      if (existing.status === "completed") {
        return {
          kind: "replay",
          responseStatus: existing.response_status as number,
          response: JSON.parse(existing.response_json as string) as JsonValue,
          ...(existing.resource_id === null
            ? {}
            : { resourceId: existing.resource_id }),
        };
      }
      return existing.status === "in_progress"
        ? { kind: "in_progress" }
        : { kind: "retryable", recordId: existing.id };
    }
    const recordId = this.idGenerator.generate();
    context.database
      .prepare(
        `INSERT INTO idempotency_records
          (id, user_id, operation, idempotency_key_hash_sha256, semantic_request_hash_sha256, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?)`,
      )
      .run(
        recordId,
        input.userId,
        input.operation,
        keyHash,
        input.semanticRequestHashSha256,
        input.createdAt,
        input.expiresAt,
      );
    return { kind: "started", recordId };
  }

  replay(
    context: TransactionContext,
    recordId: string,
  ): IdempotencyBeginResult | undefined {
    const row = context.database
      .prepare(
        "SELECT response_status, response_json, resource_id FROM idempotency_records WHERE id = ? AND status = 'completed'",
      )
      .get(recordId) as
      | {
          response_status: number;
          response_json: string;
          resource_id: string | null;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          kind: "replay",
          responseStatus: row.response_status,
          response: JSON.parse(row.response_json) as JsonValue,
          ...(row.resource_id === null ? {} : { resourceId: row.resource_id }),
        };
  }

  complete(
    context: TransactionContext,
    input: {
      recordId: string;
      responseStatus: number;
      response: JsonValue;
      resourceId?: string;
    },
  ): void {
    const result = context.database
      .prepare(
        `UPDATE idempotency_records
         SET status = 'completed', response_status = ?, response_json = ?, resource_id = ?
         WHERE id = ? AND status IN ('in_progress', 'failed_retryable')`,
      )
      .run(
        input.responseStatus,
        canonicalizeJson(input.response),
        input.resourceId ?? null,
        input.recordId,
      );
    if (result.changes !== 1)
      throw new Error("Idempotency completion conflict");
  }

  markRetryableFailure(context: TransactionContext, recordId: string): void {
    const result = context.database
      .prepare(
        `UPDATE idempotency_records SET status = 'failed_retryable',
         response_status = NULL, response_json = NULL, resource_id = NULL
         WHERE id = ? AND status = 'in_progress'`,
      )
      .run(recordId);
    if (result.changes !== 1)
      throw new Error("Idempotency failure transition conflict");
  }

  cleanup(context: TransactionContext, now: number, limit = 100): number {
    return Number(
      context.database
        .prepare(
          `DELETE FROM idempotency_records WHERE id IN
           (SELECT id FROM idempotency_records WHERE expires_at <= ? ORDER BY expires_at, id LIMIT ?)`,
        )
        .run(now, limit).changes,
    );
  }
}

function hashKey(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}
