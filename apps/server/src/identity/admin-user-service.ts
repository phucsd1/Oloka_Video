import type {
  AdminUserTransitionRequest,
  IdentityUser,
} from "@oloka/contracts";
import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
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
  private readonly cursorKey: Buffer;

  constructor(
    private readonly transactions: TransactionRunner,
    private readonly clock: Clock,
    idGenerator: IdGenerator,
    applicationKey: Uint8Array,
  ) {
    this.audit = new AuditEventRepository(idGenerator);
    this.idempotency = new IdempotencyRepository(idGenerator);
    this.cursorKey = Buffer.from(
      hkdfSync(
        "sha256",
        applicationKey,
        Buffer.from("oloka-video-identity", "utf8"),
        Buffer.from("admin-users-cursor/v1", "utf8"),
        32,
      ),
    );
  }

  list(input: {
    status?: "pending" | "active" | "disabled" | "rejected";
    search?: string;
    cursor?: string;
    limit: number;
  }): { users: IdentityUser[]; nextCursor: string | null } {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    const normalizedSearch = input.search?.trim().toLowerCase();
    const filterHash = this.filterHash(input.status, normalizedSearch);
    if (input.status !== undefined) {
      clauses.push("status = ?");
      parameters.push(input.status);
    }
    if (input.cursor !== undefined) {
      const cursor = this.decodeCursor(input.cursor, filterHash);
      clauses.push("(created_at > ? OR (created_at = ? AND id > ?))");
      parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    if (input.search !== undefined) {
      clauses.push(
        "(email_normalized LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')",
      );
      const search = `%${escapeLike(normalizedSearch!)}%`;
      parameters.push(search, search);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const rows = this.transactions.run("read", ({ database }) =>
      database
        .prepare(
          `SELECT id, email_normalized, display_name, avatar_url, role, status,
                  version, created_at
             FROM users ${where} ORDER BY created_at, id LIMIT ?`,
        )
        .all(...parameters, input.limit + 1),
    ) as unknown as UserRow[];
    const hasMore = rows.length > input.limit;
    const users = rows.slice(0, input.limit).map(mapUser);
    return {
      users,
      nextCursor: hasMore
        ? this.encodeCursor(rows[input.limit - 1]!, filterHash)
        : null,
    };
  }

  private filterHash(
    status: "pending" | "active" | "disabled" | "rejected" | undefined,
    search: string | undefined,
  ): string {
    return createHash("sha256")
      .update(
        JSON.stringify({ status: status ?? null, search: search ?? null }),
        "utf8",
      )
      .digest("base64url");
  }

  private encodeCursor(row: UserRow, filterHash: string): string {
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        sort: { createdAt: row.created_at, id: row.id },
        filterHash,
      }),
      "utf8",
    ).toString("base64url");
    const mac = createHmac("sha256", this.cursorKey)
      .update(payload, "ascii")
      .digest("base64url");
    return `${payload}.${mac}`;
  }

  private decodeCursor(
    value: string,
    expectedFilterHash: string,
  ): { createdAt: number; id: string } {
    try {
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw new Error();
      const [payload, providedMac] = value.split(".") as [string, string];
      const expectedMac = createHmac("sha256", this.cursorKey)
        .update(payload, "ascii")
        .digest();
      const providedMacBytes = Buffer.from(providedMac, "base64url");
      if (
        providedMacBytes.length !== expectedMac.length ||
        !timingSafeEqual(providedMacBytes, expectedMac)
      ) {
        throw new Error();
      }
      const decoded = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as {
        v?: unknown;
        sort?: { createdAt?: unknown; id?: unknown };
        filterHash?: unknown;
      };
      if (
        decoded.v !== 1 ||
        typeof decoded.sort?.createdAt !== "number" ||
        !Number.isSafeInteger(decoded.sort.createdAt) ||
        typeof decoded.sort.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          decoded.sort.id,
        ) ||
        typeof decoded.filterHash !== "string"
      ) {
        throw new Error();
      }
      const actualFilter = Buffer.from(decoded.filterHash, "utf8");
      const requiredFilter = Buffer.from(expectedFilterHash, "utf8");
      if (
        actualFilter.length !== requiredFilter.length ||
        !timingSafeEqual(actualFilter, requiredFilter)
      ) {
        throw new Error();
      }
      return { createdAt: decoded.sort.createdAt, id: decoded.sort.id };
    } catch {
      throw new IdentityError("INVALID_CURSOR", "admin_cursor_invalid");
    }
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
            ? "IDEMPOTENCY_CONFLICT"
            : "RESOURCE_STATE_CONFLICT",
          begin.kind === "conflict"
            ? "idempotency_semantic_conflict"
            : "idempotency_record_not_available",
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
          "admin_target_user_not_found",
        );
      }
      if (row.version !== request.version) {
        throw new IdentityError("VERSION_CONFLICT", "admin_user_version_stale");
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
            "last_active_admin_guard",
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
          "admin_user_concurrent_update",
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
  created_at: number;
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
      "admin_user_transition_invalid",
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
