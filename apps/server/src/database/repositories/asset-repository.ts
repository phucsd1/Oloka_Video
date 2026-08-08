import type { TransactionContext } from "../database.js";

export interface AssetRow {
  id: string;
  project_id: string;
  owner_user_id: string;
  original_filename: string;
  kind: "image" | "video" | "audio" | "font";
  declared_mime: string | null;
  verified_mime: string | null;
  storage_key: string;
  byte_size: number | null;
  byte_checksum_sha256: string | null;
  metadata_json: string | null;
  ingestion_status:
    | "upload_pending"
    | "uploading"
    | "processing"
    | "ready"
    | "failed";
  lifecycle_status:
    | "active"
    | "soft_deleted"
    | "purge_scheduled"
    | "purging"
    | "purged";
  failure_code: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  purge_after: number | null;
  purge_scheduled_at: number | null;
  purged_at: number | null;
  version: number;
}

export interface UploadSessionRow {
  id: string;
  project_id: string;
  owner_user_id: string;
  asset_id: string;
  staging_key: string;
  original_filename: string;
  declared_mime: string | null;
  declared_size: number;
  declared_checksum_sha256: string | null;
  received_size: number;
  last_chunk_offset: number | null;
  last_chunk_size: number | null;
  last_chunk_checksum_sha256: string | null;
  status:
    | "open"
    | "verifying"
    | "completed"
    | "aborted"
    | "expired"
    | "rejected";
  expires_at: number;
  created_at: number;
  updated_at: number;
  version: number;
}

export class AssetRepository {
  createUpload(
    context: TransactionContext,
    input: {
      asset: Pick<
        AssetRow,
        | "id"
        | "project_id"
        | "owner_user_id"
        | "original_filename"
        | "kind"
        | "declared_mime"
        | "storage_key"
        | "created_at"
        | "updated_at"
      >;
      upload: Pick<
        UploadSessionRow,
        | "id"
        | "project_id"
        | "owner_user_id"
        | "asset_id"
        | "staging_key"
        | "original_filename"
        | "declared_mime"
        | "declared_size"
        | "declared_checksum_sha256"
        | "expires_at"
        | "created_at"
        | "updated_at"
      >;
    },
  ): void {
    context.database
      .prepare(
        `INSERT INTO assets
          (id, project_id, owner_user_id, original_filename, kind, declared_mime,
           verified_mime, storage_key, byte_size, byte_checksum_sha256, metadata_json,
           ingestion_status, lifecycle_status, failure_code, created_at, updated_at,
           deleted_at, purge_after, purge_scheduled_at, purged_at, version)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, 'upload_pending', 'active', NULL, ?, ?, NULL, NULL, NULL, NULL, 1)`,
      )
      .run(
        input.asset.id,
        input.asset.project_id,
        input.asset.owner_user_id,
        input.asset.original_filename,
        input.asset.kind,
        input.asset.declared_mime,
        input.asset.storage_key,
        input.asset.created_at,
        input.asset.updated_at,
      );
    context.database
      .prepare(
        `INSERT INTO upload_sessions
          (id, project_id, owner_user_id, asset_id, staging_key, original_filename,
           declared_mime, declared_size, declared_checksum_sha256, received_size,
           last_chunk_offset, last_chunk_size, last_chunk_checksum_sha256, status,
           expires_at, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, 'open', ?, ?, ?, 1)`,
      )
      .run(
        input.upload.id,
        input.upload.project_id,
        input.upload.owner_user_id,
        input.upload.asset_id,
        input.upload.staging_key,
        input.upload.original_filename,
        input.upload.declared_mime,
        input.upload.declared_size,
        input.upload.declared_checksum_sha256,
        input.upload.expires_at,
        input.upload.created_at,
        input.upload.updated_at,
      );
  }

  getUpload(context: TransactionContext, id: string): UploadSessionRow | null {
    return (
      (context.database
        .prepare("SELECT * FROM upload_sessions WHERE id = ?")
        .get(id) as UploadSessionRow | undefined) ?? null
    );
  }

  getUploadByAsset(
    context: TransactionContext,
    assetId: string,
  ): UploadSessionRow | null {
    return (
      (context.database
        .prepare("SELECT * FROM upload_sessions WHERE asset_id = ?")
        .get(assetId) as UploadSessionRow | undefined) ?? null
    );
  }

  getAsset(context: TransactionContext, id: string): AssetRow | null {
    return (
      (context.database.prepare("SELECT * FROM assets WHERE id = ?").get(id) as
        | AssetRow
        | undefined) ?? null
    );
  }

  getOwnedUpload(
    context: TransactionContext,
    id: string,
    ownerUserId: string,
  ): UploadSessionRow | null {
    return (
      (context.database
        .prepare(
          "SELECT * FROM upload_sessions WHERE id = ? AND owner_user_id = ?",
        )
        .get(id, ownerUserId) as UploadSessionRow | undefined) ?? null
    );
  }

  getOwnedAsset(
    context: TransactionContext,
    id: string,
    ownerUserId: string,
  ): AssetRow | null {
    return (
      (context.database
        .prepare("SELECT * FROM assets WHERE id = ? AND owner_user_id = ?")
        .get(id, ownerUserId) as AssetRow | undefined) ?? null
    );
  }

  updateChunk(
    context: TransactionContext,
    input: {
      id: string;
      expectedVersion: number;
      offset: number;
      size: number;
      checksum: string;
      now: number;
    },
  ): boolean {
    return (
      Number(
        context.database
          .prepare(
            `UPDATE upload_sessions
       SET received_size = ?, last_chunk_offset = ?, last_chunk_size = ?,
           last_chunk_checksum_sha256 = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND status = 'open' AND version = ? AND received_size = ?`,
          )
          .run(
            input.offset + input.size,
            input.offset,
            input.size,
            input.checksum,
            input.now,
            input.id,
            input.expectedVersion,
            input.offset,
          ).changes,
      ) === 1
    );
  }

  markVerifying(
    context: TransactionContext,
    id: string,
    expectedVersion: number,
    now: number,
  ): boolean {
    return (
      Number(
        context.database
          .prepare(
            "UPDATE upload_sessions SET status = 'verifying', updated_at = ?, version = version + 1 WHERE id = ? AND status = 'open' AND version = ?",
          )
          .run(now, id, expectedVersion).changes,
      ) === 1
    );
  }

  reopenVerifying(
    context: TransactionContext,
    id: string,
    now: number,
  ): boolean {
    return (
      Number(
        context.database
          .prepare(
            "UPDATE upload_sessions SET status = 'open', updated_at = ?, version = version + 1 WHERE id = ? AND status = 'verifying'",
          )
          .run(now, id).changes,
      ) === 1
    );
  }

  completeUpload(
    context: TransactionContext,
    input: {
      uploadId: string;
      assetId: string;
      now: number;
      size: number;
      checksum: string;
      verifiedMime: string;
      metadataJson: string;
    },
  ): boolean {
    const upload = context.database
      .prepare(
        "UPDATE upload_sessions SET status = 'completed', updated_at = ?, version = version + 1 WHERE id = ? AND status = 'verifying'",
      )
      .run(input.now, input.uploadId);
    if (Number(upload.changes) !== 1) return false;
    const asset = context.database
      .prepare(
        `UPDATE assets SET byte_size = ?, byte_checksum_sha256 = ?, verified_mime = ?, metadata_json = ?,
       ingestion_status = 'processing', updated_at = ?, version = version + 1
       WHERE id = ? AND ingestion_status IN ('upload_pending', 'uploading') AND lifecycle_status = 'active'`,
      )
      .run(
        input.size,
        input.checksum,
        input.verifiedMime,
        input.metadataJson,
        input.now,
        input.assetId,
      );
    return Number(asset.changes) === 1;
  }

  markReady(
    context: TransactionContext,
    id: string,
    metadataJson: string,
    now: number,
  ): boolean {
    return (
      Number(
        context.database
          .prepare(
            "UPDATE assets SET ingestion_status = 'ready', metadata_json = ?, failure_code = NULL, updated_at = ?, version = version + 1 WHERE id = ? AND ingestion_status = 'processing' AND lifecycle_status = 'active'",
          )
          .run(metadataJson, now, id).changes,
      ) === 1
    );
  }

  markFailed(
    context: TransactionContext,
    id: string,
    failureCode: string,
    now: number,
  ): boolean {
    return (
      Number(
        context.database
          .prepare(
            "UPDATE assets SET ingestion_status = 'failed', failure_code = ?, updated_at = ?, version = version + 1 WHERE id = ? AND ingestion_status IN ('processing', 'upload_pending', 'uploading')",
          )
          .run(failureCode, now, id).changes,
      ) === 1
    );
  }

  abortUpload(context: TransactionContext, id: string, now: number): boolean {
    return (
      Number(
        context.database
          .prepare(
            "UPDATE upload_sessions SET status = 'aborted', updated_at = ?, version = version + 1 WHERE id = ? AND status = 'open'",
          )
          .run(now, id).changes,
      ) === 1
    );
  }

  softDelete(
    context: TransactionContext,
    id: string,
    ownerUserId: string,
    expectedVersion: number,
    now: number,
    purgeAfter: number,
  ): boolean {
    return (
      Number(
        context.database
          .prepare(
            `UPDATE assets SET lifecycle_status = 'soft_deleted', deleted_at = ?, purge_after = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND owner_user_id = ? AND lifecycle_status = 'active' AND version = ?`,
          )
          .run(now, purgeAfter, now, id, ownerUserId, expectedVersion).changes,
      ) === 1
    );
  }

  restore(
    context: TransactionContext,
    id: string,
    ownerUserId: string,
    expectedVersion: number,
    now: number,
  ): boolean {
    return (
      Number(
        context.database
          .prepare(
            `UPDATE assets SET lifecycle_status = 'active', deleted_at = NULL, purge_after = NULL, updated_at = ?, version = version + 1
       WHERE id = ? AND owner_user_id = ? AND lifecycle_status = 'soft_deleted' AND version = ?`,
          )
          .run(now, id, ownerUserId, expectedVersion).changes,
      ) === 1
    );
  }

  retryUpload(
    context: TransactionContext,
    input: {
      assetId: string;
      ownerUserId: string;
      expectedAssetVersion: number;
      uploadId: string;
      stagingKey: string;
      storageKey: string;
      expiresAt: number;
      now: number;
    },
  ): boolean {
    const upload = context.database
      .prepare(
        `UPDATE upload_sessions
         SET id = ?, staging_key = ?, received_size = 0,
             last_chunk_offset = NULL, last_chunk_size = NULL,
             last_chunk_checksum_sha256 = NULL, status = 'open',
             expires_at = ?, updated_at = ?, version = version + 1
         WHERE asset_id = ? AND owner_user_id = ?
           AND status IN ('completed', 'aborted', 'expired', 'rejected')`,
      )
      .run(
        input.uploadId,
        input.stagingKey,
        input.expiresAt,
        input.now,
        input.assetId,
        input.ownerUserId,
      );
    if (Number(upload.changes) !== 1) return false;
    const asset = context.database
      .prepare(
        `UPDATE assets
         SET storage_key = ?, verified_mime = NULL,
             byte_checksum_sha256 = NULL, metadata_json = NULL,
             ingestion_status = 'upload_pending', failure_code = NULL,
             updated_at = ?, version = version + 1
         WHERE id = ? AND owner_user_id = ? AND version = ?
           AND ingestion_status = 'failed' AND lifecycle_status = 'active'`,
      )
      .run(
        input.storageKey,
        input.now,
        input.assetId,
        input.ownerUserId,
        input.expectedAssetVersion,
      );
    return Number(asset.changes) === 1;
  }

  listOwned(
    context: TransactionContext,
    input: {
      ownerUserId: string;
      projectId: string;
      kind?: string;
      ingestionStatus?: string;
      lifecycleStatus: string;
      search?: string;
      uploadedAfter?: number;
      uploadedBefore?: number;
      limit: number;
      cursor?: { createdAt: number; id: string };
    },
  ): AssetRow[] {
    const clauses = [
      "owner_user_id = ?",
      "project_id = ?",
      "lifecycle_status = ?",
    ];
    const values: (string | number)[] = [
      input.ownerUserId,
      input.projectId,
      input.lifecycleStatus,
    ];
    if (input.kind !== undefined) {
      clauses.push("kind = ?");
      values.push(input.kind);
    }
    if (input.ingestionStatus !== undefined) {
      clauses.push("ingestion_status = ?");
      values.push(input.ingestionStatus);
    }
    if (input.search !== undefined && input.search !== "") {
      clauses.push("original_filename LIKE ? ESCAPE '\\'");
      values.push(`%${escapeLike(input.search)}%`);
    }
    if (input.uploadedAfter !== undefined) {
      clauses.push("created_at >= ?");
      values.push(input.uploadedAfter);
    }
    if (input.uploadedBefore !== undefined) {
      clauses.push("created_at < ?");
      values.push(input.uploadedBefore);
    }
    if (input.cursor !== undefined) {
      clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
      values.push(
        input.cursor.createdAt,
        input.cursor.createdAt,
        input.cursor.id,
      );
    }
    return context.database
      .prepare(
        `SELECT * FROM assets WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...values, input.limit) as unknown as AssetRow[];
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function mapAsset(row: AssetRow) {
  return row;
}
