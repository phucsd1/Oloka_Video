import type { ReadyResponse } from "@oloka/contracts";

export type DatabaseReadiness = ReadyResponse["checks"]["database"];

export interface SystemDatabase {
  migrate(): void;
  checkReadiness(): Promise<DatabaseReadiness>;
  close(): Promise<void>;
}
