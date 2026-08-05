import type { ReadyResponse } from "@oloka/contracts";
import type { DatabaseSync } from "node:sqlite";

export type DatabaseReadiness = ReadyResponse["checks"]["database"];

export type TransactionMode = "read" | "deferred" | "immediate";

export interface TransactionContext {
  readonly database: DatabaseSync;
}

export class PersistenceBusyError extends Error {
  readonly code = "PERSISTENCE_BUSY";

  constructor(options?: ErrorOptions) {
    super("Persistence is temporarily busy", options);
    this.name = "PersistenceBusyError";
  }
}

export interface TransactionRunner {
  run<T>(
    mode: TransactionMode,
    operation: (context: TransactionContext) => T,
  ): T;
}

export interface SystemDatabase {
  readonly transactions: TransactionRunner;
  migrate(): Promise<void>;
  checkReadiness(): Promise<DatabaseReadiness>;
  close(): Promise<void>;
}
