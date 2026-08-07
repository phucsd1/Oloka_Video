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
    expect(replayedCallback.statusCode).toBe(401);
    expect(replayedCallback.json().error.code).toBe(
      "OAUTH_TRANSACTION_EXPIRED_OR_CONSUMED",
    );

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
    const memberCookie = (memberCallback.headers["set-cookie"] as string).split(
      ";",
    )[0]!;
    const pendingGate = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: { cookie: memberCookie },
    });
    expect(pendingGate.statusCode).toBe(403);
    expect(pendingGate.json().error.code).toBe("ACCOUNT_PENDING");

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
    expect(unverifiedCallback.statusCode).toBe(401);
    expect(unverifiedCallback.json().error.code).toBe("OAUTH_CLAIMS_INVALID");

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
    expect(wrongOrigin.json().error.code).toBe("CSRF_VALIDATION_FAILED");

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
    expect(wrongToken.json().error.code).toBe("CSRF_VALIDATION_FAILED");

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
    expect(missingOrigin.json().error.code).toBe("CSRF_VALIDATION_FAILED");

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
    expect(loggedOutSession.json()).toEqual({ authenticated: false });

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
    expect(revokedMemberSession.json()).toEqual({ authenticated: false });

    await app.close();
  });
});
