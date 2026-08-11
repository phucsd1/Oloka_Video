import {
  compositionDocumentV1Schema,
  compositionListResponseSchema,
  compositionVersionSchema,
  previewArtifactSchema,
  type CompositionDocumentV1,
  type CompositionEditOperation,
  type CompositionListQuery,
  type CompositionVersion,
  type PreviewArtifact,
} from "@oloka/contracts";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ObjectStorage } from "../storage/object-storage.js";
import type {
  TransactionContext,
  TransactionRunner,
} from "../database/database.js";
import {
  AssetRepository,
  type AssetRow,
} from "../database/repositories/asset-repository.js";
import { AuditEventRepository } from "../database/repositories/audit-event-repository.js";
import {
  CompositionRepository,
  PreviewArtifactRepository,
  parseCompositionDocument,
  parseCompositionValidation,
  type CompositionVersionRow,
  type PreviewArtifactRow,
} from "../database/repositories/composition-repository.js";
import { IdempotencyRepository } from "../database/repositories/idempotency-repository.js";
import { ProjectRepository } from "../database/repositories/project-repository.js";
import { ApplicationError } from "../http/application-error.js";
import type { AuthenticatedSession } from "../identity/identity-service.js";
import {
  canonicalizeJson,
  sha256CanonicalJson,
  sha256Hex,
} from "../kernel/canonical-json.js";
import type { Clock } from "../kernel/clock.js";
import type { IdGenerator } from "../kernel/id-generator.js";
import type { QuotaPolicyResolver } from "../quota/quota-policy.js";
import { materializeCompositionPreview } from "./composition-materializer.js";
import {
  buildRenderContractFingerprint,
  collectCompositionAssetReferences,
  CSP_PROFILE_VERSION,
  HYPERFRAMES_VERSION,
  MATERIALIZER_VERSION,
  resolveCompositionManifests,
} from "./composition-manifests.js";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const PREVIEW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EMBEDDED_PREVIEW_BYTES = 16 * 1024 * 1024;

export interface CompositionServiceOptions {
  transactions: TransactionRunner;
  storage: ObjectStorage;
  applicationKey: Uint8Array;
  clock: Clock;
  idGenerator: IdGenerator;
  quotaPolicyResolver: QuotaPolicyResolver;
}

export class CompositionService {
  private readonly compositions = new CompositionRepository();
  private readonly previews = new PreviewArtifactRepository();
  private readonly assets = new AssetRepository();
  private readonly projects = new ProjectRepository();
  private readonly idempotency: IdempotencyRepository;
  private readonly audit: AuditEventRepository;

  constructor(private readonly options: CompositionServiceOptions) {
    this.idempotency = new IdempotencyRepository(options.idGenerator);
    this.audit = new AuditEventRepository(options.idGenerator);
  }

  create(
    actor: AuthenticatedSession,
    projectId: string,
    input: { document: CompositionDocumentV1; expectedProjectVersion: number },
    idempotencyKey: string,
  ): { composition: CompositionVersion; replayed: boolean } {
    return this.createVersion(
      actor,
      projectId,
      input.document,
      null,
      input.expectedProjectVersion,
      idempotencyKey,
      "composition.create",
    );
  }

  derive(
    actor: AuthenticatedSession,
    parentVersionId: string,
    input: {
      edits: CompositionEditOperation[];
      expectedProjectVersion: number;
    },
    idempotencyKey: string,
  ): { composition: CompositionVersion; replayed: boolean } {
    const parent = this.get(actor, parentVersionId);
    const candidate = applyCompositionEdits(parent.document, input.edits);
    return this.createVersion(
      actor,
      parent.projectId,
      candidate,
      parent.id,
      input.expectedProjectVersion,
      idempotencyKey,
      `composition.derive:${parent.id}`,
    );
  }

  get(
    actor: AuthenticatedSession,
    compositionVersionId: string,
  ): CompositionVersion {
    return this.options.transactions.run("read", (context) => {
      const row = this.compositions.getOwned(
        context,
        compositionVersionId,
        actor.user.id,
      );
      if (row === null)
        throw new ApplicationError(
          "RESOURCE_NOT_FOUND",
          "composition_not_found",
        );
      return toPublicComposition(row);
    });
  }

  current(
    actor: AuthenticatedSession,
    projectId: string,
  ): CompositionVersion | null {
    return this.options.transactions.run("read", (context) => {
      const project = this.projects.getById(context, projectId);
      if (
        project === null ||
        project.owner_user_id !== actor.user.id ||
        project.status !== "active"
      )
        throw new ApplicationError("RESOURCE_NOT_FOUND", "project_not_found");
      if (project.current_composition_version_id === null) return null;
      const row = this.compositions.getById(
        context,
        project.current_composition_version_id,
      );
      if (row === null)
        throw new Error("Current composition pointer is corrupt");
      return toPublicComposition(row);
    });
  }

  list(
    actor: AuthenticatedSession,
    projectId: string,
    query: CompositionListQuery,
  ) {
    const filterHash = sha256CanonicalJson({
      ownerUserId: actor.user.id,
      projectId,
      status: query.status ?? null,
    });
    const cursor =
      query.cursor === undefined
        ? undefined
        : this.decodeCursor(query.cursor, filterHash);
    return this.options.transactions.run("read", (context) => {
      const project = this.projects.getById(context, projectId);
      if (project === null || project.owner_user_id !== actor.user.id)
        throw new ApplicationError("RESOURCE_NOT_FOUND", "project_not_found");
      const rows = this.compositions.listOwned(context, {
        projectId,
        ownerUserId: actor.user.id,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(cursor === undefined ? {} : { cursor }),
        limit: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return compositionListResponseSchema.parse({
        compositions: page.map(toPublicComposition),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? this.encodeCursor(
                { createdAt: last.created_at, id: last.id },
                filterHash,
              )
            : null,
      });
    });
  }

  validate(actor: AuthenticatedSession, compositionVersionId: string) {
    return this.get(actor, compositionVersionId).validation;
  }

  async requestPreview(
    actor: AuthenticatedSession,
    compositionVersionId: string,
    idempotencyKey: string,
  ): Promise<{ preview: PreviewArtifact; replayed: boolean }> {
    const input = this.options.transactions.run("read", (context) => {
      const row = this.compositions.getOwned(
        context,
        compositionVersionId,
        actor.user.id,
      );
      if (row === null)
        throw new ApplicationError(
          "RESOURCE_NOT_FOUND",
          "composition_not_found",
        );
      const project = this.projects.getById(context, row.project_id);
      if (
        project === null ||
        project.status !== "active" ||
        row.status !== "valid"
      )
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "composition_preview_not_allowed",
        );
      return this.resolveDocument(
        context,
        actor,
        project.id,
        parseCompositionDocument(row),
      );
    });
    const semanticHash = sha256CanonicalJson({ compositionVersionId });
    const begin = this.options.transactions.run("immediate", (context) =>
      this.idempotency.begin(context, {
        userId: actor.user.id,
        operation: `composition.preview:${compositionVersionId}`,
        idempotencyKey,
        semanticRequestHashSha256: semanticHash,
        createdAt: this.options.clock.now(),
        expiresAt: this.options.clock.now() + IDEMPOTENCY_TTL_MS,
      }),
    );
    if (begin.kind === "replay")
      return {
        preview: (begin.response as { preview: PreviewArtifact }).preview,
        replayed: true,
      };
    if (begin.kind !== "started" && begin.kind !== "retryable")
      throw this.idempotencyError(begin.kind);
    let stagingKey: string | undefined;
    let storageKey: string | undefined;
    let persisted = false;
    try {
      const assets = await this.loadAssetBytes(input.assets);
      const materialized = await materializeCompositionPreview(
        input.document,
        assets,
      );
      const fingerprint = buildRenderContractFingerprint({
        bundleChecksum: materialized.checksumSha256,
        compositionSchemaVersion: input.document.schemaVersion,
        renderProtocolVersion: input.document.runtimeVersions.renderProtocol,
        rendererVersion: input.document.runtimeVersions.renderer,
        hyperframesVersion: input.document.runtimeVersions.hyperframes,
        dependencyManifestHash: input.hashes.dependencyManifestHash,
        assetManifestHash: input.hashes.assetManifestHash,
        fontManifestHash: input.hashes.fontManifestHash,
        captionManifestHash: input.hashes.captionManifestHash,
      });
      const existing = this.options.transactions.run("read", (context) =>
        this.previews.findIdentity(context, {
          compositionVersionId,
          fingerprint,
          materializerVersion: MATERIALIZER_VERSION,
          cspProfileVersion: CSP_PROFILE_VERSION,
        }),
      );
      if (existing !== null)
        return this.completePreviewReplay(begin.recordId, existing, false);

      const objectId = this.options.idGenerator.generate();
      const generatedStagingKey = this.options.idGenerator.generate();
      const generatedStorageKey = `v1/${objectId.slice(0, 2)}/${objectId}`;
      stagingKey = generatedStagingKey;
      storageKey = generatedStorageKey;
      await this.options.storage.stage(generatedStagingKey);
      await this.options.storage.appendAtOffset(
        generatedStagingKey,
        0,
        materialized.bytes,
      );
      if (
        (await this.options.storage.createStagingHash(generatedStagingKey)) !==
        materialized.checksumSha256
      )
        throw new ApplicationError(
          "CHECKSUM_MISMATCH",
          "preview_staging_checksum_mismatch",
        );
      await this.options.storage.finalize(
        generatedStagingKey,
        generatedStorageKey,
      );
      const now = this.options.clock.now();
      let row: PreviewArtifactRow;
      try {
        row = this.options.transactions.run("immediate", (context) => {
          const inserted = this.previews.insert(context, {
            id: this.options.idGenerator.generate(),
            composition_version_id: compositionVersionId,
            render_contract_fingerprint_sha256: fingerprint,
            materializer_version: MATERIALIZER_VERSION,
            hyperframes_version: HYPERFRAMES_VERSION,
            csp_profile_version: CSP_PROFILE_VERSION,
            storage_key: generatedStorageKey,
            byte_checksum_sha256: materialized.checksumSha256,
            status: "ready",
            created_at: now,
            purge_after: now + PREVIEW_RETENTION_MS,
          });
          this.audit.append(context, {
            actorUserId: actor.user.id,
            actorType: actor.user.role === "admin" ? "admin" : "user",
            action: "preview.materialized",
            resourceType: "preview",
            resourceId: inserted.id,
            outcome: "success",
            metadata: {
              compositionVersionId,
              materializerVersion: MATERIALIZER_VERSION,
            },
            createdAt: now,
          });
          return inserted;
        });
        persisted = true;
      } catch (error) {
        const winner = this.options.transactions.run("read", (context) =>
          this.previews.findIdentity(context, {
            compositionVersionId,
            fingerprint,
            materializerVersion: MATERIALIZER_VERSION,
            cspProfileVersion: CSP_PROFILE_VERSION,
          }),
        );
        if (winner === null) throw error;
        await this.options.storage.delete("durable", generatedStorageKey);
        storageKey = undefined;
        row = winner;
      }
      return this.completePreviewReplay(begin.recordId, row, false);
    } catch (error) {
      await Promise.allSettled([
        ...(stagingKey === undefined
          ? []
          : [this.options.storage.delete("staging", stagingKey)]),
        ...(storageKey === undefined || persisted
          ? []
          : [this.options.storage.delete("durable", storageKey)]),
      ]);
      this.options.transactions.run("immediate", (context) =>
        this.idempotency.markRetryableFailure(context, begin.recordId),
      );
      throw error;
    }
  }

  previewDescriptor(
    actor: AuthenticatedSession,
    previewArtifactId: string,
  ): { preview: PreviewArtifact; storageKey: string } {
    return this.options.transactions.run("read", (context) => {
      const row = this.previews.getOwned(
        context,
        previewArtifactId,
        actor.user.id,
      );
      if (row === null || row.status !== "ready")
        throw new ApplicationError("RESOURCE_NOT_FOUND", "preview_not_found");
      return { preview: toPublicPreview(row), storageKey: row.storage_key };
    });
  }

  private createVersion(
    actor: AuthenticatedSession,
    projectId: string,
    rawDocument: CompositionDocumentV1,
    parentVersionId: string | null,
    expectedProjectVersion: number,
    idempotencyKey: string,
    operation: string,
  ): { composition: CompositionVersion; replayed: boolean } {
    const parsed = compositionDocumentV1Schema.safeParse(rawDocument);
    if (!parsed.success)
      throw new ApplicationError(
        "COMPOSITION_INVALID",
        "composition_schema_invalid",
      );
    const now = this.options.clock.now();
    return this.options.transactions.run("immediate", (context) => {
      const project = this.projects.getById(context, projectId);
      if (project === null || project.owner_user_id !== actor.user.id)
        throw new ApplicationError("RESOURCE_NOT_FOUND", "project_not_found");
      const begin = this.idempotency.begin(context, {
        userId: actor.user.id,
        operation,
        idempotencyKey,
        semanticRequestHashSha256: sha256CanonicalJson({
          projectId,
          parentVersionId,
          expectedProjectVersion,
          document: parsed.data,
        }),
        createdAt: now,
        expiresAt: now + IDEMPOTENCY_TTL_MS,
      });
      if (begin.kind === "replay")
        return {
          composition: (begin.response as { composition: CompositionVersion })
            .composition,
          replayed: true,
        };
      if (begin.kind !== "started" && begin.kind !== "retryable")
        throw this.idempotencyError(begin.kind);
      if (project.status !== "active")
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "project_not_active",
        );
      if (project.version !== expectedProjectVersion)
        throw new ApplicationError("VERSION_CONFLICT", "project_version_stale");
      if (
        parentVersionId !== null &&
        project.current_composition_version_id !== parentVersionId
      )
        throw new ApplicationError(
          "VERSION_CONFLICT",
          "composition_parent_stale",
        );
      const resolution = this.resolveDocument(
        context,
        actor,
        projectId,
        parsed.data,
      );
      const canonicalHashSha256 = sha256Hex(
        canonicalizeJson(resolution.document),
      );
      const validation = { schemaVersion: 1 as const, valid: true, issues: [] };
      const row = this.compositions.insert(context, {
        id: this.options.idGenerator.generate(),
        projectId,
        createdByUserId: actor.user.id,
        versionNumber: this.compositions.nextVersionNumber(context, projectId),
        ...(parentVersionId === null ? {} : { parentVersionId }),
        document: resolution.document,
        canonicalHashSha256,
        semanticRequestHashSha256: sha256CanonicalJson({
          operation,
          projectId,
          parentVersionId,
          expectedProjectVersion,
        }),
        status: "valid",
        validation,
        createdAt: now,
        references: collectCompositionAssetReferences(resolution.document),
      });
      if (
        !this.compositions.advanceProjectPointer(context, {
          projectId,
          ownerUserId: actor.user.id,
          compositionVersionId: row.id,
          expectedProjectVersion,
          now,
        })
      )
        throw new ApplicationError("VERSION_CONFLICT", "project_version_stale");
      const composition = toPublicComposition(row);
      this.audit.append(context, {
        actorUserId: actor.user.id,
        actorType: actor.user.role === "admin" ? "admin" : "user",
        action:
          parentVersionId === null
            ? "composition.create"
            : "composition.derive",
        resourceType: "composition",
        resourceId: row.id,
        outcome: "success",
        metadata: { projectId, versionNumber: row.version_number },
        createdAt: now,
      });
      const response = { composition };
      this.idempotency.complete(context, {
        recordId: begin.recordId,
        responseStatus: 201,
        response,
        resourceId: row.id,
      });
      return { ...response, replayed: false };
    });
  }

  private resolveDocument(
    context: TransactionContext,
    actor: AuthenticatedSession,
    projectId: string,
    document: CompositionDocumentV1,
  ) {
    const policy = this.options.quotaPolicyResolver.resolve({
      userId: actor.user.id,
      projectId,
      at: this.options.clock.now(),
    });
    if (document.durationMs > policy.maxVideoDurationSeconds * 1000)
      throw new ApplicationError(
        "QUOTA_EXCEEDED",
        "composition_duration_quota_exceeded",
      );
    const references = collectCompositionAssetReferences(document);
    const rows: AssetRow[] = [];
    for (const reference of references) {
      const row = this.assets.getAsset(context, reference.assetId);
      if (
        row === null ||
        row.owner_user_id !== actor.user.id ||
        row.project_id !== projectId
      )
        throw new ApplicationError(
          "ASSET_UNAVAILABLE",
          "composition_asset_unavailable",
        );
      rows.push(row);
    }
    return resolveCompositionManifests(document, rows);
  }

  private async loadAssetBytes(
    assets: ReturnType<typeof resolveCompositionManifests>["assets"],
  ) {
    const total = assets.reduce((sum, asset) => sum + asset.byteSize, 0);
    if (total > MAX_EMBEDDED_PREVIEW_BYTES)
      throw new ApplicationError(
        "PAYLOAD_TOO_LARGE",
        "preview_embedded_media_limit",
      );
    return Promise.all(
      assets.map(async (asset) => {
        const stream = await this.options.storage.openRange(
          asset.storageKey,
          0,
          asset.byteSize - 1,
        );
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of stream as AsyncIterable<
          Buffer | Uint8Array
        >) {
          const bytes = Buffer.from(chunk);
          length += bytes.length;
          if (length > MAX_EMBEDDED_PREVIEW_BYTES)
            throw new ApplicationError(
              "PAYLOAD_TOO_LARGE",
              "preview_embedded_media_limit",
            );
          chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks);
        if (
          bytes.length !== asset.byteSize ||
          sha256Hex(bytes) !== asset.checksumSha256
        )
          throw new ApplicationError(
            "CHECKSUM_MISMATCH",
            "preview_asset_checksum_mismatch",
          );
        return { id: asset.id, mime: asset.mime, bytes };
      }),
    );
  }

  private completePreviewReplay(
    recordId: string,
    row: PreviewArtifactRow,
    replayed: boolean,
  ) {
    const preview = toPublicPreview(row);
    this.options.transactions.run("immediate", (context) =>
      this.idempotency.complete(context, {
        recordId,
        responseStatus: 200,
        response: { preview },
        resourceId: row.id,
      }),
    );
    return { preview, replayed };
  }

  private idempotencyError(kind: "conflict" | "in_progress"): ApplicationError {
    return new ApplicationError(
      kind === "conflict" ? "IDEMPOTENCY_CONFLICT" : "RESOURCE_STATE_CONFLICT",
      kind === "conflict"
        ? "composition_idempotency_conflict"
        : "composition_idempotency_in_progress",
    );
  }

  private encodeCursor(
    sort: { createdAt: number; id: string },
    filterHash: string,
  ): string {
    const payload = Buffer.from(
      JSON.stringify({ v: 1, sort, filterHash }),
      "utf8",
    ).toString("base64url");
    const signature = createHmac("sha256", this.options.applicationKey)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  private decodeCursor(
    cursor: string,
    filterHash: string,
  ): { createdAt: number; id: string } {
    try {
      const [payload, signature, extra] = cursor.split(".");
      if (
        payload === undefined ||
        signature === undefined ||
        extra !== undefined
      )
        throw new Error();
      const expected = createHmac("sha256", this.options.applicationKey)
        .update(payload)
        .digest();
      const actual = Buffer.from(signature, "base64url");
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      )
        throw new Error();
      const decoded = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as {
        v?: unknown;
        sort?: { createdAt?: unknown; id?: unknown };
        filterHash?: unknown;
      };
      if (
        decoded.v !== 1 ||
        !Number.isSafeInteger(decoded.sort?.createdAt) ||
        typeof decoded.sort?.id !== "string" ||
        decoded.filterHash !== filterHash
      )
        throw new Error();
      return {
        createdAt: decoded.sort.createdAt as number,
        id: decoded.sort.id,
      };
    } catch {
      throw new ApplicationError(
        "INVALID_CURSOR",
        "composition_cursor_invalid",
      );
    }
  }
}

function toPublicComposition(row: CompositionVersionRow): CompositionVersion {
  return compositionVersionSchema.parse({
    id: row.id,
    projectId: row.project_id,
    versionNumber: row.version_number,
    parentVersionId: row.parent_version_id,
    document: parseCompositionDocument(row),
    canonicalHashSha256: row.canonical_hash_sha256,
    status: row.status,
    validation: parseCompositionValidation(row),
    createdAt: new Date(row.created_at).toISOString(),
  });
}

function toPublicPreview(row: PreviewArtifactRow): PreviewArtifact {
  return previewArtifactSchema.parse({
    id: row.id,
    compositionVersionId: row.composition_version_id,
    renderContractFingerprintSha256: row.render_contract_fingerprint_sha256,
    materializerVersion: row.materializer_version,
    hyperframesVersion: row.hyperframes_version,
    cspProfileVersion: row.csp_profile_version,
    byteChecksumSha256: row.byte_checksum_sha256,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    contentUrl: `/api/v1/previews/${row.id}/content`,
  });
}

function applyCompositionEdits(
  source: CompositionDocumentV1,
  edits: CompositionEditOperation[],
): CompositionDocumentV1 {
  const document = structuredClone(source);
  for (const edit of edits) {
    if (edit.type === "aspectRatio") {
      const presets = {
        "16:9": [1920, 1080],
        "9:16": [1080, 1920],
        "1:1": [1080, 1080],
        "4:5": [1080, 1350],
      } as const;
      document.aspectRatio = edit.aspectRatio;
      [document.width, document.height] = presets[edit.aspectRatio];
      continue;
    }
    if (edit.type === "voice") {
      document.voiceConfig = edit.voiceConfig;
      continue;
    }
    if (edit.type === "caption") {
      document.captionConfig = edit.captionConfig;
      continue;
    }
    if (edit.type === "bgm") {
      document.bgmConfig = edit.bgmConfig;
      continue;
    }
    const scene = document.scenes.find(
      (candidate) => candidate.id === edit.sceneId,
    );
    if (scene === undefined)
      throw new ApplicationError(
        "COMPOSITION_INVALID",
        "composition_scene_missing",
      );
    if (edit.type === "sceneText") scene.text = edit.text;
    if (edit.type === "sceneDuration") scene.durationMs = edit.durationMs;
    if (edit.type === "sceneAsset") scene.assetReferences = edit.references;
    if (edit.type === "sceneStyle") scene.style = edit.style;
    if (edit.type === "sceneOrder") {
      const current = document.scenes.indexOf(scene);
      document.scenes.splice(current, 1);
      document.scenes.splice(
        Math.min(edit.order, document.scenes.length),
        0,
        scene,
      );
    }
  }
  let startMs = 0;
  document.scenes.forEach((scene, order) => {
    scene.order = order;
    scene.startMs = startMs;
    startMs += scene.durationMs;
  });
  document.durationMs = startMs;
  return compositionDocumentV1Schema.parse(document);
}
