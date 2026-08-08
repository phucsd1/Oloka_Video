import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApplication } from "../app.js";
import { parseEnvironment } from "../config/environment.js";
import type {
  OidcAuthorizationRequest,
  OidcCallbackRequest,
  OidcProviderClient,
} from "./oidc-provider-client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("identity HTTP routes", () => {
  it("bootstraps exactly the configured verified first admin through Google callback", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "oloka-identity-api-"));
    temporaryDirectories.push(dataDir);
    let authorizationRequest: OidcAuthorizationRequest | undefined;
    let callbackRequest: OidcCallbackRequest | undefined;
    let nextIdentity = {
      subject: "google-subject-1",
      email: "Admin@Example.Test",
      emailVerified: true,
      displayName: "Quản trị viên",
      avatarUrl: "https://images.example.test/admin.png" as string | null,
    };
    const oidcClient: OidcProviderClient = {
      createAuthorizationUrl: (request) => {
        authorizationRequest = request;
        return Promise.resolve(
          new URL(
            `https://fake-oidc.test/authorize?state=${encodeURIComponent(request.state)}`,
          ),
        );
      },
      exchangeCallback: (request) => {
        callbackRequest = request;
        return Promise.resolve(nextIdentity);
      },
    };
    const app = await buildApplication({
      environment: parseEnvironment({
        NODE_ENV: "test",
        OBJECT_STORAGE_ROOT: join(dataDir, "objects"),
        DATABASE_PATH: join(dataDir, "database", "test.db"),
        OLOKA_APP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        OLOKA_GOOGLE_OIDC_ISSUER: "https://fake-oidc.test",
        OLOKA_GOOGLE_CLIENT_ID: "test-client",
        OLOKA_GOOGLE_CLIENT_SECRET: "test-client-secret",
        OLOKA_PUBLIC_ORIGIN: "https://oloka.example.test",
        OLOKA_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
        LOG_LEVEL: "silent",
      }),
      serveFrontend: false,
      oidcClient,
    });

    const start = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start",
    });
    expect(start.statusCode).toBe(302);
    expect(authorizationRequest).toMatchObject({
      redirectUri: "https://oloka.example.test/api/v1/auth/google/callback",
      codeChallengeMethod: "S256",
    });

    const state = new URL(start.headers.location!).searchParams.get("state")!;
    const callback = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=one-use-code&state=${encodeURIComponent(state)}`,
    });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe("/");
    expect(callback.body).not.toContain("one-use-code");
    expect(callback.body).not.toContain(state);
    expect(callbackRequest).toMatchObject({
      expectedState: state,
      expectedNonce: authorizationRequest?.nonce,
    });
    expect(callbackRequest?.pkceCodeVerifier).not.toBe(
      authorizationRequest?.codeChallenge,
    );
    const cookie = callback.headers["set-cookie"] as string;
    expect(cookie).toContain("__Host-oloka_session=");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Domain=");
    const replayedCallback = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=replayed-code&state=${encodeURIComponent(state)}`,
    });
    expect(replayedCallback.statusCode).toBe(303);
    expect(replayedCallback.headers.location).toBe("/auth/error");
    expect(replayedCallback.headers["cache-control"]).toBe("no-store");
    expect(replayedCallback.headers.pragma).toBe("no-cache");
    expect(replayedCallback.headers["referrer-policy"]).toBe("no-referrer");
    expect(replayedCallback.body).not.toContain(state);
    expect(replayedCallback.body).not.toContain("replayed-code");
    const missingState = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/callback?code=missing-state-code",
    });
    expect(missingState.statusCode).toBe(303);
    expect(missingState.headers.location).toBe("/auth/error");
    expect(missingState.body).not.toContain("missing-state-code");
    const invalidState = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/callback?code=invalid-state-code&state=not-a-real-state",
    });
    expect(invalidState.statusCode).toBe(303);
    expect(invalidState.headers.location).toBe("/auth/error");

    const session = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: cookie.split(";")[0]! },
    });
    expect(session.statusCode, session.body).toBe(200);
    expect(session.json()).toMatchObject({
      authenticated: true,
      user: {
        email: "admin@example.test",
        role: "admin",
        status: "active",
      },
    });
    const visitorAdmin = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users",
    });
    expect(visitorAdmin.statusCode).toBe(401);
    expect(visitorAdmin.json().error.code).toBe("AUTHENTICATION_REQUIRED");
    expectCanonicalError(visitorAdmin, "AUTHENTICATION_REQUIRED");

    nextIdentity = {
      subject: "google-subject-2",
      email: "member@example.test",
      emailVerified: true,
      displayName: "Thành viên chờ duyệt",
      avatarUrl: null,
    };
    const memberStart = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start?returnPath=%2Faccount%2Fpending",
    });
    const memberState = new URL(memberStart.headers.location!).searchParams.get(
      "state",
    )!;
    const memberCallback = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=member-code&state=${encodeURIComponent(memberState)}`,
    });
    expect(memberCallback.headers.location).toBe("/account/pending");
    const memberCookie = (memberCallback.headers["set-cookie"] as string).split(
      ";",
    )[0]!;
    const deniedStart = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start",
    });
    const deniedState = new URL(deniedStart.headers.location!).searchParams.get(
      "state",
    )!;
    const exchangesBeforeDenial = callbackRequest;
    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?error=access_denied&error_description=${encodeURIComponent("sensitive provider text")}&state=${encodeURIComponent(deniedState)}`,
    });
    expect(denied.statusCode).toBe(303);
    expect(denied.headers.location).toBe("/auth/error");
    expect(denied.body).not.toContain("sensitive provider text");
    expect(callbackRequest).toBe(exchangesBeforeDenial);
    const deniedReplay = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=must-not-exchange&state=${encodeURIComponent(deniedState)}`,
    });
    expect(deniedReplay.statusCode).toBe(303);
    expect(deniedReplay.headers.location).toBe("/auth/error");
    expect(deniedReplay.headers["set-cookie"]).toBeUndefined();
    expect(callbackRequest).toBe(exchangesBeforeDenial);
    const ambiguousStart = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start",
    });
    const ambiguousState = new URL(
      ambiguousStart.headers.location!,
    ).searchParams.get("state")!;
    const ambiguous = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=ambiguous-code&error=access_denied&state=${encodeURIComponent(ambiguousState)}`,
    });
    expect(ambiguous.statusCode).toBe(303);
    expect(ambiguous.headers.location).toBe("/auth/error");
    const ambiguousReplay = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=must-not-exchange&state=${encodeURIComponent(ambiguousState)}`,
    });
    expect(ambiguousReplay.headers.location).toBe("/auth/error");
    expect(callbackRequest).toBe(exchangesBeforeDenial);
    const pendingGate = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: { cookie: memberCookie },
    });
    expect(pendingGate.statusCode).toBe(403);
    expect(pendingGate.json().error.code).toBe("ACCOUNT_PENDING");
    expectCanonicalError(pendingGate, "ACCOUNT_PENDING");
    const pendingProjectGate = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { cookie: memberCookie },
    });
    expect(pendingProjectGate.statusCode).toBe(403);
    expect(pendingProjectGate.json().error.code).toBe("ACCOUNT_PENDING");

    nextIdentity = {
      subject: "unverified-google-subject",
      email: "unverified@example.test",
      emailVerified: false,
      displayName: "Unverified account",
      avatarUrl: null,
    };
    const unverifiedStart = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start",
    });
    const unverifiedState = new URL(
      unverifiedStart.headers.location!,
    ).searchParams.get("state")!;
    const unverifiedCallback = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=unverified-code&state=${encodeURIComponent(unverifiedState)}`,
    });
    expect(unverifiedCallback.statusCode).toBe(303);
    expect(unverifiedCallback.headers.location).toBe("/auth/error");
    expect(unverifiedCallback.body).not.toContain("unverified-code");
    expect(unverifiedCallback.body).not.toContain(unverifiedState);

    const csrf = await app.inject({
      method: "GET",
      url: "/api/v1/auth/csrf",
      headers: { cookie: cookie.split(";")[0]! },
    });
    const csrfToken = csrf.json().csrfToken as string;
    expect(csrf.headers["cache-control"]).toBe("no-store");
    const users = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users?status=pending",
      headers: { cookie: cookie.split(";")[0]! },
    });
    expect(users.statusCode, users.body).toBe(200);
    const invalidCursor = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users?cursor=not-base64url",
      headers: { cookie: cookie.split(";")[0]! },
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json().error.code).toBe("INVALID_CURSOR");
    expectCanonicalError(invalidCursor, "INVALID_CURSOR");
    const pendingUser = users.json().users[0] as {
      id: string;
      version: number;
    };
    const transitionBody = {
      status: "active",
      version: pendingUser.version,
      reason: "Approved for the closed beta",
    };
    const wrongOrigin = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${pendingUser.id}`,
      headers: {
        cookie: cookie.split(";")[0]!,
        origin: "https://attacker.example.test",
        "content-type": "application/json",
        "x-oloka-csrf": csrfToken,
        "idempotency-key": "approve-member-wrong-origin",
      },
      payload: transitionBody,
    });
    expect(wrongOrigin.statusCode).toBe(403);
    expect(wrongOrigin.json().error.code).toBe("AUTHORIZATION_DENIED");
    expectCanonicalError(wrongOrigin, "AUTHORIZATION_DENIED");

    const wrongToken = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${pendingUser.id}`,
      headers: {
        cookie: cookie.split(";")[0]!,
        origin: "https://oloka.example.test",
        "content-type": "application/json",
        "x-oloka-csrf": "not-the-current-csrf-token",
        "idempotency-key": "approve-member-wrong-token",
      },
      payload: transitionBody,
    });
    expect(wrongToken.statusCode).toBe(403);
    expect(wrongToken.json().error.code).toBe("AUTHORIZATION_DENIED");

    const missingOrigin = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${pendingUser.id}`,
      headers: {
        cookie: cookie.split(";")[0]!,
        "content-type": "application/json",
        "x-oloka-csrf": csrfToken,
        "idempotency-key": "approve-member-1",
      },
      payload: transitionBody,
    });
    expect(missingOrigin.statusCode).toBe(403);
    expect(missingOrigin.json().error.code).toBe("AUTHORIZATION_DENIED");

    const approved = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${pendingUser.id}`,
      headers: {
        cookie: cookie.split(";")[0]!,
        origin: "https://oloka.example.test",
        "content-type": "application/json",
        "x-oloka-csrf": csrfToken,
        "idempotency-key": "approve-member-1",
      },
      payload: transitionBody,
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().user).toMatchObject({ status: "active" });
    const replayedApproval = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${pendingUser.id}`,
      headers: {
        cookie: cookie.split(";")[0]!,
        origin: "https://oloka.example.test",
        "content-type": "application/json",
        "x-oloka-csrf": csrfToken,
        "idempotency-key": "approve-member-1",
      },
      payload: transitionBody,
    });
    expect(replayedApproval.statusCode).toBe(200);
    expect(replayedApproval.headers["idempotency-replayed"]).toBe("true");

    nextIdentity = {
      subject: "google-subject-2",
      email: "member@example.test",
      emailVerified: true,
      displayName: "Thành viên đã duyệt",
      avatarUrl: null,
    };
    const activeMemberStart = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start",
    });
    const activeMemberState = new URL(
      activeMemberStart.headers.location!,
    ).searchParams.get("state")!;
    const activeMemberCallback = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=active-member&state=${encodeURIComponent(activeMemberState)}`,
    });
    const activeMemberCookie = (
      activeMemberCallback.headers["set-cookie"] as string
    ).split(";")[0]!;
    const memberDeniedAdmin = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: { cookie: activeMemberCookie },
    });
    expect(memberDeniedAdmin.statusCode).toBe(403);
    expect(memberDeniedAdmin.json().error.code).toBe("AUTHORIZATION_DENIED");

    const memberCsrf = await app.inject({
      method: "GET",
      url: "/api/v1/auth/csrf",
      headers: { cookie: activeMemberCookie },
    });
    const createdProject = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: {
        cookie: activeMemberCookie,
        origin: "https://oloka.example.test",
        "content-type": "application/json",
        "x-oloka-csrf": memberCsrf.json().csrfToken as string,
        "idempotency-key": "member-create-project-1",
      },
      payload: { name: "Dự án đầu tiên", description: "Canonical SQLite" },
    });
    expect(createdProject.statusCode, createdProject.body).toBe(201);
    expect(createdProject.json()).toMatchObject({
      name: "Dự án đầu tiên",
      status: "active",
      favorite: false,
      version: 1,
    });
    const projectId = createdProject.json().id as string;
    const replayedProject = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: {
        cookie: activeMemberCookie,
        origin: "https://oloka.example.test",
        "content-type": "application/json",
        "x-oloka-csrf": memberCsrf.json().csrfToken as string,
        "idempotency-key": "member-create-project-1",
      },
      payload: { name: "Dự án đầu tiên", description: "Canonical SQLite" },
    });
    expect(replayedProject.statusCode).toBe(201);
    expect(replayedProject.headers["idempotency-replayed"]).toBe("true");
    expect(replayedProject.json().id).toBe(projectId);
    const projectConflict = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: {
        cookie: activeMemberCookie,
        origin: "https://oloka.example.test",
        "content-type": "application/json",
        "x-oloka-csrf": memberCsrf.json().csrfToken as string,
        "idempotency-key": "member-create-project-1",
      },
      payload: { name: "Changed semantic request" },
    });
    expect(projectConflict.statusCode).toBe(409);
    expect(projectConflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    const memberProjects = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { cookie: activeMemberCookie },
    });
    expect(memberProjects.statusCode, memberProjects.body).toBe(200);
    expect(memberProjects.json().projects).toHaveLength(1);
    const adminCannotReadMemberProject = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: { cookie: cookie.split(";")[0]! },
    });
    expect(adminCannotReadMemberProject.statusCode).toBe(404);
    expect(adminCannotReadMemberProject.json().error.code).toBe(
      "RESOURCE_NOT_FOUND",
    );
    const updatedProject = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: {
        cookie: activeMemberCookie,
        origin: "https://oloka.example.test",
        "content-type": "application/json",
        "x-oloka-csrf": memberCsrf.json().csrfToken as string,
        "idempotency-key": "member-update-project-1",
      },
      payload: { name: "Dự án đã đổi tên", favorite: true, expectedVersion: 1 },
    });
    expect(updatedProject.statusCode, updatedProject.body).toBe(200);
    expect(updatedProject.json()).toMatchObject({
      id: projectId,
      name: "Dự án đã đổi tên",
      favorite: true,
      version: 2,
    });
    const staleUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: {
        cookie: activeMemberCookie,
        origin: "https://oloka.example.test",
        "content-type": "application/json",
        "x-oloka-csrf": memberCsrf.json().csrfToken as string,
        "idempotency-key": "member-update-project-stale",
      },
      payload: { description: "Stale", expectedVersion: 1 },
    });
    expect(staleUpdate.statusCode).toBe(409);
    expect(staleUpdate.json().error.code).toBe("VERSION_CONFLICT");
    const deletedProject = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}`,
      headers: {
        cookie: activeMemberCookie,
        origin: "https://oloka.example.test",
        "content-type": "application/json",
        "x-oloka-csrf": memberCsrf.json().csrfToken as string,
        "idempotency-key": "member-delete-project-1",
      },
      payload: { expectedVersion: 2 },
    });
    expect(deletedProject.statusCode, deletedProject.body).toBe(200);
    expect(deletedProject.json()).toMatchObject({
      status: "soft_deleted",
      version: 3,
    });
    const activeAfterDelete = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { cookie: activeMemberCookie },
    });
    expect(activeAfterDelete.json().projects).toEqual([]);
    const trash = await app.inject({
      method: "GET",
      url: "/api/v1/trash/projects",
      headers: { cookie: activeMemberCookie },
    });
    expect(trash.statusCode, trash.body).toBe(200);
    expect(trash.json().projects).toHaveLength(1);
    const crossUserRestore = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/restore`,
      headers: {
        cookie: cookie.split(";")[0]!,
        origin: "https://oloka.example.test",
        "content-type": "application/json",
        "x-oloka-csrf": csrfToken,
        "idempotency-key": "admin-cross-user-restore",
      },
      payload: { expectedVersion: 3 },
    });
    expect(crossUserRestore.statusCode).toBe(404);
    const restoredProject = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/restore`,
      headers: {
        cookie: activeMemberCookie,
        origin: "https://oloka.example.test",
        "content-type": "application/json",
        "x-oloka-csrf": memberCsrf.json().csrfToken as string,
        "idempotency-key": "member-restore-project-1",
      },
      payload: { expectedVersion: 3 },
    });
    expect(restoredProject.statusCode, restoredProject.body).toBe(200);
    expect(restoredProject.json()).toMatchObject({
      id: projectId,
      status: "active",
      version: 4,
    });

    nextIdentity = {
      subject: "google-subject-1",
      email: "admin@example.test",
      emailVerified: true,
      displayName: "Quản trị viên",
      avatarUrl: "https://images.example.test/admin.png",
    };
    const secondAdminStart = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start",
    });
    const secondAdminState = new URL(
      secondAdminStart.headers.location!,
    ).searchParams.get("state")!;
    const secondAdminCallback = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=second-admin-session&state=${encodeURIComponent(secondAdminState)}`,
    });
    const secondAdminCookie = (
      secondAdminCallback.headers["set-cookie"] as string
    ).split(";")[0]!;
    const secondAdminCsrf = await app.inject({
      method: "GET",
      url: "/api/v1/auth/csrf",
      headers: { cookie: secondAdminCookie },
    });
    const refererLogout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: {
        cookie: secondAdminCookie,
        referer: "https://oloka.example.test/account/security",
        "content-type": "application/json",
        "x-oloka-csrf": secondAdminCsrf.json().csrfToken as string,
      },
      payload: {},
    });
    expect(refererLogout.statusCode).toBe(204);
    const loggedOutSession = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: secondAdminCookie },
    });
    expect(loggedOutSession.statusCode).toBe(401);
    expect(loggedOutSession.json().error.code).toBe("AUTHENTICATION_REQUIRED");

    const refreshedAdminSession = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: cookie.split(";")[0]! },
    });
    const adminUser = refreshedAdminSession.json().user as {
      id: string;
      version: number;
    };
    const lockOutFinalAdmin = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${adminUser.id}`,
      headers: {
        cookie: cookie.split(";")[0]!,
        origin: "https://oloka.example.test",
        "content-type": "application/json",
        "x-oloka-csrf": csrfToken,
        "idempotency-key": "disable-final-admin-1",
      },
      payload: {
        status: "disabled",
        version: adminUser.version,
        reason: "Exercise the last-admin guard",
      },
    });
    expect(lockOutFinalAdmin.statusCode).toBe(409);
    expect(lockOutFinalAdmin.json().error.code).toBe("RESOURCE_STATE_CONFLICT");

    const revokedMemberSession = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: memberCookie },
    });
    expect(revokedMemberSession.statusCode).toBe(401);
    expect(revokedMemberSession.json().error.code).toBe(
      "AUTHENTICATION_REQUIRED",
    );

    await app.close();
  });
});

function expectCanonicalError(
  response: {
    json(): { error: Record<string, unknown> };
    headers: Record<string, unknown>;
  },
  code: string,
): void {
  const body = response.json();
  expect(body.error.code).toBe(code);
  expect(Object.keys(body.error).sort()).toEqual([
    "code",
    "messageKey",
    "requestId",
    "retryable",
    "suggestedAction",
  ]);
  expect(body.error.messageKey).toEqual(expect.any(String));
  expect(body.error.suggestedAction).toEqual(expect.any(String));
  expect(body.error.requestId).toBe(response.headers["x-request-id"]);
  expect(body.error).not.toHaveProperty("message");
  expect(body.error).not.toHaveProperty("correlationId");
}
