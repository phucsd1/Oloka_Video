import {
  authSessionResponseSchema,
  adminUsersQuerySchema,
  adminUsersResponseSchema,
  adminUserTransitionRequestSchema,
  csrfResponseSchema,
  sessionsResponseSchema,
} from "@oloka/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
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
import { parseIdempotencyKey } from "./idempotency-key.js";

export interface RegisterIdentityRoutesOptions {
  app: FastifyInstance;
  database: SystemDatabase;
  environment: AppEnvironment;
  oidcClient?: OidcProviderClient;
}

export function registerIdentityRoutes(
  options: RegisterIdentityRoutesOptions,
): IdentityService | undefined {
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
  const adminService =
    applicationKey === undefined
      ? undefined
      : new AdminUserService(
          database.transactions,
          new SystemClock(),
          new UuidIdGenerator(),
          applicationKey,
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
    reply.header(
      "referrer-policy",
      request.url.startsWith("/api/v1/auth/google/callback")
        ? "no-referrer"
        : "strict-origin-when-cross-origin",
    );
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
    const activeService = requireIdentityService(service);
    limiter?.check("start", request.ip, 20, 60_000);
    const query = request.query as { returnPath?: unknown };
    const returnPath =
      typeof query.returnPath === "string" ? query.returnPath : "/";
    const destination = await activeService.startAuthorization(returnPath);
    return reply.code(302).header("location", destination.href).send();
  });

  app.get("/api/v1/auth/google/callback", async (request, reply) => {
    try {
      const activeService = requireIdentityService(service);
      const query = request.query as {
        state?: unknown;
        code?: unknown;
        error?: unknown;
      };
      if (typeof query.state !== "string") {
        throw new IdentityError(
          "VALIDATION_ERROR",
          "oauth_callback_incomplete",
        );
      }
      if (typeof query.error === "string") {
        activeService.denyAuthorization(
          query.state,
          typeof query.code === "string"
            ? "invalid_callback"
            : query.error === "access_denied"
              ? "user_denied"
              : "provider_error",
        );
        return reply.code(303).header("location", "/auth/error").send();
      }
      if (typeof query.code !== "string") {
        activeService.denyAuthorization(query.state, "invalid_callback");
        return reply.code(303).header("location", "/auth/error").send();
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
        if (limited instanceof IdentityError) {
          for (const [name, value] of Object.entries(
            limited.responseHeaders ?? {},
          )) {
            reply.header(name, value);
          }
        }
      }
      request.log.info(
        {
          event: "identity.oauth_callback.denied",
          requestId: request.id,
          failureCategory: callbackFailureCategory(error),
        },
        "OAuth callback failed",
      );
      return reply.code(303).header("location", "/auth/error").send();
    }
  });

  app.get("/api/v1/auth/session", async (request, reply) => {
    const session = resolveSession(service, request);
    if (session === null) throw authenticationRequired();
    return reply.send(
      authSessionResponseSchema.parse({
        authenticated: true,
        user: session.user,
      }),
    );
  });

  app.get("/api/v1/auth/csrf", async (request, reply) => {
    const activeService = requireIdentityService(service);
    const session = requireSession(activeService, request);
    return reply.send(
      csrfResponseSchema.parse({
        csrfToken: activeService.rotateCsrfToken(session.sessionId),
      }),
    );
  });

  app.get("/api/v1/auth/sessions", async (request, reply) => {
    const activeService = requireIdentityService(service);
    const session = requireSession(activeService, request);
    return reply.send(
      sessionsResponseSchema.parse({
        sessions: activeService.listSessions(session),
      }),
    );
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
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
  });

  app.post("/api/v1/auth/sessions/revoke-all", async (request, reply) => {
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
  });

  app.get("/api/v1/admin/users", async (request, reply) => {
    const activeService = requireIdentityService(service);
    const session = requireAdmin(activeService, request);
    const parsedQuery = adminUsersQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      const rawQuery = request.query as { cursor?: unknown };
      if (rawQuery.cursor !== undefined) {
        throw new IdentityError("INVALID_CURSOR", "admin_cursor_malformed");
      }
      throw parsedQuery.error;
    }
    const query = parsedQuery.data;
    void session;
    return reply.send(
      adminUsersResponseSchema.parse(
        requireAdminService(adminService).list(query),
      ),
    );
  });

  app.patch("/api/v1/admin/users/:userId", async (request, reply) => {
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
      throw new IdentityError("VALIDATION_ERROR", "admin_user_id_invalid");
    }
    const idempotencyKey = parseIdempotencyKey(
      request.headers["idempotency-key"],
    );
    const command = adminUserTransitionRequestSchema.parse(request.body);
    const result = requireAdminService(adminService).transition(
      session,
      parameters.userId,
      command,
      idempotencyKey,
    );
    return reply
      .header("idempotency-replayed", result.replayed ? "true" : "false")
      .send({ user: result.user });
  });
  return service;
}

function callbackFailureCategory(error: unknown): string {
  if (!(error instanceof IdentityError)) return "provider_error";
  if (error.internalCause === "oauth_transaction_expired_or_consumed") {
    return "invalid_callback";
  }
  if (error.code === "AUTHENTICATION_REQUIRED") return "invalid_callback";
  return "provider_error";
}

function requireAdminService(
  service: AdminUserService | undefined,
): AdminUserService {
  if (service === undefined) {
    throw new IdentityError(
      "PROVIDER_UNAVAILABLE",
      "identity_configuration_unavailable",
    );
  }
  return service;
}

export function requireActiveUser(session: AuthenticatedSession): void {
  const decisions: Record<
    Exclude<AuthenticatedSession["user"]["status"], "active">,
    "ACCOUNT_PENDING" | "ACCOUNT_DISABLED" | "ACCOUNT_REJECTED"
  > = {
    pending: "ACCOUNT_PENDING",
    disabled: "ACCOUNT_DISABLED",
    rejected: "ACCOUNT_REJECTED",
  };
  if (session.user.status === "active") return;
  throw new IdentityError(
    decisions[session.user.status],
    `account_${session.user.status}`,
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

export function requireProtectedSession(
  service: IdentityService | undefined,
  request: FastifyRequest,
): AuthenticatedSession {
  if (service === undefined) throw authenticationRequired();
  const session = requireSession(service, request);
  service.auditStatusDenial(session);
  requireActiveUser(session);
  return session;
}

export function verifyProtectedCsrfRequest(
  service: IdentityService,
  session: AuthenticatedSession,
  request: FastifyRequest,
  publicOrigin: string | undefined,
  allowedContentTypes: readonly string[] = ["application/json"],
): void {
  verifyCsrfRequest(
    service,
    session,
    request,
    publicOrigin,
    undefined,
    allowedContentTypes,
  );
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
      "administrator_role_required",
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
  allowedContentTypes: readonly string[] = ["application/json"],
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
      !allowedContentTypes.some((allowed) =>
        contentType.toLowerCase().startsWith(allowed),
      ))
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
    throw new IdentityError("AUTHORIZATION_DENIED", `csrf_${failureCategory}`);
  }
}

function requireIdentityService(
  service: IdentityService | undefined,
): IdentityService {
  if (service === undefined) {
    throw new IdentityError(
      "PROVIDER_UNAVAILABLE",
      "identity_configuration_unavailable",
    );
  }
  return service;
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

export class BoundedIdentityRateLimiter {
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
      throw new IdentityError("RATE_LIMITED", "identity_rate_limit_exceeded", {
        "retry-after": String(
          Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
        ),
      });
    }
  }
}
