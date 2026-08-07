import type {
  IdentityUser,
  PublicErrorCode,
  SessionSummary,
} from "@oloka/contracts";
import { createHash, randomBytes } from "node:crypto";
import type { Clock } from "../kernel/clock.js";
import type { IdGenerator } from "../kernel/id-generator.js";
import { canonicalizeJson } from "../kernel/canonical-json.js";
import type { TransactionRunner } from "../database/database.js";
import { ApplicationError } from "../http/application-error.js";
import { AuditEventRepository } from "../database/repositories/audit-event-repository.js";
import {
  openPkceVerifier,
  sealPkceVerifier,
} from "./oauth-transaction-crypto.js";
import type {
  OidcIdentityClaims,
  OidcProviderClient,
} from "./oidc-provider-client.js";
import {
  generateOpaqueToken,
  hashCoarseIpPrefix,
  hashOpaqueToken,
  summarizeUserAgent,
} from "./session-security.js";

const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface IdentityServiceOptions {
  transactions: TransactionRunner;
  oidcClient: OidcProviderClient;
  applicationKey: Uint8Array;
  issuer: string;
  redirectUri: string;
  bootstrapAdminEmail: string;
  oauthTransactionTtlMs: number;
  sessionIdleTtlMs: number;
  sessionAbsoluteTtlMs: number;
  clock: Clock;
  idGenerator: IdGenerator;
}

export interface RequestMetadata {
  ipAddress: string;
  userAgent?: string;
}

export interface AuthenticatedSession {
  sessionId: string;
  user: IdentityUser;
}

export class IdentityError extends ApplicationError {
  constructor(
    code: PublicErrorCode,
    internalCause?: string,
    responseHeaders?: Readonly<Record<string, string>>,
  ) {
    super(code, internalCause, responseHeaders);
    this.name = "IdentityError";
  }
}

export class IdentityService {
  private readonly audit: AuditEventRepository;

  constructor(private readonly options: IdentityServiceOptions) {
    this.audit = new AuditEventRepository(options.idGenerator);
  }

  async startAuthorization(returnPath = "/"): Promise<URL> {
    assertSafeReturnPath(returnPath);
    const now = this.options.clock.now();
    const transactionId = this.options.idGenerator.generate();
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const pkceCodeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(pkceCodeVerifier, "utf8")
      .digest("base64url");
    const sealed = sealPkceVerifier(
      this.options.applicationKey,
      transactionId,
      canonicalizeJson({ nonce, pkceCodeVerifier }),
    );
    this.options.transactions.run("immediate", ({ database }) => {
      database
        .prepare(
          `INSERT INTO oauth_transactions
            (id, provider, state_hash_sha256, nonce_hash_sha256,
             pkce_verifier_ciphertext, pkce_cipher_algorithm,
             pkce_iv, pkce_auth_tag, key_version, redirect_uri, return_path,
             status, created_at, expires_at, failure_count)
           VALUES (?, 'google', ?, ?, ?, 'AES-256-GCM', ?, ?, ?, ?, ?, 'pending', ?, ?, 0)`,
        )
        .run(
          transactionId,
          hashOpaqueToken(state),
          hashOpaqueToken(nonce),
          sealed.ciphertext,
          sealed.iv,
          sealed.authTag,
          sealed.keyVersion,
          this.options.redirectUri,
          returnPath,
          now,
          now + this.options.oauthTransactionTtlMs,
        );
    });
    return this.options.oidcClient.createAuthorizationUrl({
      redirectUri: this.options.redirectUri,
      state,
      nonce,
      codeChallenge,
      codeChallengeMethod: "S256",
    });
  }

  async finishAuthorization(
    callbackUrl: URL,
    state: string,
    metadata: RequestMetadata,
    currentSessionToken?: string,
  ): Promise<{ sessionToken: string; returnPath: string }> {
    const transaction = this.consumeOAuthTransaction(state);
    const claims = await this.options.oidcClient.exchangeCallback({
      callbackUrl,
      expectedState: state,
      expectedNonce: transaction.nonce,
      pkceCodeVerifier: transaction.pkceCodeVerifier,
    });
    if (!claims.emailVerified) {
      throw new IdentityError(
        "INVALID_PROVIDER_RESPONSE",
        "oidc_claims_unverified",
      );
    }
    const result = this.establishIdentityAndSession(
      claims,
      metadata,
      currentSessionToken,
    );
    return {
      sessionToken: result.sessionToken,
      returnPath: transaction.returnPath,
    };
  }

  denyAuthorization(
    state: string,
    category: "user_denied" | "provider_error" | "invalid_callback",
  ): void {
    const transaction = this.consumeOAuthTransaction(state);
    const now = this.options.clock.now();
    this.options.transactions.run("immediate", (context) => {
      this.audit.append(context, {
        actorType: "system",
        action: "auth.oauth_callback_denied",
        resourceType: "oauth_transaction",
        resourceId: transaction.transactionId,
        outcome: "denied",
        metadata: { failureCategory: category },
        createdAt: now,
      });
    });
  }

  getSession(rawToken: string | null): AuthenticatedSession | null {
    if (rawToken === null) return null;
    const now = this.options.clock.now();
    return this.options.transactions.run("immediate", ({ database }) => {
      const row = database
        .prepare(
          `SELECT s.id AS session_id, s.last_seen_at, s.idle_expires_at, s.expires_at,
                  s.status AS session_status,
                  u.id, u.email_normalized, u.display_name, u.avatar_url,
                  u.role, u.status, u.version
             FROM sessions s
             JOIN users u ON u.id = s.user_id
            WHERE s.token_hash_sha256 = ?`,
        )
        .get(hashOpaqueToken(rawToken)) as SessionDatabaseRow | undefined;
      if (row === undefined || row.session_status !== "active") return null;
      if (row.expires_at <= now || row.idle_expires_at <= now) {
        database
          .prepare(
            `UPDATE sessions
                SET status = 'expired', revoked_at = ?, revoke_reason = 'expired'
              WHERE id = ? AND status = 'active'`,
          )
          .run(now, row.session_id);
        return null;
      }
      if (row.last_seen_at <= now - SESSION_TOUCH_INTERVAL_MS) {
        database
          .prepare(
            `UPDATE sessions
                SET last_seen_at = ?, idle_expires_at = min(?, expires_at)
              WHERE id = ? AND status = 'active'`,
          )
          .run(now, now + this.options.sessionIdleTtlMs, row.session_id);
      }
      return { sessionId: row.session_id, user: mapUser(row) };
    });
  }

  rotateCsrfToken(sessionId: string): string {
    const token = generateOpaqueToken();
    const changed = this.options.transactions.run(
      "immediate",
      ({ database }) =>
        database
          .prepare(
            `UPDATE sessions SET csrf_token_hash_sha256 = ?
              WHERE id = ? AND status = 'active'`,
          )
          .run(hashOpaqueToken(token), sessionId).changes,
    );
    if (changed !== 1) throw authenticationRequired();
    return token;
  }

  verifyCsrfToken(sessionId: string, token: string): boolean {
    return this.options.transactions.run("read", ({ database }) => {
      const row = database
        .prepare(
          `SELECT 1 AS valid FROM sessions
            WHERE id = ? AND status = 'active' AND csrf_token_hash_sha256 = ?`,
        )
        .get(sessionId, hashOpaqueToken(token));
      return row !== undefined;
    });
  }

  logout(session: AuthenticatedSession): void {
    const now = this.options.clock.now();
    this.options.transactions.run("immediate", (context) => {
      const changed = context.database
        .prepare(
          `UPDATE sessions
              SET status = 'revoked', revoked_at = ?, revoke_reason = 'logout'
            WHERE id = ? AND status = 'active'`,
        )
        .run(now, session.sessionId).changes;
      if (changed === 1) {
        this.audit.append(context, {
          actorUserId: session.user.id,
          actorType: "user",
          action: "auth.logout",
          resourceType: "session",
          resourceId: session.sessionId,
          outcome: "success",
          metadata: { reasonCategory: "user_requested" },
          createdAt: now,
        });
      }
    });
  }

  listSessions(session: AuthenticatedSession): SessionSummary[] {
    const now = this.options.clock.now();
    return this.options.transactions.run("read", ({ database }) =>
      (
        database
          .prepare(
            `SELECT id, created_at, last_seen_at,
                    min(idle_expires_at, expires_at) AS effective_expires_at,
                    user_agent_summary
               FROM sessions
              WHERE user_id = ? AND status = 'active'
                AND idle_expires_at > ? AND expires_at > ?
              ORDER BY created_at DESC, id DESC LIMIT 100`,
          )
          .all(session.user.id, now, now) as Array<{
          id: string;
          created_at: number;
          last_seen_at: number;
          effective_expires_at: number;
          user_agent_summary: string | null;
        }>
      ).map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.effective_expires_at,
        current: row.id === session.sessionId,
        userAgentSummary: row.user_agent_summary,
      })),
    );
  }

  revokeAllSessions(session: AuthenticatedSession): number {
    const now = this.options.clock.now();
    return this.options.transactions.run("immediate", (context) => {
      const changes = context.database
        .prepare(
          `UPDATE sessions SET status = 'revoked', revoked_at = ?,
                  revoke_reason = 'user_revoke_all'
            WHERE user_id = ? AND status = 'active'`,
        )
        .run(now, session.user.id).changes;
      this.audit.append(context, {
        actorUserId: session.user.id,
        actorType: "user",
        action: "auth.session_revoke_all",
        resourceType: "user",
        resourceId: session.user.id,
        outcome: "success",
        metadata: { revokedCount: Number(changes) },
        createdAt: now,
      });
      return Number(changes);
    });
  }

  auditCsrfFailure(
    session: AuthenticatedSession | null,
    category: string,
  ): void {
    const now = this.options.clock.now();
    this.options.transactions.run("immediate", (context) => {
      this.audit.append(context, {
        ...(session === null ? {} : { actorUserId: session.user.id }),
        actorType: session?.user.role === "admin" ? "admin" : "user",
        action: "auth.csrf_failure",
        resourceType: "session",
        ...(session === null ? {} : { resourceId: session.sessionId }),
        outcome: "denied",
        metadata: { failureCategory: category },
        createdAt: now,
      });
    });
  }

  auditStatusDenial(session: AuthenticatedSession): void {
    if (session.user.status !== "disabled") return;
    const now = this.options.clock.now();
    this.options.transactions.run("immediate", (context) => {
      this.audit.append(context, {
        actorUserId: session.user.id,
        actorType: session.user.role === "admin" ? "admin" : "user",
        action: "auth.disabled_user_rejected",
        resourceType: "user",
        resourceId: session.user.id,
        outcome: "denied",
        metadata: { status: "disabled" },
        createdAt: now,
      });
    });
  }

  private consumeOAuthTransaction(state: string): {
    transactionId: string;
    nonce: string;
    pkceCodeVerifier: string;
    returnPath: string;
  } {
    const now = this.options.clock.now();
    const row = this.options.transactions.run("immediate", ({ database }) => {
      const transaction = database
        .prepare(
          `SELECT id, nonce_hash_sha256, pkce_verifier_ciphertext,
                  pkce_cipher_algorithm, pkce_iv, pkce_auth_tag,
                  key_version, return_path, expires_at, status
             FROM oauth_transactions WHERE state_hash_sha256 = ?`,
        )
        .get(hashOpaqueToken(state)) as OAuthTransactionRow | undefined;
      if (transaction === undefined) return undefined;
      if (transaction.status !== "pending" || transaction.expires_at <= now) {
        return null;
      }
      const changed = database
        .prepare(
          `UPDATE oauth_transactions SET status = 'consumed', consumed_at = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .run(now, transaction.id).changes;
      return changed === 1 ? transaction : null;
    });
    if (row === undefined) {
      throw new IdentityError("AUTHENTICATION_REQUIRED", "oauth_state_invalid");
    }
    if (row === null) {
      throw new IdentityError(
        "AUTHENTICATION_REQUIRED",
        "oauth_transaction_expired_or_consumed",
      );
    }
    if (row.pkce_cipher_algorithm !== "AES-256-GCM") {
      throw new IdentityError(
        "AUTHENTICATION_REQUIRED",
        "oauth_transaction_cipher_invalid",
      );
    }
    const opened = openPkceVerifier(this.options.applicationKey, row.id, {
      keyVersion: row.key_version,
      ciphertext: row.pkce_verifier_ciphertext,
      iv: row.pkce_iv,
      authTag: row.pkce_auth_tag,
    });
    const secret = JSON.parse(opened) as {
      nonce?: unknown;
      pkceCodeVerifier?: unknown;
    };
    if (
      typeof secret.nonce !== "string" ||
      typeof secret.pkceCodeVerifier !== "string" ||
      !hashOpaqueToken(secret.nonce).equals(row.nonce_hash_sha256)
    ) {
      throw new IdentityError(
        "AUTHENTICATION_REQUIRED",
        "oauth_transaction_secret_invalid",
      );
    }
    return {
      transactionId: row.id,
      nonce: secret.nonce,
      pkceCodeVerifier: secret.pkceCodeVerifier,
      returnPath: row.return_path,
    };
  }

  private establishIdentityAndSession(
    claims: OidcIdentityClaims,
    metadata: RequestMetadata,
    currentSessionToken?: string,
  ): { sessionToken: string } {
    const now = this.options.clock.now();
    const email = normalizeEmail(claims.email);
    const sessionToken = generateOpaqueToken();
    const initialCsrfToken = generateOpaqueToken();
    const result = this.options.transactions.run("immediate", (context) => {
      const identity = context.database
        .prepare(
          `SELECT user_id FROM oauth_identities
            WHERE issuer = ? AND subject = ?`,
        )
        .get(this.options.issuer, claims.subject) as
        | { user_id: string }
        | undefined;
      let userId = identity?.user_id;
      if (userId === undefined) {
        const emailOwner = context.database
          .prepare("SELECT id FROM users WHERE email_normalized = ?")
          .get(email) as { id: string } | undefined;
        if (emailOwner !== undefined) {
          this.audit.append(context, {
            actorType: "system",
            action: "auth.identity_link_rejected",
            resourceType: "user",
            resourceId: emailOwner.id,
            outcome: "denied",
            metadata: { reasonCategory: "email_identity_conflict" },
            createdAt: now,
          });
          return { kind: "identity_conflict" } as const;
        }
        userId = this.options.idGenerator.generate();
        const adminEverEstablished =
          (
            context.database
              .prepare(
                "SELECT COUNT(*) AS count FROM users WHERE role = 'admin'",
              )
              .get() as { count: number }
          ).count > 0;
        const bootstrap =
          !adminEverEstablished &&
          email === this.options.bootstrapAdminEmail &&
          claims.emailVerified;
        context.database
          .prepare(
            `INSERT INTO users
              (id, email_normalized, display_name, avatar_url, role, status,
               approved_at, created_at, updated_at, last_login_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          )
          .run(
            userId,
            email,
            normalizeDisplayName(claims.displayName, email),
            normalizeAvatarUrl(claims.avatarUrl),
            bootstrap ? "admin" : "member",
            bootstrap ? "active" : "pending",
            bootstrap ? now : null,
            now,
            now,
            now,
          );
        context.database
          .prepare(
            `INSERT INTO oauth_identities
              (id, user_id, issuer, subject, email_at_link, email_verified,
               profile_json, created_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          )
          .run(
            this.options.idGenerator.generate(),
            userId,
            this.options.issuer,
            claims.subject,
            email,
            canonicalizeJson({
              displayName: normalizeDisplayName(claims.displayName, email),
              hasAvatar: claims.avatarUrl !== null,
            }),
            now,
            now,
          );
        if (bootstrap) {
          this.audit.append(context, {
            actorType: "system",
            action: "admin.bootstrap",
            resourceType: "user",
            resourceId: userId,
            outcome: "success",
            metadata: { provider: "google" },
            createdAt: now,
          });
        }
      } else {
        context.database
          .prepare(
            `UPDATE oauth_identities SET last_seen_at = ?
              WHERE issuer = ? AND subject = ?`,
          )
          .run(now, this.options.issuer, claims.subject);
        context.database
          .prepare(
            `UPDATE users SET display_name = ?, avatar_url = ?,
                    last_login_at = ?, updated_at = ?, version = version + 1
              WHERE id = ?`,
          )
          .run(
            normalizeDisplayName(claims.displayName, email),
            normalizeAvatarUrl(claims.avatarUrl),
            now,
            now,
            userId,
          );
      }
      const rotatedFrom =
        currentSessionToken === undefined
          ? undefined
          : (context.database
              .prepare(
                `SELECT id FROM sessions
                  WHERE user_id = ? AND token_hash_sha256 = ? AND status = 'active'`,
              )
              .get(userId, hashOpaqueToken(currentSessionToken)) as
              | { id: string }
              | undefined);
      if (rotatedFrom !== undefined) {
        context.database
          .prepare(
            `UPDATE sessions SET status = 'revoked', revoked_at = ?,
                    revoke_reason = 'login_rotation'
              WHERE id = ? AND status = 'active'`,
          )
          .run(now, rotatedFrom.id);
        this.audit.append(context, {
          actorUserId: userId,
          actorType: "user",
          action: "auth.session_revoke",
          resourceType: "session",
          resourceId: rotatedFrom.id,
          outcome: "success",
          metadata: { reasonCategory: "login_rotation" },
          createdAt: now,
        });
      }
      const sessionId = this.options.idGenerator.generate();
      context.database
        .prepare(
          `INSERT INTO sessions
            (id, user_id, token_hash_sha256, csrf_token_hash_sha256, status,
             created_at, last_seen_at, idle_expires_at, expires_at,
             rotated_from_id,
             ip_hash, user_agent_summary)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionId,
          userId,
          hashOpaqueToken(sessionToken),
          hashOpaqueToken(initialCsrfToken),
          now,
          now,
          now + this.options.sessionIdleTtlMs,
          now + this.options.sessionAbsoluteTtlMs,
          rotatedFrom?.id ?? null,
          hashCoarseIpPrefix(this.options.applicationKey, metadata.ipAddress),
          summarizeUserAgent(metadata.userAgent),
        );
      this.audit.append(context, {
        actorUserId: userId,
        actorType: "user",
        action: "auth.login_success",
        resourceType: "session",
        resourceId: sessionId,
        outcome: "success",
        metadata: { provider: "google" },
        createdAt: now,
      });
      return { kind: "created" } as const;
    });
    if (result.kind === "identity_conflict") {
      throw new IdentityError(
        "RESOURCE_STATE_CONFLICT",
        "identity_link_conflict",
      );
    }
    return { sessionToken };
  }
}

interface OAuthTransactionRow {
  id: string;
  nonce_hash_sha256: Buffer;
  pkce_verifier_ciphertext: Buffer;
  pkce_cipher_algorithm: "AES-256-GCM";
  pkce_iv: Buffer;
  pkce_auth_tag: Buffer;
  key_version: number;
  return_path: string;
  expires_at: number;
  status: string;
}

interface SessionDatabaseRow {
  session_id: string;
  last_seen_at: number;
  idle_expires_at: number;
  expires_at: number;
  session_status: string;
  id: string;
  email_normalized: string;
  display_name: string;
  avatar_url: string | null;
  role: "member" | "admin";
  status: "pending" | "active" | "disabled" | "rejected";
  version: number;
}

function mapUser(row: SessionDatabaseRow): IdentityUser {
  return {
    id: row.id,
    email: row.email_normalized,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    status: row.status,
    version: row.version,
  };
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 320 || !email.includes("@")) {
    throw new IdentityError("INVALID_PROVIDER_RESPONSE", "oidc_email_invalid");
  }
  return email;
}

function normalizeDisplayName(value: string, email: string): string {
  const normalized = stripControlCharacters(value).trim();
  return (normalized || email.split("@")[0]!).slice(0, 200);
}

function normalizeAvatarUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href.slice(0, 2048) : null;
  } catch {
    return null;
  }
}

export function assertSafeReturnPath(value: string): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw invalidReturnPath();
  }
  if (
    value.length > 512 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    decoded.startsWith("//") ||
    decoded.includes("\\") ||
    containsControlCharacters(decoded)
  ) {
    throw invalidReturnPath();
  }
}

function stripControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 ? " " : character;
  }).join("");
}

function containsControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function invalidReturnPath(): IdentityError {
  return new IdentityError("VALIDATION_ERROR", "return_path_invalid");
}

export function authenticationRequired(): IdentityError {
  return new IdentityError(
    "AUTHENTICATION_REQUIRED",
    "session_missing_or_invalid",
  );
}
