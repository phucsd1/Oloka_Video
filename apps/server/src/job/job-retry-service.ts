import type { Job } from "@oloka/contracts";
import type {
  TransactionContext,
  TransactionRunner,
} from "../database/database.js";
import { AuditEventRepository } from "../database/repositories/audit-event-repository.js";
import { IdempotencyRepository } from "../database/repositories/idempotency-repository.js";
import { OutboxRepository } from "../database/repositories/outbox-repository.js";
import type { AuthenticatedSession } from "../identity/identity-service.js";
import { ApplicationError } from "../http/application-error.js";
import {
  canonicalizeJson,
  sha256CanonicalJson,
  type JsonValue,
} from "../kernel/canonical-json.js";
import type { Clock } from "../kernel/clock.js";
import type { IdGenerator } from "../kernel/id-generator.js";
import type { QuotaPolicyResolver } from "../quota/quota-policy.js";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

type RetryTerminalStatus = "failed" | "cancelled" | "completed";
type JobType = Job["type"];

export interface JobRetryPlan {
  request: JsonValue;
  currentStepKey: string;
  maxAttempts: number;
  priority?: number;
  steps: readonly {
    stepKey: string;
    itemKey: string;
    maxAttempts: number;
    input: JsonValue;
  }[];
  reservation?: {
    resourceType: "generation" | "render";
    amount: number;
    expiresAt: number;
  };
}

export interface JobRetrySource {
  id: string;
  projectId: string | null;
  ownerUserId: string;
  type: JobType;
  status: RetryTerminalStatus;
  requestJson: string;
  version: number;
}

export interface JobRetryPolicy {
  readonly type: JobType;
  readonly terminalStatuses?: readonly RetryTerminalStatus[];
  plan(source: JobRetrySource, context: TransactionContext): JobRetryPlan;
}

export class JobRetryPolicyRegistry {
  private readonly policies = new Map<JobType, JobRetryPolicy>();

  constructor(policies: readonly JobRetryPolicy[]) {
    for (const policy of policies) {
      if (this.policies.has(policy.type))
        throw new Error(`Duplicate Job retry policy: ${policy.type}`);
      this.policies.set(policy.type, policy);
    }
  }

  get(type: JobType): JobRetryPolicy | undefined {
    return this.policies.get(type);
  }
}

export interface JobRetryServiceOptions {
  transactions: TransactionRunner;
  clock: Clock;
  idGenerator: IdGenerator;
  quotaPolicyResolver: QuotaPolicyResolver;
  policies: JobRetryPolicyRegistry;
}

export class JobRetryService {
  private readonly idempotency: IdempotencyRepository;
  private readonly outbox: OutboxRepository;
  private readonly audit: AuditEventRepository;

  constructor(private readonly options: JobRetryServiceOptions) {
    this.idempotency = new IdempotencyRepository(options.idGenerator);
    this.outbox = new OutboxRepository(options.idGenerator);
    this.audit = new AuditEventRepository(options.idGenerator);
  }

  retry(
    actor: AuthenticatedSession,
    sourceJobId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): { job: Job; replayed: boolean } {
    assertActiveActor(actor);
    const now = this.options.clock.now();
    return this.options.transactions.run("immediate", (context) => {
      const begin = this.idempotency.begin(context, {
        userId: actor.user.id,
        operation: `job.retry:${sourceJobId}`,
        idempotencyKey,
        semanticRequestHashSha256: sha256CanonicalJson({
          sourceJobId,
          expectedVersion,
        }),
        createdAt: now,
        expiresAt: now + IDEMPOTENCY_TTL_MS,
      });
      if (begin.kind === "replay")
        return {
          job: (begin.response as { job: Job }).job,
          replayed: true,
        };
      if (begin.kind === "conflict")
        throw new ApplicationError(
          "IDEMPOTENCY_CONFLICT",
          "job_retry_idempotency_conflict",
        );
      if (begin.kind === "in_progress")
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "job_retry_in_progress",
        );
      const row = context.database
        .prepare(
          `SELECT id, project_id, owner_user_id, type, status, request_json, version
           FROM jobs WHERE id = ? AND owner_user_id = ?`,
        )
        .get(sourceJobId, actor.user.id) as RetrySourceRow | undefined;
      if (row === undefined)
        throw new ApplicationError("RESOURCE_NOT_FOUND", "job_not_found");
      if (row.version !== expectedVersion)
        throw new ApplicationError("VERSION_CONFLICT", "job_version_stale");
      if (!isTerminalStatus(row.status))
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "job_retry_source_not_terminal",
        );
      const policy = this.options.policies.get(row.type);
      if (
        policy === undefined ||
        !(policy.terminalStatuses ?? ["failed"]).includes(row.status)
      )
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "job_retry_policy_unavailable",
        );
      if (row.project_id !== null) {
        const project = context.database
          .prepare("SELECT owner_user_id, status FROM projects WHERE id = ?")
          .get(row.project_id) as
          | { owner_user_id: string; status: string }
          | undefined;
        if (project?.owner_user_id !== actor.user.id)
          throw new ApplicationError("RESOURCE_NOT_FOUND", "project_not_found");
        if (project.status !== "active")
          throw new ApplicationError(
            "RESOURCE_STATE_CONFLICT",
            "project_not_active",
          );
      }
      const source: JobRetrySource = {
        id: row.id,
        projectId: row.project_id,
        ownerUserId: row.owner_user_id,
        type: row.type,
        status: row.status,
        requestJson: row.request_json,
        version: row.version,
      };
      const plan = policy.plan(source, context);
      if (plan.steps.length === 0)
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "job_retry_plan_empty",
        );
      if (row.project_id === null)
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "job_retry_project_required",
        );
      this.assertQuota(context, actor.user.id, row.project_id, row.type, now);
      const jobId = this.options.idGenerator.generate();
      context.database
        .prepare(
          `INSERT INTO jobs
            (id, project_id, owner_user_id, parent_job_id, type, status, priority,
             request_json, progress_basis_points, current_step_key, max_attempts,
             available_at, created_at, updated_at)
           VALUES (?, ?, ?, NULL, ?, 'queued', ?, ?, 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          jobId,
          row.project_id,
          actor.user.id,
          row.type,
          plan.priority ?? 100,
          canonicalizeJson(plan.request),
          plan.currentStepKey,
          plan.maxAttempts,
          now,
          now,
          now,
        );
      for (const step of plan.steps) {
        context.database
          .prepare(
            `INSERT INTO job_steps
              (id, job_id, parent_step_id, step_key, item_key, status,
               max_attempts, available_at, input_json, created_at, updated_at)
             VALUES (?, ?, NULL, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
          )
          .run(
            this.options.idGenerator.generate(),
            jobId,
            step.stepKey,
            step.itemKey,
            step.maxAttempts,
            now,
            canonicalizeJson(step.input),
            now,
            now,
          );
      }
      if (plan.reservation !== undefined) {
        context.database
          .prepare(
            `INSERT INTO quota_reservations
              (id,user_id,project_id,resource_type,resource_id,amount,status,
               expires_at,created_at,updated_at,version)
             VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, 1)`,
          )
          .run(
            this.options.idGenerator.generate(),
            actor.user.id,
            row.project_id,
            plan.reservation.resourceType,
            jobId,
            plan.reservation.amount,
            plan.reservation.expiresAt,
            now,
            now,
          );
      }
      context.database
        .prepare(
          `INSERT INTO job_events (id,job_id,sequence,type,payload_json,created_at)
           VALUES (?, ?, 1, 'job.queued', ?, ?)`,
        )
        .run(
          this.options.idGenerator.generate(),
          jobId,
          canonicalizeJson({
            schemaVersion: 1,
            jobId,
            status: "queued",
            progressBasisPoints: 0,
          }),
          now,
        );
      this.outbox.enqueue(context, {
        topic: "job.dispatch.requested",
        aggregateType: "job",
        aggregateId: jobId,
        payload: { schemaVersion: 1, jobId },
        availableAt: now,
        createdAt: now,
      });
      this.audit.append(context, {
        actorUserId: actor.user.id,
        actorType: actor.user.role === "admin" ? "admin" : "user",
        action: "job.retry_admit",
        resourceType: "job",
        resourceId: jobId,
        outcome: "success",
        metadata: { sourceJobId, jobType: row.type },
        createdAt: now,
      });
      const job = toPublicJob(
        context.database
          .prepare("SELECT * FROM jobs WHERE id = ?")
          .get(jobId) as PublicJobRow | undefined,
      );
      this.idempotency.complete(context, {
        recordId: begin.recordId,
        responseStatus: 201,
        response: { job },
        resourceId: jobId,
      });
      return { job, replayed: false };
    });
  }

  private assertQuota(
    context: TransactionContext,
    userId: string,
    projectId: string,
    type: JobType,
    now: number,
  ): void {
    const quota = this.options.quotaPolicyResolver.resolve({
      userId,
      projectId,
      at: now,
    });
    const queued = context.database
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE owner_user_id = ? AND status IN ('queued','retry_scheduled')",
      )
      .get(userId) as { count: number };
    if (queued.count >= quota.maxQueuedJobsPerUser)
      throw new ApplicationError("QUOTA_EXCEEDED", "queued_job_limit");
    if (type === "generation") {
      const active = countActive(context, userId, "generation");
      if (active >= quota.maxActiveGenerationPerUser)
        throw new ApplicationError("QUOTA_EXCEEDED", "active_generation_limit");
    }
    if (type === "render") {
      const active = countActive(context, userId, "render");
      if (active >= quota.maxActiveRenderPerUser)
        throw new ApplicationError("QUOTA_EXCEEDED", "active_render_limit");
      const system = context.database
        .prepare(
          "SELECT COUNT(*) AS count FROM jobs WHERE type = 'render' AND status IN ('running','waiting_provider')",
        )
        .get() as { count: number };
      if (system.count >= quota.maxActiveRenderSystemDev)
        throw new ApplicationError(
          "QUOTA_EXCEEDED",
          "active_render_system_limit",
        );
    }
  }
}

interface RetrySourceRow {
  id: string;
  project_id: string | null;
  owner_user_id: string;
  type: JobType;
  status: string;
  request_json: string;
  version: number;
}

interface PublicJobRow {
  id: string;
  project_id: string | null;
  type: JobType;
  status: "queued";
  progress_basis_points: number;
  current_step_key: string | null;
  attempt_count: number;
  failure_code: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
  version: number;
}

function isTerminalStatus(value: string): value is RetryTerminalStatus {
  return value === "failed" || value === "cancelled" || value === "completed";
}

function countActive(
  context: TransactionContext,
  userId: string,
  type: "generation" | "render",
): number {
  return (
    context.database
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE owner_user_id = ? AND type = ? AND status IN ('running','waiting_provider')",
      )
      .get(userId, type) as { count: number }
  ).count;
}

function toPublicJob(row: PublicJobRow | undefined): Job {
  if (row === undefined) throw new Error("Retried Job missing after admission");
  return {
    schemaVersion: 1,
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    status: row.status,
    progressBasisPoints: row.progress_basis_points,
    currentStepKey: row.current_step_key,
    attemptCount: row.attempt_count,
    failureCode: row.failure_code,
    createdAt: new Date(row.created_at).toISOString(),
    startedAt:
      row.started_at === null ? null : new Date(row.started_at).toISOString(),
    finishedAt:
      row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    version: row.version,
  };
}

function assertActiveActor(actor: AuthenticatedSession): void {
  if (actor.user.status === "active") return;
  const code =
    actor.user.status === "pending"
      ? "ACCOUNT_PENDING"
      : actor.user.status === "disabled"
        ? "ACCOUNT_DISABLED"
        : "ACCOUNT_REJECTED";
  throw new ApplicationError(code, "account_not_active");
}
