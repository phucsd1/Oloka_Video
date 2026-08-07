import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import type { Clock } from "../kernel/clock.js";
import { UuidIdGenerator } from "../kernel/id-generator.js";
import { IdentityError, IdentityService } from "./identity-service.js";
import type {
  OidcAuthorizationRequest,
  OidcCallbackRequest,
  OidcIdentityClaims,
  OidcProviderClient,
} from "./oidc-provider-client.js";
import { hashOpaqueToken } from "./session-security.js";

const directories: string[] = [];
const databases: SqliteSystemDatabase[] = [];

afterEach(async () => {
  await Promise.allSettled(
    databases.splice(0).map((database) => database.close()),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("identity transaction contract", () => {
  it("consumes state once, deduplicates subjects, and refuses email-only linking", async () => {
    const harness = await createHarness({
      subject: "member-subject",
      email: "member@example.test",
      emailVerified: true,
      displayName: "Member",
      avatarUrl: null,
    });
    const first = await harness.service.startAuthorization("/account/pending");
    await harness.service.startAuthorization();
    const firstState = first.searchParams.get("state")!;
    const rowsBeforeCallback = readOAuthRows(harness);
    const firstRow = rowsBeforeCallback.find((row) =>
      buffersEqual(row.state_hash_sha256, sha256(firstState)),
    )!;

    expect(rowsBeforeCallback).toHaveLength(2);
    expect(buffersEqual(firstRow.state_hash_sha256, sha256(firstState))).toBe(
      true,
    );
    expect(
      buffersEqual(
        firstRow.nonce_hash_sha256,
        sha256(harness.authorizationRequests[0]!.nonce),
      ),
    ).toBe(true);
    expect(
      buffersEqual(
        rowsBeforeCallback[0]!.pkce_iv,
        rowsBeforeCallback[1]!.pkce_iv,
      ),
    ).toBe(false);
    expect(
      Buffer.from(firstRow.pkce_verifier_ciphertext).toString("utf8"),
    ).not.toContain(harness.authorizationRequests[0]!.nonce);

    const callback = new URL(
      `https://oloka.example.test/api/v1/auth/google/callback?code=one&state=${encodeURIComponent(firstState)}`,
    );
    const race = await Promise.allSettled([
      harness.service.finishAuthorization(callback, firstState, metadata),
      harness.service.finishAuthorization(callback, firstState, metadata),
    ]);
    expect(race.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = race.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        code: "AUTHENTICATION_REQUIRED",
      }),
    });
    expect(harness.callbackRequests).toHaveLength(1);
    expect(
      Buffer.from(firstRow.pkce_verifier_ciphertext).toString("utf8"),
    ).not.toContain(harness.callbackRequests[0]!.pkceCodeVerifier);

    const firstSessionToken = (
      race.find(
        ({ status }) => status === "fulfilled",
      ) as PromiseFulfilledResult<{
        sessionToken: string;
      }>
    ).value.sessionToken;
    const firstCounts = readIdentityCounts(harness);
    expect(firstCounts).toEqual({ users: 1, identities: 1, sessions: 1 });
    expect(
      buffersEqual(
        readSessionTokenHash(harness),
        hashOpaqueToken(firstSessionToken),
      ),
    ).toBe(true);

    harness.clock.advance(10_000);
    const sameSubject = await harness.service.startAuthorization();
    await harness.service.finishAuthorization(
      callbackFor(sameSubject, "same-subject"),
      sameSubject.searchParams.get("state")!,
      metadata,
    );
    expect(readIdentityCounts(harness)).toEqual({
      users: 1,
      identities: 1,
      sessions: 2,
    });
    expect(readIdentityLastSeen(harness)).toBe(harness.clock.now());

    harness.claims.subject = "different-subject";
    const conflicting = await harness.service.startAuthorization();
    await expect(
      harness.service.finishAuthorization(
        callbackFor(conflicting, "email-conflict"),
        conflicting.searchParams.get("state")!,
        metadata,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_STATE_CONFLICT" });
    expect(readIdentityCounts(harness)).toEqual({
      users: 1,
      identities: 1,
      sessions: 2,
    });
  });

  it("consumes a provider-denied transaction once without exchanging or creating identity data", async () => {
    const harness = await createHarness({
      subject: "must-not-be-created",
      email: "denied@example.test",
      emailVerified: true,
      displayName: "Denied",
      avatarUrl: null,
    });
    const start = await harness.service.startAuthorization();
    const state = start.searchParams.get("state")!;

    harness.service.denyAuthorization(state, "user_denied");

    expect(
      captureIdentityError(() =>
        harness.service.denyAuthorization(state, "user_denied"),
      ).code,
    ).toBe("AUTHENTICATION_REQUIRED");
    expect(harness.callbackRequests).toHaveLength(0);
    expect(readIdentityCounts(harness)).toEqual({
      users: 0,
      identities: 0,
      sessions: 0,
    });
    expect(
      harness.database.transactions.run("read", ({ database }) =>
        database
          .prepare(
            "SELECT metadata_json FROM audit_events WHERE action = 'auth.oauth_callback_denied'",
          )
          .get(),
      ),
    ).toEqual({ metadata_json: '{"failureCategory":"user_denied"}' });
  });

  it("rejects an expired OAuth transaction before provider exchange", async () => {
    const harness = await createHarness({
      subject: "expired-subject",
      email: "expired@example.test",
      emailVerified: true,
      displayName: "Expired",
      avatarUrl: null,
    });
    const start = await harness.service.startAuthorization();
    const state = start.searchParams.get("state")!;
    harness.clock.advance(10 * 60 * 1000 + 1);

    await expect(
      harness.service.finishAuthorization(
        callbackFor(start, "expired-code"),
        state,
        metadata,
      ),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(harness.callbackRequests).toHaveLength(0);
    expect(readIdentityCounts(harness)).toEqual({
      users: 0,
      identities: 0,
      sessions: 0,
    });
  });

  it("serializes two matching first-admin callbacks into one User and one bootstrap audit", async () => {
    const harness = await createHarness(
      {
        subject: "admin-subject",
        email: "admin@example.test",
        emailVerified: true,
        displayName: "Admin",
        avatarUrl: null,
      },
      "admin@example.test",
    );
    const starts = await Promise.all([
      harness.service.startAuthorization(),
      harness.service.startAuthorization(),
    ]);
    const results = await Promise.all(
      starts.map((start, index) =>
        harness.service.finishAuthorization(
          callbackFor(start, `admin-race-${index}`),
          start.searchParams.get("state")!,
          metadata,
        ),
      ),
    );

    expect(results).toHaveLength(2);
    expect(
      harness.database.transactions.run("read", ({ database }) => ({
        users: database.prepare("SELECT COUNT(*) AS count FROM users").get(),
        admins: database
          .prepare(
            "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'",
          )
          .get(),
        identities: database
          .prepare("SELECT COUNT(*) AS count FROM oauth_identities")
          .get(),
        bootstrapAudits: database
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'admin.bootstrap' AND outcome = 'success'",
          )
          .get(),
      })),
    ).toEqual({
      users: { count: 1 },
      admins: { count: 1 },
      identities: { count: 1 },
      bootstrapAudits: { count: 1 },
    });
  });
});

describe("session lifecycle contract", () => {
  it("coalesces touches, enforces both expiries, rotates login, logout, and revoke-all", async () => {
    const harness = await createHarness({
      subject: "session-subject",
      email: "session@example.test",
      emailVerified: true,
      displayName: "Session member",
      avatarUrl: null,
    });
    const initial = await login(harness, "initial");
    const initialSession = harness.service.getSession(initial.sessionToken)!;
    const original = readSession(harness, initialSession.sessionId);

    harness.clock.advance(4 * 60 * 1000);
    expect(harness.service.getSession(initial.sessionToken)).not.toBeNull();
    expect(readSession(harness, initialSession.sessionId).last_seen_at).toBe(
      original.last_seen_at,
    );

    harness.clock.advance(2 * 60 * 1000);
    expect(harness.service.getSession(initial.sessionToken)).not.toBeNull();
    const touched = readSession(harness, initialSession.sessionId);
    expect(touched.last_seen_at).toBe(harness.clock.now());
    expect(touched.idle_expires_at).toBe(
      Math.min(harness.clock.now() + 10 * 60 * 1000, touched.expires_at),
    );

    const rotated = await login(harness, "rotated", initial.sessionToken);
    expect(harness.service.getSession(initial.sessionToken)).toBeNull();
    expect(readSession(harness, initialSession.sessionId)).toMatchObject({
      status: "revoked",
      revoke_reason: "login_rotation",
    });
    const rotatedSession = harness.service.getSession(rotated.sessionToken)!;
    harness.service.logout(rotatedSession);
    expect(harness.service.getSession(rotated.sessionToken)).toBeNull();
    expect(readSession(harness, rotatedSession.sessionId).revoke_reason).toBe(
      "logout",
    );

    const revokeOne = await login(harness, "revoke-one");
    const revokeTwo = await login(harness, "revoke-two");
    const revokeSession = harness.service.getSession(revokeOne.sessionToken)!;
    expect(
      harness.service.revokeAllSessions(revokeSession),
    ).toBeGreaterThanOrEqual(2);
    expect(harness.service.getSession(revokeOne.sessionToken)).toBeNull();
    expect(harness.service.getSession(revokeTwo.sessionToken)).toBeNull();

    const idle = await login(harness, "idle-expiry");
    const idleSession = harness.service.getSession(idle.sessionToken)!;
    harness.clock.advance(10 * 60 * 1000 + 1);
    expect(harness.service.getSession(idle.sessionToken)).toBeNull();
    expect(readSession(harness, idleSession.sessionId)).toMatchObject({
      status: "expired",
      revoke_reason: "expired",
    });

    const absolute = await login(harness, "absolute-expiry");
    const absoluteSession = harness.service.getSession(absolute.sessionToken)!;
    for (let step = 0; step < 4; step += 1) {
      harness.clock.advance(6 * 60 * 1000);
      expect(harness.service.getSession(absolute.sessionToken)).not.toBeNull();
    }
    harness.clock.advance(6 * 60 * 1000 + 1);
    expect(harness.service.getSession(absolute.sessionToken)).toBeNull();
    expect(readSession(harness, absoluteSession.sessionId).status).toBe(
      "expired",
    );
  });
});

const metadata = {
  ipAddress: "203.0.113.42",
  userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/123.0 private-detail",
};

class MutableClock implements Clock {
  constructor(private value: number) {}
  now(): number {
    return this.value;
  }
  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

async function createHarness(
  claims: OidcIdentityClaims,
  bootstrapAdminEmail = "configured-admin@example.test",
) {
  const directory = await mkdtemp(join(tmpdir(), "oloka-identity-contract-"));
  directories.push(directory);
  const database = await SqliteSystemDatabase.connect(
    pathToFileURL(join(directory, "identity.sqlite")).href,
  );
  databases.push(database);
  await database.migrate();
  const clock = new MutableClock(1_000_000);
  const authorizationRequests: OidcAuthorizationRequest[] = [];
  const callbackRequests: OidcCallbackRequest[] = [];
  const oidcClient: OidcProviderClient = {
    createAuthorizationUrl(request) {
      authorizationRequests.push(request);
      return Promise.resolve(
        new URL(
          `https://issuer.example.test/authorize?state=${encodeURIComponent(request.state)}`,
        ),
      );
    },
    async exchangeCallback(request) {
      callbackRequests.push(request);
      await Promise.resolve();
      return { ...claims };
    },
  };
  const service = new IdentityService({
    transactions: database.transactions,
    oidcClient,
    applicationKey: Buffer.alloc(32, 9),
    issuer: "https://issuer.example.test",
    redirectUri: "https://oloka.example.test/api/v1/auth/google/callback",
    bootstrapAdminEmail,
    oauthTransactionTtlMs: 10 * 60 * 1000,
    sessionIdleTtlMs: 10 * 60 * 1000,
    sessionAbsoluteTtlMs: 30 * 60 * 1000,
    clock,
    idGenerator: new UuidIdGenerator(),
  });
  return {
    database,
    service,
    clock,
    claims,
    authorizationRequests,
    callbackRequests,
  };
}

async function login(
  harness: Awaited<ReturnType<typeof createHarness>>,
  code: string,
  currentSessionToken?: string,
) {
  const start = await harness.service.startAuthorization();
  const state = start.searchParams.get("state")!;
  return harness.service.finishAuthorization(
    callbackFor(start, code),
    state,
    metadata,
    currentSessionToken,
  );
}

function callbackFor(start: URL, code: string): URL {
  return new URL(
    `https://oloka.example.test/api/v1/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(start.searchParams.get("state")!)}`,
  );
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function readOAuthRows(harness: Awaited<ReturnType<typeof createHarness>>) {
  return harness.database.transactions.run("read", ({ database }) =>
    database
      .prepare(
        `SELECT state_hash_sha256, nonce_hash_sha256,
                pkce_verifier_ciphertext, pkce_iv
           FROM oauth_transactions ORDER BY created_at, id`,
      )
      .all(),
  ) as unknown as Array<{
    state_hash_sha256: Uint8Array;
    nonce_hash_sha256: Uint8Array;
    pkce_verifier_ciphertext: Uint8Array;
    pkce_iv: Uint8Array;
  }>;
}

function readIdentityCounts(
  harness: Awaited<ReturnType<typeof createHarness>>,
): { users: number; identities: number; sessions: number } {
  return harness.database.transactions.run("read", ({ database }) => ({
    users: (
      database.prepare("SELECT COUNT(*) AS count FROM users").get() as {
        count: number;
      }
    ).count,
    identities: (
      database
        .prepare("SELECT COUNT(*) AS count FROM oauth_identities")
        .get() as {
        count: number;
      }
    ).count,
    sessions: (
      database.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
        count: number;
      }
    ).count,
  }));
}

function readIdentityLastSeen(
  harness: Awaited<ReturnType<typeof createHarness>>,
): number {
  return harness.database.transactions.run(
    "read",
    ({ database }) =>
      (
        database.prepare("SELECT last_seen_at FROM oauth_identities").get() as {
          last_seen_at: number;
        }
      ).last_seen_at,
  );
}

function readSessionTokenHash(
  harness: Awaited<ReturnType<typeof createHarness>>,
): Uint8Array {
  return harness.database.transactions.run(
    "read",
    ({ database }) =>
      (
        database
          .prepare(
            "SELECT token_hash_sha256 FROM sessions ORDER BY created_at, id LIMIT 1",
          )
          .get() as { token_hash_sha256: Uint8Array }
      ).token_hash_sha256,
  );
}

function buffersEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function readSession(
  harness: Awaited<ReturnType<typeof createHarness>>,
  sessionId: string,
) {
  return harness.database.transactions.run(
    "read",
    ({ database }) =>
      database
        .prepare(
          `SELECT status, last_seen_at, idle_expires_at, expires_at, revoke_reason
             FROM sessions WHERE id = ?`,
        )
        .get(sessionId) as {
        status: string;
        last_seen_at: number;
        idle_expires_at: number;
        expires_at: number;
        revoke_reason: string | null;
      },
  );
}

function captureIdentityError(operation: () => unknown): IdentityError {
  try {
    operation();
  } catch (error) {
    if (error instanceof IdentityError) return error;
    throw error;
  }
  throw new Error("Expected an identity error");
}
