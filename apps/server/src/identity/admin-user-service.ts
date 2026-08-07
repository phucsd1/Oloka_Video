import type {
  AdminUserTransitionRequest,
  IdentityUser,
} from "@oloka/contracts";
import { sha256CanonicalJson } from "../kernel/canonical-json.js";
import type { Clock } from "../kernel/clock.js";
import type { IdGenerator } from "../kernel/id-generator.js";
import type { TransactionRunner } from "../database/database.js";
import { AuditEventRepository } from "../database/repositories/audit-event-repository.js";
import { IdempotencyRepository } from "../database/repositories/idempotency-repository.js";
import type { AuthenticatedSession } from "./identity-service.js";
import { IdentityError } from "./identity-service.js";

export class AdminUserService {
  private readonly audit: AuditEventRepository;
  private readonly idempotency: IdempotencyRepository;

  constructor(
    private readonly transactions: TransactionRunner,
    private readonly clock: Clock,
    idGenerator: IdGenerator,
  ) {
    this.audit = new AuditEventRepository(idGenerator);
    this.idempotency = new IdempotencyRepository(idGenerator);
  }

  list(input: {
    status?: "pending" | "active" | "disabled" | "rejected";
    search?: string;
    cursor?: string;
    limit: number;
  }): { users: IdentityUser[]; nextCursor: string | null } {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.status !== undefined) {
      clauses.push("status = ?");
      parameters.push(input.status);
    }
    if (input.cursor !== undefined) {
      clauses.push("id > ?");
      parameters.push(input.cursor);
    }
    if (input.search !== undefined) {
      clauses.push(
        "(email_normalized LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')",
      );
      const search = `%${escapeLike(input.search.trim().toLowerCase())}%`;
      parameters.push(search, search);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const rows = this.transactions.run("read", ({ database }) =>
      database
        .prepare(
          `SELECT id, email_normalized, display_name, avatar_url, role, status, version
             FROM users ${where} ORDER BY id LIMIT ?`,
        )
        .all(...parameters, input.limit + 1),
    ) as unknown as UserRow[];
    const hasMore = rows.length > input.limit;
    const users = rows.slice(0, input.limit).map(mapUser);
    return {
      users,
      nextCursor: hasMore ? (users.at(-1)?.id ?? null) : null,
    };
  }

  transition(
    actor: AuthenticatedSession,
    targetUserId: string,
    request: AdminUserTransitionRequest,
    idempotencyKey: string,
  ): { user: IdentityUser; replayed: boolean } {
    const now = this.clock.now();
    return this.transactions.run("immediate", (context) => {
      const begin = this.idempotency.begin(context, {
        userId: actor.user.id,
        operation: `admin.user.transition:${targetUserId}`,
        idempotencyKey,
        semanticRequestHashSha256: sha256CanonicalJson({
          targetUserId,
          ...request,
        }),
        createdAt: now,
        expiresAt: now + 24 * 60 * 60 * 1000,
      });
      if (begin.kind === "replay") {
        const response = begin.response as { user: IdentityUser };
        return { user: response.user, replayed: true };
      }
      if (begin.kind !== "started" && begin.kind !== "retryable") {
        throw new IdentityError(
          begin.kind === "conflict"
            ? "IDEMPOTENCY_KEY_CONFLICT"
            : "RESOURCE_STATE_CONFLICT",
          409,
          begin.kind !== "conflict",
          "The admin command conflicts with an existing request",
        );
      }
      const row = context.database
        .prepare(
          `SELECT id, email_normalized, display_name, avatar_url, role, status,
                  approved_at, version
             FROM users WHERE id = ?`,
        )
        .get(targetUserId) as
        | (UserRow & { approved_at: number | null })
        | undefined;
      if (row === undefined) {
        throw new IdentityError(
          "RESOURCE_NOT_FOUND",
          404,
          false,
          "The requested user was not found",
        );
      }
      if (row.version !== request.version) {
        throw new IdentityError(
          "VERSION_CONFLICT",
          409,
          true,
          "The user changed before this command was applied",
        );
      }
      const nextRole = request.role ?? row.role;
      assertAllowedTransition(row.status, request.status, row.role, nextRole);
      if (
        row.role === "admin" &&
        row.status === "active" &&
        (nextRole !== "admin" || request.status !== "active")
      ) {
        const activeAdmins = context.database
          .prepare(
            "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'",
          )
          .get() as { count: number };
        if (activeAdmins.count <= 1) {
          throw new IdentityError(
            "RESOURCE_STATE_CONFLICT",
            409,
            false,
            "The final active admin cannot be changed",
          );
        }
      }
      const approvedAt =
        request.status === "active"
          ? (row.approved_at ?? now)
          : row.approved_at;
      const changed = context.database
        .prepare(
          `UPDATE users
              SET role = ?, status = ?, approved_at = ?,
                  approved_by_user_id = CASE WHEN ? = 'active' THEN ? ELSE approved_by_user_id END,
                  disabled_at = CASE WHEN ? = 'disabled' THEN ? ELSE NULL END,
                  rejected_at = CASE WHEN ? = 'rejected' THEN ? ELSE NULL END,
                  updated_at = ?, version = version + 1
            WHERE id = ? AND version = ?`,
        )
        .run(
          nextRole,
          request.status,
          approvedAt,
          request.status,
          actor.user.id,
          request.status,
          now,
          request.status,
          now,
          now,
          targetUserId,
          request.version,
        ).changes;
      if (changed !== 1) {
        throw new IdentityError(
          "VERSION_CONFLICT",
          409,
          true,
          "The user changed before this command was applied",
        );
      }
      const revokedSessions = context.database
        .prepare(
          `UPDATE sessions SET status = 'revoked', revoked_at = ?,
                  revoke_reason = 'admin_user_transition'
            WHERE user_id = ? AND status = 'active'`,
        )
        .run(now, targetUserId).changes;
      if (row.status !== request.status) {
        this.audit.append(context, {
          actorUserId: actor.user.id,
          actorType: "admin",
          action: statusAuditAction(request.status),
          resourceType: "user",
          resourceId: targetUserId,
          outcome: "success",
          metadata: {
            previousStatus: row.status,
            nextStatus: request.status,
            reason: request.reason,
          },
          createdAt: now,
        });
      }
      if (row.role !== nextRole) {
        this.audit.append(context, {
          actorUserId: actor.user.id,
          actorType: "admin",
          action: "admin.role_changed",
          resourceType: "user",
          resourceId: targetUserId,
          outcome: "success",
          metadata: {
            previousRole: row.role,
            nextRole,
            reason: request.reason,
          },
          createdAt: now,
        });
      }
      if (revokedSessions > 0) {
        this.audit.append(context, {
          actorUserId: actor.user.id,
          actorType: "admin",
          action: "admin.session_revoked",
          resourceType: "user",
          resourceId: targetUserId,
          outcome: "success",
          metadata: { revokedCount: Number(revokedSessions) },
          createdAt: now,
        });
      }
      const updated = context.database
        .prepare(
          `SELECT id, email_normalized, display_name, avatar_url, role, status, version
             FROM users WHERE id = ?`,
        )
        .get(targetUserId) as unknown as UserRow;
      const response = { user: mapUser(updated) };
      this.idempotency.complete(context, {
        recordId: begin.recordId,
        responseStatus: 200,
        response,
        resourceId: targetUserId,
      });
      return { ...response, replayed: false };
    });
  }
}

interface UserRow {
  id: string;
  email_normalized: string;
  display_name: string;
  avatar_url: string | null;
  role: "member" | "admin";
  status: "pending" | "active" | "disabled" | "rejected";
  version: number;
}

function mapUser(row: UserRow): IdentityUser {
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

function assertAllowedTransition(
  previousStatus: UserRow["status"],
  nextStatus: AdminUserTransitionRequest["status"],
  previousRole: UserRow["role"],
  nextRole: UserRow["role"],
): void {
  const allowedStatus =
    previousStatus === nextStatus ||
    (previousStatus === "pending" &&
      (nextStatus === "active" || nextStatus === "rejected")) ||
    (previousStatus === "active" && nextStatus === "disabled") ||
    (previousStatus === "disabled" && nextStatus === "active") ||
    (previousStatus === "rejected" && nextStatus === "active");
  const allowedRole =
    previousRole === nextRole ||
    (nextStatus === "active" &&
      ((previousRole === "member" && nextRole === "admin") ||
        (previousRole === "admin" && nextRole === "member")));
  if (!allowedStatus || !allowedRole) {
    throw new IdentityError(
      "RESOURCE_STATE_CONFLICT",
      409,
      false,
      "The requested user transition is not allowed",
    );
  }
}

function statusAuditAction(
  status: AdminUserTransitionRequest["status"],
): string {
  if (status === "active") return "admin.user_approved";
  if (status === "disabled") return "admin.user_disabled";
  return "admin.user_rejected";
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
