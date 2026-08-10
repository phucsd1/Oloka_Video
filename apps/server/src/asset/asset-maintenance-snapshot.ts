import type { AssetMaintenanceResult } from "./asset-maintenance-service.js";

const emptyResult: AssetMaintenanceResult = {
  expired: 0,
  truncatedFileAhead: 0,
  quarantinedDatabaseAhead: 0,
  missingDurable: 0,
  unreferencedDurable: 0,
  unreferencedStaging: 0,
  recoveredVerifying: 0,
  failedVerifying: 0,
};

export class AssetMaintenanceSnapshot {
  private latest: AssetMaintenanceResult = emptyResult;

  update(result: AssetMaintenanceResult): void {
    this.latest = { ...result };
  }

  current(): AssetMaintenanceResult {
    return { ...this.latest };
  }
}
