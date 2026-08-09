import type { TransactionContext } from "../database/database.js";
import { OutboxRepository } from "../database/repositories/outbox-repository.js";
import { AuditEventRepository } from "../database/repositories/audit-event-repository.js";
import { canonicalizeJson, type JsonValue } from "../kernel/canonical-json.js";
import type { IdGenerator } from "../kernel/id-generator.js";
import { ApplicationError } from "../http/application-error.js";

export interface ClaimedJob {
  jobId: string;
  stepId: string;
  type: "asset_ingestion";
  assetId: string;
  leaseOwner: string;
  leaseExpiresAt: number;
  jobVersion: number;
  stepVersion: number;
  attemptCount: number;
  heartbeat?: () => void;
}

export interface ReconcileResult {
  requeued: number;
  retried: number;
  cancelled: number;
}

export interface ClaimedCancellationCleanup {
  jobId: string;
  leaseOwner: string;
  leaseExpiresAt: number;
  jobVersion: number;
}

export interface ClaimedProviderReconciliation {
  jobId: string;
  stepId: string;
  leaseOwner: string;
  leaseExpiresAt: number;
  jobVersion: number;
  stepVersion: number;
  submissionState: "accepted" | "outcome_unknown";
  operationId: string | null;
  idempotencyKeyHashSha256: string;
}

export interface AssetIngestionFailureInput {
  jobId: string;
  stepId: string;
  assetId: string;
  leaseOwner: string;
  expectedJobVersion: number;
  expectedStepVersion: number;
  now: number;
  failureCode: string;
  retryable: boolean;
}

export class JobRepository {
  private readonly outbox: OutboxRepository;
  private readonly audit: AuditEventRepository;

  constructor(private readonly idGenerator: IdGenerator) {
    this.outbox = new OutboxRepository(idGenerator);
    this.audit = new AuditEventRepository(idGenerator);
  }

  claimNext(
    context: TransactionContext,
    input: { leaseOwner: string; now: number; leaseDurationMs: number },
  ): ClaimedJob | null {
    const candidate = context.database
      .prepare(
        `WITH candidate AS MATERIALIZED (
           SELECT id, type, request_json, version, attempt_count
           FROM jobs INDEXED BY jobs_claim_idx
           WHERE type = 'asset_ingestion' AND status = 'queued' AND available_at <= ?
           ORDER BY priority ASC, available_at ASC, created_at ASC, id ASC
           LIMIT 1
         )
         SELECT j.id AS job_id, j.type, j.request_json, j.version AS job_version,
                j.attempt_count, s.id AS step_id, s.version AS step_version
         FROM candidate j
         JOIN job_steps s ON s.job_id = j.id AND s.parent_step_id IS NULL
         WHERE s.status = 'pending' AND s.available_at <= ?
         LIMIT 1`,
      )
      .get(input.now, input.now) as
      | {
          job_id: string;
          type: string;
          request_json: string;
          job_version: number;
          attempt_count: number;
          step_id: string;
          step_version: number;
        }
      | undefined;
    if (candidate === undefined) return null;
    if (candidate.type !== "asset_ingestion") return null;
    const request = parseAssetIngestionRequest(candidate.request_json);
    const leaseExpiresAt = input.now + input.leaseDurationMs;
    const jobUpdate = context.database
      .prepare(
        `UPDATE jobs SET status = 'running', attempt_count = attempt_count + 1,
           lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?,
           started_at = COALESCE(started_at, ?), updated_at = ?, version = version + 1
         WHERE id = ? AND status = 'queued' AND available_at <= ? AND version = ?`,
      )
      .run(
        input.leaseOwner,
        leaseExpiresAt,
        input.now,
        input.now,
        input.now,
        candidate.job_id,
        input.now,
        candidate.job_version,
      );
    if (jobUpdate.changes !== 1) return null;
    const stepUpdate = context.database
      .prepare(
        `UPDATE job_steps SET status = 'running', attempt_count = attempt_count + 1,
           lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?,
           started_at = COALESCE(started_at, ?), updated_at = ?, version = version + 1
         WHERE id = ? AND job_id = ? AND status = 'pending' AND available_at <= ? AND version = ?`,
      )
      .run(
        input.leaseOwner,
        leaseExpiresAt,
        input.now,
        input.now,
        input.now,
        candidate.step_id,
        candidate.job_id,
        input.now,
        candidate.step_version,
      );
    if (stepUpdate.changes !== 1)
      throw new Error("JobStep claim conflict after Job claim");
    this.appendEvent(context, {
      jobId: candidate.job_id,
      type: "job.started",
      payload: {
        schemaVersion: 1,
        jobId: candidate.job_id,
        status: "running",
        attempt: candidate.attempt_count + 1,
      },
      createdAt: input.now,
    });
    this.appendEvent(context, {
      jobId: candidate.job_id,
      type: "step.started",
      payload: {
        schemaVersion: 1,
        jobId: candidate.job_id,
        stepId: candidate.step_id,
        status: "running",
      },
      createdAt: input.now,
    });
    this.outbox.enqueue(context, {
      topic: "job.state.changed",
      aggregateType: "job",
      aggregateId: candidate.job_id,
      payload: { schemaVersion: 1, jobId: candidate.job_id, status: "running" },
      availableAt: input.now,
      createdAt: input.now,
    });
    return {
      jobId: candidate.job_id,
      stepId: candidate.step_id,
      type: "asset_ingestion",
      assetId: request.assetId,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt,
      jobVersion: candidate.job_version + 1,
      stepVersion: candidate.step_version + 1,
      attemptCount: candidate.attempt_count + 1,
    };
  }

  claimCancellationCleanup(
    context: TransactionContext,
    input: { leaseOwner: string; now: number; leaseDurationMs: number },
  ): ClaimedCancellationCleanup | null {
    const candidate = context.database
      .prepare(
        `SELECT id, version FROM jobs
         WHERE status = 'cancel_requested'
           AND (lease_owner IS NULL OR lease_expires_at <= ?)
         ORDER BY cancel_requested_at, created_at, id LIMIT 1`,
      )
      .get(input.now) as { id: string; version: number } | undefined;
    if (candidate === undefined) return null;
    const leaseExpiresAt = input.now + input.leaseDurationMs;
    const update = context.database
      .prepare(
        `UPDATE jobs SET lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?,
           updated_at = ?, version = version + 1
         WHERE id = ? AND status = 'cancel_requested'
           AND (lease_owner IS NULL OR lease_expires_at <= ?) AND version = ?`,
      )
      .run(
        input.leaseOwner,
        leaseExpiresAt,
        input.now,
        input.now,
        candidate.id,
        input.now,
        candidate.version,
      );
    if (update.changes !== 1) return null;
    return {
      jobId: candidate.id,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt,
      jobVersion: candidate.version + 1,
    };
  }

  completeCancellationCleanup(
    context: TransactionContext,
    input: {
      jobId: string;
      leaseOwner: string;
      expectedJobVersion: number;
      now: number;
    },
  ): number {
    const job = context.database
      .prepare(
        `UPDATE jobs SET status = 'cancelled', finished_at = ?, lease_owner = NULL,
           lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ?,
           version = version + 1
         WHERE id = ? AND status = 'cancel_requested' AND lease_owner = ?
           AND lease_expires_at > ? AND version = ?`,
      )
      .run(
        input.now,
        input.now,
        input.jobId,
        input.leaseOwner,
        input.now,
        input.expectedJobVersion,
      );
    if (job.changes !== 1) throw leaseConflict();
    context.database
      .prepare(
        `UPDATE job_steps SET status = 'cancelled', completed_at = ?,
           lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
           updated_at = ?, version = version + 1
         WHERE job_id = ? AND status IN ('pending','running','waiting_provider','retry_scheduled')`,
      )
      .run(input.now, input.now, input.jobId);
    this.appendEvent(context, {
      jobId: input.jobId,
      type: "job.cancelled",
      payload: {
        schemaVersion: 1,
        jobId: input.jobId,
        status: "cancelled",
      },
      createdAt: input.now,
    });
    this.outbox.enqueue(context, {
      topic: "job.state.changed",
      aggregateType: "job",
      aggregateId: input.jobId,
      payload: {
        schemaVersion: 1,
        jobId: input.jobId,
        status: "cancelled",
      },
      availableAt: input.now,
      createdAt: input.now,
    });
    return input.expectedJobVersion + 1;
  }

  claimWaitingProvider(
    context: TransactionContext,
    input: { leaseOwner: string; now: number; leaseDurationMs: number },
  ): ClaimedProviderReconciliation | null {
    const candidate = context.database
      .prepare(
        `SELECT j.id AS job_id, j.version AS job_version,
                s.id AS step_id, s.version AS step_version,
                s.provider_submission_state, s.provider_operation_id,
                s.provider_idempotency_key_hash_sha256
         FROM jobs j
         JOIN job_steps s ON s.job_id = j.id AND s.parent_step_id IS NULL
         WHERE j.status = 'waiting_provider' AND s.status = 'waiting_provider'
           AND (j.lease_owner IS NULL OR j.lease_expires_at <= ?)
           AND (s.lease_owner IS NULL OR s.lease_expires_at <= ?)
           AND (
             (s.provider_submission_state = 'accepted' AND s.provider_operation_id IS NOT NULL)
             OR
             (s.provider_submission_state = 'outcome_unknown'
              AND s.provider_operation_id IS NULL
              AND s.provider_idempotency_key_hash_sha256 IS NOT NULL)
           )
         ORDER BY j.updated_at, j.id LIMIT 1`,
      )
      .get(input.now, input.now) as
      | {
          job_id: string;
          job_version: number;
          step_id: string;
          step_version: number;
          provider_submission_state: "accepted" | "outcome_unknown";
          provider_operation_id: string | null;
          provider_idempotency_key_hash_sha256: string;
        }
      | undefined;
    if (candidate === undefined) return null;
    const leaseExpiresAt = input.now + input.leaseDurationMs;
    const job = context.database
      .prepare(
        `UPDATE jobs SET lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?,
           updated_at = ?, version = version + 1
         WHERE id = ? AND status = 'waiting_provider'
           AND (lease_owner IS NULL OR lease_expires_at <= ?) AND version = ?`,
      )
      .run(
        input.leaseOwner,
        leaseExpiresAt,
        input.now,
        input.now,
        candidate.job_id,
        input.now,
        candidate.job_version,
      );
    if (job.changes !== 1) return null;
    const step = context.database
      .prepare(
        `UPDATE job_steps SET lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?,
           updated_at = ?, version = version + 1
         WHERE id = ? AND job_id = ? AND status = 'waiting_provider'
           AND (lease_owner IS NULL OR lease_expires_at <= ?) AND version = ?`,
      )
      .run(
        input.leaseOwner,
        leaseExpiresAt,
        input.now,
        input.now,
        candidate.step_id,
        candidate.job_id,
        input.now,
        candidate.step_version,
      );
    if (step.changes !== 1)
      throw new Error(
        "Provider reconciliation Step claim conflict after Job claim",
      );
    return {
      jobId: candidate.job_id,
      stepId: candidate.step_id,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt,
      jobVersion: candidate.job_version + 1,
      stepVersion: candidate.step_version + 1,
      submissionState: candidate.provider_submission_state,
      operationId: candidate.provider_operation_id,
      idempotencyKeyHashSha256: candidate.provider_idempotency_key_hash_sha256,
    };
  }

  recordProviderLookupFound(
    context: TransactionContext,
    input: {
      jobId: string;
      stepId: string;
      leaseOwner: string;
      expectedStepVersion: number;
      operationId: string;
      now: number;
    },
  ): number {
    const step = context.database
      .prepare(
        `UPDATE job_steps SET provider_submission_state = 'accepted',
           provider_operation_id = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND job_id = ? AND status = 'waiting_provider'
           AND provider_submission_state = 'outcome_unknown'
           AND provider_operation_id IS NULL AND lease_owner = ?
           AND lease_expires_at > ? AND version = ?`,
      )
      .run(
        input.operationId,
        input.now,
        input.stepId,
        input.jobId,
        input.leaseOwner,
        input.now,
        input.expectedStepVersion,
      );
    if (step.changes !== 1) throw leaseConflict();
    return input.expectedStepVersion + 1;
  }

  releaseWaitingProvider(
    context: TransactionContext,
    input: {
      jobId: string;
      stepId: string;
      leaseOwner: string;
      expectedJobVersion: number;
      expectedStepVersion: number;
      now: number;
    },
  ): { jobVersion: number; stepVersion: number } {
    const job = context.database
      .prepare(
        `UPDATE jobs SET lease_owner = NULL, lease_expires_at = NULL,
           heartbeat_at = NULL, updated_at = ?, version = version + 1
         WHERE id = ? AND status = 'waiting_provider' AND lease_owner = ?
           AND lease_expires_at > ? AND version = ?`,
      )
      .run(
        input.now,
        input.jobId,
        input.leaseOwner,
        input.now,
        input.expectedJobVersion,
      );
    if (job.changes !== 1) throw leaseConflict();
    const step = context.database
      .prepare(
        `UPDATE job_steps SET lease_owner = NULL, lease_expires_at = NULL,
           heartbeat_at = NULL, updated_at = ?, version = version + 1
         WHERE id = ? AND job_id = ? AND status = 'waiting_provider'
           AND lease_owner = ? AND lease_expires_at > ? AND version = ?`,
      )
      .run(
        input.now,
        input.stepId,
        input.jobId,
        input.leaseOwner,
        input.now,
        input.expectedStepVersion,
      );
    if (step.changes !== 1) throw leaseConflict();
    return {
      jobVersion: input.expectedJobVersion + 1,
      stepVersion: input.expectedStepVersion + 1,
    };
  }

  heartbeat(
    context: TransactionContext,
    input: {
      jobId: string;
      stepId: string;
      leaseOwner: string;
      expectedJobVersion: number;
      expectedStepVersion: number;
      now: number;
      leaseDurationMs: number;
    },
  ): { jobVersion: number; stepVersion: number; leaseExpiresAt: number } {
    const leaseExpiresAt = input.now + input.leaseDurationMs;
    const job = context.database
      .prepare(
        `UPDATE jobs SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?,
           version = version + 1
         WHERE id = ? AND status = 'running' AND lease_owner = ?
           AND lease_expires_at > ? AND version = ?`,
      )
      .run(
        input.now,
        leaseExpiresAt,
        input.now,
        input.jobId,
        input.leaseOwner,
        input.now,
        input.expectedJobVersion,
      );
    if (job.changes !== 1) throw leaseConflict();
    const step = context.database
      .prepare(
        `UPDATE job_steps SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?,
           version = version + 1
         WHERE id = ? AND job_id = ? AND status = 'running' AND lease_owner = ?
           AND lease_expires_at > ? AND version = ?`,
      )
      .run(
        input.now,
        leaseExpiresAt,
        input.now,
        input.stepId,
        input.jobId,
        input.leaseOwner,
        input.now,
        input.expectedStepVersion,
      );
    if (step.changes !== 1) throw leaseConflict();
    return {
      jobVersion: input.expectedJobVersion + 1,
      stepVersion: input.expectedStepVersion + 1,
      leaseExpiresAt,
    };
  }

  reportProgress(
    context: TransactionContext,
    input: {
      jobId: string;
      stepId: string;
      leaseOwner: string;
      expectedJobVersion: number;
      expectedStepVersion: number;
      progressBasisPoints: number;
      now: number;
    },
  ): { jobVersion: number; stepVersion: number } {
    if (
      !Number.isInteger(input.progressBasisPoints) ||
      input.progressBasisPoints < 0 ||
      input.progressBasisPoints >= 10_000
    )
      throw new ApplicationError("VALIDATION_ERROR", "job_progress_invalid");
    const current = context.database
      .prepare(
        `SELECT j.progress_basis_points, j.version AS job_version,
                s.version AS step_version
         FROM jobs j JOIN job_steps s ON s.id = ? AND s.job_id = j.id
         WHERE j.id = ? AND j.status = 'running' AND s.status = 'running'
           AND j.lease_owner = ? AND s.lease_owner = ?
           AND j.lease_expires_at > ? AND s.lease_expires_at > ?`,
      )
      .get(
        input.stepId,
        input.jobId,
        input.leaseOwner,
        input.leaseOwner,
        input.now,
        input.now,
      ) as
      | {
          progress_basis_points: number;
          job_version: number;
          step_version: number;
        }
      | undefined;
    if (
      current === undefined ||
      current.job_version !== input.expectedJobVersion ||
      current.step_version !== input.expectedStepVersion
    )
      throw leaseConflict();
    if (input.progressBasisPoints <= current.progress_basis_points) {
      return {
        jobVersion: current.job_version,
        stepVersion: current.step_version,
      };
    }
    const update = context.database
      .prepare(
        `UPDATE jobs SET progress_basis_points = ?, updated_at = ?,
           version = version + 1
         WHERE id = ? AND version = ? AND status = 'running'
           AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(
        input.progressBasisPoints,
        input.now,
        input.jobId,
        input.expectedJobVersion,
        input.leaseOwner,
        input.now,
      );
    if (update.changes !== 1) throw leaseConflict();
    this.appendEvent(context, {
      jobId: input.jobId,
      type: "job.progress",
      payload: {
        schemaVersion: 1,
        jobId: input.jobId,
        stepId: input.stepId,
        progressBasisPoints: input.progressBasisPoints,
      },
      createdAt: input.now,
    });
    return {
      jobVersion: input.expectedJobVersion + 1,
      stepVersion: input.expectedStepVersion,
    };
  }

  recordProviderSubmissionIntent(
    context: TransactionContext,
    input: {
      stepId: string;
      jobId: string;
      leaseOwner: string;
      expectedVersion: number;
      now: number;
      requestHashSha256: string;
      idempotencyKeyHashSha256: string;
    },
  ): number {
    const update = context.database
      .prepare(
        `UPDATE job_steps SET provider_submission_state = 'requested',
           provider_request_hash_sha256 = ?, provider_idempotency_key_hash_sha256 = ?,
           provider_submission_attempt = provider_submission_attempt + 1,
           updated_at = ?, version = version + 1
         WHERE id = ? AND job_id = ? AND status = 'running' AND lease_owner = ?
           AND lease_expires_at > ? AND version = ?
           AND provider_submission_state IS NULL`,
      )
      .run(
        input.requestHashSha256,
        input.idempotencyKeyHashSha256,
        input.now,
        input.stepId,
        input.jobId,
        input.leaseOwner,
        input.now,
        input.expectedVersion,
      );
    if (update.changes !== 1) throw leaseConflict();
    return input.expectedVersion + 1;
  }

  recordProviderAccepted(
    context: TransactionContext,
    input: {
      stepId: string;
      jobId: string;
      leaseOwner: string;
      expectedVersion: number;
      now: number;
      operationId: string;
    },
  ): number {
    const update = context.database
      .prepare(
        `UPDATE job_steps SET provider_submission_state = 'accepted',
           provider_operation_id = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND job_id = ? AND status = 'running' AND lease_owner = ?
           AND lease_expires_at > ? AND version = ?
           AND provider_submission_state = 'requested'`,
      )
      .run(
        input.operationId,
        input.now,
        input.stepId,
        input.jobId,
        input.leaseOwner,
        input.now,
        input.expectedVersion,
      );
    if (update.changes !== 1) throw leaseConflict();
    return input.expectedVersion + 1;
  }

  recordProviderOutcomeUnknown(
    context: TransactionContext,
    input: {
      stepId: string;
      jobId: string;
      leaseOwner: string;
      expectedVersion: number;
      now: number;
    },
  ): number {
    const update = context.database
      .prepare(
        `UPDATE job_steps SET provider_submission_state = 'outcome_unknown',
           updated_at = ?, version = version + 1
         WHERE id = ? AND job_id = ? AND status = 'running' AND lease_owner = ?
           AND lease_expires_at > ? AND version = ?
           AND provider_submission_state = 'requested'`,
      )
      .run(
        input.now,
        input.stepId,
        input.jobId,
        input.leaseOwner,
        input.now,
        input.expectedVersion,
      );
    if (update.changes !== 1) throw leaseConflict();
    return input.expectedVersion + 1;
  }

  markWaitingProvider(
    context: TransactionContext,
    input: {
      jobId: string;
      stepId: string;
      leaseOwner: string;
      expectedJobVersion: number;
      expectedStepVersion: number;
      now: number;
    },
  ): { jobVersion: number; stepVersion: number } {
    const job = context.database
      .prepare(
        `UPDATE jobs SET status = 'waiting_provider', updated_at = ?,
           version = version + 1
         WHERE id = ? AND status = 'running' AND lease_owner = ?
           AND lease_expires_at > ? AND version = ?`,
      )
      .run(
        input.now,
        input.jobId,
        input.leaseOwner,
        input.now,
        input.expectedJobVersion,
      );
    if (job.changes !== 1) throw leaseConflict();
    const step = context.database
      .prepare(
        `UPDATE job_steps SET status = 'waiting_provider', updated_at = ?,
           version = version + 1
         WHERE id = ? AND job_id = ? AND status = 'running' AND lease_owner = ?
           AND lease_expires_at > ? AND version = ?
           AND provider_submission_state IN ('accepted','outcome_unknown')`,
      )
      .run(
        input.now,
        input.stepId,
        input.jobId,
        input.leaseOwner,
        input.now,
        input.expectedStepVersion,
      );
    if (step.changes !== 1) throw leaseConflict();
    this.appendEvent(context, {
      jobId: input.jobId,
      type: "step.waiting_provider",
      payload: {
        schemaVersion: 1,
        jobId: input.jobId,
        stepId: input.stepId,
        status: "waiting_provider",
      },
      createdAt: input.now,
    });
    return {
      jobVersion: input.expectedJobVersion + 1,
      stepVersion: input.expectedStepVersion + 1,
    };
  }

  completeAssetIngestion(
    context: TransactionContext,
    input: {
      jobId: string;
      stepId: string;
      assetId: string;
      leaseOwner: string;
      expectedJobVersion: number;
      expectedStepVersion: number;
      now: number;
    },
  ): { jobVersion: number; stepVersion: number } {
    const resultJson = canonicalizeJson({
      schemaVersion: 1,
      assetId: input.assetId,
    });
    const job = context.database
      .prepare(
        `UPDATE jobs SET status = 'completed', result_json = ?,
           progress_basis_points = 10000, lease_owner = NULL,
           lease_expires_at = NULL, heartbeat_at = NULL, finished_at = ?,
           updated_at = ?, version = version + 1
         WHERE id = ? AND type = 'asset_ingestion' AND status = 'running'
           AND lease_owner = ? AND lease_expires_at > ? AND version = ?`,
      )
      .run(
        resultJson,
        input.now,
        input.now,
        input.jobId,
        input.leaseOwner,
        input.now,
        input.expectedJobVersion,
      );
    if (job.changes !== 1) throw leaseConflict();
    const step = context.database
      .prepare(
        `UPDATE job_steps SET status = 'completed', result_json = ?,
           lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
           completed_at = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND job_id = ? AND status = 'running'
           AND lease_owner = ? AND lease_expires_at > ? AND version = ?`,
      )
      .run(
        resultJson,
        input.now,
        input.now,
        input.stepId,
        input.jobId,
        input.leaseOwner,
        input.now,
        input.expectedStepVersion,
      );
    if (step.changes !== 1) throw leaseConflict();
    const asset = context.database
      .prepare(
        `UPDATE assets SET ingestion_status = 'ready', failure_code = NULL,
           updated_at = ?, version = version + 1
         WHERE id = ? AND ingestion_status = 'processing'
           AND lifecycle_status = 'active'`,
      )
      .run(input.now, input.assetId);
    if (asset.changes !== 1)
      throw new ApplicationError(
        "RESOURCE_STATE_CONFLICT",
        "asset_ingestion_state_conflict",
      );
    this.appendEvent(context, {
      jobId: input.jobId,
      type: "job.progress",
      payload: {
        schemaVersion: 1,
        jobId: input.jobId,
        progressBasisPoints: 10000,
      },
      createdAt: input.now,
    });
    this.appendEvent(context, {
      jobId: input.jobId,
      type: "job.succeeded",
      payload: {
        schemaVersion: 1,
        jobId: input.jobId,
        stepId: input.stepId,
        status: "completed",
        progressBasisPoints: 10000,
        assetId: input.assetId,
      },
      createdAt: input.now,
    });
    this.outbox.enqueue(context, {
      topic: "job.state.changed",
      aggregateType: "job",
      aggregateId: input.jobId,
      payload: {
        schemaVersion: 1,
        jobId: input.jobId,
        status: "completed",
      },
      availableAt: input.now,
      createdAt: input.now,
    });
    this.audit.append(context, {
      actorType: "system",
      action: "asset.ingestion_complete",
      resourceType: "asset",
      resourceId: input.assetId,
      outcome: "success",
      metadata: { jobId: input.jobId, stepId: input.stepId },
      createdAt: input.now,
    });
    return {
      jobVersion: input.expectedJobVersion + 1,
      stepVersion: input.expectedStepVersion + 1,
    };
  }

  failAssetIngestion(
    context: TransactionContext,
    input: AssetIngestionFailureInput,
  ): {
    status: "retry_scheduled" | "failed";
    jobVersion: number;
    stepVersion: number;
  } {
    const current = context.database
      .prepare(
        `SELECT j.attempt_count, j.max_attempts, s.max_attempts AS step_max_attempts
         FROM jobs j JOIN job_steps s ON s.id = ? AND s.job_id = j.id
         WHERE j.id = ? AND j.status = 'running' AND s.status = 'running'
           AND j.lease_owner = ? AND s.lease_owner = ?
           AND j.lease_expires_at > ? AND s.lease_expires_at > ?
           AND j.version = ? AND s.version = ?`,
      )
      .get(
        input.stepId,
        input.jobId,
        input.leaseOwner,
        input.leaseOwner,
        input.now,
        input.now,
        input.expectedJobVersion,
        input.expectedStepVersion,
      ) as
      | {
          attempt_count: number;
          max_attempts: number;
          step_max_attempts: number;
        }
      | undefined;
    if (current === undefined) throw leaseConflict();
    const canRetry =
      input.retryable &&
      current.attempt_count < current.max_attempts &&
      current.attempt_count < current.step_max_attempts;
    const nextStatus = canRetry ? "retry_scheduled" : "failed";
    const availableAt = canRetry
      ? input.now +
        Math.min(60_000, 1_000 * 2 ** Math.max(0, current.attempt_count - 1))
      : input.now;
    const job = context.database
      .prepare(
        `UPDATE jobs SET status = ?, failure_code = ?, available_at = ?,
           lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
           finished_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END,
           updated_at = ?, version = version + 1
         WHERE id = ? AND status = 'running' AND lease_owner = ?
           AND lease_expires_at > ? AND version = ?`,
      )
      .run(
        nextStatus,
        input.failureCode,
        availableAt,
        nextStatus,
        input.now,
        input.now,
        input.jobId,
        input.leaseOwner,
        input.now,
        input.expectedJobVersion,
      );
    if (job.changes !== 1) throw leaseConflict();
    const step = context.database
      .prepare(
        `UPDATE job_steps SET status = ?, failure_code = ?, available_at = ?,
           lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
           completed_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END,
           updated_at = ?, version = version + 1
         WHERE id = ? AND job_id = ? AND status = 'running' AND lease_owner = ?
           AND lease_expires_at > ? AND version = ?`,
      )
      .run(
        nextStatus,
        input.failureCode,
        availableAt,
        nextStatus,
        input.now,
        input.now,
        input.stepId,
        input.jobId,
        input.leaseOwner,
        input.now,
        input.expectedStepVersion,
      );
    if (step.changes !== 1) throw leaseConflict();
    if (nextStatus === "failed") {
      const asset = context.database
        .prepare(
          `UPDATE assets SET ingestion_status = 'failed', failure_code = ?,
             updated_at = ?, version = version + 1
           WHERE id = ? AND ingestion_status = 'processing' AND lifecycle_status = 'active'`,
        )
        .run(input.failureCode, input.now, input.assetId);
      if (asset.changes !== 1)
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "asset_ingestion_state_conflict",
        );
    }
    this.appendEvent(context, {
      jobId: input.jobId,
      type: canRetry ? "step.retry_scheduled" : "job.failed",
      payload: {
        schemaVersion: 1,
        jobId: input.jobId,
        stepId: input.stepId,
        status: nextStatus,
        failureCode: input.failureCode,
        ...(canRetry ? { retryAt: new Date(availableAt).toISOString() } : {}),
      },
      createdAt: input.now,
    });
    this.outbox.enqueue(context, {
      topic: "job.state.changed",
      aggregateType: "job",
      aggregateId: input.jobId,
      payload: { schemaVersion: 1, jobId: input.jobId, status: nextStatus },
      availableAt: input.now,
      createdAt: input.now,
    });
    return {
      status: nextStatus,
      jobVersion: input.expectedJobVersion + 1,
      stepVersion: input.expectedStepVersion + 1,
    };
  }

  reconcile(context: TransactionContext, now: number): ReconcileResult {
    let requeued = 0;
    const expired = context.database
      .prepare(
        `SELECT id, version FROM jobs
         WHERE type = 'asset_ingestion' AND status = 'running'
           AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      )
      .all(now) as Array<{ id: string; version: number }>;
    for (const job of expired) {
      const update = context.database
        .prepare(
          `UPDATE jobs SET status = 'queued', lease_owner = NULL,
             lease_expires_at = NULL, heartbeat_at = NULL, available_at = ?,
             updated_at = ?, version = version + 1
           WHERE id = ? AND status = 'running' AND version = ?`,
        )
        .run(now, now, job.id, job.version);
      if (update.changes !== 1) continue;
      context.database
        .prepare(
          `UPDATE job_steps SET status = 'pending', lease_owner = NULL,
             lease_expires_at = NULL, heartbeat_at = NULL, available_at = ?,
             updated_at = ?, version = version + 1
           WHERE job_id = ? AND status = 'running'`,
        )
        .run(now, now, job.id);
      this.appendEvent(context, {
        jobId: job.id,
        type: "job.queued",
        payload: {
          schemaVersion: 1,
          jobId: job.id,
          status: "queued",
          requeuedExpired: true,
        },
        createdAt: now,
      });
      requeued += 1;
    }
    const retryRows = context.database
      .prepare(
        `SELECT id, version FROM jobs
         WHERE status = 'retry_scheduled' AND available_at <= ?`,
      )
      .all(now) as Array<{ id: string; version: number }>;
    let retried = 0;
    for (const job of retryRows) {
      const retry = context.database
        .prepare(
          `UPDATE jobs SET status = 'queued', updated_at = ?, version = version + 1
           WHERE id = ? AND status = 'retry_scheduled' AND version = ?`,
        )
        .run(now, job.id, job.version);
      if (retry.changes !== 1) continue;
      context.database
        .prepare(
          `UPDATE job_steps SET status = 'pending', updated_at = ?, version = version + 1
           WHERE job_id = ? AND status = 'retry_scheduled'`,
        )
        .run(now, job.id);
      this.appendEvent(context, {
        jobId: job.id,
        type: "job.queued",
        payload: { schemaVersion: 1, jobId: job.id, status: "queued" },
        createdAt: now,
      });
      retried += 1;
    }
    context.database
      .prepare(
        `UPDATE jobs SET lease_owner = NULL, lease_expires_at = NULL,
           heartbeat_at = NULL, updated_at = ?, version = version + 1
         WHERE status IN ('waiting_provider', 'cancel_requested')
           AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      )
      .run(now, now);
    return { requeued, retried, cancelled: 0 };
  }

  appendEvent(
    context: TransactionContext,
    input: {
      jobId: string;
      type: string;
      payload: JsonValue;
      createdAt: number;
    },
  ): string {
    const sequence = context.database
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM job_events WHERE job_id = ?",
      )
      .get(input.jobId) as { sequence: number };
    const id = this.idGenerator.generate();
    context.database
      .prepare(
        "INSERT INTO job_events (id, job_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.jobId,
        sequence.sequence,
        input.type,
        canonicalizeJson(input.payload),
        input.createdAt,
      );
    return id;
  }
}

function leaseConflict(): ApplicationError {
  return new ApplicationError("VERSION_CONFLICT", "job_lease_conflict");
}

function parseAssetIngestionRequest(value: string): { assetId: string } {
  const parsed = JSON.parse(value) as {
    schemaVersion?: unknown;
    assetId?: unknown;
  };
  if (parsed.schemaVersion !== 1 || typeof parsed.assetId !== "string")
    throw new Error("Invalid Asset-ingestion Job request");
  return { assetId: parsed.assetId };
}
