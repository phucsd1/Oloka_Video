import {
  canonicalizeJson,
  type JsonValue,
} from "../../kernel/canonical-json.js";
import type { TransactionContext } from "../database.js";

export const SYSTEM_METADATA_KEYS = [
  "kernel.schema",
  "kernel.backup",
  "deployment.runtime",
] as const;
export type SystemMetadataKey = (typeof SYSTEM_METADATA_KEYS)[number];

export interface SystemMetadataRecord {
  key: SystemMetadataKey;
  value: JsonValue;
  updatedAt: number;
  version: number;
}

export class SystemMetadataRepository {
  get(
    context: TransactionContext,
    key: SystemMetadataKey,
  ): SystemMetadataRecord | undefined {
    assertAllowedKey(key);
    const row = context.database
      .prepare(
        "SELECT key, value_json, updated_at, version FROM system_metadata WHERE key = ?",
      )
      .get(key) as
      | {
          key: SystemMetadataKey;
          value_json: string;
          updated_at: number;
          version: number;
        }
      | undefined;
    if (row === undefined) return undefined;
    const value = JSON.parse(row.value_json) as JsonValue;
    if (canonicalizeJson(value) !== row.value_json) {
      throw new Error("Stored system metadata is not canonical JSON");
    }
    return {
      key: row.key,
      value,
      updatedAt: row.updated_at,
      version: row.version,
    };
  }

  put(
    context: TransactionContext,
    input: {
      key: SystemMetadataKey;
      value: JsonValue;
      updatedAt: number;
      expectedVersion: number | null;
    },
  ): SystemMetadataRecord {
    assertAllowedKey(input.key);
    const valueJson = canonicalizeJson(input.value);
    const result =
      input.expectedVersion === null
        ? context.database
            .prepare(
              `INSERT INTO system_metadata (key, value_json, updated_at, version)
               VALUES (?, ?, ?, 1) ON CONFLICT(key) DO NOTHING`,
            )
            .run(input.key, valueJson, input.updatedAt)
        : context.database
            .prepare(
              `UPDATE system_metadata SET value_json = ?, updated_at = ?, version = version + 1
               WHERE key = ? AND version = ?`,
            )
            .run(valueJson, input.updatedAt, input.key, input.expectedVersion);
    if (result.changes !== 1) {
      throw new Error("System metadata optimistic version conflict");
    }
    return this.get(context, input.key) as SystemMetadataRecord;
  }
}

function assertAllowedKey(key: string): asserts key is SystemMetadataKey {
  if (!(SYSTEM_METADATA_KEYS as readonly string[]).includes(key)) {
    throw new Error("System metadata key is not allowed");
  }
}
