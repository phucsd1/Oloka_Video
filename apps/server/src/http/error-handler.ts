import { errorEnvelopeSchema } from "@oloka/contracts";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { ApplicationError, publicErrorCatalog } from "./application-error.js";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const applicationError = normalizeApplicationError(error);
    const definition = publicErrorCatalog[applicationError.code];
    const requestId = request.id;
    reply.header("x-request-id", requestId);
    for (const [name, value] of Object.entries(
      applicationError.responseHeaders ?? {},
    )) {
      reply.header(name, value);
    }
    if (applicationError.code === "INTERNAL_ERROR") {
      request.log.error(
        {
          event: "http.request.failed",
          requestId,
          internalCause: applicationError.internalCause ?? "unexpected_error",
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "request failed",
      );
    }
    return reply.code(definition.statusCode).send(
      errorEnvelopeSchema.parse({
        error: {
          code: applicationError.code,
          retryable: definition.retryable,
          messageKey: definition.messageKey,
          suggestedAction: definition.suggestedAction,
          requestId,
        },
      }),
    );
  });
}

function normalizeApplicationError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  if (error instanceof ZodError) {
    return new ApplicationError("VALIDATION_ERROR", "request_schema_invalid");
  }
  if (isFastifyValidationError(error)) {
    return new ApplicationError(
      "VALIDATION_ERROR",
      "fastify_validation_failed",
    );
  }
  return new ApplicationError("INTERNAL_ERROR", "unexpected_application_error");
}

function isFastifyValidationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { statusCode?: unknown; code?: unknown };
  return (
    candidate.statusCode === 400 || candidate.code === "FST_ERR_VALIDATION"
  );
}
