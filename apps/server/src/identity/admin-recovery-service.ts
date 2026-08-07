import type { TransactionRunner } from "../database/database.js";
import { AuditEventRepository } from "../database/repositories/audit-event-repository.js";
import type { Clock } from "../kernel/clock.js";
import type { IdGenerator } from "../kernel/id-generator.js";
import { IdentityError } from "./identity-service.js";

export class AdminRecoveryService {
  private readonly audit: AuditEventRepository;

  constructor(
    private readonly transactions: TransactionRunner,
    private readonly clock: Clock,
    idGenerator: IdGenerator,
    private readonly googleIssuer = "https://accounts.google.com",
  ) {
    this.audit = new AuditEventRepository(idGenerator);
  }

  recover(input: { identityId: string; reason: string }): { userId: string } {
    const reason = input.reason.trim();
    if (reason.length < 10 || reason.length > 500) {
      throw new IdentityError(
        "VALIDATION_FAILED",
        400,
        false,
        "Admin recovery requires a bounded explicit reason",
      );
    }
    const now = this.clock.now();
    return this.transactions.run("immediate", (context) => {
      assertDatabaseIntegrity(context.database);
      const target = context.database
        .prepare(
          `SELECT i.user_id
             FROM oauth_identities i
             JOIN users u ON u.id = i.user_id
            WHERE i.id = ? AND i.issuer = ? AND i.email_verified = 1`,
        )
        .get(input.identityId, this.googleIssuer) as
        | { user_id: string }
        | undefined;
      if (target === undefined) {
        throw new IdentityError(
          "RECOVERY_IDENTITY_NOT_ELIGIBLE",
          409,
          false,
          "Recovery requires an existing verified Google identity",
        );
      }
      context.database
        .prepare(
          `UPDATE users
              SET role = 'admin', status = 'active',
                  approved_at = COALESCE(approved_at, ?),
                  approved_by_user_id = NULL,
                  disabled_at = NULL, rejected_at = NULL,
                  updated_at = ?, version = version + 1
            WHERE id = ?`,
        )
        .run(now, now, target.user_id);
      const revoked = context.database
        .prepare(
          `UPDATE sessions SET status = 'revoked', revoked_at = ?,
                  revoke_reason = 'admin_recovery'
            WHERE user_id = ? AND status = 'active'`,
        )
        .run(now, target.user_id).changes;
      this.audit.append(context, {
        actorType: "system",
        action: "admin.recovery",
        resourceType: "user",
        resourceId: target.user_id,
        outcome: "success",
        metadata: {
          reason,
          revokedSessionCount: Number(revoked),
          identityProvider: "google",
        },
        createdAt: now,
      });
      assertDatabaseIntegrity(context.database);
      return { userId: target.user_id };
    });
  }
}

function assertDatabaseIntegrity(
  database: import("node:sqlite").DatabaseSync,
): void {
  const quickCheck = database.prepare("PRAGMA quick_check").get() as
    | Record<string, string>
    | undefined;
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (
    quickCheck === undefined ||
    Object.values(quickCheck)[0] !== "ok" ||
    foreignKeys.length > 0
  ) {
    throw new Error("Database integrity verification failed");
  }
}
