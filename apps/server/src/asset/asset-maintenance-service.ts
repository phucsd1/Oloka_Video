import type { TransactionRunner } from "../database/database.js";
import type { ObjectStorage } from "../storage/object-storage.js";

interface OpenUpload {
  id: string;
  asset_id: string;
  staging_key: string;
  received_size: number;
  expires_at: number;
}

interface VerifyingUpload extends OpenUpload {
  storage_key: string;
}

export interface AssetMaintenanceResult {
  expired: number;
  truncatedFileAhead: number;
  quarantinedDatabaseAhead: number;
  missingDurable: number;
  unreferencedDurable: number;
  unreferencedStaging: number;
  recoveredVerifying: number;
  failedVerifying: number;
}

export class AssetMaintenanceService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly storage: ObjectStorage,
  ) {}

  async run(now: number): Promise<AssetMaintenanceResult> {
    const result: AssetMaintenanceResult = {
      expired: 0,
      truncatedFileAhead: 0,
      quarantinedDatabaseAhead: 0,
      missingDurable: 0,
      unreferencedDurable: 0,
      unreferencedStaging: 0,
      recoveredVerifying: 0,
      failedVerifying: 0,
    };
    const uploads = this.transactions.run(
      "read",
      ({ database }) =>
        database
          .prepare(
            "SELECT id, asset_id, staging_key, received_size, expires_at FROM upload_sessions WHERE status = 'open' ORDER BY expires_at, id LIMIT 500",
          )
          .all() as unknown as OpenUpload[],
    );
    for (const upload of uploads) {
      if (upload.expires_at <= now) {
        const expired = this.transactions.run("immediate", ({ database }) => {
          const changed = Number(
            database
              .prepare(
                "UPDATE upload_sessions SET status = 'expired', updated_at = ?, version = version + 1 WHERE id = ? AND status = 'open'",
              )
              .run(now, upload.id).changes,
          );
          if (changed === 1)
            database
              .prepare(
                `UPDATE quota_reservations SET status = 'expired', expires_at = NULL,
                   updated_at = ?, version = version + 1
                 WHERE resource_type = 'upload_bytes' AND resource_id = ? AND status = 'reserved'`,
              )
              .run(now, upload.id);
          return changed;
        });
        if (expired === 1) {
          result.expired += 1;
          await this.storage
            .delete("staging", upload.staging_key)
            .catch(() => undefined);
        }
        continue;
      }
      const staging = await this.storage
        .statStaging(upload.staging_key)
        .catch(() => null);
      if (staging === null || staging.size < upload.received_size) {
        this.transactions.run("immediate", ({ database }) => {
          database
            .prepare(
              "UPDATE upload_sessions SET status = 'rejected', updated_at = ?, version = version + 1 WHERE id = ? AND status = 'open'",
            )
            .run(now, upload.id);
          database
            .prepare(
              "UPDATE assets SET ingestion_status = 'failed', failure_code = 'STORAGE_UNAVAILABLE', updated_at = ?, version = version + 1 WHERE id = ?",
            )
            .run(now, upload.asset_id);
          database
            .prepare(
              `UPDATE quota_reservations SET status = 'released', expires_at = NULL,
                 updated_at = ?, version = version + 1
               WHERE resource_type = 'upload_bytes' AND resource_id = ? AND status = 'reserved'`,
            )
            .run(now, upload.id);
        });
        result.quarantinedDatabaseAhead += 1;
        continue;
      }
      if (staging.size > upload.received_size) {
        await this.storage.truncateStaging(
          upload.staging_key,
          upload.received_size,
        );
        result.truncatedFileAhead += 1;
      }
    }

    const verifying = this.transactions.run(
      "read",
      ({ database }) =>
        database
          .prepare(
            `SELECT u.id, u.asset_id, u.staging_key, u.received_size, u.expires_at,
                    a.storage_key
             FROM upload_sessions u JOIN assets a ON a.id = u.asset_id
             WHERE u.status = 'verifying' ORDER BY u.updated_at, u.id LIMIT 500`,
          )
          .all() as unknown as VerifyingUpload[],
    );
    for (const upload of verifying) {
      const staging = await this.storage
        .statStaging(upload.staging_key)
        .catch(() => null);
      if (staging !== null && staging.size > upload.received_size) {
        await this.storage.truncateStaging(
          upload.staging_key,
          upload.received_size,
        );
      }
      if (staging !== null && staging.size >= upload.received_size) {
        this.reopenVerifying(upload.id, now);
        result.recoveredVerifying += 1;
        continue;
      }
      if (staging === null) {
        const durable = await this.storage
          .head(upload.storage_key)
          .then(() => true)
          .catch(() => false);
        if (durable) {
          try {
            await this.storage.rollbackFinalize(
              upload.staging_key,
              upload.storage_key,
            );
            this.reopenVerifying(upload.id, now);
            result.recoveredVerifying += 1;
            continue;
          } catch {
            // Fall through to a typed terminal storage failure.
          }
        }
      }
      this.failVerifying(upload, now);
      result.failedVerifying += 1;
    }

    const manifest = await this.storage.listForReconciliation();
    const references = this.transactions.run("read", ({ database }) => ({
      staging: new Set(
        (
          database
            .prepare(
              "SELECT staging_key FROM upload_sessions WHERE status IN ('open', 'verifying')",
            )
            .all() as unknown as { staging_key: string }[]
        ).map((row) => row.staging_key),
      ),
      durable: new Set(
        (
          database
            .prepare(
              "SELECT storage_key FROM assets WHERE byte_checksum_sha256 IS NOT NULL AND lifecycle_status != 'purged'",
            )
            .all() as unknown as { storage_key: string }[]
        ).map((row) => row.storage_key),
      ),
      required: database
        .prepare(
          "SELECT storage_key FROM assets WHERE ingestion_status = 'ready' AND lifecycle_status = 'active'",
        )
        .all() as unknown as { storage_key: string }[],
    }));
    const present = new Set(manifest.durable);
    result.unreferencedStaging = manifest.staging.filter(
      (key) => !references.staging.has(key),
    ).length;
    result.unreferencedDurable = manifest.durable.filter(
      (key) => !references.durable.has(key),
    ).length;
    result.missingDurable = references.required.filter(
      ({ storage_key }) => !present.has(storage_key),
    ).length;
    return result;
  }

  private reopenVerifying(uploadId: string, now: number): void {
    this.transactions.run("immediate", ({ database }) => {
      const updated = database
        .prepare(
          "UPDATE upload_sessions SET status = 'open', updated_at = ?, version = version + 1 WHERE id = ? AND status = 'verifying'",
        )
        .run(now, uploadId).changes;
      if (updated !== 1) return;
      database
        .prepare(
          "UPDATE idempotency_records SET status = 'failed_retryable', response_status = NULL, response_json = NULL, resource_id = NULL WHERE operation = ? AND status = 'in_progress'",
        )
        .run(`upload.complete:${uploadId}`);
    });
  }

  private failVerifying(upload: VerifyingUpload, now: number): void {
    this.transactions.run("immediate", ({ database }) => {
      database
        .prepare(
          "UPDATE upload_sessions SET status = 'rejected', updated_at = ?, version = version + 1 WHERE id = ? AND status = 'verifying'",
        )
        .run(now, upload.id);
      database
        .prepare(
          "UPDATE assets SET ingestion_status = 'failed', failure_code = 'STORAGE_UNAVAILABLE', updated_at = ?, version = version + 1 WHERE id = ? AND ingestion_status IN ('upload_pending', 'uploading')",
        )
        .run(now, upload.asset_id);
      database
        .prepare(
          "UPDATE idempotency_records SET status = 'failed_retryable', response_status = NULL, response_json = NULL, resource_id = NULL WHERE operation = ? AND status = 'in_progress'",
        )
        .run(`upload.complete:${upload.id}`);
      database
        .prepare(
          `UPDATE quota_reservations SET status = 'released', expires_at = NULL,
             updated_at = ?, version = version + 1
           WHERE resource_type = 'upload_bytes' AND resource_id = ? AND status = 'reserved'`,
        )
        .run(now, upload.id);
    });
  }
}
