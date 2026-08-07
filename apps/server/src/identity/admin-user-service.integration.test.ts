import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import { UuidIdGenerator } from "../kernel/id-generator.js";
import {
  IdentityError,
  type AuthenticatedSession,
} from "./identity-service.js";
import { AdminUserService } from "./admin-user-service.js";

const directories: string[] = [];
const databases: SqliteSystemDatabase[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("admin user transitions", () => {
  it("enforces state, version, idempotency, session, audit, and last-admin invariants", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-admin-contract-"));
    directories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "admin.sqlite")).href,
    );
    databases.push(database);
    await database.migrate();
    seedUsersAndSessions(database);
    const clock = { now: () => 5_000 };
    const service = new AdminUserService(
      database.transactions,
      clock,
      new UuidIdGenerator(),
    );
    const actor = adminSession(ids.adminOne);

    const rejected = service.transition(
      actor,
      ids.memberRejected,
      { status: "rejected", version: 1, reason: "Not approved" },
      "reject-member-0001",
    );
    expect(rejected.user.status).toBe("rejected");
    expect(readSession(database, ids.rejectedSession)).toEqual({
      status: "revoked",
      revoke_reason: "admin_user_transition",
    });
    expect(
      identityErrorCode(() =>
        service.transition(
          actor,
          ids.memberRejected,
          { status: "disabled", version: 2, reason: "Invalid transition" },
          "invalid-transition-0001",
        ),
      ),
    ).toBe("RESOURCE_STATE_CONFLICT");

    expect(
      identityErrorCode(() =>
        service.transition(
          actor,
          ids.memberVersion,
          { status: "active", version: 99, reason: "Stale version" },
          "stale-version-0001",
        ),
      ),
    ).toBe("VERSION_CONFLICT");

    const concurrent = await Promise.allSettled([
      Promise.resolve().then(() =>
        service.transition(
          actor,
          ids.memberConcurrent,
          { status: "active", version: 1, reason: "First admin decision" },
          "concurrent-decision-0001",
        ),
      ),
      Promise.resolve().then(() =>
        service.transition(
          actor,
          ids.memberConcurrent,
          { status: "rejected", version: 1, reason: "Second admin decision" },
          "concurrent-decision-0002",
        ),
      ),
    ]);
    expect(
      concurrent.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      concurrent.filter(({ status }) => status === "rejected"),
    ).toHaveLength(1);

    const activated = service.transition(
      actor,
      ids.memberActive,
      { status: "active", version: 1, reason: "Closed beta approval" },
      "activate-member-0001",
    );
    expect(activated.user.status).toBe("active");
    const disabled = service.transition(
      actor,
      ids.memberActive,
      { status: "disabled", version: 2, reason: "Access suspended" },
      "disable-member-0001",
    );
    expect(disabled.user.status).toBe("disabled");
    expect(
      identityErrorCode(() =>
        service.transition(
          actor,
          ids.memberActive,
          {
            status: "active",
            version: 3,
            reason: "Different semantic request",
          },
          "disable-member-0001",
        ),
      ),
    ).toBe("IDEMPOTENCY_KEY_CONFLICT");

    service.transition(
      actor,
      ids.adminTwo,
      { status: "disabled", version: 1, reason: "Rotate secondary admin" },
      "disable-admin-two-0001",
    );
    expect(
      identityErrorCode(() =>
        service.transition(
          actor,
          ids.adminOne,
          {
            status: "disabled",
            version: 1,
            reason: "Would remove final admin",
          },
          "disable-final-admin-0001",
        ),
      ),
    ).toBe("RESOURCE_STATE_CONFLICT");

    const evidence = database.transactions.run(
      "read",
      ({ database: connection }) => ({
        successfulStatusAudits: (
          connection
            .prepare(
              `SELECT COUNT(*) AS count FROM audit_events
              WHERE action IN ('admin.user_approved', 'admin.user_rejected', 'admin.user_disabled')
                AND outcome = 'success'`,
            )
            .get() as { count: number }
        ).count,
        invalidTransitionAudits: (
          connection
            .prepare(
              "SELECT COUNT(*) AS count FROM audit_events WHERE metadata_json LIKE '%Invalid transition%'",
            )
            .get() as { count: number }
        ).count,
        completedCommands: (
          connection
            .prepare(
              "SELECT COUNT(*) AS count FROM idempotency_records WHERE status = 'completed'",
            )
            .get() as { count: number }
        ).count,
      }),
    );
    expect(evidence.successfulStatusAudits).toBeGreaterThanOrEqual(5);
    expect(evidence.invalidTransitionAudits).toBe(0);
    expect(evidence.completedCommands).toBeGreaterThanOrEqual(5);
  });
});

const ids = {
  adminOne: "00000000-0000-4000-8000-000000000201",
  adminTwo: "00000000-0000-4000-8000-000000000202",
  memberRejected: "00000000-0000-4000-8000-000000000203",
  memberVersion: "00000000-0000-4000-8000-000000000204",
  memberConcurrent: "00000000-0000-4000-8000-000000000205",
  memberActive: "00000000-0000-4000-8000-000000000206",
  rejectedSession: "00000000-0000-4000-8000-000000000211",
};

function seedUsersAndSessions(database: SqliteSystemDatabase): void {
  database.transactions.run("immediate", ({ database: connection }) => {
    const insertUser = connection.prepare(
      `INSERT INTO users
        (id, email_normalized, display_name, role, status, approved_at,
         created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1)`,
    );
    insertUser.run(
      ids.adminOne,
      "admin-one@example.test",
      "Admin One",
      "admin",
      "active",
      1,
    );
    insertUser.run(
      ids.adminTwo,
      "admin-two@example.test",
      "Admin Two",
      "admin",
      "active",
      1,
    );
    for (const [id, label] of [
      [ids.memberRejected, "Rejected"],
      [ids.memberVersion, "Version"],
      [ids.memberConcurrent, "Concurrent"],
      [ids.memberActive, "Active"],
    ] as const) {
      insertUser.run(
        id,
        `${label.toLowerCase()}@example.test`,
        `${label} Member`,
        "member",
        "pending",
        null,
      );
    }
    connection
      .prepare(
        `INSERT INTO sessions
          (id, user_id, token_hash_sha256, csrf_token_hash_sha256, status,
           created_at, last_seen_at, idle_expires_at, expires_at)
         VALUES (?, ?, ?, ?, 'active', 1, 1, 10000, 20000)`,
      )
      .run(
        ids.rejectedSession,
        ids.memberRejected,
        Buffer.alloc(32, 31),
        Buffer.alloc(32, 32),
      );
  });
}

function adminSession(userId: string): AuthenticatedSession {
  return {
    sessionId: randomUUID(),
    user: {
      id: userId,
      email: "admin-one@example.test",
      displayName: "Admin One",
      avatarUrl: null,
      role: "admin",
      status: "active",
      version: 1,
    },
  };
}

function readSession(database: SqliteSystemDatabase, sessionId: string) {
  return database.transactions.run(
    "read",
    ({ database: connection }) =>
      connection
        .prepare("SELECT status, revoke_reason FROM sessions WHERE id = ?")
        .get(sessionId) as { status: string; revoke_reason: string | null },
  );
}

function identityErrorCode(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    if (error instanceof IdentityError) return error.code;
    throw error;
  }
  throw new Error("Expected an identity error");
}
