import {
  assetListQuerySchema,
  assetListResponseSchema,
  assetMutationRequestSchema,
  assetRetryIngestionRequestSchema,
  assetSchema,
  deliveryCapabilityRequestSchema,
  deliveryCapabilityResponseSchema,
  deliveryOperationSchema,
  initializeUploadRequestSchema,
  jobSchema,
  uploadCompleteRequestSchema,
  uploadSessionSchema,
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
import type { ObjectStorage } from "../storage/object-storage.js";
import {
  MAX_CHUNK_SIZE,
  type AssetDeliveryDescriptor,
  type AssetService,
} from "./asset-service.js";

const idSchema = z.uuid();
const lowercaseSha256 = /^[0-9a-f]{64}$/;

export interface RegisterAssetRoutesOptions {
  app: FastifyInstance;
  identityService: IdentityService | undefined;
  assetService: AssetService | undefined;
  storage: ObjectStorage;
  publicOrigin: string | undefined;
}

export function registerAssetRoutes(options: RegisterAssetRoutesOptions): void {
  const { app } = options;
  app.addContentTypeParser(
    "application/offset+octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_CHUNK_SIZE },
    (_request, body, done) => done(null, body),
  );

  app.post("/api/v1/projects/:projectId/uploads", async (request, reply) => {
    const session = requireSession(options, request);
    verifyMutation(options, session, request);
    const result = await requireService(options).initializeUpload(
      session,
      parseParameter(request, "projectId"),
      initializeUploadRequestSchema.parse(request.body),
      parseIdempotencyKey(request.headers["idempotency-key"]),
    );
    return reply
      .code(201)
      .header("cache-control", "no-store")
      .header("idempotency-replayed", result.replayed ? "true" : "false")
      .send({
        asset: assetSchema.parse(result.asset),
        upload: uploadSessionSchema.parse(result.upload),
      });
  });

  app.head("/api/v1/uploads/:uploadId", async (request, reply) => {
    const session = requireSession(options, request);
    const upload = requireService(options).headUpload(
      session,
      parseParameter(request, "uploadId"),
    );
    return reply
      .code(200)
      .header("cache-control", "no-store")
      .header("upload-offset", String(upload.receivedSize))
      .header("upload-length", String(upload.declaredSize))
      .header("upload-status", upload.status)
      .header("upload-expires", upload.expiresAt)
      .header("upload-chunk-size", String(upload.recommendedChunkSize))
      .send();
  });

  app.patch("/api/v1/uploads/:uploadId", async (request, reply) => {
    const session = requireSession(options, request);
    verifyMutation(options, session, request, [
      "application/offset+octet-stream",
    ]);
    const offset = parseIntegerHeader(request, "upload-offset");
    const contentLength = parseIntegerHeader(request, "content-length");
    const checksum = request.headers["upload-chunk-sha256"];
    if (
      typeof checksum !== "string" ||
      !lowercaseSha256.test(checksum) ||
      !Buffer.isBuffer(request.body) ||
      request.body.byteLength !== contentLength
    ) {
      throw new ApplicationError(
        "VALIDATION_ERROR",
        "upload_chunk_headers_invalid",
      );
    }
    const committedOffset = await requireService(options).appendChunk(
      session,
      parseParameter(request, "uploadId"),
      offset,
      request.body,
      checksum,
    );
    return reply
      .code(204)
      .header("cache-control", "no-store")
      .header("upload-offset", String(committedOffset))
      .send();
  });

  app.post("/api/v1/uploads/:uploadId/complete", async (request, reply) => {
    const session = requireSession(options, request);
    verifyMutation(options, session, request);
    const result = await requireService(options).completeUpload(
      session,
      parseParameter(request, "uploadId"),
      uploadCompleteRequestSchema.parse(request.body ?? {}),
      parseIdempotencyKey(request.headers["idempotency-key"]),
    );
    return reply
      .header("cache-control", "no-store")
      .header("etag", `"${result.asset.version}"`)
      .header("idempotency-replayed", result.replayed ? "true" : "false")
      .send({
        ...assetSchema.parse(result.asset),
        ...(result.job === undefined
          ? {}
          : { job: jobSchema.parse(result.job) }),
      });
  });

  app.delete("/api/v1/uploads/:uploadId", async (request, reply) => {
    const session = requireSession(options, request);
    verifyMutation(options, session, request);
    requireService(options).abortUpload(
      session,
      parseParameter(request, "uploadId"),
    );
    return reply.code(204).send();
  });

  app.get("/api/v1/projects/:projectId/assets", async (request, reply) => {
    const session = requireSession(options, request);
    const query = assetListQuerySchema.parse(request.query);
    return reply
      .header("cache-control", "no-store")
      .send(
        assetListResponseSchema.parse(
          requireService(options).listAssets(
            session,
            parseParameter(request, "projectId"),
            query,
          ),
        ),
      );
  });

  app.get("/api/v1/assets/:assetId", async (request, reply) => {
    const session = requireSession(options, request);
    const asset = requireService(options).getAsset(
      session,
      parseParameter(request, "assetId"),
    );
    return reply
      .header("cache-control", "no-store")
      .header("etag", `"${asset.version}"`)
      .send(assetSchema.parse(asset));
  });

  app.post(
    "/api/v1/assets/:assetId/retry-ingestion",
    async (request, reply) => {
      const session = requireSession(options, request);
      verifyMutation(options, session, request);
      const idempotencyKey = parseIdempotencyKey(
        request.headers["idempotency-key"],
      );
      const command = assetRetryIngestionRequestSchema.parse(request.body);
      const result = await requireService(options).retryIngestion(
        session,
        parseParameter(request, "assetId"),
        command.expectedVersion,
        idempotencyKey,
      );
      return reply
        .header("etag", `"${result.asset.version}"`)
        .header("idempotency-replayed", result.replayed ? "true" : "false")
        .send({
          asset: assetSchema.parse(result.asset),
          upload: uploadSessionSchema.parse(result.upload),
        });
    },
  );

  app.delete("/api/v1/assets/:assetId", async (request, reply) => {
    const session = requireSession(options, request);
    verifyMutation(options, session, request);
    const command = assetMutationRequestSchema.parse(request.body);
    const asset = requireService(options).softDelete(
      session,
      parseParameter(request, "assetId"),
      command.expectedVersion,
      parseIdempotencyKey(request.headers["idempotency-key"]),
    );
    return reply
      .header("etag", `"${asset.version}"`)
      .send(assetSchema.parse(asset));
  });

  app.post(
    "/api/v1/assets/:assetId/delivery-capabilities",
    async (request, reply) => {
      const session = requireSession(options, request);
      verifyMutation(options, session, request);
      const idempotencyKey = parseIdempotencyKey(
        request.headers["idempotency-key"],
      );
      const body = deliveryCapabilityRequestSchema.parse(request.body);
      return reply
        .header("cache-control", "no-store")
        .send(
          deliveryCapabilityResponseSchema.parse(
            requireService(options).issueCapability(
              session,
              parseParameter(request, "assetId"),
              body.operation,
              idempotencyKey,
            ),
          ),
        );
    },
  );

  app.get(
    "/api/v1/assets/:assetId/content",
    { exposeHeadRoute: false },
    async (request, reply) => sendContent(options, request, reply, false),
  );
  app.head("/api/v1/assets/:assetId/content", async (request, reply) =>
    sendContent(options, request, reply, true),
  );
}

async function sendContent(
  options: RegisterAssetRoutesOptions,
  request: FastifyRequest,
  reply: FastifyReply,
  headOnly: boolean,
) {
  const assetId = parseParameter(request, "assetId");
  const descriptor = authorizeContent(options, request, assetId);
  const etag = `"${descriptor.asset.byteChecksumSha256}"`;
  if (request.headers["if-none-match"] === etag) {
    return reply.code(304).header("etag", etag).send();
  }
  let object;
  try {
    object = await options.storage.head(descriptor.storageKey);
  } catch {
    throw new ApplicationError("STORAGE_UNAVAILABLE", "asset_bytes_missing");
  }
  const range = parseRange(request.headers.range, object.size);
  const contentLength = range.end - range.start + 1;
  const response = reply
    .code(range.partial ? 206 : 200)
    .header("accept-ranges", "bytes")
    .header("content-length", String(contentLength))
    .header(
      "content-type",
      descriptor.asset.verifiedMime ?? "application/octet-stream",
    )
    .header(
      "content-disposition",
      contentDisposition(
        descriptor.asset.originalFilename,
        descriptor.capabilityOperation === "download" ? "attachment" : "inline",
      ),
    )
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

function authorizeContent(
  options: RegisterAssetRoutesOptions,
  request: FastifyRequest,
  assetId: string,
): AssetDeliveryDescriptor {
  const query = request.query as { capability?: unknown; operation?: unknown };
  if (typeof query.capability === "string") {
    const operation = deliveryOperationSchema.safeParse(query.operation);
    if (!operation.success)
      throw new ApplicationError("RESOURCE_NOT_FOUND", "capability_invalid");
    const service = requireService(options);
    const descriptor = service.authorizeCapabilityDelivery(
      assetId,
      query.capability,
      operation.data,
    );
    if (descriptor === null)
      throw new ApplicationError("RESOURCE_NOT_FOUND", "capability_invalid");
    return descriptor;
  }
  const session = requireSession(options, request);
  return requireService(options).authorizeDelivery(session, assetId);
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
  return new ApplicationError("RANGE_NOT_SATISFIABLE", "asset_range_invalid", {
    "content-range": `bytes */${size}`,
  });
}

function contentDisposition(
  filename: string,
  disposition: "inline" | "attachment",
): string {
  return `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function requireSession(
  options: RegisterAssetRoutesOptions,
  request: FastifyRequest,
) {
  return requireProtectedSession(options.identityService, request);
}

function verifyMutation(
  options: RegisterAssetRoutesOptions,
  session: ReturnType<typeof requireSession>,
  request: FastifyRequest,
  contentTypes?: readonly string[],
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
    contentTypes,
  );
}

function requireService(options: RegisterAssetRoutesOptions): AssetService {
  if (options.assetService === undefined)
    throw new ApplicationError(
      "STORAGE_UNAVAILABLE",
      "asset_service_unavailable",
    );
  return options.assetService;
}

function parseParameter(request: FastifyRequest, key: string): string {
  const value = (request.params as Record<string, unknown>)[key];
  return idSchema.parse(value);
}

function parseIntegerHeader(request: FastifyRequest, name: string): number {
  const value = request.headers[name];
  if (typeof value !== "string" || !/^\d+$/.test(value))
    throw new ApplicationError("VALIDATION_ERROR", `${name}_invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new ApplicationError("VALIDATION_ERROR", `${name}_invalid`);
  return parsed;
}
