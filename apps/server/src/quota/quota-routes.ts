import {
  createQuotaPolicyRequestSchema,
  quotaPolicyListResponseSchema,
  quotaPolicyRecordSchema,
} from "@oloka/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { IdentityService } from "../identity/identity-service.js";
import {
  requireProtectedSession,
  verifyProtectedCsrfRequest,
} from "../identity/identity-routes.js";
import { parseIdempotencyKey } from "../identity/idempotency-key.js";
import { ApplicationError } from "../http/application-error.js";
import type { QuotaPolicyService } from "./quota-policy-service.js";

export interface RegisterQuotaRoutesOptions {
  app: FastifyInstance;
  identityService: IdentityService | undefined;
  quotaPolicyService: QuotaPolicyService;
  publicOrigin: string | undefined;
}

export function registerQuotaRoutes(options: RegisterQuotaRoutesOptions): void {
  options.app.get("/api/v1/admin/quota-policies", (request) => {
    requireAdmin(options.identityService, request);
    return quotaPolicyListResponseSchema.parse(
      options.quotaPolicyService.list(),
    );
  });
  options.app.post("/api/v1/admin/quota-policies", async (request, reply) => {
    const session = requireAdmin(options.identityService, request);
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
    const result = options.quotaPolicyService.create(
      session,
      createQuotaPolicyRequestSchema.parse(request.body),
      parseIdempotencyKey(request.headers["idempotency-key"]),
    );
    return reply
      .code(201)
      .header("idempotency-replayed", result.replayed ? "true" : "false")
      .send(quotaPolicyRecordSchema.parse(result.policy));
  });
}

function requireAdmin(
  identityService: IdentityService | undefined,
  request: FastifyRequest,
) {
  const session = requireProtectedSession(identityService, request);
  if (session.user.role !== "admin")
    throw new ApplicationError(
      "AUTHORIZATION_DENIED",
      "administrator_role_required",
    );
  return session;
}
