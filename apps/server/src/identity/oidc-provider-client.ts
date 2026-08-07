import * as oidc from "openid-client";
import { ApplicationError } from "../http/application-error.js";

export interface OidcAuthorizationRequest {
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

export interface OidcCallbackRequest {
  callbackUrl: URL;
  expectedState: string;
  expectedNonce: string;
  pkceCodeVerifier: string;
}

export interface OidcIdentityClaims {
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  avatarUrl: string | null;
}

export interface OidcProviderClient {
  createAuthorizationUrl(request: OidcAuthorizationRequest): Promise<URL>;
  exchangeCallback(request: OidcCallbackRequest): Promise<OidcIdentityClaims>;
}

export class OpenIdClientAdapter implements OidcProviderClient {
  private configuration: Promise<oidc.Configuration> | undefined;

  constructor(
    private readonly issuer: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly testOptions: {
      allowInsecureIssuer?: boolean;
      timeoutSeconds?: number;
    } = {},
  ) {}

  async createAuthorizationUrl(
    request: OidcAuthorizationRequest,
  ): Promise<URL> {
    const configuration = await this.getConfiguration().catch(
      (error: unknown) => {
        throw normalizeOidcError(error, "discovery");
      },
    );
    return oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: request.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: request.codeChallengeMethod,
      prompt: "select_account",
    });
  }

  async exchangeCallback(
    request: OidcCallbackRequest,
  ): Promise<OidcIdentityClaims> {
    const configuration = await this.getConfiguration().catch(
      (error: unknown) => {
        throw normalizeOidcError(error, "discovery");
      },
    );
    const tokens = await oidc
      .authorizationCodeGrant(configuration, request.callbackUrl, {
        expectedState: request.expectedState,
        expectedNonce: request.expectedNonce,
        pkceCodeVerifier: request.pkceCodeVerifier,
        idTokenExpected: true,
      })
      .catch((error: unknown) => {
        throw normalizeOidcError(error, "callback");
      });
    const claims = tokens.claims();
    if (
      claims === undefined ||
      typeof claims.sub !== "string" ||
      typeof claims.email !== "string" ||
      claims.email_verified !== true
    ) {
      throw new ApplicationError(
        "INVALID_PROVIDER_RESPONSE",
        "oidc_verified_claims_incomplete",
      );
    }
    return {
      subject: claims.sub,
      email: claims.email,
      emailVerified: true,
      displayName:
        typeof claims.name === "string" && claims.name.trim().length > 0
          ? claims.name.trim().slice(0, 200)
          : claims.email.split("@")[0]!.slice(0, 200),
      avatarUrl: typeof claims.picture === "string" ? claims.picture : null,
    };
  }

  private getConfiguration(): Promise<oidc.Configuration> {
    this.configuration ??= oidc.discovery(
      new URL(this.issuer),
      this.clientId,
      this.clientSecret,
      undefined,
      {
        timeout: this.testOptions.timeoutSeconds ?? 10,
        execute: [
          oidc.enableNonRepudiationChecks,
          ...(this.testOptions.allowInsecureIssuer === true
            ? [oidc.allowInsecureRequests]
            : []),
        ],
      },
    );
    return this.configuration;
  }
}

function normalizeOidcError(
  error: unknown,
  phase: "discovery" | "callback",
): ApplicationError {
  if (error instanceof ApplicationError) return error;
  const signals = collectErrorSignals(error);
  if (signals.some((signal) => /TIMEOUT|TIMEDOUT|ABORT/i.test(signal))) {
    return new ApplicationError("PROVIDER_TIMEOUT", `oidc_${phase}_timeout`);
  }
  if (
    phase === "discovery" ||
    signals.some((signal) =>
      /ECONN|ENOTFOUND|EAI_AGAIN|NETWORK|FETCH FAILED|SOCKET/i.test(signal),
    )
  ) {
    return new ApplicationError(
      "PROVIDER_UNAVAILABLE",
      `oidc_${phase}_unavailable`,
    );
  }
  return new ApplicationError(
    "INVALID_PROVIDER_RESPONSE",
    "oidc_callback_invalid",
  );
}

function collectErrorSignals(error: unknown): string[] {
  const signals: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    const value = current as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    for (const signal of [value.name, value.code, value.message]) {
      if (typeof signal === "string") signals.push(signal);
    }
    current = value.cause;
  }
  return signals;
}
