import {
  assetListResponseSchema,
  assetSchema,
  deliveryCapabilityResponseSchema,
  type Asset,
  type AssetListQuery,
  type DeliveryCapabilityResponse,
  type InitializeUploadRequest,
  type UploadCompleteRequest,
  type UploadSession,
  uploadSessionSchema,
} from "@oloka/contracts";
import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { ObjectStorage } from "../storage/object-storage.js";
import type {
  TransactionContext,
  TransactionRunner,
} from "../database/database.js";
import {
  AssetRepository,
  type AssetRow,
  type UploadSessionRow,
} from "../database/repositories/asset-repository.js";
import { AuditEventRepository } from "../database/repositories/audit-event-repository.js";
import { IdempotencyRepository } from "../database/repositories/idempotency-repository.js";
import { OutboxRepository } from "../database/repositories/outbox-repository.js";
import {
  sha256CanonicalJson,
  canonicalizeJson,
} from "../kernel/canonical-json.js";
import type { Clock } from "../kernel/clock.js";
import type { IdGenerator } from "../kernel/id-generator.js";
import type { AuthenticatedSession } from "../identity/identity-service.js";
import { ApplicationError } from "../http/application-error.js";
import type { QuotaPolicyResolver } from "../quota/quota-policy.js";

export const MAX_CHUNK_SIZE = 8 * 1024 * 1024;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const ASSET_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CAPABILITY_TTL_MS = 5 * 60 * 1000;
const CAPABILITY_TOKEN_CONTEXT = "oloka/delivery-capability-token/v1";

export interface AssetServiceOptions {
  transactions: TransactionRunner;
  storage: ObjectStorage;
  applicationKey: Uint8Array;
  clock: Clock;
  idGenerator: IdGenerator;
  quotaPolicyResolver: QuotaPolicyResolver;
}

export interface AssetDeliveryDescriptor {
  asset: Asset;
  storageKey: string;
  capabilityOperation?: "stream" | "preview" | "download";
}

export class AssetService {
  private readonly assets = new AssetRepository();
  private readonly idempotency: IdempotencyRepository;
  private readonly audit: AuditEventRepository;
  private readonly outbox: OutboxRepository;
  private readonly capabilityTokenKey: Buffer;

  constructor(private readonly options: AssetServiceOptions) {
    this.idempotency = new IdempotencyRepository(options.idGenerator);
    this.audit = new AuditEventRepository(options.idGenerator);
    this.outbox = new OutboxRepository(options.idGenerator);
    this.capabilityTokenKey = Buffer.from(
      hkdfSync(
        "sha256",
        options.applicationKey,
        Buffer.alloc(0),
        CAPABILITY_TOKEN_CONTEXT,
        32,
      ),
    );
  }

  async initializeUpload(
    actor: AuthenticatedSession,
    projectId: string,
    request: InitializeUploadRequest,
    idempotencyKey: string,
  ): Promise<{ asset: Asset; upload: UploadSession; replayed: boolean }> {
    const normalized = normalizeFilename(request.originalFilename);
    const now = this.options.clock.now();
    const idempotencyInput = {
      userId: actor.user.id,
      operation: `asset.upload.initialize:${projectId}`,
      idempotencyKey,
      semanticRequestHashSha256: sha256CanonicalJson({
        projectId,
        ...request,
        originalFilename: normalized,
      }),
    };
    assertActiveActor(actor);
    const lookup = this.options.transactions.run("read", (context) =>
      this.idempotency.lookup(context, idempotencyInput),
    );
    if (lookup.kind === "replay")
      return this.replayInitializedUpload(actor, lookup.response);
    if (lookup.kind === "conflict" || lookup.kind === "in_progress")
      throw idempotencyError(lookup.kind);
    const allocatedAssetId = this.options.idGenerator.generate();
    const allocatedUploadId = this.options.idGenerator.generate();
    try {
      await this.options.storage.stage(allocatedUploadId);
    } catch {
      throw new ApplicationError("STORAGE_UNAVAILABLE", "upload_stage_failed");
    }
    let result;
    try {
      result = this.options.transactions.run("immediate", (context) => {
        assertActiveActor(actor);
        const begin = this.idempotency.begin(context, {
          ...idempotencyInput,
          createdAt: now,
          expiresAt: now + UPLOAD_TTL_MS,
        });
        if (begin.kind === "replay") {
          const response = begin.response as {
            asset: Asset;
            upload: UploadSession;
          };
          return { ...response, replayed: true, recordId: undefined };
        }
        if (begin.kind !== "started" && begin.kind !== "retryable")
          throw idempotencyError(begin.kind);
        const project = context.database
          .prepare("SELECT owner_user_id, status FROM projects WHERE id = ?")
          .get(projectId) as
          | { owner_user_id: string; status: string }
          | undefined;
        if (project === undefined || project.owner_user_id !== actor.user.id)
          throw new ApplicationError("RESOURCE_NOT_FOUND", "project_not_found");
        if (project.status !== "active")
          throw new ApplicationError(
            "RESOURCE_STATE_CONFLICT",
            "project_not_active",
          );
        const quota = this.options.quotaPolicyResolver.resolve({
          userId: actor.user.id,
          projectId,
          at: now,
        });
        if (request.declaredSize > quota.maxAssetSizeBytes)
          throw new ApplicationError("PAYLOAD_TOO_LARGE", "asset_size_limit");
        const reserved = context.database
          .prepare(
            `SELECT COALESCE((SELECT SUM(COALESCE(byte_size, 0)) FROM assets WHERE project_id = ? AND lifecycle_status != 'purged'), 0) +
                COALESCE((SELECT SUM(declared_size) FROM upload_sessions WHERE project_id = ? AND status IN ('open','verifying')), 0) AS total`,
          )
          .get(projectId, projectId) as { total: number };
        if (
          reserved.total + request.declaredSize >
          quota.maxProjectStorageBytes
        )
          throw new ApplicationError("QUOTA_EXCEEDED", "project_storage_limit");
        const assetId = allocatedAssetId;
        const uploadId = allocatedUploadId;
        const assetKey = `v1/${assetId.slice(0, 2)}/${assetId}`;
        const upload: UploadSessionRow = {
          id: uploadId,
          project_id: projectId,
          owner_user_id: actor.user.id,
          asset_id: assetId,
          staging_key: uploadId,
          original_filename: normalized,
          declared_mime: request.declaredMime ?? null,
          declared_size: request.declaredSize,
          declared_checksum_sha256: request.declaredChecksumSha256 ?? null,
          received_size: 0,
          last_chunk_offset: null,
          last_chunk_size: null,
          last_chunk_checksum_sha256: null,
          status: "open",
          expires_at: now + UPLOAD_TTL_MS,
          created_at: now,
          updated_at: now,
          version: 1,
        };
        this.assets.createUpload(context, {
          asset: {
            id: assetId,
            project_id: projectId,
            owner_user_id: actor.user.id,
            original_filename: normalized,
            kind: request.kind,
            declared_mime: request.declaredMime ?? null,
            storage_key: assetKey,
            created_at: now,
            updated_at: now,
          },
          upload: {
            id: upload.id,
            project_id: upload.project_id,
            owner_user_id: upload.owner_user_id,
            asset_id: upload.asset_id,
            staging_key: upload.staging_key,
            original_filename: upload.original_filename,
            declared_mime: upload.declared_mime,
            declared_size: upload.declared_size,
            declared_checksum_sha256: upload.declared_checksum_sha256,
            expires_at: upload.expires_at,
            created_at: upload.created_at,
            updated_at: upload.updated_at,
          },
        });
        const asset = this.toAsset(this.assets.getAsset(context, assetId)!);
        const safeUpload = this.toUpload(
          this.assets.getUpload(context, uploadId)!,
          request.kind,
        );
        this.audit.append(context, {
          actorUserId: actor.user.id,
          actorType: actor.user.role === "admin" ? "admin" : "user",
          action: "upload.create",
          resourceType: "asset",
          resourceId: assetId,
          outcome: "success",
          metadata: {
            projectId,
            byteSize: request.declaredSize,
            kind: request.kind,
          },
          createdAt: now,
        });
        const response = { asset, upload: safeUpload };
        this.idempotency.complete(context, {
          recordId: begin.recordId,
          responseStatus: 201,
          response,
          resourceId: assetId,
        });
        return { ...response, replayed: false, recordId: begin.recordId };
      });
    } catch (error) {
      await this.options.storage
        .delete("staging", allocatedUploadId)
        .catch(() => undefined);
      throw error;
    }
    if (result.replayed) {
      await this.options.storage
        .delete("staging", allocatedUploadId)
        .catch(() => undefined);
      return this.replayInitializedUpload(actor, {
        asset: result.asset,
        upload: result.upload,
      });
    }
    return { asset: result.asset, upload: result.upload, replayed: false };
  }

  private async replayInitializedUpload(
    actor: AuthenticatedSession,
    persisted: unknown,
  ): Promise<{ asset: Asset; upload: UploadSession; replayed: true }> {
    const response = persisted as {
      asset?: { id?: unknown };
      upload?: unknown;
    };
    const upload = uploadSessionSchema.parse(response.upload);
    if (typeof response.asset?.id !== "string")
      throw new ApplicationError(
        "RESOURCE_STATE_CONFLICT",
        "upload_initialize_replay_invalid",
      );
    const current = this.headUpload(actor, upload.uploadId);
    if (current.status !== "open") {
      throw new ApplicationError(
        "RESOURCE_STATE_CONFLICT",
        "upload_initialize_replay_not_open",
      );
    }
    await this.options.storage.statStaging(current.uploadId).catch(() => {
      throw new ApplicationError(
        "STORAGE_UNAVAILABLE",
        "upload_initialize_replay_staging_missing",
      );
    });
    return {
      asset: this.getAsset(actor, response.asset.id),
      upload: current,
      replayed: true,
    };
  }

  headUpload(actor: AuthenticatedSession, uploadId: string): UploadSession {
    return this.options.transactions.run("read", (context) => {
      const row = this.assets.getOwnedUpload(context, uploadId, actor.user.id);
      if (row === null)
        throw new ApplicationError("RESOURCE_NOT_FOUND", "upload_not_found");
      const asset = this.assets.getAsset(context, row.asset_id);
      if (asset === null)
        throw new ApplicationError("RESOURCE_NOT_FOUND", "asset_not_found");
      return this.toUpload(row, asset.kind);
    });
  }

  async appendChunk(
    actor: AuthenticatedSession,
    uploadId: string,
    offset: number,
    bytes: Buffer,
    checksum: string,
  ): Promise<number> {
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_CHUNK_SIZE)
      throw new ApplicationError("PAYLOAD_TOO_LARGE", "upload_chunk_limit");
    if (!/^[0-9a-f]{64}$/.test(checksum))
      throw new ApplicationError(
        "VALIDATION_ERROR",
        "upload_chunk_checksum_invalid",
      );
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== checksum)
      throw new ApplicationError(
        "CHECKSUM_MISMATCH",
        "upload_chunk_checksum_mismatch",
      );
    const state = this.options.transactions.run("read", (context) => {
      const upload = this.assets.getOwnedUpload(
        context,
        uploadId,
        actor.user.id,
      );
      if (upload === null)
        throw new ApplicationError("RESOURCE_NOT_FOUND", "upload_not_found");
      const project = context.database
        .prepare("SELECT status FROM projects WHERE id = ?")
        .get(upload.project_id) as { status: string } | undefined;
      if (project?.status !== "active")
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "project_not_active",
        );
      if (
        upload.status !== "open" ||
        upload.expires_at <= this.options.clock.now()
      )
        throw new ApplicationError("UPLOAD_NOT_OPEN", "upload_not_open");
      if (offset < upload.received_size) {
        if (
          upload.last_chunk_offset === offset &&
          upload.last_chunk_size === bytes.byteLength &&
          upload.last_chunk_checksum_sha256 === checksum
        )
          return { kind: "replay" as const, offset: upload.received_size };
        throw new ApplicationError(
          "UPLOAD_OFFSET_CONFLICT",
          "upload_offset_replay_mismatch",
        );
      }
      if (offset > upload.received_size)
        throw new ApplicationError(
          "UPLOAD_OFFSET_CONFLICT",
          "upload_offset_future",
          { "upload-offset": String(upload.received_size) },
        );
      if (offset + bytes.byteLength > upload.declared_size)
        throw new ApplicationError(
          "UPLOAD_LENGTH_MISMATCH",
          "upload_chunk_exceeds_declared_size",
        );
      return { kind: "append" as const, upload };
    });
    if (state.kind === "replay") return state.offset;
    const file = await this.options.storage
      .statStaging(state.upload.staging_key)
      .catch(() => {
        throw new ApplicationError("STORAGE_UNAVAILABLE", "staging_missing");
      });
    if (file.size > state.upload.received_size)
      await this.options.storage.truncateStaging(
        state.upload.staging_key,
        state.upload.received_size,
      );
    if (file.size < state.upload.received_size)
      throw new ApplicationError("STORAGE_UNAVAILABLE", "staging_db_ahead");
    await this.options.storage.appendAtOffset(
      state.upload.staging_key,
      offset,
      bytes,
    );
    const committed = this.options.transactions.run("immediate", (context) => {
      const ok = this.assets.updateChunk(context, {
        id: uploadId,
        expectedVersion: state.upload.version,
        offset,
        size: bytes.byteLength,
        checksum,
        now: this.options.clock.now(),
      });
      if (ok)
        context.database
          .prepare(
            "UPDATE assets SET ingestion_status = 'uploading', updated_at = ? WHERE id = ? AND ingestion_status = 'upload_pending'",
          )
          .run(this.options.clock.now(), state.upload.asset_id);
      return ok;
    });
    if (!committed)
      throw new ApplicationError(
        "UPLOAD_OFFSET_CONFLICT",
        "upload_concurrent_append",
      );
    return offset + bytes.byteLength;
  }

  async completeUpload(
    actor: AuthenticatedSession,
    uploadId: string,
    request: UploadCompleteRequest,
    idempotencyKey: string,
  ): Promise<{ asset: Asset; replayed: boolean }> {
    const now = this.options.clock.now();
    const state = this.options.transactions.run("immediate", (context) => {
      const upload = this.assets.getOwnedUpload(
        context,
        uploadId,
        actor.user.id,
      );
      if (upload === null)
        throw new ApplicationError("RESOURCE_NOT_FOUND", "upload_not_found");
      const asset = this.assets.getAsset(context, upload.asset_id);
      if (asset === null)
        throw new ApplicationError("RESOURCE_NOT_FOUND", "asset_not_found");
      const begin = this.idempotency.begin(context, {
        userId: actor.user.id,
        operation: `upload.complete:${uploadId}`,
        idempotencyKey,
        semanticRequestHashSha256: sha256CanonicalJson({
          uploadId,
          ...request,
        }),
        createdAt: now,
        expiresAt: now + UPLOAD_TTL_MS,
      });
      if (begin.kind === "replay")
        return {
          kind: "replay" as const,
          response: begin.response as { asset: Asset },
        };
      if (begin.kind !== "started" && begin.kind !== "retryable")
        throw idempotencyError(begin.kind);
      const project = context.database
        .prepare("SELECT status FROM projects WHERE id = ?")
        .get(upload.project_id) as { status: string } | undefined;
      if (project?.status !== "active")
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "project_not_active",
        );
      if (upload.status !== "open")
        throw new ApplicationError("UPLOAD_NOT_OPEN", "upload_not_open");
      if (upload.received_size !== upload.declared_size)
        throw new ApplicationError(
          "UPLOAD_LENGTH_MISMATCH",
          "upload_incomplete",
        );
      if (!this.assets.markVerifying(context, uploadId, upload.version, now))
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "upload_verifying_conflict",
        );
      return {
        kind: "verify" as const,
        upload,
        asset,
        recordId: begin.recordId,
      };
    });
    if (state.kind === "replay")
      return { asset: state.response.asset, replayed: true };
    let finalizationAttempted = false;
    let terminalRejected = false;
    try {
      let staged;
      try {
        staged = await this.options.storage.statStaging(
          state.upload.staging_key,
        );
      } catch {
        terminalRejected = true;
        this.rejectUpload(
          uploadId,
          state.asset.id,
          "STORAGE_UNAVAILABLE",
          state.recordId,
        );
        throw new ApplicationError("STORAGE_UNAVAILABLE", "staging_missing");
      }
      if (staged.size !== state.upload.declared_size) {
        terminalRejected = true;
        this.rejectUpload(
          uploadId,
          state.asset.id,
          "UPLOAD_LENGTH_MISMATCH",
          state.recordId,
        );
        throw new ApplicationError(
          "UPLOAD_LENGTH_MISMATCH",
          "staging_length_mismatch",
        );
      }
      let checksum: string;
      try {
        checksum = await this.options.storage.createStagingHash(
          state.upload.staging_key,
        );
      } catch {
        throw new ApplicationError(
          "STORAGE_UNAVAILABLE",
          "staging_hash_failed",
        );
      }
      const expectedChecksum =
        request.declaredChecksumSha256 ?? state.upload.declared_checksum_sha256;
      if (
        expectedChecksum !== undefined &&
        expectedChecksum !== null &&
        checksum !== expectedChecksum
      ) {
        terminalRejected = true;
        this.rejectUpload(
          uploadId,
          state.asset.id,
          "CHECKSUM_MISMATCH",
          state.recordId,
        );
        throw new ApplicationError(
          "CHECKSUM_MISMATCH",
          "upload_checksum_mismatch",
        );
      }
      let prefix: Buffer;
      try {
        prefix = await this.options.storage.readStagingPrefix(
          state.upload.staging_key,
          32,
        );
      } catch {
        throw new ApplicationError(
          "STORAGE_UNAVAILABLE",
          "staging_read_failed",
        );
      }
      const detected = detectMime(
        prefix,
        state.asset.kind,
        state.upload.declared_mime,
      );
      if (detected.kind === "unsupported") {
        terminalRejected = true;
        this.rejectUpload(
          uploadId,
          state.asset.id,
          "UNSUPPORTED_MEDIA_TYPE",
          state.recordId,
        );
        throw new ApplicationError(
          "UNSUPPORTED_MEDIA_TYPE",
          "asset_media_unsupported",
        );
      }
      if (detected.kind === "invalid") {
        terminalRejected = true;
        this.rejectUpload(
          uploadId,
          state.asset.id,
          "ASSET_INVALID",
          state.recordId,
        );
        throw new ApplicationError("ASSET_INVALID", "asset_media_invalid");
      }
      const metadata = extractMetadata(prefix, state.asset.kind, staged.size);
      finalizationAttempted = true;
      await this.options.storage.finalize(
        state.upload.staging_key,
        state.asset.storage_key,
      );
      this.options.transactions.run("immediate", (context) => {
        if (
          !this.assets.completeUpload(context, {
            uploadId,
            assetId: state.asset.id,
            now: this.options.clock.now(),
            size: staged.size,
            checksum,
            verifiedMime: detected.mime,
            metadataJson: canonicalizeJson(metadata),
          })
        )
          throw new ApplicationError(
            "RESOURCE_STATE_CONFLICT",
            "upload_finalize_conflict",
          );
        this.audit.append(context, {
          actorUserId: actor.user.id,
          actorType: actor.user.role === "admin" ? "admin" : "user",
          action: "upload.complete",
          resourceType: "asset",
          resourceId: state.asset.id,
          outcome: "success",
          metadata: { byteSize: staged.size, verifiedMime: detected.mime },
          createdAt: this.options.clock.now(),
        });
        this.outbox.enqueue(context, {
          topic: "asset.ingestion.requested",
          aggregateType: "asset",
          aggregateId: state.asset.id,
          payload: { assetId: state.asset.id },
          availableAt: this.options.clock.now(),
          createdAt: this.options.clock.now(),
        });
        const asset = this.toAsset(
          this.assets.getAsset(context, state.asset.id)!,
        );
        this.idempotency.complete(context, {
          recordId: state.recordId,
          responseStatus: 200,
          response: { asset },
          resourceId: state.asset.id,
        });
      });
    } catch (error) {
      if (!terminalRejected) {
        let restoredToStaging = !finalizationAttempted;
        if (finalizationAttempted) {
          try {
            await this.options.storage.rollbackFinalize(
              state.upload.staging_key,
              state.asset.storage_key,
            );
            restoredToStaging = true;
          } catch {
            restoredToStaging = false;
          }
        }
        if (restoredToStaging) {
          this.reopenVerifyingUpload(uploadId, state.recordId);
        } else {
          this.rejectUpload(
            uploadId,
            state.asset.id,
            "STORAGE_UNAVAILABLE",
            state.recordId,
          );
        }
      }
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "STORAGE_UNAVAILABLE",
        "upload_finalize_failed",
      );
    }
    await this.processPendingIngestion(10);
    return { asset: this.getAsset(actor, state.asset.id), replayed: false };
  }

  abortUpload(actor: AuthenticatedSession, uploadId: string): void {
    const row = this.options.transactions.run("immediate", (context) => {
      const upload = this.assets.getOwnedUpload(
        context,
        uploadId,
        actor.user.id,
      );
      if (upload === null)
        throw new ApplicationError("RESOURCE_NOT_FOUND", "upload_not_found");
      if (upload.status === "completed") return null;
      this.assets.abortUpload(context, uploadId, this.options.clock.now());
      this.audit.append(context, {
        actorUserId: actor.user.id,
        actorType: actor.user.role === "admin" ? "admin" : "user",
        action: "upload.abort",
        resourceType: "upload",
        resourceId: uploadId,
        outcome: "success",
        metadata: {},
        createdAt: this.options.clock.now(),
      });
      return upload;
    });
    if (row !== null)
      void this.options.storage
        .delete("staging", row.staging_key)
        .catch(() => undefined);
  }

  listAssets(
    actor: AuthenticatedSession,
    projectId: string,
    query: AssetListQuery,
  ) {
    const filterHash = sha256CanonicalJson({
      projectId,
      ...query,
      owner: actor.user.id,
    });
    const cursor =
      query.cursor === undefined
        ? undefined
        : decodeCursor(query.cursor, filterHash, this.options.applicationKey);
    return this.options.transactions.run("read", (context) => {
      const project = context.database
        .prepare("SELECT owner_user_id FROM projects WHERE id = ?")
        .get(projectId) as { owner_user_id: string } | undefined;
      if (project?.owner_user_id !== actor.user.id)
        throw new ApplicationError("RESOURCE_NOT_FOUND", "project_not_found");
      const rows = this.assets.listOwned(context, {
        ownerUserId: actor.user.id,
        projectId,
        lifecycleStatus: query.lifecycleStatus ?? "active",
        ...(query.kind === undefined ? {} : { kind: query.kind }),
        ...(query.ingestionStatus === undefined
          ? {}
          : { ingestionStatus: query.ingestionStatus }),
        ...(query.search === undefined ? {} : { search: query.search }),
        ...(query.uploadedAfter === undefined
          ? {}
          : { uploadedAfter: query.uploadedAfter }),
        ...(query.uploadedBefore === undefined
          ? {}
          : { uploadedBefore: query.uploadedBefore }),
        limit: query.limit + 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return assetListResponseSchema.parse({
        assets: page.map((row) => this.toAsset(row)),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encodeCursor(
                { createdAt: last.created_at, id: last.id },
                filterHash,
                this.options.applicationKey,
              )
            : null,
      });
    });
  }

  getAsset(actor: AuthenticatedSession, assetId: string): Asset {
    return this.options.transactions.run("read", (context) => {
      const row = this.assets.getOwnedAsset(context, assetId, actor.user.id);
      if (row === null || row.lifecycle_status === "purged")
        throw new ApplicationError("RESOURCE_NOT_FOUND", "asset_not_found");
      return this.toAsset(row);
    });
  }

  authorizeDelivery(
    actor: AuthenticatedSession,
    assetId: string,
  ): AssetDeliveryDescriptor {
    return this.options.transactions.run("read", (context) => {
      const row = this.assets.getOwnedAsset(context, assetId, actor.user.id);
      if (
        row === null ||
        row.lifecycle_status !== "active" ||
        row.ingestion_status !== "ready"
      ) {
        throw new ApplicationError(
          "RESOURCE_NOT_FOUND",
          "asset_not_deliverable",
        );
      }
      return { asset: this.toAsset(row), storageKey: row.storage_key };
    });
  }

  authorizeCapabilityDelivery(
    assetId: string,
    token: string,
    operation: "stream" | "preview" | "download",
  ): AssetDeliveryDescriptor | null {
    return this.options.transactions.run("read", (context) => {
      const row = context.database
        .prepare(
          `SELECT a.* FROM delivery_capabilities c JOIN assets a ON a.id = c.resource_id JOIN users u ON u.id = c.issued_to_user_id WHERE c.resource_type = 'asset' AND c.resource_id = ? AND c.operation = ? AND c.status = 'active' AND c.expires_at > ? AND c.token_hash_sha256 = ? AND u.status = 'active'`,
        )
        .get(
          assetId,
          operation,
          this.options.clock.now(),
          createHash("sha256").update(token).digest(),
        ) as AssetRow | undefined;
      if (
        row === undefined ||
        row.lifecycle_status !== "active" ||
        row.ingestion_status !== "ready"
      )
        return null;
      return {
        asset: this.toAsset(row),
        storageKey: row.storage_key,
        capabilityOperation: operation,
      };
    });
  }

  async processIngestion(assetId: string): Promise<void> {
    const row = this.options.transactions.run("read", (context) =>
      this.assets.getAsset(context, assetId),
    );
    if (row === null || row.ingestion_status !== "processing") return;
    try {
      await this.options.storage.head(row.storage_key);
      this.options.transactions.run("immediate", (context) =>
        this.assets.markReady(
          context,
          assetId,
          row.metadata_json ?? canonicalizeJson({}),
          this.options.clock.now(),
        ),
      );
    } catch {
      this.options.transactions.run("immediate", (context) =>
        this.assets.markFailed(
          context,
          assetId,
          "STORAGE_UNAVAILABLE",
          this.options.clock.now(),
        ),
      );
    }
  }

  async processPendingIngestion(limit = 25): Promise<number> {
    const now = this.options.clock.now();
    const events = this.options.transactions.run(
      "immediate",
      ({ database }) => {
        const rows = database
          .prepare(
            `SELECT id, aggregate_id FROM outbox_events
           WHERE topic = 'asset.ingestion.requested' AND status = 'pending' AND available_at <= ?
           ORDER BY available_at, created_at, id LIMIT ?`,
          )
          .all(now, limit) as unknown as Array<{
          id: string;
          aggregate_id: string;
        }>;
        const claimed: typeof rows = [];
        for (const row of rows) {
          const update = database
            .prepare(
              `UPDATE outbox_events SET status = 'processing', lease_owner = 'asset-local',
             lease_expires_at = ?, attempt_count = attempt_count + 1
             WHERE id = ? AND status = 'pending'`,
            )
            .run(now + 30_000, row.id);
          if (Number(update.changes) === 1) claimed.push(row);
        }
        return claimed;
      },
    );
    for (const event of events) {
      try {
        await this.processIngestion(event.aggregate_id);
        this.options.transactions.run("immediate", ({ database }) => {
          database
            .prepare(
              `UPDATE outbox_events SET status = 'published', published_at = ?, lease_owner = NULL,
               lease_expires_at = NULL WHERE id = ? AND status = 'processing' AND lease_owner = 'asset-local'`,
            )
            .run(this.options.clock.now(), event.id);
        });
      } catch {
        this.options.transactions.run("immediate", ({ database }) => {
          database
            .prepare(
              `UPDATE outbox_events SET status = 'pending', available_at = ?, last_error_code = 'ASSET_INGESTION_FAILED',
               lease_owner = NULL, lease_expires_at = NULL
               WHERE id = ? AND status = 'processing' AND lease_owner = 'asset-local'`,
            )
            .run(this.options.clock.now() + 5_000, event.id);
        });
      }
    }
    return events.length;
  }

  softDelete(
    actor: AuthenticatedSession,
    assetId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Asset {
    const now = this.options.clock.now();
    return this.options.transactions.run("immediate", (context) => {
      const begin = this.idempotency.begin(context, {
        userId: actor.user.id,
        operation: `asset.delete:${assetId}`,
        idempotencyKey,
        semanticRequestHashSha256: sha256CanonicalJson({
          assetId,
          expectedVersion,
        }),
        createdAt: now,
        expiresAt: now + UPLOAD_TTL_MS,
      });
      if (begin.kind === "replay")
        return (begin.response as { asset: Asset }).asset;
      if (begin.kind !== "started" && begin.kind !== "retryable")
        throw idempotencyError(begin.kind);
      const row = this.assets.getOwnedAsset(context, assetId, actor.user.id);
      if (row === null)
        throw new ApplicationError("RESOURCE_NOT_FOUND", "asset_not_found");
      if (
        !this.assets.softDelete(
          context,
          assetId,
          actor.user.id,
          expectedVersion,
          now,
          now + ASSET_RETENTION_MS,
        )
      )
        throw mutationConflict(row, expectedVersion);
      context.database
        .prepare(
          "UPDATE delivery_capabilities SET status = 'revoked' WHERE resource_type = 'asset' AND resource_id = ? AND status = 'active'",
        )
        .run(assetId);
      this.audit.append(context, {
        actorUserId: actor.user.id,
        actorType: actor.user.role === "admin" ? "admin" : "user",
        action: "asset.delete_requested",
        resourceType: "asset",
        resourceId: assetId,
        outcome: "success",
        metadata: {},
        createdAt: now,
      });
      const asset = this.toAsset(this.assets.getAsset(context, assetId)!);
      this.idempotency.complete(context, {
        recordId: begin.recordId,
        responseStatus: 200,
        response: { asset },
        resourceId: assetId,
      });
      return asset;
    });
  }

  restore(
    actor: AuthenticatedSession,
    assetId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Asset {
    const now = this.options.clock.now();
    return this.options.transactions.run("immediate", (context) => {
      const begin = this.idempotency.begin(context, {
        userId: actor.user.id,
        operation: `asset.restore:${assetId}`,
        idempotencyKey,
        semanticRequestHashSha256: sha256CanonicalJson({
          assetId,
          expectedVersion,
        }),
        createdAt: now,
        expiresAt: now + UPLOAD_TTL_MS,
      });
      if (begin.kind === "replay")
        return (begin.response as { asset: Asset }).asset;
      if (begin.kind !== "started" && begin.kind !== "retryable")
        throw idempotencyError(begin.kind);
      const row = this.assets.getOwnedAsset(context, assetId, actor.user.id);
      if (row === null)
        throw new ApplicationError("RESOURCE_NOT_FOUND", "asset_not_found");
      const project = context.database
        .prepare("SELECT status FROM projects WHERE id = ?")
        .get(row.project_id) as { status: string } | undefined;
      if (project?.status !== "active")
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "project_not_active",
        );
      if (
        !this.assets.restore(
          context,
          assetId,
          actor.user.id,
          expectedVersion,
          now,
        )
      )
        throw mutationConflict(row, expectedVersion);
      this.audit.append(context, {
        actorUserId: actor.user.id,
        actorType: actor.user.role === "admin" ? "admin" : "user",
        action: "asset.restore",
        resourceType: "asset",
        resourceId: assetId,
        outcome: "success",
        metadata: {},
        createdAt: now,
      });
      const asset = this.toAsset(this.assets.getAsset(context, assetId)!);
      this.idempotency.complete(context, {
        recordId: begin.recordId,
        responseStatus: 200,
        response: { asset },
        resourceId: assetId,
      });
      return asset;
    });
  }

  async retryIngestion(
    actor: AuthenticatedSession,
    assetId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<{ asset: Asset; upload: UploadSession; replayed: boolean }> {
    const now = this.options.clock.now();
    const idempotencyInput = {
      userId: actor.user.id,
      operation: `asset.ingestion.retry:${assetId}`,
      idempotencyKey,
      semanticRequestHashSha256: sha256CanonicalJson({
        assetId,
        expectedVersion,
      }),
    };
    assertActiveActor(actor);
    const lookup = this.options.transactions.run("read", (context) =>
      this.idempotency.lookup(context, idempotencyInput),
    );
    if (lookup.kind === "replay")
      return this.replayRetriedIngestion(actor, assetId, lookup.response);
    if (lookup.kind === "conflict" || lookup.kind === "in_progress")
      throw idempotencyError(lookup.kind);
    const uploadId = this.options.idGenerator.generate();
    const storageId = this.options.idGenerator.generate();
    const storageKey = `v1/${storageId.slice(0, 2)}/${storageId}`;
    try {
      await this.options.storage.stage(uploadId);
    } catch {
      throw new ApplicationError("STORAGE_UNAVAILABLE", "upload_stage_failed");
    }
    let result;
    try {
      result = this.options.transactions.run("immediate", (context) => {
        assertActiveActor(actor);
        const begin = this.idempotency.begin(context, {
          ...idempotencyInput,
          createdAt: now,
          expiresAt: now + UPLOAD_TTL_MS,
        });
        if (begin.kind === "replay")
          return {
            ...(begin.response as { asset: Asset; upload: UploadSession }),
            replayed: true,
          };
        if (begin.kind !== "started" && begin.kind !== "retryable")
          throw idempotencyError(begin.kind);
        const asset = this.assets.getOwnedAsset(
          context,
          assetId,
          actor.user.id,
        );
        if (asset === null)
          throw new ApplicationError("RESOURCE_NOT_FOUND", "asset_not_found");
        if (asset.version !== expectedVersion)
          throw new ApplicationError("VERSION_CONFLICT", "asset_version_stale");
        if (
          asset.lifecycle_status !== "active" ||
          asset.ingestion_status !== "failed" ||
          asset.failure_code === null
        )
          throw new ApplicationError(
            "RESOURCE_STATE_CONFLICT",
            "asset_retry_not_allowed",
          );
        const project = context.database
          .prepare("SELECT status FROM projects WHERE id = ?")
          .get(asset.project_id) as { status: string } | undefined;
        if (project?.status !== "active")
          throw new ApplicationError(
            "RESOURCE_STATE_CONFLICT",
            "project_not_active",
          );
        const previousUpload = this.assets.getUploadByAsset(context, assetId);
        if (previousUpload === null)
          throw new ApplicationError(
            "RESOURCE_STATE_CONFLICT",
            "asset_retry_session_missing",
          );
        const quota = this.options.quotaPolicyResolver.resolve({
          userId: actor.user.id,
          projectId: asset.project_id,
          at: now,
        });
        const reserved = context.database
          .prepare(
            `SELECT COALESCE((SELECT SUM(COALESCE(byte_size, 0)) FROM assets WHERE project_id = ? AND lifecycle_status != 'purged'), 0) +
                    COALESCE((SELECT SUM(declared_size) FROM upload_sessions WHERE project_id = ? AND status IN ('open','verifying')), 0) AS total`,
          )
          .get(asset.project_id, asset.project_id) as { total: number };
        if (
          previousUpload.declared_size > quota.maxAssetSizeBytes ||
          reserved.total + previousUpload.declared_size >
            quota.maxProjectStorageBytes
        )
          throw new ApplicationError("QUOTA_EXCEEDED", "project_storage_limit");
        if (
          !this.assets.retryUpload(context, {
            assetId,
            ownerUserId: actor.user.id,
            expectedAssetVersion: expectedVersion,
            uploadId,
            stagingKey: uploadId,
            storageKey,
            expiresAt: now + UPLOAD_TTL_MS,
            now,
          })
        )
          throw new ApplicationError(
            "RESOURCE_STATE_CONFLICT",
            "asset_retry_conflict",
          );
        const nextAsset = this.toAsset(this.assets.getAsset(context, assetId)!);
        const nextUpload = this.toUpload(
          this.assets.getUpload(context, uploadId)!,
          asset.kind,
        );
        this.audit.append(context, {
          actorUserId: actor.user.id,
          actorType: actor.user.role === "admin" ? "admin" : "user",
          action: "asset.ingestion_retry",
          resourceType: "asset",
          resourceId: assetId,
          outcome: "success",
          metadata: { previousUploadId: previousUpload.id, uploadId },
          createdAt: now,
        });
        const response = { asset: nextAsset, upload: nextUpload };
        this.idempotency.complete(context, {
          recordId: begin.recordId,
          responseStatus: 200,
          response,
          resourceId: assetId,
        });
        return {
          ...response,
          replayed: false,
          staleStagingKey: previousUpload.staging_key,
        };
      });
    } catch (error) {
      await this.options.storage
        .delete("staging", uploadId)
        .catch(() => undefined);
      throw error;
    }
    if (result.replayed) {
      await this.options.storage
        .delete("staging", uploadId)
        .catch(() => undefined);
      return this.replayRetriedIngestion(actor, assetId, {
        asset: result.asset,
        upload: result.upload,
      });
    } else if ("staleStagingKey" in result) {
      await this.options.storage
        .delete("staging", result.staleStagingKey)
        .catch(() => undefined);
    }
    return result;
  }

  private async replayRetriedIngestion(
    actor: AuthenticatedSession,
    assetId: string,
    persisted: unknown,
  ): Promise<{ asset: Asset; upload: UploadSession; replayed: true }> {
    const response = persisted as { asset?: unknown; upload?: unknown };
    const persistedAsset = assetSchema.parse(response.asset);
    const persistedUpload = uploadSessionSchema.parse(response.upload);
    if (persistedAsset.id !== assetId || persistedUpload.assetId !== assetId) {
      throw new ApplicationError(
        "RESOURCE_STATE_CONFLICT",
        "asset_retry_replay_invalid",
      );
    }
    const current = this.options.transactions.run("read", (context) => {
      const asset = this.assets.getOwnedAsset(context, assetId, actor.user.id);
      const upload = this.assets.getOwnedUpload(
        context,
        persistedUpload.uploadId,
        actor.user.id,
      );
      const canonicalUpload = this.assets.getUploadByAsset(context, assetId);
      if (
        asset === null ||
        asset.lifecycle_status !== "active" ||
        upload === null ||
        upload.asset_id !== assetId ||
        upload.status !== "open" ||
        canonicalUpload?.id !== upload.id
      ) {
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "asset_retry_replay_not_open",
        );
      }
      return {
        asset: this.toAsset(asset),
        upload: this.toUpload(upload, asset.kind),
        stagingKey: upload.staging_key,
      };
    });
    await this.options.storage.statStaging(current.stagingKey).catch(() => {
      throw new ApplicationError(
        "STORAGE_UNAVAILABLE",
        "asset_retry_staging_missing",
      );
    });
    return { asset: current.asset, upload: current.upload, replayed: true };
  }

  issueCapability(
    actor: AuthenticatedSession,
    assetId: string,
    operation: "stream" | "preview" | "download",
    idempotencyKey: string,
  ): DeliveryCapabilityResponse {
    const now = this.options.clock.now();
    return this.options.transactions.run("immediate", (context) => {
      assertActiveActor(actor);
      const begin = this.idempotency.begin(context, {
        userId: actor.user.id,
        operation: `asset.capability.issue:${assetId}`,
        idempotencyKey,
        semanticRequestHashSha256: sha256CanonicalJson({
          assetId,
          operation,
        }),
        createdAt: now,
        expiresAt: now + UPLOAD_TTL_MS,
      });
      if (begin.kind === "replay")
        return this.reconstructCapabilityReplay(context, actor, begin.response);
      if (begin.kind !== "started" && begin.kind !== "retryable")
        throw idempotencyError(begin.kind);
      const asset = this.assets.getOwnedAsset(context, assetId, actor.user.id);
      if (
        asset === null ||
        asset.lifecycle_status !== "active" ||
        asset.ingestion_status !== "ready"
      )
        throw new ApplicationError(
          "RESOURCE_NOT_FOUND",
          "asset_not_deliverable",
        );
      const id = this.options.idGenerator.generate();
      const expiresAt = now + CAPABILITY_TTL_MS;
      const token = this.deriveCapabilityToken({
        capabilityId: id,
        issuedToUserId: actor.user.id,
        resourceType: "asset",
        resourceId: assetId,
        operation,
        expiresAt,
      });
      context.database
        .prepare(
          "INSERT INTO delivery_capabilities (id, issued_to_user_id, resource_type, resource_id, operation, token_hash_sha256, status, expires_at, created_at) VALUES (?, ?, 'asset', ?, ?, ?, 'active', ?, ?)",
        )
        .run(
          id,
          actor.user.id,
          assetId,
          operation,
          createHash("sha256").update(token).digest(),
          expiresAt,
          now,
        );
      this.audit.append(context, {
        actorUserId: actor.user.id,
        actorType: actor.user.role === "admin" ? "admin" : "user",
        action: "capability.issue",
        resourceType: "asset",
        resourceId: assetId,
        outcome: "success",
        metadata: { operation },
        createdAt: now,
      });
      const response = deliveryCapabilityResponseSchema.parse({
        capability: token,
        expiresAt: new Date(expiresAt).toISOString(),
        operation,
        assetId,
      });
      this.idempotency.complete(context, {
        recordId: begin.recordId,
        responseStatus: 200,
        response: {
          capabilityId: id,
          assetId,
          operation,
          expiresAt: response.expiresAt,
        },
        resourceId: assetId,
      });
      return response;
    });
  }

  private reconstructCapabilityReplay(
    context: TransactionContext,
    actor: AuthenticatedSession,
    persisted: unknown,
  ): DeliveryCapabilityResponse {
    const replay = parseCapabilityReplayState(persisted);
    const row = context.database
      .prepare(
        `SELECT c.id, c.issued_to_user_id, c.resource_type, c.resource_id, c.operation,
                c.token_hash_sha256, c.status, c.expires_at, a.lifecycle_status,
                a.ingestion_status, u.status AS user_status
         FROM delivery_capabilities c
         JOIN assets a ON a.id = c.resource_id
         JOIN users u ON u.id = c.issued_to_user_id
         WHERE c.id = ?`,
      )
      .get(replay.capabilityId) as
      | {
          id: string;
          issued_to_user_id: string;
          resource_type: string;
          resource_id: string;
          operation: string;
          token_hash_sha256: Uint8Array;
          status: string;
          expires_at: number;
          lifecycle_status: string;
          ingestion_status: string;
          user_status: string;
        }
      | undefined;
    if (
      row === undefined ||
      row.issued_to_user_id !== actor.user.id ||
      row.resource_type !== "asset" ||
      row.resource_id !== replay.assetId ||
      row.operation !== replay.operation ||
      row.status !== "active" ||
      row.expires_at <= this.options.clock.now() ||
      row.lifecycle_status !== "active" ||
      row.ingestion_status !== "ready" ||
      row.user_status !== "active" ||
      new Date(row.expires_at).toISOString() !== replay.expiresAt
    ) {
      throw new ApplicationError(
        "RESOURCE_STATE_CONFLICT",
        "capability_replay_not_active",
      );
    }
    const token = this.deriveCapabilityToken({
      capabilityId: row.id,
      issuedToUserId: row.issued_to_user_id,
      resourceType: "asset",
      resourceId: row.resource_id,
      operation: replay.operation,
      expiresAt: row.expires_at,
    });
    const tokenHash = createHash("sha256").update(token).digest();
    const storedHash = Buffer.from(row.token_hash_sha256);
    if (
      tokenHash.length !== storedHash.length ||
      !timingSafeEqual(tokenHash, storedHash)
    ) {
      throw new ApplicationError(
        "RESOURCE_STATE_CONFLICT",
        "capability_replay_not_active",
      );
    }
    return deliveryCapabilityResponseSchema.parse({
      capability: token,
      expiresAt: replay.expiresAt,
      operation: replay.operation,
      assetId: replay.assetId,
    });
  }

  private deriveCapabilityToken(input: {
    capabilityId: string;
    issuedToUserId: string;
    resourceType: "asset";
    resourceId: string;
    operation: "stream" | "preview" | "download";
    expiresAt: number;
  }): string {
    return createHmac("sha256", this.capabilityTokenKey)
      .update(
        canonicalizeJson({
          version: 1,
          capabilityId: input.capabilityId,
          issuedToUserId: input.issuedToUserId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          operation: input.operation,
          expiresAt: input.expiresAt,
        }),
        "utf8",
      )
      .digest("base64url");
  }

  private rejectUpload(
    uploadId: string,
    assetId: string,
    failureCode: string,
    idempotencyRecordId: string,
  ): void {
    this.options.transactions.run("immediate", (context) => {
      this.assets.markFailed(
        context,
        assetId,
        failureCode,
        this.options.clock.now(),
      );
      context.database
        .prepare(
          "UPDATE upload_sessions SET status = 'rejected', updated_at = ?, version = version + 1 WHERE id = ? AND status = 'verifying'",
        )
        .run(this.options.clock.now(), uploadId);
      this.idempotency.markRetryableFailure(context, idempotencyRecordId);
    });
  }

  private reopenVerifyingUpload(
    uploadId: string,
    idempotencyRecordId: string,
  ): void {
    this.options.transactions.run("immediate", (context) => {
      if (
        !this.assets.reopenVerifying(
          context,
          uploadId,
          this.options.clock.now(),
        )
      )
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "upload_recovery_conflict",
        );
      this.idempotency.markRetryableFailure(context, idempotencyRecordId);
    });
  }

  private toAsset(row: AssetRow): Asset {
    let metadata: Record<string, string | number | boolean> | null = null;
    if (row.metadata_json !== null)
      metadata = JSON.parse(row.metadata_json) as Record<
        string,
        string | number | boolean
      >;
    return assetSchema.parse({
      id: row.id,
      projectId: row.project_id,
      originalFilename: row.original_filename,
      kind: row.kind,
      declaredMime: row.declared_mime,
      verifiedMime: row.verified_mime,
      byteSize: row.byte_size,
      byteChecksumSha256: row.byte_checksum_sha256,
      metadata,
      ingestionStatus: row.ingestion_status,
      lifecycleStatus: row.lifecycle_status,
      failureCode: row.failure_code,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      deletedAt:
        row.deleted_at === null ? null : new Date(row.deleted_at).toISOString(),
      version: row.version,
    });
  }

  private toUpload(
    row: UploadSessionRow,
    kind: "image" | "video" | "audio" | "font",
  ): UploadSession {
    return uploadSessionSchema.parse({
      uploadId: row.id,
      assetId: row.asset_id,
      projectId: row.project_id,
      originalFilename: row.original_filename,
      kind,
      declaredMime: row.declared_mime,
      declaredSize: row.declared_size,
      receivedSize: row.received_size,
      status: row.status,
      expiresAt: new Date(row.expires_at).toISOString(),
      recommendedChunkSize: MAX_CHUNK_SIZE,
    });
  }
}

export function normalizeFilename(value: string): string {
  const normalized = value.normalize("NFC");
  const cleaned = Array.from(normalized, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 || character === "\\0" ? " " : character;
  })
    .join("")
    .replace(/[\\/]+/g, "_")
    .trim();
  if (cleaned.length === 0 || cleaned.length > 255)
    throw new ApplicationError("VALIDATION_ERROR", "asset_filename_invalid");
  return cleaned;
}

function detectMime(
  prefix: Buffer,
  kind: AssetRow["kind"],
  declared: string | null,
):
  | { kind: "ok"; mime: string }
  | { kind: "unsupported" }
  | { kind: "invalid" } {
  let detected: string | undefined;
  if (
    prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    detected = "image/png";
  else if (prefix.subarray(0, 3).equals(Buffer.from([255, 216, 255])))
    detected = "image/jpeg";
  else if (
    prefix.subarray(0, 6).toString("ascii") === "GIF89a" ||
    prefix.subarray(0, 6).toString("ascii") === "GIF87a"
  )
    detected = "image/gif";
  else if (
    prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
    prefix.subarray(8, 12).toString("ascii") === "WEBP"
  )
    detected = "image/webp";
  else if (prefix.subarray(4, 8).toString("ascii") === "ftyp")
    detected = kind === "audio" ? "audio/mp4" : "video/mp4";
  else if (prefix.subarray(0, 4).toString("ascii") === "OggS")
    detected = kind === "audio" ? "audio/ogg" : "video/ogg";
  else if (
    prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
    prefix.subarray(8, 12).toString("ascii") === "WAVE"
  )
    detected = "audio/wav";
  else if (
    prefix.subarray(0, 3).toString("ascii") === "ID3" ||
    (prefix[0] === 0xff && (prefix[1]! & 0xe0) === 0xe0)
  )
    detected = "audio/mpeg";
  else if (prefix.subarray(0, 4).toString("ascii") === "wOFF")
    detected = "font/woff";
  else if (prefix.subarray(0, 4).toString("ascii") === "wOF2")
    detected = "font/woff2";
  else if (prefix.subarray(0, 4).toString("ascii") === "\0\x01\0\0")
    detected = "font/ttf";
  if (detected === undefined) return { kind: "unsupported" };
  if (
    declared !== null &&
    declared !== "application/octet-stream" &&
    declared.toLowerCase() !== detected
  )
    return { kind: "unsupported" };
  return { kind: "ok", mime: detected };
}

function extractMetadata(
  prefix: Buffer,
  kind: AssetRow["kind"],
  size: number,
): Record<string, string | number | boolean> {
  const metadata: Record<string, string | number | boolean> = {
    byteSize: size,
  };
  if (
    kind === "image" &&
    prefix
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    prefix.length >= 24
  ) {
    metadata.width = prefix.readUInt32BE(16);
    metadata.height = prefix.readUInt32BE(20);
  }
  return metadata;
}

function idempotencyError(kind: "conflict" | "in_progress"): ApplicationError {
  return new ApplicationError(
    kind === "conflict" ? "IDEMPOTENCY_CONFLICT" : "RESOURCE_STATE_CONFLICT",
    kind === "conflict"
      ? "asset_idempotency_conflict"
      : "asset_idempotency_in_progress",
  );
}

function assertActiveActor(actor: AuthenticatedSession): void {
  if (actor.user.status === "active") return;
  const code =
    actor.user.status === "pending"
      ? "ACCOUNT_PENDING"
      : actor.user.status === "disabled"
        ? "ACCOUNT_DISABLED"
        : "ACCOUNT_REJECTED";
  throw new ApplicationError(code, "account_not_active");
}

function mutationConflict(
  row: AssetRow,
  expectedVersion: number,
): ApplicationError {
  if (row.version !== expectedVersion)
    return new ApplicationError("VERSION_CONFLICT", "asset_version_stale");
  return new ApplicationError(
    "RESOURCE_STATE_CONFLICT",
    "asset_lifecycle_conflict",
  );
}

function parseCapabilityReplayState(value: unknown): {
  capabilityId: string;
  assetId: string;
  operation: "stream" | "preview" | "download";
  expiresAt: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ApplicationError(
      "RESOURCE_STATE_CONFLICT",
      "capability_replay_invalid",
    );
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.capabilityId !== "string" ||
    typeof candidate.assetId !== "string" ||
    (candidate.operation !== "stream" &&
      candidate.operation !== "preview" &&
      candidate.operation !== "download") ||
    typeof candidate.expiresAt !== "string"
  ) {
    throw new ApplicationError(
      "RESOURCE_STATE_CONFLICT",
      "capability_replay_invalid",
    );
  }
  return {
    capabilityId: candidate.capabilityId,
    assetId: candidate.assetId,
    operation: candidate.operation,
    expiresAt: candidate.expiresAt,
  };
}

function encodeCursor(
  sort: { createdAt: number; id: string },
  filterHash: string,
  key: Uint8Array,
): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, sort, filterHash }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", key)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function decodeCursor(
  cursor: string,
  filterHash: string,
  key: Uint8Array,
): { createdAt: number; id: string } {
  try {
    const [payload, signature, extra] = cursor.split(".");
    if (!payload || !signature || extra) throw new Error();
    const expected = createHmac("sha256", key).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new Error();
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as {
      v?: unknown;
      sort?: { createdAt?: unknown; id?: unknown };
      filterHash?: unknown;
    };
    if (
      decoded.v !== 1 ||
      typeof decoded.filterHash !== "string" ||
      decoded.filterHash !== filterHash ||
      typeof decoded.sort?.createdAt !== "number" ||
      typeof decoded.sort.id !== "string"
    )
      throw new Error();
    return { createdAt: decoded.sort.createdAt, id: decoded.sort.id };
  } catch {
    throw new ApplicationError("INVALID_CURSOR", "asset_cursor_invalid");
  }
}
