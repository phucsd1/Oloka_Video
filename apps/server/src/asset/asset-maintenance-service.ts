import type { TransactionRunner } from "../database/database.js";
import type { ObjectStorage } from "../storage/object-storage.js";

interface OpenUpload {
  id: string;
  asset_id: string;
  staging_key: string;
  received_size: number;
  expires_at: number;
}

export interface AssetMaintenanceResult {
  expired: number;
  truncatedFileAhead: number;
  quarantinedDatabaseAhead: number;
  missingDurable: number;
  unreferencedDurable: number;
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
        const expired = this.transactions.run("immediate", ({ database }) =>
          Number(
            database
              .prepare(
                "UPDATE upload_sessions SET status = 'expired', updated_at = ?, version = version + 1 WHERE id = ? AND status = 'open'",
              )
              .run(now, upload.id).changes,
          ),
        );
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

    const manifest = await this.storage.listForReconciliation();
    const references = this.transactions.run("read", ({ database }) => ({
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
    result.unreferencedDurable = manifest.durable.filter(
      (key) => !references.durable.has(key),
    ).length;
    result.missingDurable = references.required.filter(
      ({ storage_key }) => !present.has(storage_key),
    ).length;
    return result;
  }
}
