import {
  canonicalizeJson,
  type JsonValue,
} from "../../kernel/canonical-json.js";
import type { IdGenerator } from "../../kernel/id-generator.js";
import type { TransactionContext } from "../database.js";

const FORBIDDEN_AUDIT_KEYS = new Set([
  "password",
  "secret",
  "token",
  "auth",
  "cookie",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "pkceverifier",
  "csrftoken",
  "storagekey",
  "filesystempath",
  "prompt",
  "rawproviderpayload",
  "stack",
]);

export interface AppendAuditEventInput {
  actorUserId?: string;
  actorType: "user" | "admin" | "system";
  action: string;
  resourceType: string;
  resourceId?: string;
  outcome: "success" | "denied" | "failed";
  metadata: JsonValue;
  createdAt: number;
}

export class AuditEventRepository {
  constructor(private readonly idGenerator: IdGenerator) {}

  append(context: TransactionContext, input: AppendAuditEventInput): string {
    assertSafeAuditMetadata(input.metadata);
    const id = this.idGenerator.generate();
    const sequenceRow = context.database
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM audit_events",
      )
      .get() as { sequence: number };
    context.database
      .prepare(
        `INSERT INTO audit_events
          (id, sequence, actor_user_id, actor_type, action, resource_type, resource_id, outcome, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sequenceRow.sequence,
        input.actorUserId ?? null,
        input.actorType,
        input.action,
        input.resourceType,
        input.resourceId ?? null,
        input.outcome,
        canonicalizeJson(input.metadata),
        input.createdAt,
      );
    return id;
  }
}

export function assertSafeAuditMetadata(value: JsonValue): void {
  visit(value);
}

function visit(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (
        [...FORBIDDEN_AUDIT_KEYS].some((forbidden) =>
          normalized.includes(forbidden),
        )
      ) {
        throw new Error("Audit metadata contains a forbidden field");
      }
      visit(child);
    }
  }
}
