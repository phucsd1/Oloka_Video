import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AuthenticatedSession,
  IdentityService,
} from "../identity/identity-service.js";
import { registerErrorHandler } from "../http/error-handler.js";
import { ApplicationError } from "../http/application-error.js";
import { registerJobRoutes } from "./job-routes.js";

const applications: FastifyInstance[] = [];
const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

describe("admin Job HTTP routes", () => {
  it("enforces admin access, CSRF/idempotency, and redacted diagnostics", async () => {
    const admin = session("admin", "admin");
    const member = session("member", "member");
    const sessions = new Map([
      ["admin-session", admin],
      ["member-session", member],
    ]);
    const identity = {
      getSession: (cookie: string | null) => sessions.get(cookie ?? "") ?? null,
      auditStatusDenial: () => undefined,
      verifyCsrfToken: (_sessionId: string, token: string) => token === "csrf",
      auditCsrfFailure: () => undefined,
    } as unknown as IdentityService;
    const job = publicJob();
    const diagnostics = {
      schemaVersion: 1 as const,
      job,
      steps: [
        {
          schemaVersion: 1 as const,
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          jobId,
          parentStepId: null,
          stepKey: "inspect_asset",
          itemKey: "",
          status: "pending" as const,
          attemptCount: 0,
          failureCode: null,
          startedAt: null,
          completedAt: null,
          updatedAt: job.updatedAt,
          version: 1,
        },
      ],
    };
    let reconciles = 0;
    const jobService = {
      listAdmin: (actor: AuthenticatedSession) => {
        assertAdmin(actor);
        return { jobs: [job], nextCursor: null };
      },
      getAdmin: (actor: AuthenticatedSession) => {
        assertAdmin(actor);
        return diagnostics;
      },
      requestAdminReconcile: (actor: AuthenticatedSession) => {
        assertAdmin(actor);
        reconciles += 1;
        return { replayed: reconciles > 1 };
      },
      operations: (actor: AuthenticatedSession) => {
        assertAdmin(actor);
        return {
          schemaVersion: 1,
          queuedJobsCurrent: 1,
          oldestQueueAgeMsCurrent: 10,
          activeLeasesCurrent: 0,
          expiredLeasesCurrent: 0,
          retryScheduledCurrent: 0,
          cancelRequestedCurrent: 0,
          waitingProviderCurrent: 0,
          outboxPendingCurrent: 0,
          outboxDeadDurable: 0,
          outboxRedeliveryDurable: 0,
          reconciliationRunsDurable: 0,
          reconciliationRunsSinceProcessStart: 0,
          requeuedExpiredWorkDurable: 0,
          requeuedExpiredWorkSinceProcessStart: 0,
          cancellationCleanupSinceProcessStart: 0,
          waitingProviderReconciliationsSinceProcessStart: 0,
          assetMaintenanceCurrent: {
            expired: 0,
            truncatedFileAhead: 0,
            quarantinedDatabaseAhead: 0,
            missingDurable: 0,
            unreferencedDurable: 0,
            unreferencedStaging: 0,
            recoveredVerifying: 0,
            failedVerifying: 0,
          },
          assetStorageDivergenceCurrent: 0,
          dispatcherActiveCurrent: 0,
          dispatcherCapacityCurrent: 1,
        };
      },
    };
    const app = Fastify({ logger: false });
    applications.push(app);
    registerErrorHandler(app);
    registerJobRoutes({
      app,
      identityService: identity,
      jobService: jobService as never,
      publicOrigin: "https://oloka.example.test",
    });
    await app.ready();
    const adminHeaders = { cookie: "__Host-oloka_session=admin-session" };
    const memberList = await app.inject({
      method: "GET",
      url: "/api/v1/admin/jobs",
      headers: { cookie: "__Host-oloka_session=member-session" },
    });
    expect(memberList.statusCode).toBe(403);
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/admin/jobs",
      headers: adminHeaders,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().jobs[0]).toEqual(job);
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/admin/jobs/${jobId}`,
      headers: adminHeaders,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain("requestJson");
    expect(detail.body).not.toContain("lease_owner");
    const missing = await app.inject({
      method: "POST",
      url: `/api/v1/admin/jobs/${jobId}/reconcile`,
      headers: {
        ...adminHeaders,
        origin: "https://oloka.example.test",
        "content-type": "application/json",
        "x-oloka-csrf": "csrf",
      },
      payload: { expectedVersion: 1, reason: "manual evidence" },
    });
    expect(missing.statusCode).toBe(400);
    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/admin/jobs/${jobId}/reconcile`,
      headers: {
        ...adminHeaders,
        origin: "https://oloka.example.test",
        "content-type": "application/json",
        "x-oloka-csrf": "csrf",
        "idempotency-key": "reconcile-1",
      },
      payload: { expectedVersion: 1, reason: "manual evidence" },
    });
    expect(accepted.statusCode).toBe(202);
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/admin/jobs/${jobId}/reconcile`,
      headers: {
        ...adminHeaders,
        origin: "https://oloka.example.test",
        "content-type": "application/json",
        "x-oloka-csrf": "csrf",
        "idempotency-key": "reconcile-1",
      },
      payload: { expectedVersion: 1, reason: "manual evidence" },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    const operations = await app.inject({
      method: "GET",
      url: "/api/v1/admin/operations",
      headers: adminHeaders,
    });
    expect(operations.statusCode).toBe(200);
  });
});

function session(id: string, role: "admin" | "member"): AuthenticatedSession {
  return {
    sessionId: `${id}-session-id`,
    user: {
      id,
      email: `${id}@example.test`,
      displayName: id,
      avatarUrl: null,
      role,
      status: "active",
      version: 1,
    },
  };
}

function assertAdmin(actor: AuthenticatedSession): void {
  if (actor.user.role !== "admin")
    throw new ApplicationError(
      "AUTHORIZATION_DENIED",
      "administrator_role_required",
    );
}

function publicJob() {
  return {
    schemaVersion: 1 as const,
    id: jobId,
    projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    type: "asset_ingestion" as const,
    status: "queued" as const,
    progressBasisPoints: 0,
    currentStepKey: "inspect_asset",
    attemptCount: 0,
    failureCode: null,
    createdAt: new Date(1).toISOString(),
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date(1).toISOString(),
    version: 1,
  };
}
