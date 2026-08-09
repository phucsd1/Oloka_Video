import {
  adminJobDiagnosticsSchema,
  cancelJobRequestSchema,
  jobHistoryQuerySchema,
  jobEventHistoryResponseSchema,
  jobListQuerySchema,
  jobListResponseSchema,
  jobSchema,
  jobStepListResponseSchema,
  operationsSnapshotSchema,
  reconcileJobRequestSchema,
  retryJobRequestSchema,
  type JobEvent,
} from "@oloka/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { IdentityService } from "../identity/identity-service.js";
import {
  requireProtectedSession,
  verifyProtectedCsrfRequest,
} from "../identity/identity-routes.js";
import { parseIdempotencyKey } from "../identity/idempotency-key.js";
import { ApplicationError } from "../http/application-error.js";
import type { JobService } from "./job-service.js";

export interface RegisterJobRoutesOptions {
  app: FastifyInstance;
  identityService: IdentityService | undefined;
  jobService: JobService;
  publicOrigin: string | undefined;
}

export function registerJobRoutes(options: RegisterJobRoutesOptions): void {
  const { app } = options;
  app.get("/api/v1/jobs", (request) => {
    const session = requireProtectedSession(options.identityService, request);
    const query = jobListQuerySchema.parse(request.query);
    return jobListResponseSchema.parse(options.jobService.list(session, query));
  });
  app.get("/api/v1/jobs/:jobId", (request) => {
    const session = requireProtectedSession(options.identityService, request);
    return jobSchema.parse(
      options.jobService.get(session, parseJobId(request)),
    );
  });
  app.get("/api/v1/jobs/:jobId/steps", (request) => {
    const session = requireProtectedSession(options.identityService, request);
    return jobStepListResponseSchema.parse(
      options.jobService.listSteps(
        session,
        parseJobId(request),
        jobHistoryQuerySchema.parse(request.query),
      ),
    );
  });
  app.get("/api/v1/jobs/:jobId/event-history", (request) => {
    const session = requireProtectedSession(options.identityService, request);
    return jobEventHistoryResponseSchema.parse(
      options.jobService.listEvents(
        session,
        parseJobId(request),
        jobHistoryQuerySchema.parse(request.query),
      ),
    );
  });
  app.post("/api/v1/jobs/:jobId/retry", (request) => {
    const session = requireProtectedSession(options.identityService, request);
    if (options.identityService === undefined)
      throw new ApplicationError(
        "AUTHENTICATION_REQUIRED",
        "identity_unavailable",
      );
    verifyProtectedCsrfRequest(
      options.identityService,
      session,
      request,
      options.publicOrigin,
    );
    const body = retryJobRequestSchema.parse(request.body);
    parseIdempotencyKey(request.headers["idempotency-key"]);
    const job = options.jobService.get(session, parseJobId(request));
    if (job.version !== body.expectedVersion)
      throw new ApplicationError("VERSION_CONFLICT", "job_version_stale");
    throw new ApplicationError(
      "RESOURCE_STATE_CONFLICT",
      "job_retry_policy_unavailable",
    );
  });
  app.post("/api/v1/jobs/:jobId/cancel", (request, reply) => {
    const session = requireProtectedSession(options.identityService, request);
    if (options.identityService === undefined)
      throw new Error("Identity service unavailable");
    verifyProtectedCsrfRequest(
      options.identityService,
      session,
      request,
      options.publicOrigin,
    );
    const body = cancelJobRequestSchema.parse(request.body);
    const result = options.jobService.cancel(
      session,
      parseJobId(request),
      body.expectedVersion,
      parseIdempotencyKey(request.headers["idempotency-key"]),
    );
    return reply
      .header("etag", `"${result.job.version}"`)
      .header("idempotency-replayed", result.replayed ? "true" : "false")
      .send(jobSchema.parse(result.job));
  });
  app.get("/api/v1/jobs/:jobId/events", (request, reply) => {
    const session = requireProtectedSession(options.identityService, request);
    const jobId = parseJobId(request);
    const lastEventId = request.headers["last-event-id"];
    const startSequence =
      typeof lastEventId === "string"
        ? options.jobService.resolveEventSequence(session, jobId, lastEventId)
        : 0;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const writeEvent = (event: JobEvent): boolean => {
      const payload = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
      if (!raw.write(payload)) {
        raw.destroy();
        return false;
      }
      return true;
    };
    let lastSequence = startSequence;
    while (true) {
      const replay = options.jobService.listEventsAfter(
        session,
        jobId,
        lastSequence,
      );
      for (const event of replay) {
        if (!writeEvent(event)) return;
        lastSequence = event.sequence;
      }
      if (replay.length < 100) break;
    }
    const heartbeat = setInterval(() => {
      if (!raw.write(": heartbeat\n\n")) raw.destroy();
    }, 15_000);
    const poll = setInterval(() => {
      try {
        const current = options.jobService.listEventsAfter(
          session,
          jobId,
          lastSequence,
        );
        for (const event of current) {
          if (event.sequence > lastSequence && !writeEvent(event)) return;
          lastSequence = Math.max(lastSequence, event.sequence);
        }
      } catch {
        raw.destroy();
      }
    }, 750);
    raw.once("close", () => {
      clearInterval(heartbeat);
      clearInterval(poll);
    });
  });

  app.get("/api/v1/admin/jobs", (request) => {
    const session = requireProtectedSession(options.identityService, request);
    return jobListResponseSchema.parse(
      options.jobService.listAdmin(
        session,
        jobListQuerySchema.parse(request.query),
      ),
    );
  });
  app.get("/api/v1/admin/jobs/:jobId", (request) => {
    const session = requireProtectedSession(options.identityService, request);
    return adminJobDiagnosticsSchema.parse(
      options.jobService.getAdmin(session, parseJobId(request)),
    );
  });
  app.post("/api/v1/admin/jobs/:jobId/reconcile", (request, reply) => {
    const session = requireProtectedSession(options.identityService, request);
    if (options.identityService === undefined)
      throw new ApplicationError(
        "AUTHENTICATION_REQUIRED",
        "identity_unavailable",
      );
    verifyProtectedCsrfRequest(
      options.identityService,
      session,
      request,
      options.publicOrigin,
    );
    const body = reconcileJobRequestSchema.parse(request.body);
    const result = options.jobService.requestAdminReconcile(
      session,
      parseJobId(request),
      body.expectedVersion,
      body.reason,
      parseIdempotencyKey(request.headers["idempotency-key"]),
    );
    return reply
      .code(202)
      .header("idempotency-replayed", result.replayed ? "true" : "false")
      .send({ accepted: true });
  });
  app.get("/api/v1/admin/operations", (request) => {
    const session = requireProtectedSession(options.identityService, request);
    return operationsSnapshotSchema.parse(
      options.jobService.operations(session),
    );
  });
}

function parseJobId(request: FastifyRequest): string {
  const value = (request.params as { jobId?: unknown }).jobId;
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success)
    throw new ApplicationError("VALIDATION_ERROR", "job_id_invalid");
  return parsed.data;
}
