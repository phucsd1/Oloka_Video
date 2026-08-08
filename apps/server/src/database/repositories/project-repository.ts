import type { Project } from "@oloka/contracts";
import type { TransactionContext } from "../database.js";

export interface ProjectRow {
  id: string;
  owner_user_id: string;
  name: string;
  description: string | null;
  favorite: number;
  status: "active" | "soft_deleted" | "purge_scheduled" | "purging" | "purged";
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  purge_after: number | null;
  version: number;
}

export class ProjectRepository {
  create(
    context: TransactionContext,
    input: {
      id: string;
      ownerUserId: string;
      name: string;
      description: string | null;
      now: number;
    },
  ): ProjectRow {
    context.database
      .prepare(
        `INSERT INTO projects
          (id, owner_user_id, name, description, favorite, status,
           created_at, updated_at, version)
         VALUES (?, ?, ?, ?, 0, 'active', ?, ?, 1)`,
      )
      .run(
        input.id,
        input.ownerUserId,
        input.name,
        input.description,
        input.now,
        input.now,
      );
    return this.getById(context, input.id) as ProjectRow;
  }

  getById(context: TransactionContext, projectId: string): ProjectRow | null {
    return (
      (context.database
        .prepare(
          `SELECT id, owner_user_id, name, description, favorite, status,
                  created_at, updated_at, deleted_at, purge_after, version
             FROM projects WHERE id = ?`,
        )
        .get(projectId) as ProjectRow | undefined) ?? null
    );
  }

  listOwned(
    context: TransactionContext,
    input: {
      ownerUserId: string;
      status: "active" | "soft_deleted";
      favorite?: boolean;
      cursor?: { favorite: number; updatedAt: number; id: string };
      limit: number;
    },
  ): ProjectRow[] {
    const favoriteFilter =
      input.favorite === undefined ? "" : " AND favorite = ?";
    const cursorFilter =
      input.cursor === undefined
        ? ""
        : ` AND (
              favorite < ? OR
              (favorite = ? AND updated_at < ?) OR
              (favorite = ? AND updated_at = ? AND id < ?)
            )`;
    const parameters: Array<string | number> = [
      input.ownerUserId,
      input.status,
    ];
    if (input.favorite !== undefined) parameters.push(input.favorite ? 1 : 0);
    if (input.cursor !== undefined) {
      parameters.push(
        input.cursor.favorite,
        input.cursor.favorite,
        input.cursor.updatedAt,
        input.cursor.favorite,
        input.cursor.updatedAt,
        input.cursor.id,
      );
    }
    parameters.push(input.limit);
    return context.database
      .prepare(
        `SELECT id, owner_user_id, name, description, favorite, status,
                created_at, updated_at, deleted_at, purge_after, version
           FROM projects
          WHERE owner_user_id = ? AND status = ?${favoriteFilter}${cursorFilter}
          ORDER BY favorite DESC, updated_at DESC, id DESC
          LIMIT ?`,
      )
      .all(...parameters) as unknown as ProjectRow[];
  }

  updatePresentation(
    context: TransactionContext,
    input: {
      projectId: string;
      ownerUserId: string;
      expectedVersion: number;
      name?: string;
      description?: string | null;
      favorite?: boolean;
      now: number;
    },
  ): ProjectRow | null {
    const changed = context.database
      .prepare(
        `UPDATE projects
            SET name = CASE WHEN ? = 1 THEN ? ELSE name END,
                description = CASE WHEN ? = 1 THEN ? ELSE description END,
                favorite = CASE WHEN ? = 1 THEN ? ELSE favorite END,
                updated_at = ?, version = version + 1
          WHERE id = ? AND owner_user_id = ? AND status = 'active' AND version = ?`,
      )
      .run(
        input.name === undefined ? 0 : 1,
        input.name ?? null,
        input.description === undefined ? 0 : 1,
        input.description ?? null,
        input.favorite === undefined ? 0 : 1,
        input.favorite ? 1 : 0,
        input.now,
        input.projectId,
        input.ownerUserId,
        input.expectedVersion,
      ).changes;
    return changed === 1 ? this.getById(context, input.projectId) : null;
  }

  softDelete(
    context: TransactionContext,
    input: {
      projectId: string;
      ownerUserId: string;
      expectedVersion: number;
      now: number;
      purgeAfter: number;
    },
  ): ProjectRow | null {
    const changed = context.database
      .prepare(
        `UPDATE projects
            SET status = 'soft_deleted', deleted_at = ?, purge_after = ?,
                retention_policy_version = 1, updated_at = ?, version = version + 1
          WHERE id = ? AND owner_user_id = ? AND status = 'active' AND version = ?`,
      )
      .run(
        input.now,
        input.purgeAfter,
        input.now,
        input.projectId,
        input.ownerUserId,
        input.expectedVersion,
      ).changes;
    return changed === 1 ? this.getById(context, input.projectId) : null;
  }

  restore(
    context: TransactionContext,
    input: {
      projectId: string;
      ownerUserId: string;
      expectedVersion: number;
      now: number;
    },
  ): ProjectRow | null {
    const changed = context.database
      .prepare(
        `UPDATE projects
            SET status = 'active', deleted_at = NULL, purge_after = NULL,
                retention_policy_version = NULL, updated_at = ?, version = version + 1
          WHERE id = ? AND owner_user_id = ? AND status = 'soft_deleted'
            AND purge_after > ? AND purged_at IS NULL AND version = ?`,
      )
      .run(
        input.now,
        input.projectId,
        input.ownerUserId,
        input.now,
        input.expectedVersion,
      ).changes;
    return changed === 1 ? this.getById(context, input.projectId) : null;
  }
}

export function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    favorite: row.favorite === 1,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    version: row.version,
  };
}
