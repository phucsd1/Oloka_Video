import type { ReadyResponse } from "@oloka/contracts";

export type ReadinessResult = ReadyResponse["checks"]["storage"];

export interface StoredObjectStat {
  size: number;
  modifiedAt: Date;
}

export interface ObjectStorage {
  stage(stagingKey: string): Promise<void>;
  appendAtOffset(
    stagingKey: string,
    offset: number,
    bytes: Uint8Array,
  ): Promise<void>;
  statStaging(stagingKey: string): Promise<StoredObjectStat>;
  truncateStaging(stagingKey: string, size: number): Promise<void>;
  finalize(stagingKey: string, storageKey: string): Promise<void>;
  rollbackFinalize(stagingKey: string, storageKey: string): Promise<void>;
  openRange(
    storageKey: string,
    start: number,
    end: number,
  ): Promise<NodeJS.ReadableStream>;
  head(storageKey: string): Promise<StoredObjectStat>;
  delete(kind: "staging" | "durable", key: string): Promise<void>;
  listForReconciliation(): Promise<{ staging: string[]; durable: string[] }>;
  readPrefix(storageKey: string, length: number): Promise<Buffer>;
  readStagingPrefix(stagingKey: string, length: number): Promise<Buffer>;
  createHash(storageKey: string): Promise<string>;
  createStagingHash(stagingKey: string): Promise<string>;
  checkReadiness(): Promise<ReadinessResult>;
  close(): Promise<void>;
}
