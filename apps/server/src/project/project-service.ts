import type {
  CreateProjectRequest,
  Project,
  ProjectListResponse,
  UpdateProjectRequest,
} from "@oloka/contracts";
import { projectListResponseSchema, projectSchema } from "@oloka/contracts";
import { createHmac, timingSafeEqual } from "node:crypto";
import { AuditEventRepository } from "../database/repositories/audit-event-repository.js";
import { IdempotencyRepository } from "../database/repositories/idempotency-repository.js";
import {
  mapProject,
  ProjectRepository,
} from "../database/repositories/project-repository.js";
import type { TransactionRunner } from "../database/database.js";
import { ApplicationError } from "../http/application-error.js";
import { sha256CanonicalJson } from "../kernel/canonical-json.js";
import type { Clock } from "../kernel/clock.js";
import type { IdGenerator } from "../kernel/id-generator.js";
import type { AuthenticatedSession } from "../identity/identity-service.js";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const PROJECT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ProjectServiceOptions {
  transactions: TransactionRunner;
  applicationKey: Uint8Array;
  clock: Clock;
  idGenerator: IdGenerator;
}

export class ProjectService {
  private readonly projects = new ProjectRepository();
  private readonly idempotency: IdempotencyRepository;
  private readonly audit: AuditEventRepository;

  constructor(private readonly options: ProjectServiceOptions) {
    this.idempotency = new IdempotencyRepository(options.idGenerator);
    this.audit = new AuditEventRepository(options.idGenerator);
  }

  create(
    actor: AuthenticatedSession,
    request: CreateProjectRequest,
    idempotencyKey: string,
  ): { project: Project; replayed: boolean } {
    const now = this.options.clock.now();
    const projectId = this.options.idGenerator.generate();
    return this.options.transactions.run("immediate", (context) => {
      const begin = this.idempotency.begin(context, {
        userId: actor.user.id,
        operation: "project.create",
        idempotencyKey,
        semanticRequestHashSha256: sha256CanonicalJson(request),
        createdAt: now,
        expiresAt: now + IDEMPOTENCY_TTL_MS,
      });
      if (begin.kind === "replay") {
        const response = begin.response as { project: Project };
        return { project: response.project, replayed: true };
      }
      if (begin.kind !== "started" && begin.kind !== "retryable") {
        throw new ApplicationError(
          begin.kind === "conflict"
            ? "IDEMPOTENCY_CONFLICT"
            : "RESOURCE_STATE_CONFLICT",
          begin.kind === "conflict"
            ? "project_idempotency_conflict"
            : "project_idempotency_in_progress",
        );
      }
      const project = projectSchema.parse(
        mapProject(
          this.projects.create(context, {
            id: projectId,
            ownerUserId: actor.user.id,
            name: request.name,
            description: request.description ?? null,
            now,
          }),
        ),
      );
      this.audit.append(context, {
        actorUserId: actor.user.id,
        actorType: actor.user.role === "admin" ? "admin" : "user",
        action: "project.create",
        resourceType: "project",
        resourceId: project.id,
        outcome: "success",
        metadata: { status: project.status },
        createdAt: now,
      });
      const response = { project };
      this.idempotency.complete(context, {
        recordId: begin.recordId,
        responseStatus: 201,
        response,
        resourceId: project.id,
      });
      return { ...response, replayed: false };
    });
  }

  listActive(
    actor: AuthenticatedSession,
    query: { limit: number; cursor?: string; favorite?: boolean },
  ): ProjectListResponse {
    return this.listByStatus(actor, "active", query);
  }

  getActive(actor: AuthenticatedSession, projectId: string): Project {
    return this.options.transactions.run("read", (context) => {
      const row = this.projects.getById(context, projectId);
      if (
        row === null ||
        row.owner_user_id !== actor.user.id ||
        row.status !== "active"
      ) {
        throw new ApplicationError("RESOURCE_NOT_FOUND", "project_not_found");
      }
      return projectSchema.parse(mapProject(row));
    });
  }

  update(
    actor: AuthenticatedSession,
    projectId: string,
    request: UpdateProjectRequest,
    idempotencyKey: string,
  ): { project: Project; replayed: boolean } {
    const now = this.options.clock.now();
    return this.options.transactions.run("immediate", (context) => {
      const begin = this.idempotency.begin(context, {
        userId: actor.user.id,
        operation: `project.update:${projectId}`,
        idempotencyKey,
        semanticRequestHashSha256: sha256CanonicalJson({
          projectId,
          ...request,
        }),
        createdAt: now,
        expiresAt: now + IDEMPOTENCY_TTL_MS,
      });
      if (begin.kind === "replay") {
        return {
          project: (begin.response as { project: Project }).project,
          replayed: true,
        };
      }
      if (begin.kind !== "started" && begin.kind !== "retryable")
        throw this.idempotencyError(begin.kind);
      const updated = this.projects.updatePresentation(context, {
        projectId,
        ownerUserId: actor.user.id,
        expectedVersion: request.expectedVersion,
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.description === undefined
          ? {}
          : { description: request.description }),
        ...(request.favorite === undefined
          ? {}
          : { favorite: request.favorite }),
        now,
      });
      if (updated === null)
        this.throwMutationConflict(
          context,
          actor,
          projectId,
          request.expectedVersion,
        );
      const project = projectSchema.parse(mapProject(updated));
      this.audit.append(context, {
        actorUserId: actor.user.id,
        actorType: actor.user.role === "admin" ? "admin" : "user",
        action: "project.update",
        resourceType: "project",
        resourceId: projectId,
        outcome: "success",
        metadata: { version: project.version },
        createdAt: now,
      });
      const response = { project };
      this.idempotency.complete(context, {
        recordId: begin.recordId,
        responseStatus: 200,
        response,
        resourceId: projectId,
      });
      return { ...response, replayed: false };
    });
  }

  softDelete(
    actor: AuthenticatedSession,
    projectId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): { project: Project; replayed: boolean } {
    const now = this.options.clock.now();
    return this.options.transactions.run("immediate", (context) => {
      const begin = this.idempotency.begin(context, {
        userId: actor.user.id,
        operation: `project.delete:${projectId}`,
        idempotencyKey,
        semanticRequestHashSha256: sha256CanonicalJson({
          projectId,
          expectedVersion,
        }),
        createdAt: now,
        expiresAt: now + IDEMPOTENCY_TTL_MS,
      });
      if (begin.kind === "replay")
        return {
          project: (begin.response as { project: Project }).project,
          replayed: true,
        };
      if (begin.kind !== "started" && begin.kind !== "retryable")
        throw this.idempotencyError(begin.kind);
      const deleted = this.projects.softDelete(context, {
        projectId,
        ownerUserId: actor.user.id,
        expectedVersion,
        now,
        purgeAfter: now + PROJECT_RETENTION_MS,
      });
      if (deleted === null)
        this.throwMutationConflict(context, actor, projectId, expectedVersion);
      return this.completeMutation(
        context,
        actor,
        begin.recordId,
        projectSchema.parse(mapProject(deleted)),
        "project.delete_requested",
        now,
      );
    });
  }

  restore(
    actor: AuthenticatedSession,
    projectId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): { project: Project; replayed: boolean } {
    const now = this.options.clock.now();
    return this.options.transactions.run("immediate", (context) => {
      const begin = this.idempotency.begin(context, {
        userId: actor.user.id,
        operation: `project.restore:${projectId}`,
        idempotencyKey,
        semanticRequestHashSha256: sha256CanonicalJson({
          projectId,
          expectedVersion,
        }),
        createdAt: now,
        expiresAt: now + IDEMPOTENCY_TTL_MS,
      });
      if (begin.kind === "replay")
        return {
          project: (begin.response as { project: Project }).project,
          replayed: true,
        };
      if (begin.kind !== "started" && begin.kind !== "retryable")
        throw this.idempotencyError(begin.kind);
      const restored = this.projects.restore(context, {
        projectId,
        ownerUserId: actor.user.id,
        expectedVersion,
        now,
      });
      if (restored === null) {
        const current = this.projects.getById(context, projectId);
        if (current === null || current.owner_user_id !== actor.user.id)
          throw new ApplicationError("RESOURCE_NOT_FOUND", "project_not_found");
        if (current.version !== expectedVersion)
          throw new ApplicationError(
            "VERSION_CONFLICT",
            "project_version_stale",
          );
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "project_restore_not_allowed",
        );
      }
      return this.completeMutation(
        context,
        actor,
        begin.recordId,
        projectSchema.parse(mapProject(restored)),
        "project.restore",
        now,
      );
    });
  }

  listTrash(
    actor: AuthenticatedSession,
    query: { limit: number; cursor?: string },
  ): ProjectListResponse {
    return this.listByStatus(actor, "soft_deleted", query);
  }

  private listByStatus(
    actor: AuthenticatedSession,
    status: "active" | "soft_deleted",
    query: { limit: number; cursor?: string; favorite?: boolean },
  ): ProjectListResponse {
    const filterHash = sha256CanonicalJson({
      ownerUserId: actor.user.id,
      status,
      favorite: query.favorite ?? null,
    });
    const cursor =
      query.cursor === undefined
        ? undefined
        : this.decodeCursor(query.cursor, filterHash);
    return this.options.transactions.run("read", (context) => {
      const rows = this.projects.listOwned(context, {
        ownerUserId: actor.user.id,
        status,
        ...(query.favorite === undefined ? {} : { favorite: query.favorite }),
        ...(cursor === undefined ? {} : { cursor }),
        limit: query.limit + 1,
      });
      const hasNextPage = rows.length > query.limit;
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return projectListResponseSchema.parse({
        projects: page.map(mapProject),
        nextCursor:
          hasNextPage && last !== undefined
            ? this.encodeCursor(
                {
                  favorite: last.favorite,
                  updatedAt: last.updated_at,
                  id: last.id,
                },
                filterHash,
              )
            : null,
      });
    });
  }

  private encodeCursor(
    sort: { favorite: number; updatedAt: number; id: string },
    filterHash: string,
  ): string {
    const payload = Buffer.from(
      JSON.stringify({ v: 1, sort, filterHash }),
      "utf8",
    ).toString("base64url");
    const signature = createHmac("sha256", this.options.applicationKey)
      .update(payload, "utf8")
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  private decodeCursor(
    cursor: string,
    expectedFilterHash: string,
  ): { favorite: number; updatedAt: number; id: string } {
    try {
      const [payload, signature, extra] = cursor.split(".");
      if (
        payload === undefined ||
        signature === undefined ||
        extra !== undefined
      )
        throw new Error();
      const expected = createHmac("sha256", this.options.applicationKey)
        .update(payload, "utf8")
        .digest();
      const actual = Buffer.from(signature, "base64url");
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      )
        throw new Error();
      const decoded = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as {
        v?: unknown;
        sort?: { favorite?: unknown; updatedAt?: unknown; id?: unknown };
        filterHash?: unknown;
      };
      if (
        decoded.v !== 1 ||
        (decoded.sort?.favorite !== 0 && decoded.sort?.favorite !== 1) ||
        typeof decoded.sort.updatedAt !== "number" ||
        !Number.isSafeInteger(decoded.sort.updatedAt) ||
        typeof decoded.sort.id !== "string" ||
        typeof decoded.filterHash !== "string" ||
        decoded.filterHash !== expectedFilterHash
      )
        throw new Error();
      return {
        favorite: decoded.sort.favorite,
        updatedAt: decoded.sort.updatedAt,
        id: decoded.sort.id,
      };
    } catch {
      throw new ApplicationError("INVALID_CURSOR", "project_cursor_invalid");
    }
  }

  private idempotencyError(kind: "conflict" | "in_progress"): ApplicationError {
    return new ApplicationError(
      kind === "conflict" ? "IDEMPOTENCY_CONFLICT" : "RESOURCE_STATE_CONFLICT",
      kind === "conflict"
        ? "project_idempotency_conflict"
        : "project_idempotency_in_progress",
    );
  }

  private completeMutation(
    context: Parameters<ProjectRepository["getById"]>[0],
    actor: AuthenticatedSession,
    recordId: string,
    project: Project,
    action: "project.delete_requested" | "project.restore",
    now: number,
  ): { project: Project; replayed: false } {
    this.audit.append(context, {
      actorUserId: actor.user.id,
      actorType: actor.user.role === "admin" ? "admin" : "user",
      action,
      resourceType: "project",
      resourceId: project.id,
      outcome: "success",
      metadata: { status: project.status, version: project.version },
      createdAt: now,
    });
    const response = { project };
    this.idempotency.complete(context, {
      recordId,
      responseStatus: 200,
      response,
      resourceId: project.id,
    });
    return { ...response, replayed: false };
  }

  private throwMutationConflict(
    context: Parameters<ProjectRepository["getById"]>[0],
    actor: AuthenticatedSession,
    projectId: string,
    expectedVersion: number,
  ): never {
    const current = this.projects.getById(context, projectId);
    if (current === null || current.owner_user_id !== actor.user.id)
      throw new ApplicationError("RESOURCE_NOT_FOUND", "project_not_found");
    if (current.status !== "active")
      throw new ApplicationError(
        "RESOURCE_STATE_CONFLICT",
        "project_not_active",
      );
    if (current.version !== expectedVersion)
      throw new ApplicationError("VERSION_CONFLICT", "project_version_stale");
    throw new ApplicationError(
      "RESOURCE_STATE_CONFLICT",
      "project_mutation_conflict",
    );
  }
}
