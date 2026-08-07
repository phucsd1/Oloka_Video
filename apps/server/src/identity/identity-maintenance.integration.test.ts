import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import { IdentityMaintenanceService } from "./identity-maintenance-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("identity retention maintenance", () => {
  it("purges stale OAuth envelopes within the 24-hour policy and terminal sessions after 90 days", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-identity-cleanup-"));
    directories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    const now = 100 * 24 * 60 * 60 * 1000;
    database.transactions.run("immediate", ({ database: connection }) => {
      connection.exec(`
        INSERT INTO users
          (id, email_normalized, display_name, role, status, created_at, updated_at, version)
        VALUES
          ('00000000-0000-4000-8000-000000000001', 'member@example.test', 'Member', 'member', 'pending', 1, 1, 1);
      `);
      const insertTransaction = connection.prepare(
        `INSERT INTO oauth_transactions
          (id, provider, state_hash_sha256, nonce_hash_sha256,
           pkce_verifier_ciphertext, pkce_cipher_algorithm, pkce_iv,
           pkce_auth_tag, key_version, redirect_uri, return_path, status,
           created_at, expires_at, consumed_at, failure_count)
         VALUES (?, 'google', ?, ?, ?, 'AES-256-GCM', ?, ?, 1,
                 'https://oloka.test/callback', '/', ?, ?, ?, ?, 0)`,
      );
      insertTransaction.run(
        "00000000-0000-4000-8000-000000000002",
        Buffer.alloc(32, 1),
        Buffer.alloc(32, 2),
        Buffer.from("cipher-old"),
        Buffer.alloc(12, 3),
        Buffer.alloc(16, 4),
        "consumed",
        1,
        now - 3 * 24 * 60 * 60 * 1000,
        now - 2 * 24 * 60 * 60 * 1000,
      );
      insertTransaction.run(
        "00000000-0000-4000-8000-000000000003",
        Buffer.alloc(32, 5),
        Buffer.alloc(32, 6),
        Buffer.from("cipher-new"),
        Buffer.alloc(12, 7),
        Buffer.alloc(16, 8),
        "consumed",
        1,
        now - 60 * 60 * 1000,
        now - 30 * 60 * 1000,
      );
      const insertSession = connection.prepare(
        `INSERT INTO sessions
          (id, user_id, token_hash_sha256, csrf_token_hash_sha256, status,
           created_at, last_seen_at, idle_expires_at, expires_at,
           revoked_at, revoke_reason)
         VALUES (?, '00000000-0000-4000-8000-000000000001', ?, ?,
                 'revoked', 1, 1, 2, 3, ?, 'retention-test')`,
      );
      insertSession.run(
        "00000000-0000-4000-8000-000000000004",
        Buffer.alloc(32, 9),
        Buffer.alloc(32, 10),
        now - 91 * 24 * 60 * 60 * 1000,
      );
      insertSession.run(
        "00000000-0000-4000-8000-000000000005",
        Buffer.alloc(32, 11),
        Buffer.alloc(32, 12),
        now - 10 * 24 * 60 * 60 * 1000,
      );
    });

    const result = new IdentityMaintenanceService(database.transactions).run(
      now,
    );

    expect(result).toEqual({
      expiredTransactions: 0,
      purgedTransactions: 1,
      purgedSessions: 1,
    });
    const counts = database.transactions.run(
      "read",
      ({ database: connection }) => ({
        transactions: connection
          .prepare("SELECT COUNT(*) AS count FROM oauth_transactions")
          .get(),
        sessions: connection
          .prepare("SELECT COUNT(*) AS count FROM sessions")
          .get(),
      }),
    );
    expect(counts).toEqual({
      transactions: { count: 1 },
      sessions: { count: 1 },
    });
    await database.close();
  });
});
