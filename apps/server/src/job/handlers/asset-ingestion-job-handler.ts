import type { TransactionRunner } from "../../database/database.js";
import type { Clock } from "../../kernel/clock.js";
import type { JobHandler } from "../job-handler-registry.js";
import type { ClaimedJob, JobRepository } from "../job-repository.js";
import { ApplicationError } from "../../http/application-error.js";

export interface AssetInspectionResult {
  byteSize: number;
}

export interface AssetIngestionJobHandlerOptions {
  transactions: TransactionRunner;
  repository: JobRepository;
  clock: Clock;
  inspect(storageKey: string): Promise<AssetInspectionResult>;
}

export class AssetIngestionJobHandler implements JobHandler {
  readonly type = "asset_ingestion" as const;

  constructor(private readonly options: AssetIngestionJobHandlerOptions) {}

  async handle(claim: ClaimedJob): Promise<void> {
    try {
      const storageKey = this.options.transactions.run(
        "read",
        ({ database }) => {
          const asset = database
            .prepare(
              `SELECT storage_key FROM assets
             WHERE id = ? AND ingestion_status = 'processing'
               AND lifecycle_status = 'active'`,
            )
            .get(claim.assetId) as { storage_key: string } | undefined;
          if (asset === undefined)
            throw new ApplicationError(
              "RESOURCE_STATE_CONFLICT",
              "asset_not_ingestible",
            );
          return asset.storage_key;
        },
      );
      const inspection = await this.options.inspect(storageKey);
      if (!Number.isSafeInteger(inspection.byteSize) || inspection.byteSize < 1)
        throw new ApplicationError("ASSET_INVALID", "asset_metadata_invalid");
      claim.heartbeat?.();
      const progress = this.options.transactions.run("immediate", (context) =>
        this.options.repository.reportProgress(context, {
          jobId: claim.jobId,
          stepId: claim.stepId,
          leaseOwner: claim.leaseOwner,
          expectedJobVersion: claim.jobVersion,
          expectedStepVersion: claim.stepVersion,
          progressBasisPoints: 5_000,
          now: this.options.clock.now(),
        }),
      );
      claim.jobVersion = progress.jobVersion;
      claim.stepVersion = progress.stepVersion;
      this.options.transactions.run("immediate", (context) =>
        this.options.repository.completeAssetIngestion(context, {
          jobId: claim.jobId,
          stepId: claim.stepId,
          assetId: claim.assetId,
          leaseOwner: claim.leaseOwner,
          expectedJobVersion: claim.jobVersion,
          expectedStepVersion: claim.stepVersion,
          now: this.options.clock.now(),
        }),
      );
    } catch (error) {
      const retryable = !(error instanceof ApplicationError) || error.retryable;
      const failureCode =
        error instanceof ApplicationError ? error.code : "STORAGE_UNAVAILABLE";
      try {
        this.options.transactions.run("immediate", (context) =>
          this.options.repository.failAssetIngestion(context, {
            jobId: claim.jobId,
            stepId: claim.stepId,
            assetId: claim.assetId,
            leaseOwner: claim.leaseOwner,
            expectedJobVersion: claim.jobVersion,
            expectedStepVersion: claim.stepVersion,
            now: this.options.clock.now(),
            failureCode,
            retryable,
          }),
        );
      } catch (settlementError) {
        if (
          !(settlementError instanceof ApplicationError) ||
          settlementError.code !== "VERSION_CONFLICT"
        )
          throw settlementError;
      }
    }
  }
}
