import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApplication } from "../app.js";
import { parseEnvironment } from "../config/environment.js";
import {
  FakeOidcServer,
  type FakeOidcMode,
} from "./fake-oidc-server.fixture.js";
import { OpenIdClientAdapter } from "./oidc-provider-client.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((operation) => operation()));
});

describe("openid-client adapter", () => {
  it("validates discovery, signed claims, PKCE S256, state, and nonce against a fake OIDC server", async () => {
    const fakeOidc = new FakeOidcServer();
    await fakeOidc.start();
    cleanup.push(() => fakeOidc.stop());
    const dataDir = await mkdtemp(join(tmpdir(), "oloka-fake-oidc-"));
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
    const app = await buildApplication({
      environment: parseEnvironment({
        NODE_ENV: "test",
        DATABASE_PATH: join(dataDir, "database", "test.db"),
        OBJECT_STORAGE_ROOT: join(dataDir, "objects"),
        OLOKA_APP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        OLOKA_GOOGLE_OIDC_ISSUER: fakeOidc.issuer,
        OLOKA_GOOGLE_CLIENT_ID: "test-client",
        OLOKA_GOOGLE_CLIENT_SECRET: "test-client-secret",
        OLOKA_PUBLIC_ORIGIN: "https://oloka.example.test",
        OLOKA_BOOTSTRAP_ADMIN_EMAIL: "signed-admin@example.test",
        LOG_LEVEL: "silent",
      }),
      serveFrontend: false,
      oidcClient: new OpenIdClientAdapter(
        fakeOidc.issuer,
        "test-client",
        "test-client-secret",
        { allowInsecureIssuer: true },
      ),
    });
    cleanup.push(() => app.close());

    const start = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/start",
    });
    expect(start.statusCode, start.body).toBe(302);
    const authorization = await fetch(start.headers.location!, {
      redirect: "manual",
    });
    expect(authorization.status).toBe(302);
    const callback = new URL(authorization.headers.get("location")!);
    const completed = await app.inject({
      method: "GET",
      url: `${callback.pathname}${callback.search}`,
    });
    expect(completed.statusCode, completed.body).toBe(303);
    expect(completed.headers["set-cookie"]).toContain("__Host-oloka_session=");
  });

  it.each([
    "missing-email",
    "unverified-email",
    "wrong-nonce",
    "invalid-signature",
    "expired-token",
    "malformed-token",
  ] as FakeOidcMode[])("rejects the %s provider response", async (mode) => {
    const flow = await authorize(mode);
    await expect(
      flow.adapter.exchangeCallback(flow.callbackRequest),
    ).rejects.toBeDefined();
  });

  it("rejects state and PKCE mismatches and a replayed provider code", async () => {
    const wrongState = await authorize("happy");
    await expect(
      wrongState.adapter.exchangeCallback({
        ...wrongState.callbackRequest,
        expectedState: "state-that-does-not-match",
      }),
    ).rejects.toBeDefined();

    const wrongPkce = await authorize("happy");
    await expect(
      wrongPkce.adapter.exchangeCallback({
        ...wrongPkce.callbackRequest,
        pkceCodeVerifier: "wrong-verifier-that-is-long-enough-for-pkce",
      }),
    ).rejects.toBeDefined();

    const replay = await authorize("happy");
    await expect(
      replay.adapter.exchangeCallback(replay.callbackRequest),
    ).resolves.toMatchObject({
      subject: "signed-google-subject",
      emailVerified: true,
    });
    await expect(
      replay.adapter.exchangeCallback(replay.callbackRequest),
    ).rejects.toBeDefined();
  });

  it("bounds a stalled token endpoint", async () => {
    const flow = await authorize("token-timeout", 1);
    await expect(
      flow.adapter.exchangeCallback(flow.callbackRequest),
    ).rejects.toBeDefined();
  });
});

async function authorize(mode: FakeOidcMode, timeoutSeconds = 10) {
  const fakeOidc = new FakeOidcServer(mode);
  await fakeOidc.start();
  cleanup.push(() => fakeOidc.stop());
  const adapter = new OpenIdClientAdapter(
    fakeOidc.issuer,
    "test-client",
    "test-client-secret",
    { allowInsecureIssuer: true, timeoutSeconds },
  );
  const state = "test-state-value";
  const nonce = "test-nonce-value";
  const pkceCodeVerifier = "v".repeat(43);
  const authorizationUrl = await adapter.createAuthorizationUrl({
    redirectUri: "https://oloka.example.test/api/v1/auth/google/callback",
    state,
    nonce,
    codeChallenge: createHash("sha256")
      .update(pkceCodeVerifier, "utf8")
      .digest("base64url"),
    codeChallengeMethod: "S256",
  });
  const response = await fetch(authorizationUrl, { redirect: "manual" });
  const callbackUrl = new URL(response.headers.get("location")!);
  return {
    adapter,
    callbackRequest: {
      callbackUrl,
      expectedState: state,
      expectedNonce: nonce,
      pkceCodeVerifier,
    },
  };
}
import { createHash } from "node:crypto";
