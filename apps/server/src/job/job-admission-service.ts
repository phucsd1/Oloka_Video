import type { AuthenticatedSession } from "../identity/identity-service.js";
import type {
  TransactionContext,
  TransactionRunner,
} from "../database/database.js";
import { AuditEventRepository } from "../database/repositories/audit-event-repository.js";
import { IdempotencyRepository } from "../database/repositories/idempotency-repository.js";
import { OutboxRepository } from "../database/repositories/outbox-repository.js";
import { ApplicationError } from "../http/application-error.js";
import {
  canonicalizeJson,
  sha256CanonicalJson,
} from "../kernel/canonical-json.js";
import type { Clock } from "../kernel/clock.js";
import type { IdGenerator } from "../kernel/id-generator.js";
import type { QuotaPolicyResolver } from "../quota/quota-policy.js";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface JobAdmissionServiceOptions {
  transactions: TransactionRunner;
  clock: Clock;
  idGenerator: IdGenerator;
  quotaPolicyResolver: QuotaPolicyResolver;
}

export type AdmittedJob = {
  schemaVersion: 1;
  id: string;
  projectId: string | null;
  type: "asset_ingestion";
  status: "queued";
  progressBasisPoints: number;
  currentStepKey: string | null;
  attemptCount: number;
  failureCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  version: number;
};

export class JobAdmissionService {
  private readonly audit: AuditEventRepository;
  private readonly idempotency: IdempotencyRepository;
  private readonly outbox: OutboxRepository;

  constructor(private readonly options: JobAdmissionServiceOptions) {
    this.audit = new AuditEventRepository(options.idGenerator);
    this.idempotency = new IdempotencyRepository(options.idGenerator);
    this.outbox = new OutboxRepository(options.idGenerator);
  }

  admitAssetIngestion(
    actor: AuthenticatedSession,
    input: { projectId: string; assetId: string },
    idempotencyKey: string,
  ): { job: AdmittedJob; replayed: boolean } {
    const now = this.options.clock.now();
    return this.options.transactions.run("immediate", (context) => {
      assertActiveActor(actor);
      const begin = this.idempotency.begin(context, {
        userId: actor.user.id,
        operation: "job.admit.asset_ingestion",
        idempotencyKey,
        semanticRequestHashSha256: sha256CanonicalJson({
          type: "asset_ingestion",
          projectId: input.projectId,
          assetId: input.assetId,
        }),
        createdAt: now,
        expiresAt: now + IDEMPOTENCY_TTL_MS,
      });
      if (begin.kind === "replay") {
        const response = begin.response as unknown as { job: AdmittedJob };
        return { job: response.job, replayed: true };
      }
      if (begin.kind === "conflict")
        throw new ApplicationError(
          "IDEMPOTENCY_CONFLICT",
          "job_admission_idempotency_conflict",
        );
      if (begin.kind === "in_progress")
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "job_admission_in_progress",
        );
      const job = this.admitAssetIngestionInTransaction(
        context,
        actor,
        input,
        now,
      );
      this.idempotency.complete(context, {
        recordId: begin.recordId,
        responseStatus: 201,
        response: { job },
        resourceId: job.id,
      });
      return { job, replayed: false };
    });
  }

  admitAssetIngestionInTransaction(
    context: TransactionContext,
    actor: AuthenticatedSession,
    input: { projectId: string; assetId: string },
    now = this.options.clock.now(),
  ): AdmittedJob {
    assertActiveActor(actor);
    const existing = context.database
      .prepare(
        `SELECT *
         FROM jobs
         WHERE type = 'asset_ingestion'
           AND json_extract(request_json, '$.assetId') = ?
           AND status NOT IN ('cancelled', 'completed', 'failed')
         ORDER BY created_at, id LIMIT 1`,
      )
      .get(input.assetId) as JobAdmissionRow | undefined;
    if (existing !== undefined) {
      if (
        existing.project_id !== input.projectId ||
        existing.status !== "queued" ||
        existing.progress_basis_points !== 0
      )
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "asset_ingestion_job_conflict",
        );
      return toAdmittedJob(existing);
    }
    this.assertAdmission(context, actor, input, now);
    const jobId = this.options.idGenerator.generate();
    const stepId = this.options.idGenerator.generate();
    context.database
      .prepare(
        `INSERT INTO jobs
          (id, project_id, owner_user_id, parent_job_id, type, status, priority,
           request_json, progress_basis_points, current_step_key, max_attempts,
           available_at, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'asset_ingestion', 'queued', 100, ?, 0,
                 'inspect_asset', 3, ?, ?, ?)`,
      )
      .run(
        jobId,
        input.projectId,
        actor.user.id,
        canonicalizeJson({ schemaVersion: 1, assetId: input.assetId }),
        now,
        now,
        now,
      );
    context.database
      .prepare(
        `INSERT INTO job_steps
          (id, job_id, parent_step_id, step_key, item_key, status, max_attempts,
           available_at, input_json, created_at, updated_at)
         VALUES (?, ?, NULL, 'inspect_asset', '', 'pending', 3, ?, ?, ?, ?)`,
      )
      .run(
        stepId,
        jobId,
        now,
        canonicalizeJson({ schemaVersion: 1, assetId: input.assetId }),
        now,
        now,
      );
    this.appendEvent(
      context,
      jobId,
      "job.queued",
      {
        schemaVersion: 1,
        jobId,
        status: "queued",
        progressBasisPoints: 0,
      },
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
      action: "job.admit",
      resourceType: "job",
      resourceId: jobId,
      outcome: "success",
      metadata: { jobType: "asset_ingestion", assetId: input.assetId },
      createdAt: now,
    });
    const row = context.database
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(jobId) as unknown as JobAdmissionRow;
    return toAdmittedJob(row);
  }

  reconcileProcessingAssets(): number {
    const now = this.options.clock.now();
    return this.options.transactions.run("immediate", (context) => {
      const rows = context.database
        .prepare(
          `SELECT a.id AS asset_id, a.project_id, a.owner_user_id,
                  u.email_normalized, u.display_name, u.avatar_url, u.role, u.version
           FROM assets a JOIN users u ON u.id = a.owner_user_id
           WHERE a.ingestion_status = 'processing' AND a.lifecycle_status = 'active'
           ORDER BY a.created_at, a.id`,
        )
        .all() as Array<{
        asset_id: string;
        project_id: string;
        owner_user_id: string;
        email_normalized: string;
        display_name: string;
        avatar_url: string | null;
        role: "member" | "admin";
        version: number;
      }>;
      let admitted = 0;
      for (const row of rows) {
        const existing = context.database
          .prepare(
            `SELECT 1 FROM jobs
             WHERE type = 'asset_ingestion'
               AND json_extract(request_json, '$.assetId') = ? LIMIT 1`,
          )
          .get(row.asset_id);
        if (existing !== undefined) continue;
        const actor = {
          sessionId: `system-reconcile-${row.asset_id}`,
          user: {
            id: row.owner_user_id,
            email: row.email_normalized,
            displayName: row.display_name,
            avatarUrl: row.avatar_url,
            role: row.role,
            status: "active" as const,
            version: row.version,
          },
        } satisfies AuthenticatedSession;
        this.admitAssetIngestionInTransaction(
          context,
          actor,
          { projectId: row.project_id, assetId: row.asset_id },
          now,
        );
        admitted += 1;
      }
      return admitted;
    });
  }

  private assertAdmission(
    context: TransactionContext,
    actor: AuthenticatedSession,
    input: { projectId: string; assetId: string },
    now: number,
  ): void {
    const project = context.database
      .prepare("SELECT owner_user_id, status FROM projects WHERE id = ?")
      .get(input.projectId) as
      | { owner_user_id: string; status: string }
      | undefined;
    if (project?.owner_user_id !== actor.user.id)
      throw new ApplicationError("RESOURCE_NOT_FOUND", "project_not_found");
    if (project.status !== "active")
      throw new ApplicationError(
        "RESOURCE_STATE_CONFLICT",
        "project_not_active",
      );
    const asset = context.database
      .prepare(
        "SELECT owner_user_id, project_id, ingestion_status, lifecycle_status FROM assets WHERE id = ?",
      )
      .get(input.assetId) as
      | {
          owner_user_id: string;
          project_id: string;
          ingestion_status: string;
          lifecycle_status: string;
        }
      | undefined;
    if (
      asset === undefined ||
      asset.owner_user_id !== actor.user.id ||
      asset.project_id !== input.projectId
    )
      throw new ApplicationError("RESOURCE_NOT_FOUND", "asset_not_found");
    if (
      asset.ingestion_status !== "processing" ||
      asset.lifecycle_status !== "active"
    )
      throw new ApplicationError(
        "RESOURCE_STATE_CONFLICT",
        "asset_not_ingestible",
      );
    const quota = this.options.quotaPolicyResolver.resolve({
      userId: actor.user.id,
      projectId: input.projectId,
      at: now,
    });
    const queued = context.database
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE owner_user_id = ? AND status IN ('queued','retry_scheduled')",
      )
      .get(actor.user.id) as { count: number };
    if (queued.count >= quota.maxQueuedJobsPerUser)
      throw new ApplicationError("QUOTA_EXCEEDED", "queued_job_limit");
  }

  private appendEvent(
    context: TransactionContext,
    jobId: string,
    type: string,
    payload: Record<string, string | number>,
    createdAt: number,
  ): void {
    const sequence = context.database
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM job_events WHERE job_id = ?",
      )
      .get(jobId) as { sequence: number };
    context.database
      .prepare(
        "INSERT INTO job_events (id, job_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        this.options.idGenerator.generate(),
        jobId,
        sequence.sequence,
        type,
        canonicalizeJson(payload),
        createdAt,
      );
  }
}

interface JobAdmissionRow {
  id: string;
  project_id: string | null;
  type: "asset_ingestion";
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

function toAdmittedJob(row: JobAdmissionRow): AdmittedJob {
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
