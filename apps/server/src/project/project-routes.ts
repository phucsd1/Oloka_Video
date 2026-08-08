import {
  createProjectRequestSchema,
  projectListQuerySchema,
  projectListResponseSchema,
  projectMutationRequestSchema,
  projectSchema,
  trashProjectListResponseSchema,
  updateProjectRequestSchema,
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
import type { ProjectService } from "./project-service.js";

const projectIdSchema = z.uuid();

export interface RegisterProjectRoutesOptions {
  app: FastifyInstance;
  identityService: IdentityService | undefined;
  projectService: ProjectService | undefined;
  publicOrigin: string | undefined;
}

export function registerProjectRoutes(
  options: RegisterProjectRoutesOptions,
): void {
  const { app } = options;

  app.get("/api/v1/projects", async (request, reply) => {
    const session = requireProjectSession(options, request);
    const query = parseListQuery(request);
    return reply
      .header("cache-control", "no-store")
      .send(
        projectListResponseSchema.parse(
          requireProjectService(options).listActive(session, query),
        ),
      );
  });

  app.post("/api/v1/projects", async (request, reply) => {
    const session = requireProjectSession(options, request);
    verifyMutation(options, session, request);
    const result = requireProjectService(options).create(
      session,
      createProjectRequestSchema.parse(request.body),
      parseIdempotencyKey(request.headers["idempotency-key"]),
    );
    return reply
      .code(201)
      .header("cache-control", "no-store")
      .header("etag", etag(result.project.version))
      .header("idempotency-replayed", result.replayed ? "true" : "false")
      .send(projectSchema.parse(result.project));
  });

  app.get("/api/v1/projects/:projectId", async (request, reply) => {
    const session = requireProjectSession(options, request);
    const project = requireProjectService(options).getActive(
      session,
      parseProjectId(request),
    );
    return reply
      .header("cache-control", "no-store")
      .header("etag", etag(project.version))
      .send(projectSchema.parse(project));
  });

  app.patch("/api/v1/projects/:projectId", async (request, reply) => {
    const session = requireProjectSession(options, request);
    verifyMutation(options, session, request);
    const result = requireProjectService(options).update(
      session,
      parseProjectId(request),
      updateProjectRequestSchema.parse(request.body),
      parseIdempotencyKey(request.headers["idempotency-key"]),
    );
    return reply
      .header("cache-control", "no-store")
      .header("etag", etag(result.project.version))
      .header("idempotency-replayed", result.replayed ? "true" : "false")
      .send(projectSchema.parse(result.project));
  });

  app.delete("/api/v1/projects/:projectId", async (request, reply) => {
    const session = requireProjectSession(options, request);
    verifyMutation(options, session, request);
    const command = projectMutationRequestSchema.parse(request.body);
    const result = requireProjectService(options).softDelete(
      session,
      parseProjectId(request),
      command.expectedVersion,
      parseIdempotencyKey(request.headers["idempotency-key"]),
    );
    return reply
      .header("cache-control", "no-store")
      .header("etag", etag(result.project.version))
      .header("idempotency-replayed", result.replayed ? "true" : "false")
      .send(projectSchema.parse(result.project));
  });

  app.post("/api/v1/projects/:projectId/restore", async (request, reply) => {
    const session = requireProjectSession(options, request);
    verifyMutation(options, session, request);
    const command = projectMutationRequestSchema.parse(request.body);
    const result = requireProjectService(options).restore(
      session,
      parseProjectId(request),
      command.expectedVersion,
      parseIdempotencyKey(request.headers["idempotency-key"]),
    );
    return reply
      .header("cache-control", "no-store")
      .header("etag", etag(result.project.version))
      .header("idempotency-replayed", result.replayed ? "true" : "false")
      .send(projectSchema.parse(result.project));
  });

  app.get("/api/v1/trash/projects", async (request, reply) => {
    const session = requireProjectSession(options, request);
    const query = parseListQuery(request);
    return reply
      .header("cache-control", "no-store")
      .send(
        trashProjectListResponseSchema.parse(
          requireProjectService(options).listTrash(session, query),
        ),
      );
  });
}

function requireProjectSession(
  options: RegisterProjectRoutesOptions,
  request: FastifyRequest,
) {
  return requireProtectedSession(options.identityService, request);
}

function verifyMutation(
  options: RegisterProjectRoutesOptions,
  session: ReturnType<typeof requireProjectSession>,
  request: FastifyRequest,
): void {
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
}

function requireProjectService(
  options: RegisterProjectRoutesOptions,
): ProjectService {
  if (options.projectService === undefined)
    throw new ApplicationError(
      "PROVIDER_UNAVAILABLE",
      "project_service_unavailable",
    );
  return options.projectService;
}

function parseProjectId(request: FastifyRequest): string {
  return projectIdSchema.parse(
    (request.params as { projectId?: unknown }).projectId,
  );
}

function parseListQuery(request: FastifyRequest) {
  const parsed = projectListQuerySchema.safeParse(request.query);
  if (
    !parsed.success &&
    (request.query as { cursor?: unknown }).cursor !== undefined
  )
    throw new ApplicationError("INVALID_CURSOR", "project_cursor_malformed");
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

function etag(version: number): string {
  return `"${version}"`;
}
