import type {
  CompositionDocumentV1,
  CompositionValidationResultV1,
} from "@oloka/contracts";
import {
  compositionDocumentV1Schema,
  compositionValidationResultV1Schema,
} from "@oloka/contracts";
import { canonicalizeJson } from "../../kernel/canonical-json.js";
import type { TransactionContext } from "../database.js";

export interface CompositionVersionRow {
  id: string;
  project_id: string;
  created_by_user_id: string | null;
  created_by_job_id: string | null;
  version_number: number;
  parent_version_id: string | null;
  schema_version: 1;
  composition_json: string;
  canonical_hash_sha256: string;
  semantic_request_hash_sha256: string | null;
  status: "draft" | "valid" | "invalid";
  validation_json: string;
  created_at: number;
}

export interface CompositionAssetReferenceRow {
  composition_version_id: string;
  asset_id: string;
  usage: "visual" | "audio" | "font";
}

export class CompositionRepository {
  nextVersionNumber(context: TransactionContext, projectId: string): number {
    const row = context.database
      .prepare(
        "SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM composition_versions WHERE project_id = ?",
      )
      .get(projectId) as { next: number };
    return row.next;
  }

  insert(
    context: TransactionContext,
    input: {
      id: string;
      projectId: string;
      createdByUserId?: string;
      createdByJobId?: string;
      versionNumber: number;
      parentVersionId?: string;
      document: CompositionDocumentV1;
      canonicalHashSha256: string;
      semanticRequestHashSha256?: string;
      status: "draft" | "valid" | "invalid";
      validation: CompositionValidationResultV1;
      createdAt: number;
      references: Array<{
        assetId: string;
        usage: "visual" | "audio" | "font";
      }>;
    },
  ): CompositionVersionRow {
    context.database
      .prepare(
        `INSERT INTO composition_versions
          (id, project_id, created_by_user_id, created_by_job_id, version_number,
           parent_version_id, schema_version, composition_json,
           canonical_hash_sha256, semantic_request_hash_sha256, status,
           validation_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.projectId,
        input.createdByUserId ?? null,
        input.createdByJobId ?? null,
        input.versionNumber,
        input.parentVersionId ?? null,
        canonicalizeJson(input.document),
        input.canonicalHashSha256,
        input.semanticRequestHashSha256 ?? null,
        input.status,
        canonicalizeJson(input.validation),
        input.createdAt,
      );
    const insertReference = context.database.prepare(
      "INSERT INTO composition_asset_references (composition_version_id, asset_id, usage) VALUES (?, ?, ?)",
    );
    for (const reference of input.references)
      insertReference.run(input.id, reference.assetId, reference.usage);
    return this.getById(context, input.id) as CompositionVersionRow;
  }

  getById(
    context: TransactionContext,
    id: string,
  ): CompositionVersionRow | null {
    return (
      (context.database
        .prepare("SELECT * FROM composition_versions WHERE id = ?")
        .get(id) as CompositionVersionRow | undefined) ?? null
    );
  }

  getOwned(
    context: TransactionContext,
    id: string,
    ownerUserId: string,
  ): CompositionVersionRow | null {
    return (
      (context.database
        .prepare(
          `SELECT version.* FROM composition_versions version
         JOIN projects project ON project.id = version.project_id
         WHERE version.id = ? AND project.owner_user_id = ?`,
        )
        .get(id, ownerUserId) as CompositionVersionRow | undefined) ?? null
    );
  }

  listOwned(
    context: TransactionContext,
    input: {
      projectId: string;
      ownerUserId: string;
      status?: "draft" | "valid" | "invalid";
      limit: number;
      cursor?: { createdAt: number; id: string };
    },
  ): CompositionVersionRow[] {
    const statusClause =
      input.status === undefined ? "" : " AND version.status = ?";
    const cursorClause =
      input.cursor === undefined
        ? ""
        : " AND (version.created_at < ? OR (version.created_at = ? AND version.id < ?))";
    const values: Array<string | number> = [input.projectId, input.ownerUserId];
    if (input.status !== undefined) values.push(input.status);
    if (input.cursor !== undefined)
      values.push(
        input.cursor.createdAt,
        input.cursor.createdAt,
        input.cursor.id,
      );
    values.push(input.limit);
    return context.database
      .prepare(
        `SELECT version.* FROM composition_versions version
         JOIN projects project ON project.id = version.project_id
         WHERE version.project_id = ? AND project.owner_user_id = ?${statusClause}${cursorClause}
         ORDER BY version.created_at DESC, version.id DESC LIMIT ?`,
      )
      .all(...values) as unknown as CompositionVersionRow[];
  }

  references(
    context: TransactionContext,
    compositionVersionId: string,
  ): CompositionAssetReferenceRow[] {
    return context.database
      .prepare(
        "SELECT * FROM composition_asset_references WHERE composition_version_id = ? ORDER BY usage, asset_id",
      )
      .all(compositionVersionId) as unknown as CompositionAssetReferenceRow[];
  }

  advanceProjectPointer(
    context: TransactionContext,
    input: {
      projectId: string;
      ownerUserId: string;
      compositionVersionId: string;
      expectedProjectVersion: number;
      now: number;
    },
  ): boolean {
    return (
      context.database
        .prepare(
          `UPDATE projects SET current_composition_version_id = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND owner_user_id = ? AND status = 'active' AND version = ?`,
        )
        .run(
          input.compositionVersionId,
          input.now,
          input.projectId,
          input.ownerUserId,
          input.expectedProjectVersion,
        ).changes === 1
    );
  }
}

export function parseCompositionDocument(
  row: CompositionVersionRow,
): CompositionDocumentV1 {
  return compositionDocumentV1Schema.parse(
    JSON.parse(row.composition_json) as unknown,
  );
}

export function parseCompositionValidation(
  row: CompositionVersionRow,
): CompositionValidationResultV1 {
  return compositionValidationResultV1Schema.parse(
    JSON.parse(row.validation_json) as unknown,
  );
}

export interface PreviewArtifactRow {
  id: string;
  composition_version_id: string;
  render_contract_fingerprint_sha256: string;
  materializer_version: string;
  hyperframes_version: "0.7.104";
  csp_profile_version: number;
  storage_key: string;
  byte_checksum_sha256: string;
  status: "ready" | "quarantined" | "purge_scheduled" | "purged";
  created_at: number;
  purge_after: number | null;
}

export class PreviewArtifactRepository {
  getById(context: TransactionContext, id: string): PreviewArtifactRow | null {
    return (
      (context.database
        .prepare("SELECT * FROM preview_artifacts WHERE id = ?")
        .get(id) as PreviewArtifactRow | undefined) ?? null
    );
  }

  findIdentity(
    context: TransactionContext,
    input: {
      compositionVersionId: string;
      fingerprint: string;
      materializerVersion: string;
      cspProfileVersion: number;
    },
  ): PreviewArtifactRow | null {
    return (
      (context.database
        .prepare(
          `SELECT * FROM preview_artifacts WHERE composition_version_id = ?
         AND render_contract_fingerprint_sha256 = ? AND materializer_version = ?
         AND csp_profile_version = ?`,
        )
        .get(
          input.compositionVersionId,
          input.fingerprint,
          input.materializerVersion,
          input.cspProfileVersion,
        ) as PreviewArtifactRow | undefined) ?? null
    );
  }

  insert(
    context: TransactionContext,
    row: PreviewArtifactRow,
  ): PreviewArtifactRow {
    context.database
      .prepare(
        `INSERT INTO preview_artifacts
          (id, composition_version_id, render_contract_fingerprint_sha256,
           materializer_version, hyperframes_version, csp_profile_version,
           storage_key, byte_checksum_sha256, status, created_at, purge_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.composition_version_id,
        row.render_contract_fingerprint_sha256,
        row.materializer_version,
        row.hyperframes_version,
        row.csp_profile_version,
        row.storage_key,
        row.byte_checksum_sha256,
        row.status,
        row.created_at,
        row.purge_after,
      );
    return row;
  }

  markRehydrated(
    context: TransactionContext,
    input: { id: string; purgeAfter: number },
  ): boolean {
    return (
      context.database
        .prepare(
          "UPDATE preview_artifacts SET status = 'ready', purge_after = ? WHERE id = ? AND status = 'purged'",
        )
        .run(input.purgeAfter, input.id).changes === 1
    );
  }

  quarantine(context: TransactionContext, id: string): void {
    context.database
      .prepare(
        "UPDATE preview_artifacts SET status = 'quarantined', purge_after = NULL WHERE id = ? AND status IN ('purged', 'purge_scheduled')",
      )
      .run(id);
  }

  getOwned(
    context: TransactionContext,
    id: string,
    ownerUserId: string,
  ): PreviewArtifactRow | null {
    return (
      (context.database
        .prepare(
          `SELECT artifact.* FROM preview_artifacts artifact
         JOIN composition_versions version ON version.id = artifact.composition_version_id
         JOIN projects project ON project.id = version.project_id
         WHERE artifact.id = ? AND project.owner_user_id = ?`,
        )
        .get(id, ownerUserId) as PreviewArtifactRow | undefined) ?? null
    );
  }
}
