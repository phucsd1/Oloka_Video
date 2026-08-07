import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

export type FakeOidcMode =
  | "happy"
  | "missing-email"
  | "unverified-email"
  | "wrong-nonce"
  | "invalid-signature"
  | "expired-token"
  | "malformed-token"
  | "token-timeout";

export class FakeOidcServer {
  private readonly authorizationCodes = new Map<
    string,
    {
      clientId: string;
      redirectUri: string;
      nonce: string;
      codeChallenge: string;
    }
  >();
  private readonly keyPair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  private readonly untrustedKeyPair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  private readonly keyId = "fake-test-key";
  private server: Server | undefined;
  issuer = "";

  constructor(private readonly mode: FakeOidcMode = "happy") {}

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(
        request.url ?? "/",
        request.method ?? "GET",
        request,
        response,
      );
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Fake OIDC server did not bind a TCP port");
    }
    this.issuer = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (this.server === undefined) return;
    this.server.close();
    await once(this.server, "close");
  }

  private async handle(
    rawUrl: string,
    method: string,
    request: NodeJS.ReadableStream,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    const url = new URL(rawUrl, this.issuer || "http://127.0.0.1");
    if (
      method === "GET" &&
      url.pathname === "/.well-known/openid-configuration"
    ) {
      return sendJson(response, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      });
    }
    if (method === "GET" && url.pathname === "/jwks") {
      const publicJwk = this.keyPair.publicKey.export({
        format: "jwk",
      });
      return sendJson(response, {
        keys: [{ ...publicJwk, alg: "RS256", kid: this.keyId, use: "sig" }],
      });
    }
    if (method === "GET" && url.pathname === "/authorize") {
      const clientId = required(url.searchParams.get("client_id"));
      const redirectUri = required(url.searchParams.get("redirect_uri"));
      const state = required(url.searchParams.get("state"));
      const nonce = required(url.searchParams.get("nonce"));
      const codeChallenge = required(url.searchParams.get("code_challenge"));
      if (url.searchParams.get("code_challenge_method") !== "S256") {
        throw new Error("Fake OIDC authorization requires PKCE S256");
      }
      const code = randomBytes(24).toString("base64url");
      this.authorizationCodes.set(code, {
        clientId,
        redirectUri,
        nonce,
        codeChallenge,
      });
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      response.statusCode = 302;
      response.setHeader("location", callback.href);
      response.end();
      return;
    }
    if (method === "POST" && url.pathname === "/token") {
      if (this.mode === "token-timeout") await delay(1_500);
      const body = new URLSearchParams(await readBody(request));
      const code = required(body.get("code"));
      const transaction = this.authorizationCodes.get(code);
      if (transaction === undefined)
        return sendOAuthError(response, "invalid_grant");
      this.authorizationCodes.delete(code);
      const verifier = required(body.get("code_verifier"));
      const actualChallenge = createHash("sha256")
        .update(verifier, "utf8")
        .digest("base64url");
      if (
        actualChallenge !== transaction.codeChallenge ||
        body.get("client_id") !== transaction.clientId ||
        body.get("client_secret") !== "test-client-secret" ||
        body.get("redirect_uri") !== transaction.redirectUri
      ) {
        return sendOAuthError(response, "invalid_grant");
      }
      const now = Math.floor(Date.now() / 1000);
      if (this.mode === "malformed-token") {
        return sendJson(response, {
          access_token: "opaque-access-token-for-test-only",
          token_type: "Bearer",
          expires_in: 300,
          id_token: "not-a-signed-jwt",
        });
      }
      const payload: Record<string, unknown> = {
        iss: this.issuer,
        aud: transaction.clientId,
        sub: "signed-google-subject",
        name: "Signed Admin",
        nonce:
          this.mode === "wrong-nonce"
            ? "nonce-that-does-not-match"
            : transaction.nonce,
        iat: now,
        exp: this.mode === "expired-token" ? now - 3_600 : now + 300,
      };
      if (this.mode !== "missing-email") {
        payload.email = "signed-admin@example.test";
        payload.email_verified = this.mode !== "unverified-email";
      }
      const idToken = this.signJwt(payload);
      return sendJson(response, {
        access_token: "opaque-access-token-for-test-only",
        token_type: "Bearer",
        expires_in: 300,
        id_token: idToken,
      });
    }
    response.statusCode = 404;
    response.end();
  }

  private signJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", kid: this.keyId, typ: "JWT" }),
    ).toString("base64url");
    const claims = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signingInput = `${header}.${claims}`;
    const signature = createSign("RSA-SHA256")
      .update(signingInput)
      .end()
      .sign(
        this.mode === "invalid-signature"
          ? this.untrustedKeyPair.privateKey
          : this.keyPair.privateKey,
      )
      .toString("base64url");
    return `${signingInput}.${signature}`;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function required(value: string | null): string {
  if (value === null || value.length === 0)
    throw new Error("Required OIDC parameter missing");
  return value;
}

async function readBody(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(
  response: import("node:http").ServerResponse,
  value: unknown,
): void {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function sendOAuthError(
  response: import("node:http").ServerResponse,
  error: string,
): void {
  response.statusCode = 400;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ error }));
}
