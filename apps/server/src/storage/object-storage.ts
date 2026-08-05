import type { ReadyResponse } from "@oloka/contracts";

export type ReadinessResult = ReadyResponse["checks"]["storage"];

export interface ObjectStorage {
  checkReadiness(): Promise<ReadinessResult>;
  close(): Promise<void>;
}
