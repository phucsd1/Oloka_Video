import {
  compositionListQuerySchema,
  compositionListResponseSchema,
  compositionVersionSchema,
  createCompositionRequestSchema,
  deriveCompositionRequestSchema,
  previewArtifactSchema,
  requestPreviewRequestSchema,
} from "@oloka/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { IdentityService } from "../identity/identity-service.js";
import {
  requireProtectedSession,
  verifyProtectedCsrfRequest,
} from "../identity/identity-routes.js";
import { parseIdempotencyKey } from "../identity/idempotency-key.js";
import { ApplicationError } from "../http/application-error.js";
import type { CompositionService } from "./composition-service.js";

const idSchema = z.uuid();

export interface RegisterCompositionRoutesOptions {
  app: FastifyInstance;
  identityService: IdentityService | undefined;
  compositionService: CompositionService | undefined;
  storage: {
    head(storageKey: string): Promise<{ size: number; modifiedAt: Date }>;
    openRange(
      storageKey: string,
      start: number,
      end: number,
    ): Promise<NodeJS.ReadableStream>;
  };
  publicOrigin: string | undefined;
}

export function registerCompositionRoutes(
  options: RegisterCompositionRoutesOptions,
): void {
  const requireService = () => {
    if (options.compositionService === undefined)
      throw new ApplicationError(
        "PROVIDER_UNAVAILABLE",
        "composition_service_unavailable",
      );
    return options.compositionService;
  };
  const session = (request: FastifyRequest) =>
    requireProtectedSession(options.identityService, request);
  const verifyMutation = (request: FastifyRequest) => {
    const current = session(request);
    if (options.identityService === undefined)
      throw new ApplicationError(
        "AUTHENTICATION_REQUIRED",
        "identity_unavailable",
      );
    verifyProtectedCsrfRequest(
      options.identityService,
      current,
      request,
      options.publicOrigin,
    );
    return current;
  };
  const idempotency = (request: FastifyRequest) => {
    return parseIdempotencyKey(request.headers["idempotency-key"]);
  };
  const parameter = (request: FastifyRequest, name: string) =>
    idSchema.parse((request.params as Record<string, unknown>)[name]);

  options.app.get(
    "/api/v1/projects/:projectId/compositions",
    async (request, reply) => {
      const actor = session(request);
      const query = compositionListQuerySchema.parse(request.query);
      return reply
        .header("cache-control", "no-store")
        .send(
          compositionListResponseSchema.parse(
            requireService().list(
              actor,
              parameter(request, "projectId"),
              query,
            ),
          ),
        );
    },
  );

  options.app.post(
    "/api/v1/projects/:projectId/compositions",
    async (request, reply) => {
      const actor = verifyMutation(request);
      const result = requireService().create(
        actor,
        parameter(request, "projectId"),
        createCompositionRequestSchema.parse(request.body),
        idempotency(request),
      );
      return reply
        .code(result.replayed ? 200 : 201)
        .header("cache-control", "no-store")
        .header("etag", `"${result.composition.versionNumber}"`)
        .header("idempotency-replayed", result.replayed ? "true" : "false")
        .send(compositionVersionSchema.parse(result.composition));
    },
  );

  options.app.get(
    "/api/v1/compositions/:compositionVersionId",
    async (request, reply) => {
      const actor = session(request);
      const composition = requireService().get(
        actor,
        parameter(request, "compositionVersionId"),
      );
      return reply
        .header("cache-control", "no-store")
        .header("etag", `"${composition.canonicalHashSha256}"`)
        .send(compositionVersionSchema.parse(composition));
    },
  );

  options.app.post(
    "/api/v1/compositions/:compositionVersionId/derive",
    async (request, reply) => {
      const actor = verifyMutation(request);
      const result = requireService().derive(
        actor,
        parameter(request, "compositionVersionId"),
        deriveCompositionRequestSchema.parse(request.body),
        idempotency(request),
      );
      return reply
        .code(result.replayed ? 200 : 201)
        .header("cache-control", "no-store")
        .header("etag", `"${result.composition.versionNumber}"`)
        .header("idempotency-replayed", result.replayed ? "true" : "false")
        .send(compositionVersionSchema.parse(result.composition));
    },
  );

  options.app.post(
    "/api/v1/compositions/:compositionVersionId/validate",
    async (request, reply) => {
      const actor = verifyMutation(request);
      const result = requireService().validate(
        actor,
        parameter(request, "compositionVersionId"),
        idempotency(request),
      );
      return reply
        .header("cache-control", "no-store")
        .header("idempotency-replayed", result.replayed ? "true" : "false")
        .send(result.validation);
    },
  );

  options.app.get(
    "/api/v1/projects/:projectId/compositions/current",
    async (request, reply) => {
      const actor = session(request);
      const composition = requireService().current(
        actor,
        parameter(request, "projectId"),
      );
      return reply
        .header("cache-control", "no-store")
        .send(
          composition === null
            ? null
            : compositionVersionSchema.parse(composition),
        );
    },
  );

  options.app.post(
    "/api/v1/compositions/:compositionVersionId/preview",
    async (request, reply) => {
      const actor = verifyMutation(request);
      requestPreviewRequestSchema.parse(request.body ?? {});
      const result = await requireService().requestPreview(
        actor,
        parameter(request, "compositionVersionId"),
        idempotency(request),
      );
      return reply
        .code(result.replayed ? 200 : 201)
        .header("cache-control", "no-store")
        .header("idempotency-replayed", result.replayed ? "true" : "false")
        .send(previewArtifactSchema.parse(result.preview));
    },
  );

  options.app.get(
    "/api/v1/previews/:previewArtifactId",
    async (request, reply) => {
      const actor = session(request);
      const descriptor = requireService().previewDescriptor(
        actor,
        parameter(request, "previewArtifactId"),
      );
      return reply
        .header("cache-control", "no-store")
        .header("etag", `"${descriptor.preview.byteChecksumSha256}"`)
        .send(descriptor.preview);
    },
  );

  options.app.get(
    "/api/v1/previews/:previewArtifactId/content",
    { exposeHeadRoute: false },
    async (request, reply) =>
      sendContent(
        options,
        session(request),
        parameter(request, "previewArtifactId"),
        reply,
        false,
      ),
  );
  options.app.head(
    "/api/v1/previews/:previewArtifactId/content",
    async (request, reply) =>
      sendContent(
        options,
        session(request),
        parameter(request, "previewArtifactId"),
        reply,
        true,
      ),
  );
}

async function sendContent(
  options: RegisterCompositionRoutesOptions,
  actor: ReturnType<typeof requireProtectedSession>,
  previewArtifactId: string,
  reply: FastifyReply,
  headOnly: boolean,
) {
  const descriptor = options.compositionService?.previewDescriptor(
    actor,
    previewArtifactId,
  );
  if (descriptor === undefined)
    throw new ApplicationError(
      "PROVIDER_UNAVAILABLE",
      "composition_service_unavailable",
    );
  let object;
  try {
    object = await options.storage.head(descriptor.storageKey);
  } catch {
    throw new ApplicationError("STORAGE_UNAVAILABLE", "preview_bytes_missing");
  }
  const etag = `"${descriptor.preview.byteChecksumSha256}"`;
  if (reply.request.headers["if-none-match"] === etag)
    return reply
      .code(304)
      .header("content-security-policy", "sandbox allow-scripts")
      .header("etag", etag)
      .send();
  const range = parseRange(reply.request.headers.range, object.size);
  const response = reply
    .code(range.partial ? 206 : 200)
    .header("accept-ranges", "bytes")
    .header("content-length", String(range.end - range.start + 1))
    .header("content-type", "text/html; charset=utf-8")
    .header("content-disposition", "inline; filename=preview.html")
    .header("content-security-policy", "sandbox allow-scripts")
    .header("etag", etag)
    .header("last-modified", object.modifiedAt.toUTCString())
    .header("x-content-type-options", "nosniff")
    .header("cache-control", "private, max-age=0, must-revalidate");
  if (range.partial)
    response.header(
      "content-range",
      `bytes ${range.start}-${range.end}/${object.size}`,
    );
  if (headOnly) return response.send();
  return response.send(
    await options.storage.openRange(
      descriptor.storageKey,
      range.start,
      range.end,
    ),
  );
}

function parseRange(value: string | undefined, size: number) {
  if (size < 1) throw rangeError(size);
  if (value === undefined) return { start: 0, end: size - 1, partial: false };
  if (!value.startsWith("bytes=") || value.includes(","))
    throw rangeError(size);
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (match === null || (match[1] === "" && match[2] === ""))
    throw rangeError(size);
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw rangeError(size);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  )
    throw rangeError(size);
  return { start, end: Math.min(end, size - 1), partial: true };
}

function rangeError(size: number): ApplicationError {
  return new ApplicationError(
    "RANGE_NOT_SATISFIABLE",
    "preview_range_invalid",
    { "content-range": `bytes */${size}` },
  );
}
