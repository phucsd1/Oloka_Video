import {
  adminJobDiagnosticsSchema,
  jobHistoryQuerySchema,
  jobEventHistoryResponseSchema,
  jobListResponseSchema,
  jobSchema,
  jobStepListResponseSchema,
  operationsSnapshotSchema,
  type JobListQuery,
  type JobHistoryQuery,
} from "@oloka/contracts";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { TransactionRunner } from "../database/database.js";
import { AuditEventRepository } from "../database/repositories/audit-event-repository.js";
import { IdempotencyRepository } from "../database/repositories/idempotency-repository.js";
import { OutboxRepository } from "../database/repositories/outbox-repository.js";
import type { AuthenticatedSession } from "../identity/identity-service.js";
import { ApplicationError } from "../http/application-error.js";
import { sha256CanonicalJson } from "../kernel/canonical-json.js";
import type { Clock } from "../kernel/clock.js";
import type { IdGenerator } from "../kernel/id-generator.js";
import type { JobRepository } from "./job-repository.js";

export interface JobServiceOptions {
  transactions: TransactionRunner;
  clock: Clock;
  idGenerator: IdGenerator;
  applicationKey: Uint8Array;
  repository: JobRepository;
  dispatcherSnapshot?: () => {
    active: number;
    capacity: number;
    stopping: boolean;
  };
}

export class JobService {
  private readonly idempotency: IdempotencyRepository;
  private readonly audit: AuditEventRepository;
  private readonly outbox: OutboxRepository;

  constructor(private readonly options: JobServiceOptions) {
    this.idempotency = new IdempotencyRepository(options.idGenerator);
    this.audit = new AuditEventRepository(options.idGenerator);
    this.outbox = new OutboxRepository(options.idGenerator);
  }

  list(actor: AuthenticatedSession, query: JobListQuery) {
    const filterHash = sha256CanonicalJson({ owner: actor.user.id, ...query });
    const cursor = query.cursor
      ? decodeCursor(query.cursor, filterHash, this.options.applicationKey)
      : undefined;
    return this.options.transactions.run("read", ({ database }) => {
      const clauses = ["owner_user_id = ?"];
      const values: (string | number)[] = [actor.user.id];
      if (query.type !== undefined) {
        clauses.push("type = ?");
        values.push(query.type);
      }
      if (query.status !== undefined) {
        clauses.push("status = ?");
        values.push(query.status);
      }
      if (query.projectId !== undefined) {
        clauses.push("project_id = ?");
        values.push(query.projectId);
      }
      if (cursor !== undefined) {
        clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
        values.push(cursor.createdAt, cursor.createdAt, cursor.id);
      }
      const rows = database
        .prepare(
          `SELECT * FROM jobs WHERE ${clauses.join(" AND ")}
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(...values, query.limit + 1) as unknown as JobRow[];
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return jobListResponseSchema.parse({
        jobs: page.map(toPublicJob),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encodeCursor(
                { createdAt: last.created_at, id: last.id },
                filterHash,
                this.options.applicationKey,
              )
            : null,
      });
    });
  }

  get(actor: AuthenticatedSession, jobId: string) {
    return this.options.transactions.run("read", ({ database }) => {
      const row = database
        .prepare("SELECT * FROM jobs WHERE id = ? AND owner_user_id = ?")
        .get(jobId, actor.user.id) as JobRow | undefined;
      if (row === undefined)
        throw new ApplicationError("RESOURCE_NOT_FOUND", "job_not_found");
      return jobSchema.parse(toPublicJob(row));
    });
  }

  listSteps(
    actor: AuthenticatedSession,
    jobId: string,
    input: JobHistoryQuery = jobHistoryQuerySchema.parse({}),
  ) {
    const query = jobHistoryQuerySchema.parse(input);
    const filterHash = sha256CanonicalJson({
      kind: "job-steps",
      jobId,
      owner: actor.user.id,
    });
    const cursor = query.cursor
      ? decodeCursor(query.cursor, filterHash, this.options.applicationKey)
      : undefined;
    return this.options.transactions.run("read", ({ database }) => {
      assertOwner(database, jobId, actor.user.id);
      const cursorClause =
        cursor === undefined
          ? ""
          : "AND (created_at > ? OR (created_at = ? AND id > ?))";
      const cursorValues =
        cursor === undefined
          ? []
          : [cursor.createdAt, cursor.createdAt, cursor.id];
      const rows = database
        .prepare(
          `SELECT * FROM job_steps WHERE job_id = ? ${cursorClause}
           ORDER BY created_at, id LIMIT ?`,
        )
        .all(
          jobId,
          ...cursorValues,
          query.limit + 1,
        ) as unknown as JobStepRow[];
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return jobStepListResponseSchema.parse({
        steps: page.map(toPublicStep),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encodeCursor(
                { createdAt: last.created_at, id: last.id },
                filterHash,
                this.options.applicationKey,
              )
            : null,
      });
    });
  }

  listEvents(
    actor: AuthenticatedSession,
    jobId: string,
    input: JobHistoryQuery = jobHistoryQuerySchema.parse({}),
  ) {
    const query = jobHistoryQuerySchema.parse(input);
    const filterHash = sha256CanonicalJson({
      kind: "job-events",
      jobId,
      owner: actor.user.id,
    });
    const cursor = query.cursor
      ? decodeCursor(query.cursor, filterHash, this.options.applicationKey)
      : undefined;
    return this.options.transactions.run("read", ({ database }) => {
      assertOwner(database, jobId, actor.user.id);
      const afterSequence = cursor?.createdAt ?? 0;
      const rows = database
        .prepare(
          "SELECT * FROM job_events WHERE job_id = ? AND sequence > ? ORDER BY sequence, id LIMIT ?",
        )
        .all(jobId, afterSequence, query.limit + 1) as unknown as JobEventRow[];
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return jobEventHistoryResponseSchema.parse({
        events: page.map(toPublicEvent),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encodeCursor(
                { createdAt: last.sequence, id: last.id },
                filterHash,
                this.options.applicationKey,
              )
            : null,
      });
    });
  }

  resolveEventSequence(
    actor: AuthenticatedSession,
    jobId: string,
    eventId: string,
  ): number {
    return this.options.transactions.run("read", ({ database }) => {
      assertOwner(database, jobId, actor.user.id);
      const row = database
        .prepare("SELECT sequence FROM job_events WHERE id = ? AND job_id = ?")
        .get(eventId, jobId) as { sequence: number } | undefined;
      if (row === undefined)
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "job_event_replay_window",
        );
      return row.sequence;
    });
  }

  listEventsAfter(
    actor: AuthenticatedSession,
    jobId: string,
    sequence: number,
    limit = 100,
  ) {
    return this.options.transactions.run("read", ({ database }) => {
      assertOwner(database, jobId, actor.user.id);
      const rows = database
        .prepare(
          "SELECT * FROM job_events WHERE job_id = ? AND sequence > ? ORDER BY sequence, id LIMIT ?",
        )
        .all(
          jobId,
          sequence,
          Math.min(100, Math.max(1, limit)),
        ) as unknown as JobEventRow[];
      return rows.map(toPublicEvent);
    });
  }

  cancel(
    actor: AuthenticatedSession,
    jobId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): { job: ReturnType<typeof toPublicJob>; replayed: boolean } {
    const now = this.options.clock.now();
    return this.options.transactions.run("immediate", (context) => {
      const begin = this.idempotency.begin(context, {
        userId: actor.user.id,
        operation: `job.cancel:${jobId}`,
        idempotencyKey,
        semanticRequestHashSha256: sha256CanonicalJson({
          jobId,
          expectedVersion,
        }),
        createdAt: now,
        expiresAt: now + 24 * 60 * 60 * 1000,
      });
      if (begin.kind === "replay")
        return {
          job: (begin.response as { job: ReturnType<typeof toPublicJob> }).job,
          replayed: true,
        };
      if (begin.kind === "conflict")
        throw new ApplicationError(
          "IDEMPOTENCY_CONFLICT",
          "job_cancel_conflict",
        );
      if (begin.kind === "in_progress")
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "job_cancel_in_progress",
        );
      const row = context.database
        .prepare("SELECT * FROM jobs WHERE id = ? AND owner_user_id = ?")
        .get(jobId, actor.user.id) as JobRow | undefined;
      if (row === undefined)
        throw new ApplicationError("RESOURCE_NOT_FOUND", "job_not_found");
      if (row.version !== expectedVersion)
        throw new ApplicationError("VERSION_CONFLICT", "job_version_stale");
      if (
        !["queued", "running", "waiting_provider", "retry_scheduled"].includes(
          row.status,
        )
      )
        throw new ApplicationError(
          "JOB_NOT_CANCELLABLE",
          "job_not_cancellable",
        );
      const changed = context.database
        .prepare(
          `UPDATE jobs SET status = 'cancel_requested', cancel_requested_at = ?,
             updated_at = ?, version = version + 1
           WHERE id = ? AND owner_user_id = ? AND status IN ('queued','running','waiting_provider','retry_scheduled')
             AND version = ?`,
        )
        .run(now, now, jobId, actor.user.id, expectedVersion);
      if (changed.changes !== 1)
        throw new ApplicationError("VERSION_CONFLICT", "job_version_stale");
      this.options.repository.appendEvent(context, {
        jobId,
        type: "job.cancel_requested",
        payload: { schemaVersion: 1, jobId, status: "cancel_requested" },
        createdAt: now,
      });
      this.outbox.enqueue(context, {
        topic: "job.state.changed",
        aggregateType: "job",
        aggregateId: jobId,
        payload: { schemaVersion: 1, jobId, status: "cancel_requested" },
        availableAt: now,
        createdAt: now,
      });
      this.audit.append(context, {
        actorUserId: actor.user.id,
        actorType: actor.user.role === "admin" ? "admin" : "user",
        action: "job.cancel_requested",
        resourceType: "job",
        resourceId: jobId,
        outcome: "success",
        metadata: {},
        createdAt: now,
      });
      const current = context.database
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(jobId) as JobRow;
      const job = toPublicJob(current);
      this.idempotency.complete(context, {
        recordId: begin.recordId,
        responseStatus: 200,
        response: { job },
        resourceId: jobId,
      });
      return { job, replayed: false };
    });
  }

  listAdmin(actor: AuthenticatedSession, query: JobListQuery) {
    assertAdmin(actor);
    const filterHash = sha256CanonicalJson({ admin: actor.user.id, ...query });
    const cursor = query.cursor
      ? decodeCursor(query.cursor, filterHash, this.options.applicationKey)
      : undefined;
    return this.options.transactions.run("read", ({ database }) => {
      const clauses: string[] = [];
      const values: (string | number)[] = [];
      if (query.type !== undefined) {
        clauses.push("type = ?");
        values.push(query.type);
      }
      if (query.status !== undefined) {
        clauses.push("status = ?");
        values.push(query.status);
      }
      if (query.projectId !== undefined) {
        clauses.push("project_id = ?");
        values.push(query.projectId);
      }
      if (cursor !== undefined) {
        clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
        values.push(cursor.createdAt, cursor.createdAt, cursor.id);
      }
      const where =
        clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
      const rows = database
        .prepare(
          `SELECT * FROM jobs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(...values, query.limit + 1) as unknown as JobRow[];
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return jobListResponseSchema.parse({
        jobs: page.map(toPublicJob),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encodeCursor(
                { createdAt: last.created_at, id: last.id },
                filterHash,
                this.options.applicationKey,
              )
            : null,
      });
    });
  }

  getAdmin(actor: AuthenticatedSession, jobId: string) {
    assertAdmin(actor);
    return this.options.transactions.run("read", ({ database }) => {
      const job = database
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(jobId) as JobRow | undefined;
      if (job === undefined)
        throw new ApplicationError("RESOURCE_NOT_FOUND", "job_not_found");
      const steps = database
        .prepare(
          "SELECT * FROM job_steps WHERE job_id = ? ORDER BY created_at, id LIMIT 100",
        )
        .all(jobId) as unknown as JobStepRow[];
      return adminJobDiagnosticsSchema.parse({
        schemaVersion: 1,
        job: toPublicJob(job),
        steps: steps.map(toPublicStep),
      });
    });
  }

  requestAdminReconcile(
    actor: AuthenticatedSession,
    jobId: string,
    expectedVersion: number,
    reason: string,
    idempotencyKey: string,
  ) {
    assertAdmin(actor);
    const now = this.options.clock.now();
    return this.options.transactions.run("immediate", (context) => {
      const begin = this.idempotency.begin(context, {
        userId: actor.user.id,
        operation: `admin.job.reconcile:${jobId}`,
        idempotencyKey,
        semanticRequestHashSha256: sha256CanonicalJson({
          jobId,
          expectedVersion,
          reason,
        }),
        createdAt: now,
        expiresAt: now + 24 * 60 * 60 * 1000,
      });
      if (begin.kind === "replay") return { replayed: true };
      if (begin.kind === "conflict")
        throw new ApplicationError(
          "IDEMPOTENCY_CONFLICT",
          "job_reconcile_conflict",
        );
      if (begin.kind === "in_progress")
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "job_reconcile_in_progress",
        );
      const job = context.database
        .prepare("SELECT version FROM jobs WHERE id = ?")
        .get(jobId) as { version: number } | undefined;
      if (job === undefined)
        throw new ApplicationError("RESOURCE_NOT_FOUND", "job_not_found");
      if (job.version !== expectedVersion)
        throw new ApplicationError("VERSION_CONFLICT", "job_version_stale");
      this.outbox.enqueue(context, {
        topic: "job.reconcile.requested",
        aggregateType: "job",
        aggregateId: jobId,
        payload: { schemaVersion: 1, jobId, expectedVersion },
        availableAt: now,
        createdAt: now,
      });
      this.audit.append(context, {
        actorUserId: actor.user.id,
        actorType: "admin",
        action: "admin.job_reconcile_requested",
        resourceType: "job",
        resourceId: jobId,
        outcome: "success",
        metadata: { reason },
        createdAt: now,
      });
      this.idempotency.complete(context, {
        recordId: begin.recordId,
        responseStatus: 202,
        response: { accepted: true },
        resourceId: jobId,
      });
      return { replayed: false };
    });
  }

  operations(actor: AuthenticatedSession) {
    assertAdmin(actor);
    const now = this.options.clock.now();
    return this.options.transactions.run("read", ({ database }) => {
      const jobs = database
        .prepare(
          `SELECT
             SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
             MIN(CASE WHEN status = 'queued' THEN created_at END) AS oldest,
             SUM(CASE WHEN status = 'running' AND lease_expires_at > ? THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN status = 'running' AND lease_expires_at <= ? THEN 1 ELSE 0 END) AS expired,
             SUM(CASE WHEN status = 'retry_scheduled' THEN 1 ELSE 0 END) AS retries,
             SUM(CASE WHEN status = 'cancel_requested' THEN 1 ELSE 0 END) AS cancellations
           FROM jobs`,
        )
        .get(now, now) as Record<string, number | null>;
      const outbox = database
        .prepare(
          `SELECT
             SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
             SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead
           FROM outbox_events`,
        )
        .get() as Record<string, number | null>;
      const oldest = jobs.oldest ?? now;
      return operationsSnapshotSchema.parse({
        schemaVersion: 1,
        queuedJobs: jobs.queued ?? 0,
        oldestQueueAgeMs: Math.max(0, now - oldest),
        activeLeases: jobs.active ?? 0,
        expiredLeases: jobs.expired ?? 0,
        retryScheduled: jobs.retries ?? 0,
        cancelRequested: jobs.cancellations ?? 0,
        outboxPending: outbox.pending ?? 0,
        outboxDead: outbox.dead ?? 0,
        dispatcherCapacity: this.options.dispatcherSnapshot?.().capacity ?? 1,
      });
    });
  }
}

interface JobRow {
  id: string;
  project_id: string | null;
  owner_user_id: string | null;
  type: string;
  status: string;
  progress_basis_points: number;
  current_step_key: string | null;
  attempt_count: number;
  failure_code: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
  version: number;
  [key: string]: unknown;
}

interface JobStepRow {
  id: string;
  job_id: string;
  parent_step_id: string | null;
  step_key: string;
  item_key: string;
  status: string;
  attempt_count: number;
  failure_code: string | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
  version: number;
}

interface JobEventRow {
  id: string;
  job_id: string;
  sequence: number;
  type: string;
  payload_json: string;
  created_at: number;
}

function toPublicJob(row: JobRow) {
  return {
    schemaVersion: 1 as const,
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

function toPublicStep(row: JobStepRow) {
  return {
    schemaVersion: 1 as const,
    id: row.id,
    jobId: row.job_id,
    parentStepId: row.parent_step_id,
    stepKey: row.step_key,
    itemKey: row.item_key,
    status: row.status,
    attemptCount: row.attempt_count,
    failureCode: row.failure_code,
    startedAt:
      row.started_at === null ? null : new Date(row.started_at).toISOString(),
    completedAt:
      row.completed_at === null
        ? null
        : new Date(row.completed_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    version: row.version,
  };
}

function toPublicEvent(row: JobEventRow) {
  return jobEventHistoryResponseSchema.shape.events.element.parse({
    schemaVersion: 1 as const,
    id: row.id,
    jobId: row.job_id,
    sequence: row.sequence,
    type: row.type,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

function assertOwner(
  database: { prepare(sql: string): { get(...values: unknown[]): unknown } },
  jobId: string,
  ownerUserId: string,
): void {
  const row = database
    .prepare("SELECT id FROM jobs WHERE id = ? AND owner_user_id = ?")
    .get(jobId, ownerUserId);
  if (row === undefined)
    throw new ApplicationError("RESOURCE_NOT_FOUND", "job_not_found");
}

function assertAdmin(actor: AuthenticatedSession): void {
  if (actor.user.status !== "active") {
    const code =
      actor.user.status === "pending"
        ? "ACCOUNT_PENDING"
        : actor.user.status === "disabled"
          ? "ACCOUNT_DISABLED"
          : "ACCOUNT_REJECTED";
    throw new ApplicationError(code, "account_not_active");
  }
  if (actor.user.role !== "admin")
    throw new ApplicationError(
      "AUTHORIZATION_DENIED",
      "administrator_role_required",
    );
}

function encodeCursor(
  sort: { createdAt: number; id: string },
  filterHash: string,
  key: Uint8Array,
): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, sort, filterHash }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", key)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function decodeCursor(
  cursor: string,
  filterHash: string,
  key: Uint8Array,
): { createdAt: number; id: string } {
  try {
    const [payload, signature, extra] = cursor.split(".");
    if (!payload || !signature || extra) throw new Error();
    const expected = createHmac("sha256", key).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new Error();
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as {
      v?: unknown;
      sort?: { createdAt?: unknown; id?: unknown };
      filterHash?: unknown;
    };
    if (
      decoded.v !== 1 ||
      decoded.filterHash !== filterHash ||
      typeof decoded.sort?.createdAt !== "number" ||
      typeof decoded.sort.id !== "string"
    )
      throw new Error();
    return { createdAt: decoded.sort.createdAt, id: decoded.sort.id };
  } catch {
    throw new ApplicationError("INVALID_CURSOR", "job_cursor_invalid");
  }
}
