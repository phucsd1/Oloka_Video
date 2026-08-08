import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Asset query plans", () => {
  it("uses the library, owner lifecycle, and upload expiry indexes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-asset-plan-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
      { appBuildSha: "phase3d-plan", appKey: Buffer.alloc(32, 2) },
    );
    try {
      await database.migrate();
      const details = database.transactions.run("read", ({ database }) =>
        [
          database
            .prepare(
              `EXPLAIN QUERY PLAN SELECT id FROM assets
               WHERE project_id = ? AND lifecycle_status = ? AND ingestion_status = ?
               ORDER BY created_at DESC, id DESC LIMIT 25`,
            )
            .all("project", "active", "ready"),
          database
            .prepare(
              `EXPLAIN QUERY PLAN SELECT id FROM assets
               WHERE owner_user_id = ? AND lifecycle_status = ?`,
            )
            .all("owner", "active"),
          database
            .prepare(
              `EXPLAIN QUERY PLAN SELECT id FROM upload_sessions
               WHERE owner_user_id = ? AND status = ? AND expires_at <= ?`,
            )
            .all("owner", "open", 1),
        ]
          .flat()
          .map((row) => String((row as { detail: string }).detail)),
      );
      expect(details.join("\n")).toContain("assets_project_library_idx");
      expect(details.join("\n")).toContain("assets_owner_lifecycle_idx");
      expect(details.join("\n")).toContain(
        "upload_sessions_owner_status_expiry_idx",
      );
    } finally {
      await database.close();
    }
  });
});
