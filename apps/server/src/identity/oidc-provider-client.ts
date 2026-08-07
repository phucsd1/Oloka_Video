import * as oidc from "openid-client";

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
    const configuration = await this.getConfiguration();
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
    const configuration = await this.getConfiguration();
    const tokens = await oidc.authorizationCodeGrant(
      configuration,
      request.callbackUrl,
      {
        expectedState: request.expectedState,
        expectedNonce: request.expectedNonce,
        pkceCodeVerifier: request.pkceCodeVerifier,
        idTokenExpected: true,
      },
    );
    const claims = tokens.claims();
    if (
      claims === undefined ||
      typeof claims.sub !== "string" ||
      typeof claims.email !== "string" ||
      claims.email_verified !== true
    ) {
      throw new Error("OIDC verified identity claims are incomplete");
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
