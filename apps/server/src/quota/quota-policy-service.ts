import {
  createQuotaPolicyRequestSchema,
  quotaPolicyListResponseSchema,
  quotaPolicySchema,
  quotaPolicyRecordSchema,
  type CreateQuotaPolicyRequest,
} from "@oloka/contracts";
import type { TransactionRunner } from "../database/database.js";
import { AuditEventRepository } from "../database/repositories/audit-event-repository.js";
import { IdempotencyRepository } from "../database/repositories/idempotency-repository.js";
import type { AuthenticatedSession } from "../identity/identity-service.js";
import { ApplicationError } from "../http/application-error.js";
import {
  canonicalizeJson,
  sha256CanonicalJson,
} from "../kernel/canonical-json.js";
import type { Clock } from "../kernel/clock.js";
import type { IdGenerator } from "../kernel/id-generator.js";

export class QuotaPolicyService {
  private readonly idempotency: IdempotencyRepository;
  private readonly audit: AuditEventRepository;

  constructor(
    private readonly transactions: TransactionRunner,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {
    this.idempotency = new IdempotencyRepository(idGenerator);
    this.audit = new AuditEventRepository(idGenerator);
  }

  list(): ReturnType<typeof quotaPolicyListResponseSchema.parse> {
    return this.transactions.run("read", ({ database }) => {
      const rows = database
        .prepare(
          `SELECT id, scope_type, scope_id, policy_json, effective_from,
                  effective_until, created_at, version
           FROM quota_policies ORDER BY scope_type, scope_id, effective_from DESC, id DESC LIMIT 101`,
        )
        .all() as unknown as PolicyRow[];
      return quotaPolicyListResponseSchema.parse({
        policies: rows.slice(0, 100).map(toPublicPolicy),
        nextCursor: null,
      });
    });
  }

  create(
    actor: AuthenticatedSession,
    request: CreateQuotaPolicyRequest,
    idempotencyKey: string,
  ): { policy: ReturnType<typeof toPublicPolicy>; replayed: boolean } {
    const parsed = createQuotaPolicyRequestSchema.parse(request);
    if (actor.user.role !== "admin" || actor.user.status !== "active")
      throw new ApplicationError(
        "AUTHORIZATION_DENIED",
        "administrator_role_required",
      );
    const effectiveFrom = Date.parse(parsed.effectiveFrom);
    const effectiveUntil =
      parsed.effectiveUntil === undefined || parsed.effectiveUntil === null
        ? null
        : Date.parse(parsed.effectiveUntil);
    if (effectiveUntil !== null && effectiveUntil <= effectiveFrom)
      throw new ApplicationError("VALIDATION_ERROR", "quota_interval_invalid");
    if (
      parsed.scopeType === "system" &&
      parsed.scopeId !== undefined &&
      parsed.scopeId !== null
    )
      throw new ApplicationError("VALIDATION_ERROR", "quota_scope_invalid");
    if (parsed.scopeType === "user" && parsed.scopeId === undefined)
      throw new ApplicationError("VALIDATION_ERROR", "quota_scope_invalid");
    const now = this.clock.now();
    return this.transactions.run("immediate", (context) => {
      const begin = this.idempotency.begin(context, {
        userId: actor.user.id,
        operation: "admin.quota_policy.create",
        idempotencyKey,
        semanticRequestHashSha256: sha256CanonicalJson(parsed),
        createdAt: now,
        expiresAt: now + 24 * 60 * 60 * 1000,
      });
      if (begin.kind === "replay")
        return {
          policy: (
            begin.response as { policy: ReturnType<typeof toPublicPolicy> }
          ).policy,
          replayed: true,
        };
      if (begin.kind === "conflict")
        throw new ApplicationError(
          "IDEMPOTENCY_CONFLICT",
          "quota_policy_idempotency_conflict",
        );
      if (begin.kind === "in_progress")
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "quota_policy_in_progress",
        );
      if (parsed.scopeType === "user") {
        const user = context.database
          .prepare("SELECT id FROM users WHERE id = ?")
          .get(parsed.scopeId ?? null);
        if (user === undefined)
          throw new ApplicationError(
            "RESOURCE_NOT_FOUND",
            "quota_user_not_found",
          );
      }
      const id = this.idGenerator.generate();
      try {
        context.database
          .prepare(
            `INSERT INTO quota_policies
              (id, scope_type, scope_id, policy_json, effective_from, effective_until,
               created_by_user_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            parsed.scopeType,
            parsed.scopeId ?? null,
            canonicalizeJson(parsed.policy),
            effectiveFrom,
            effectiveUntil,
            actor.user.id,
            now,
          );
      } catch (error) {
        if (error instanceof Error && /overlaps/i.test(error.message))
          throw new ApplicationError(
            "RESOURCE_STATE_CONFLICT",
            "quota_interval_overlap",
          );
        throw error;
      }
      const row = context.database
        .prepare("SELECT * FROM quota_policies WHERE id = ?")
        .get(id) as unknown as PolicyRow;
      const policy = toPublicPolicy(row);
      this.audit.append(context, {
        actorUserId: actor.user.id,
        actorType: "admin",
        action: "admin.quota_policy_create",
        resourceType: "quota_policy",
        resourceId: id,
        outcome: "success",
        metadata: {
          scopeType: parsed.scopeType,
          effectiveFrom: parsed.effectiveFrom,
          changedLimitKeys: Object.keys(parsed.policy.limits),
        },
        createdAt: now,
      });
      this.idempotency.complete(context, {
        recordId: begin.recordId,
        responseStatus: 201,
        response: { policy },
        resourceId: id,
      });
      return { policy, replayed: false };
    });
  }
}

interface PolicyRow {
  id: string;
  scope_type: "system" | "user";
  scope_id: string | null;
  policy_json: string;
  effective_from: number;
  effective_until: number | null;
  created_at: number;
  version: number;
}

function toPublicPolicy(row: PolicyRow) {
  return quotaPolicyRecordSchema.parse({
    schemaVersion: 1,
    id: row.id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    policy: quotaPolicySchema.parse(JSON.parse(row.policy_json) as unknown),
    effectiveFrom: new Date(row.effective_from).toISOString(),
    effectiveUntil:
      row.effective_until === null
        ? null
        : new Date(row.effective_until).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    version: row.version,
  });
}
