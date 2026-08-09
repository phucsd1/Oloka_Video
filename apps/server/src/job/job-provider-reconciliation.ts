import type { TransactionRunner } from "../database/database.js";
import type { Clock } from "../kernel/clock.js";
import type {
  ClaimedProviderReconciliation,
  JobRepository,
} from "./job-repository.js";

export interface ProviderReconciliationAdapter {
  poll(operationId: string): Promise<{ status: "pending" }>;
  lookup(
    idempotencyKeyHashSha256: string,
  ): Promise<
    | { status: "found"; operationId: string }
    | { status: "not_found" }
    | { status: "unknown" }
  >;
}

export interface ProviderReconciliationServiceOptions {
  transactions: TransactionRunner;
  repository: JobRepository;
  clock: Clock;
  workerId: string;
  leaseDurationMs: number;
  adapter: ProviderReconciliationAdapter;
}

export class ProviderReconciliationService {
  constructor(private readonly options: ProviderReconciliationServiceOptions) {}

  async runOnce(): Promise<boolean> {
    const claim = this.options.transactions.run("immediate", (context) =>
      this.options.repository.claimWaitingProvider(context, {
        leaseOwner: this.options.workerId,
        now: this.options.clock.now(),
        leaseDurationMs: this.options.leaseDurationMs,
      }),
    );
    if (claim === null) return false;
    if (claim.submissionState === "accepted") {
      await this.options.adapter.poll(requiredOperationId(claim));
    } else {
      const lookup = await this.options.adapter.lookup(
        claim.idempotencyKeyHashSha256,
      );
      if (lookup.status === "found") {
        claim.stepVersion = this.options.transactions.run(
          "immediate",
          (context) =>
            this.options.repository.recordProviderLookupFound(context, {
              jobId: claim.jobId,
              stepId: claim.stepId,
              leaseOwner: claim.leaseOwner,
              expectedStepVersion: claim.stepVersion,
              operationId: lookup.operationId,
              now: this.options.clock.now(),
            }),
        );
      }
    }
    this.options.transactions.run("immediate", (context) =>
      this.options.repository.releaseWaitingProvider(context, {
        jobId: claim.jobId,
        stepId: claim.stepId,
        leaseOwner: claim.leaseOwner,
        expectedJobVersion: claim.jobVersion,
        expectedStepVersion: claim.stepVersion,
        now: this.options.clock.now(),
      }),
    );
    return true;
  }
}

function requiredOperationId(claim: ClaimedProviderReconciliation): string {
  if (claim.operationId === null)
    throw new Error("Accepted provider operation is missing its identity");
  return claim.operationId;
}
