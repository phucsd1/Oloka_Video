import type { ReconcileResult } from "./job-repository.js";

export interface JobOperationsActivitySnapshot {
  reconciliationRunsSinceProcessStart: number;
  requeuedExpiredWorkSinceProcessStart: number;
  cancellationCleanupSinceProcessStart: number;
  waitingProviderReconciliationsSinceProcessStart: number;
}

export class JobOperationsActivity {
  private reconciliationRuns = 0;
  private requeuedExpiredWork = 0;
  private cancellationCleanup = 0;
  private waitingProviderReconciliations = 0;

  recordReconciliation(result: ReconcileResult): void {
    this.reconciliationRuns += 1;
    this.requeuedExpiredWork += result.requeued;
  }

  recordCancellationCleanup(): void {
    this.cancellationCleanup += 1;
  }

  recordWaitingProviderReconciliation(): void {
    this.waitingProviderReconciliations += 1;
  }

  snapshot(): JobOperationsActivitySnapshot {
    return {
      reconciliationRunsSinceProcessStart: this.reconciliationRuns,
      requeuedExpiredWorkSinceProcessStart: this.requeuedExpiredWork,
      cancellationCleanupSinceProcessStart: this.cancellationCleanup,
      waitingProviderReconciliationsSinceProcessStart:
        this.waitingProviderReconciliations,
    };
  }
}
