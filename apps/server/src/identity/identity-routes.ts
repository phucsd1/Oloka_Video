import {
  authSessionResponseSchema,
  adminUsersQuerySchema,
  adminUsersResponseSchema,
  adminUserTransitionRequestSchema,
  csrfResponseSchema,
  sessionsResponseSchema,
} from "@oloka/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { AppEnvironment } from "../config/environment.js";
import type { SystemDatabase } from "../database/database.js";
import { SystemClock } from "../kernel/clock.js";
import { UuidIdGenerator } from "../kernel/id-generator.js";
import {
  authenticationRequired,
  IdentityError,
  IdentityService,
  type AuthenticatedSession,
} from "./identity-service.js";
import {
  OpenIdClientAdapter,
  type OidcProviderClient,
} from "./oidc-provider-client.js";
import {
  clearSessionCookie,
  createSessionCookie,
  hashCoarseIpPrefix,
  readSessionCookie,
} from "./session-security.js";
import { AdminUserService } from "./admin-user-service.js";

export interface RegisterIdentityRoutesOptions {
  app: FastifyInstance;
  database: SystemDatabase;
  environment: AppEnvironment;
  oidcClient?: OidcProviderClient;
}

export function registerIdentityRoutes(
  options: RegisterIdentityRoutesOptions,
): void {
  const { app, database, environment } = options;
  const configuration = environment.identity;
  const applicationKey = environment.appKey;
  const service =
    configuration === undefined || applicationKey === undefined
      ? undefined
      : new IdentityService({
          transactions: database.transactions,
          oidcClient:
            options.oidcClient ??
            new OpenIdClientAdapter(
              configuration.googleIssuer,
              configuration.googleClientId,
              configuration.googleClientSecret,
            ),
          applicationKey,
          issuer: configuration.googleIssuer,
          redirectUri: `${configuration.publicOrigin}/api/v1/auth/google/callback`,
          bootstrapAdminEmail: configuration.bootstrapAdminEmail,
          oauthTransactionTtlMs: configuration.oauthTransactionTtlMs,
          sessionIdleTtlMs: configuration.sessionIdleTtlMs,
          sessionAbsoluteTtlMs: configuration.sessionAbsoluteTtlMs,
          clock: new SystemClock(),
          idGenerator: new UuidIdGenerator(),
        });
  const limiter =
    applicationKey === undefined
      ? undefined
      : new BoundedIdentityRateLimiter(applicationKey);
  const adminService = new AdminUserService(
    database.transactions,
    new SystemClock(),
    new UuidIdGenerator(),
  );

  app.addHook("onSend", async (request, reply, payload) => {
    if (
      request.url.startsWith("/api/v1/auth/") ||
      request.url.startsWith("/api/v1/admin/")
    ) {
      reply.header("cache-control", "no-store");
      reply.header("pragma", "no-cache");
    }
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header(
      "content-security-policy",
      "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    reply.header(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=()",
    );
    if (environment.nodeEnv === "production") {
      reply.header(
        "strict-transport-security",
        "max-age=31536000; includeSubDomains",
      );
    }
    return payload;
  });

  app.get("/api/v1/auth/google/start", async (request, reply) => {
    try {
      const activeService = requireIdentityService(service);
      limiter?.check("start", request.ip, 20, 60_000);
      const query = request.query as { returnPath?: unknown };
      const returnPath =
        typeof query.returnPath === "string" ? query.returnPath : "/";
      const destination = await activeService.startAuthorization(returnPath);
      return reply.code(302).header("location", destination.href).send();
    } catch (error) {
      return sendIdentityError(reply, error);
    }
  });

  app.get("/api/v1/auth/google/callback", async (request, reply) => {
    try {
      const activeService = requireIdentityService(service);
      const query = request.query as { state?: unknown; code?: unknown };
      if (typeof query.state !== "string" || typeof query.code !== "string") {
        throw new IdentityError(
          "OAUTH_CALLBACK_INVALID",
          400,
          true,
          "The Google callback is incomplete",
        );
      }
      const callbackUrl = new URL(
        request.url,
        configuration?.publicOrigin ?? "https://invalid.local",
      );
      const result = await activeService.finishAuthorization(
        callbackUrl,
        query.state,
        requestMetadata(request),
        readSessionCookie(request.headers.cookie) ?? undefined,
      );
      const maxAge = Math.floor(
        (configuration?.sessionAbsoluteTtlMs ?? 0) / 1000,
      );
      return reply
        .code(303)
        .header("set-cookie", createSessionCookie(result.sessionToken, maxAge))
        .header("location", result.returnPath)
        .send();
    } catch (error) {
      try {
        limiter?.check("callback-failure", request.ip, 30, 60_000);
      } catch (limited) {
        return sendIdentityError(reply, limited);
      }
      return sendIdentityError(reply, error);
    }
  });

  app.get("/api/v1/auth/session", async (request, reply) => {
    const session = resolveSession(service, request);
    return reply.send(
      authSessionResponseSchema.parse(
        session === null
          ? { authenticated: false }
          : { authenticated: true, user: session.user },
      ),
    );
  });

  app.get("/api/v1/auth/csrf", async (request, reply) => {
    try {
      const activeService = requireIdentityService(service);
      const session = requireSession(activeService, request);
      return reply.send(
        csrfResponseSchema.parse({
          csrfToken: activeService.rotateCsrfToken(session.sessionId),
        }),
      );
    } catch (error) {
      return sendIdentityError(reply, error);
    }
  });

  app.get("/api/v1/auth/sessions", async (request, reply) => {
    try {
      const activeService = requireIdentityService(service);
      const session = requireSession(activeService, request);
      return reply.send(
        sessionsResponseSchema.parse({
          sessions: activeService.listSessions(session),
        }),
      );
    } catch (error) {
      return sendIdentityError(reply, error);
    }
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    try {
      const activeService = requireIdentityService(service);
      const session = requireSession(activeService, request);
      verifyCsrfRequest(
        activeService,
        session,
        request,
        configuration?.publicOrigin,
        limiter,
      );
      activeService.logout(session);
      return reply.code(204).header("set-cookie", clearSessionCookie()).send();
    } catch (error) {
      return sendIdentityError(reply, error);
    }
  });

  app.post("/api/v1/auth/sessions/revoke-all", async (request, reply) => {
    try {
      const activeService = requireIdentityService(service);
      const session = requireSession(activeService, request);
      verifyCsrfRequest(
        activeService,
        session,
        request,
        configuration?.publicOrigin,
        limiter,
      );
      activeService.revokeAllSessions(session);
      return reply.code(204).header("set-cookie", clearSessionCookie()).send();
    } catch (error) {
      return sendIdentityError(reply, error);
    }
  });

  app.get("/api/v1/admin/users", async (request, reply) => {
    try {
      const activeService = requireIdentityService(service);
      const session = requireAdmin(activeService, request);
      const query = adminUsersQuerySchema.parse(request.query);
      void session;
      return reply.send(
        adminUsersResponseSchema.parse(adminService.list(query)),
      );
    } catch (error) {
      return sendIdentityError(reply, normalizeValidationError(error));
    }
  });

  app.patch("/api/v1/admin/users/:userId", async (request, reply) => {
    try {
      const activeService = requireIdentityService(service);
      const session = requireAdmin(activeService, request);
      verifyCsrfRequest(
        activeService,
        session,
        request,
        configuration?.publicOrigin,
        limiter,
      );
      const parameters = request.params as { userId?: unknown };
      if (
        typeof parameters.userId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          parameters.userId,
        )
      ) {
        throw validationFailed();
      }
      const idempotencyKey = request.headers["idempotency-key"];
      if (
        typeof idempotencyKey !== "string" ||
        idempotencyKey.length < 8 ||
        idempotencyKey.length > 200
      ) {
        throw new IdentityError(
          "IDEMPOTENCY_KEY_REQUIRED",
          400,
          false,
          "A valid Idempotency-Key header is required",
        );
      }
      const command = adminUserTransitionRequestSchema.parse(request.body);
      const result = adminService.transition(
        session,
        parameters.userId,
        command,
        idempotencyKey,
      );
      return reply
        .header("idempotency-replayed", result.replayed ? "true" : "false")
        .send({ user: result.user });
    } catch (error) {
      return sendIdentityError(reply, normalizeValidationError(error));
    }
  });
}

export function requireActiveUser(session: AuthenticatedSession): void {
  const decisions: Record<
    Exclude<AuthenticatedSession["user"]["status"], "active">,
    { code: string; message: string; retryable: boolean }
  > = {
    pending: {
      code: "ACCOUNT_PENDING",
      message: "Your account is waiting for approval",
      retryable: true,
    },
    disabled: {
      code: "ACCOUNT_DISABLED",
      message: "Your account is disabled",
      retryable: false,
    },
    rejected: {
      code: "ACCOUNT_REJECTED",
      message: "Your account request was rejected",
      retryable: false,
    },
  };
  if (session.user.status === "active") return;
  const decision = decisions[session.user.status];
  throw new IdentityError(
    decision.code,
    403,
    decision.retryable,
    decision.message,
  );
}

function resolveSession(
  service: IdentityService | undefined,
  request: FastifyRequest,
): AuthenticatedSession | null {
  if (service === undefined) return null;
  return service.getSession(readSessionCookie(request.headers.cookie));
}

function requireSession(
  service: IdentityService,
  request: FastifyRequest,
): AuthenticatedSession {
  const session = service.getSession(readSessionCookie(request.headers.cookie));
  if (session === null) throw authenticationRequired();
  return session;
}

function requireAdmin(
  service: IdentityService,
  request: FastifyRequest,
): AuthenticatedSession {
  const session = requireSession(service, request);
  service.auditStatusDenial(session);
  requireActiveUser(session);
  if (session.user.role !== "admin") {
    throw new IdentityError(
      "AUTHORIZATION_DENIED",
      403,
      false,
      "This operation requires an administrator",
    );
  }
  return session;
}

function verifyCsrfRequest(
  service: IdentityService,
  session: AuthenticatedSession,
  request: FastifyRequest,
  publicOrigin: string | undefined,
  limiter: BoundedIdentityRateLimiter | undefined,
): void {
  let failureCategory: string | undefined;
  const origin = request.headers.origin;
  const referer = request.headers.referer;
  if (publicOrigin === undefined) failureCategory = "configuration";
  else if (origin !== undefined) {
    if (origin !== publicOrigin) failureCategory = "origin";
  } else if (referer !== undefined) {
    try {
      if (new URL(referer).origin !== publicOrigin) failureCategory = "referer";
    } catch {
      failureCategory = "referer";
    }
  } else failureCategory = "missing_source";
  const contentType = request.headers["content-type"];
  if (
    failureCategory === undefined &&
    (typeof contentType !== "string" ||
      !contentType.toLowerCase().startsWith("application/json"))
  ) {
    failureCategory = "content_type";
  }
  const csrfHeader = request.headers["x-oloka-csrf"];
  if (
    failureCategory === undefined &&
    (typeof csrfHeader !== "string" ||
      !service.verifyCsrfToken(session.sessionId, csrfHeader))
  ) {
    failureCategory = "token";
  }
  if (failureCategory !== undefined) {
    service.auditCsrfFailure(session, failureCategory);
    limiter?.check("csrf-failure", request.ip, 30, 60_000);
    throw new IdentityError(
      "CSRF_VALIDATION_FAILED",
      403,
      false,
      "The request could not be verified",
    );
  }
}

function requireIdentityService(
  service: IdentityService | undefined,
): IdentityService {
  if (service === undefined) {
    throw new IdentityError(
      "IDENTITY_CONFIGURATION_UNAVAILABLE",
      503,
      true,
      "Identity service is not configured",
    );
  }
  return service;
}

function normalizeValidationError(error: unknown): unknown {
  return error instanceof Error && error.name === "ZodError"
    ? validationFailed()
    : error;
}

function validationFailed(): IdentityError {
  return new IdentityError(
    "VALIDATION_FAILED",
    400,
    false,
    "The request did not match the required contract",
  );
}

function requestMetadata(request: FastifyRequest): {
  ipAddress: string;
  userAgent?: string;
} {
  const userAgent = request.headers["user-agent"];
  return {
    ipAddress: request.ip,
    ...(typeof userAgent === "string" ? { userAgent } : {}),
  };
}

export function sendIdentityError(
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  const identityError =
    error instanceof IdentityError
      ? error
      : new IdentityError(
          "IDENTITY_PROVIDER_FAILURE",
          502,
          true,
          "The identity provider request failed",
        );
  return reply.code(identityError.statusCode).send({
    error: {
      code: identityError.code,
      message: identityError.message,
      correlationId: randomUUID(),
      retryable: identityError.retryable,
    },
  });
}

class BoundedIdentityRateLimiter {
  private readonly entries = new Map<
    string,
    { count: number; resetAt: number }
  >();

  constructor(private readonly applicationKey: Uint8Array) {}

  check(
    category: string,
    ipAddress: string,
    maximum: number,
    windowMs: number,
  ): void {
    const now = Date.now();
    const key = `${category}:${hashCoarseIpPrefix(this.applicationKey, ipAddress).toString("hex")}`;
    const current = this.entries.get(key);
    if (current === undefined || current.resetAt <= now) {
      if (this.entries.size >= 1_000)
        this.entries.delete(this.entries.keys().next().value as string);
      this.entries.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    current.count += 1;
    if (current.count > maximum) {
      throw new IdentityError(
        "RATE_LIMITED",
        429,
        true,
        "Too many identity requests",
      );
    }
  }
}
