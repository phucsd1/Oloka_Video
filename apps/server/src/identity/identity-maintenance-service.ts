import type { TransactionRunner } from "../database/database.js";

const OAUTH_RETENTION_MS = 24 * 60 * 60 * 1000;
const SESSION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export class IdentityMaintenanceService {
  constructor(private readonly transactions: TransactionRunner) {}

  run(
    now: number,
    limit = 100,
  ): {
    expiredTransactions: number;
    purgedTransactions: number;
    purgedSessions: number;
  } {
    return this.transactions.run("immediate", ({ database }) => {
      const expiredTransactions = database
        .prepare(
          `UPDATE oauth_transactions SET status = 'expired'
            WHERE id IN (
              SELECT id FROM oauth_transactions
               WHERE status = 'pending' AND expires_at <= ?
               ORDER BY expires_at, id LIMIT ?
            )`,
        )
        .run(now, limit).changes;
      const purgedTransactions = database
        .prepare(
          `DELETE FROM oauth_transactions WHERE id IN (
             SELECT id FROM oauth_transactions
              WHERE status IN ('consumed', 'expired')
                AND COALESCE(consumed_at, expires_at) <= ?
              ORDER BY COALESCE(consumed_at, expires_at), id LIMIT ?
           )`,
        )
        .run(now - OAUTH_RETENTION_MS, limit).changes;
      database
        .prepare(
          `UPDATE sessions
              SET status = 'expired', revoked_at = ?, revoke_reason = 'expired'
            WHERE id IN (
              SELECT id FROM sessions
               WHERE status = 'active'
                 AND (idle_expires_at <= ? OR expires_at <= ?)
               ORDER BY min(idle_expires_at, expires_at), id LIMIT ?
            )`,
        )
        .run(now, now, now, limit);
      const purgedSessions = database
        .prepare(
          `DELETE FROM sessions WHERE id IN (
             SELECT id FROM sessions
              WHERE status IN ('revoked', 'expired')
                AND COALESCE(revoked_at, expires_at) <= ?
              ORDER BY COALESCE(revoked_at, expires_at), id LIMIT ?
           )`,
        )
        .run(now - SESSION_RETENTION_MS, limit).changes;
      return {
        expiredTransactions: Number(expiredTransactions),
        purgedTransactions: Number(purgedTransactions),
        purgedSessions: Number(purgedSessions),
      };
    });
  }
}
