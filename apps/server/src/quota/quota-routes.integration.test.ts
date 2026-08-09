import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AuthenticatedSession,
  IdentityService,
} from "../identity/identity-service.js";
import { registerErrorHandler } from "../http/error-handler.js";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import { UuidIdGenerator } from "../kernel/id-generator.js";
import { QuotaPolicyService } from "./quota-policy-service.js";
import { registerQuotaRoutes } from "./quota-routes.js";

const temporaryDirectories: string[] = [];
const adminId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("admin quota policy HTTP routes", () => {
  it("enforces admin/CSRF/idempotency and returns redacted replay-safe records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-quota-routes-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    database.transactions.run("immediate", ({ database: connection }) => {
      connection.exec(`
        INSERT INTO users (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
          VALUES ('${adminId}','admin@example.test','Admin','admin','active',1,1,1);
        INSERT INTO users (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
          VALUES ('${memberId}','member@example.test','Member','member','active',1,1,1);
      `);
    });
    const admin = session(adminId, "admin");
    const member = session(memberId, "member");
    const sessions = new Map([
      ["admin-session", admin],
      ["member-session", member],
    ]);
    const identity = {
      getSession: (cookie: string | null) => sessions.get(cookie ?? "") ?? null,
      auditStatusDenial: () => undefined,
      verifyCsrfToken: (_sessionId: string, token: string) => token === "csrf",
      auditCsrfFailure: () => undefined,
    } as unknown as IdentityService;
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    registerQuotaRoutes({
      app,
      identityService: identity,
      quotaPolicyService: new QuotaPolicyService(
        database.transactions,
        { now: () => 1_000 },
        new UuidIdGenerator(),
      ),
      publicOrigin: "https://oloka.example.test",
    });
    await app.ready();
    try {
      const memberDenied = await app.inject({
        method: "GET",
        url: "/api/v1/admin/quota-policies",
        headers: { cookie: "__Host-oloka_session=member-session" },
      });
      expect(memberDenied.statusCode).toBe(403);
      const request = policyRequest();
      const missingHeaders = await app.inject({
        method: "POST",
        url: "/api/v1/admin/quota-policies",
        headers: { cookie: "__Host-oloka_session=admin-session" },
        payload: request,
      });
      expect(missingHeaders.statusCode).toBe(403);
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/admin/quota-policies",
        headers: {
          cookie: "__Host-oloka_session=admin-session",
          origin: "https://oloka.example.test",
          "content-type": "application/json",
          "x-oloka-csrf": "csrf",
          "idempotency-key": "quota-1",
        },
        payload: request,
      });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json().createdByUserId).toBeUndefined();
      const replay = await app.inject({
        method: "POST",
        url: "/api/v1/admin/quota-policies",
        headers: {
          cookie: "__Host-oloka_session=admin-session",
          origin: "https://oloka.example.test",
          "content-type": "application/json",
          "x-oloka-csrf": "csrf",
          "idempotency-key": "quota-1",
        },
        payload: request,
      });
      expect(replay.statusCode).toBe(201);
      expect(replay.headers["idempotency-replayed"]).toBe("true");
      const conflict = await app.inject({
        method: "POST",
        url: "/api/v1/admin/quota-policies",
        headers: {
          cookie: "__Host-oloka_session=admin-session",
          origin: "https://oloka.example.test",
          "content-type": "application/json",
          "x-oloka-csrf": "csrf",
          "idempotency-key": "quota-1",
        },
        payload: {
          ...request,
          policy: { schemaVersion: 1, limits: { maxQueuedJobsPerUser: 9 } },
        },
      });
      expect(conflict.statusCode).toBe(409);
      const overlap = await app.inject({
        method: "POST",
        url: "/api/v1/admin/quota-policies",
        headers: {
          cookie: "__Host-oloka_session=admin-session",
          origin: "https://oloka.example.test",
          "content-type": "application/json",
          "x-oloka-csrf": "csrf",
          "idempotency-key": "quota-2",
        },
        payload: request,
      });
      expect(overlap.statusCode).toBe(409);
      const userPolicy = await app.inject({
        method: "POST",
        url: "/api/v1/admin/quota-policies",
        headers: {
          cookie: "__Host-oloka_session=admin-session",
          origin: "https://oloka.example.test",
          "content-type": "application/json",
          "x-oloka-csrf": "csrf",
          "idempotency-key": "quota-user-1",
        },
        payload: {
          ...policyRequest(),
          scopeType: "user",
          scopeId: memberId,
          effectiveFrom: "1970-01-01T00:16:41.000Z",
          effectiveUntil: null,
        },
      });
      expect(userPolicy.statusCode, userPolicy.body).toBe(201);
      const list = await app.inject({
        method: "GET",
        url: "/api/v1/admin/quota-policies",
        headers: { cookie: "__Host-oloka_session=admin-session" },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().policies).toHaveLength(2);
      expect(
        database.transactions.run("read", ({ database: connection }) =>
          connection
            .prepare(
              "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'admin.quota_policy_create'",
            )
            .get(),
        ),
      ).toEqual({ count: 2 });
    } finally {
      await app.close();
      await database.close();
    }
  });
});

function session(id: string, role: "admin" | "member"): AuthenticatedSession {
  return {
    sessionId: `${id}-session-id`,
    user: {
      id,
      email: `${role}@example.test`,
      displayName: role,
      avatarUrl: null,
      role,
      status: "active",
      version: 1,
    },
  };
}

function policyRequest() {
  return {
    scopeType: "system",
    policy: { schemaVersion: 1, limits: { maxQueuedJobsPerUser: 3 } },
    effectiveFrom: "1970-01-01T00:00:01.000Z",
    effectiveUntil: "1970-01-01T00:16:40.000Z",
  };
}
