import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import { AdminRecoveryService } from "./admin-recovery-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("operator admin recovery", () => {
  it("promotes only an existing verified Google identity, revokes sessions, and audits atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-admin-recovery-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    const userId = "00000000-0000-4000-8000-000000000001";
    const identityId = "00000000-0000-4000-8000-000000000002";
    database.transactions.run("immediate", ({ database: connection }) => {
      connection
        .prepare(
          `INSERT INTO users
            (id, email_normalized, display_name, role, status, created_at, updated_at, version)
           VALUES (?, 'operator@example.test', 'Operator', 'member', 'pending', 1, 1, 1)`,
        )
        .run(userId);
      connection
        .prepare(
          `INSERT INTO oauth_identities
            (id, user_id, issuer, subject, email_at_link, email_verified,
             profile_json, created_at, last_seen_at)
           VALUES (?, ?, 'https://accounts.google.com', 'subject',
                   'operator@example.test', 1, '{}', 1, 1)`,
        )
        .run(identityId, userId);
      connection
        .prepare(
          `INSERT INTO sessions
            (id, user_id, token_hash_sha256, csrf_token_hash_sha256, status,
             created_at, last_seen_at, idle_expires_at, expires_at)
           VALUES ('00000000-0000-4000-8000-000000000003', ?, ?, ?,
                   'active', 1, 1, 1000, 2000)`,
        )
        .run(userId, Buffer.alloc(32, 1), Buffer.alloc(32, 2));
    });
    const service = new AdminRecoveryService(
      database.transactions,
      { now: () => 100 },
      { generate: () => "00000000-0000-4000-8000-000000000004" },
    );

    service.recover({
      identityId,
      reason: "Restore administrative access after verified incident review",
    });

    const evidence = database.transactions.run(
      "read",
      ({ database: connection }) => ({
        user: connection
          .prepare("SELECT role, status, approved_at FROM users WHERE id = ?")
          .get(userId),
        session: connection
          .prepare(
            "SELECT status, revoke_reason FROM sessions WHERE user_id = ?",
          )
          .get(userId),
        audit: connection
          .prepare("SELECT action, actor_type, outcome FROM audit_events")
          .get(),
      }),
    );
    expect(evidence).toEqual({
      user: { role: "admin", status: "active", approved_at: 100 },
      session: { status: "revoked", revoke_reason: "admin_recovery" },
      audit: {
        action: "admin.recovery",
        actor_type: "system",
        outcome: "success",
      },
    });
    await database.close();
  });
});
