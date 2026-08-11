import type { CompositionDocumentV1 } from "@oloka/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../kernel/canonical-json.js";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import type { AuthenticatedSession } from "../identity/identity-service.js";
import { BaselineQuotaPolicyResolver } from "../quota/quota-policy.js";
import { FilesystemObjectStorage } from "../storage/filesystem-object-storage.js";
import { CompositionService } from "./composition-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Composition service", () => {
  it("creates an immutable version and advances the Project pointer atomically", async () => {
    const fixture = await createFixture();
    try {
      const created = fixture.service.create(
        fixture.actor,
        fixture.projectId,
        { document: compositionFixture(), expectedProjectVersion: 1 },
        "composition-create-1",
      );

      expect(created).toMatchObject({
        replayed: false,
        composition: { versionNumber: 1, status: "valid" },
      });
      const state = fixture.database.transactions.run(
        "read",
        ({ database }) => ({
          project: database
            .prepare(
              "SELECT current_composition_version_id, version FROM projects WHERE id = ?",
            )
            .get(fixture.projectId),
          version: database
            .prepare(
              "SELECT version_number, canonical_hash_sha256 FROM composition_versions",
            )
            .get(),
        }),
      );
      expect(state.project).toEqual({
        current_composition_version_id: created.composition.id,
        version: 2,
      });
      expect(state.version).toMatchObject({ version_number: 1 });
      expect(() =>
        fixture.database.transactions.run("immediate", ({ database }) =>
          database
            .prepare(
              "UPDATE composition_versions SET status = 'invalid' WHERE id = ?",
            )
            .run(created.composition.id),
        ),
      ).toThrow(/immutable/i);
    } finally {
      await fixture.storage.close();
      await fixture.database.close();
    }
  });

  it("reuses one immutable preview identity and cleans failed staging", async () => {
    const fixture = await createFixture();
    try {
      const created = fixture.service.create(
        fixture.actor,
        fixture.projectId,
        { document: compositionFixture(), expectedProjectVersion: 1 },
        "preview-identity-create",
      );
      const first = await fixture.service.requestPreview(
        fixture.actor,
        created.composition.id,
        "preview-identity-a",
      );
      const sameKey = await fixture.service.requestPreview(
        fixture.actor,
        created.composition.id,
        "preview-identity-a",
      );
      const differentKey = await fixture.service.requestPreview(
        fixture.actor,
        created.composition.id,
        "preview-identity-b",
      );
      expect(first.replayed).toBe(false);
      expect(sameKey.replayed).toBe(true);
      expect(differentKey.replayed).toBe(false);
      expect(differentKey.preview.id).toBe(first.preview.id);
      expect(
        fixture.database.transactions.run("read", ({ database }) =>
          database
            .prepare("SELECT COUNT(*) AS count FROM preview_artifacts")
            .get(),
        ),
      ).toEqual({ count: 1 });
      expect(
        (await fixture.storage.listForReconciliation()).durable,
      ).toHaveLength(1);

      const derived = fixture.service.derive(
        fixture.actor,
        created.composition.id,
        {
          edits: [
            {
              type: "sceneText",
              sceneId: compositionFixture().scenes[0]!.id,
              text: "Cleanup fixture",
            },
          ],
          expectedProjectVersion: 2,
        },
        "preview-cleanup-derive",
      );
      const originalAppend = fixture.storage.appendAtOffset.bind(
        fixture.storage,
      );
      fixture.storage.appendAtOffset = () => {
        throw new Error("injected preview append failure");
      };
      await expect(
        fixture.service.requestPreview(
          fixture.actor,
          derived.composition.id,
          "preview-cleanup-failure",
        ),
      ).rejects.toThrow();
      fixture.storage.appendAtOffset = originalAppend;
      const leftovers = await fixture.storage.listForReconciliation();
      expect(leftovers.staging).toHaveLength(0);
      expect(leftovers.durable).toHaveLength(1);
    } finally {
      await fixture.storage.close();
      await fixture.database.close();
    }
  });

  it("fails closed for unauthorized, unavailable, mismatched, over-quota, and deleted inputs", async () => {
    const fixture = await createFixture();
    try {
      const otherProjectId = "00000000-0000-4000-8000-000000000003";
      const otherUserId = "00000000-0000-4000-8000-000000000004";
      fixture.database.transactions.run("immediate", ({ database }) => {
        database
          .prepare(
            `INSERT INTO users
              (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at,version)
             VALUES (?,?,'Other','member','active',1,1,1,1)`,
          )
          .run(otherUserId, "other@example.test");
        database
          .prepare(
            `INSERT INTO projects
              (id,owner_user_id,name,description,favorite,status,created_at,updated_at,version)
             VALUES (?,?,'Other project',NULL,0,'active',1,1,1)`,
          )
          .run(otherProjectId, otherUserId);
      });

      const crossProjectAsset = await insertAsset(fixture, {
        id: "30000000-0000-4000-8000-000000000001",
        projectId: otherProjectId,
        ownerUserId: otherUserId,
        kind: "image",
      });
      const crossProjectDocument = withVisualAsset(crossProjectAsset.id);
      expect(() =>
        fixture.service.create(
          fixture.actor,
          fixture.projectId,
          { document: crossProjectDocument, expectedProjectVersion: 1 },
          "asset-cross-project-create",
        ),
      ).toThrow(/asset_unavailable/i);

      const crossOwnerAsset = await insertAsset(fixture, {
        id: "30000000-0000-4000-8000-000000000002",
        projectId: fixture.projectId,
        ownerUserId: otherUserId,
        kind: "image",
      });
      expect(() =>
        fixture.service.create(
          fixture.actor,
          fixture.projectId,
          {
            document: withVisualAsset(crossOwnerAsset.id),
            expectedProjectVersion: 1,
          },
          "asset-cross-owner-create",
        ),
      ).toThrow(/asset_unavailable/i);

      const processingAsset = await insertAsset(fixture, {
        id: "30000000-0000-4000-8000-000000000003",
        projectId: fixture.projectId,
        ownerUserId: fixture.actor.user.id,
        kind: "image",
        ingestionStatus: "processing",
      });
      expect(() =>
        fixture.service.create(
          fixture.actor,
          fixture.projectId,
          {
            document: withVisualAsset(processingAsset.id),
            expectedProjectVersion: 1,
          },
          "asset-processing-create",
        ),
      ).toThrow(/asset_unavailable/i);

      const deletedAsset = await insertAsset(fixture, {
        id: "30000000-0000-4000-8000-000000000004",
        projectId: fixture.projectId,
        ownerUserId: fixture.actor.user.id,
        kind: "image",
        lifecycleStatus: "soft_deleted",
      });
      expect(() =>
        fixture.service.create(
          fixture.actor,
          fixture.projectId,
          {
            document: withVisualAsset(deletedAsset.id),
            expectedProjectVersion: 1,
          },
          "asset-deleted-create",
        ),
      ).toThrow(/asset_unavailable/i);

      const audioAsset = await insertAsset(fixture, {
        id: "30000000-0000-4000-8000-000000000005",
        projectId: fixture.projectId,
        ownerUserId: fixture.actor.user.id,
        kind: "audio",
      });
      expect(() =>
        fixture.service.create(
          fixture.actor,
          fixture.projectId,
          {
            document: withVisualAsset(audioAsset.id),
            expectedProjectVersion: 1,
          },
          "asset-kind-mismatch-create",
        ),
      ).toThrow(/composition_asset_usage_invalid/i);

      expect(() =>
        fixture.service.create(
          fixture.actor,
          fixture.projectId,
          {
            document: { ...compositionFixture(), durationMs: 61_000 },
            expectedProjectVersion: 1,
          },
          "composition-over-quota",
        ),
      ).toThrow(/duration_quota_exceeded/i);

      fixture.database.transactions.run("immediate", ({ database }) => {
        database
          .prepare(
            "UPDATE projects SET status='soft_deleted', deleted_at=2, purge_after=3, version=2 WHERE id=?",
          )
          .run(fixture.projectId);
      });
      expect(() =>
        fixture.service.create(
          fixture.actor,
          fixture.projectId,
          { document: compositionFixture(), expectedProjectVersion: 2 },
          "deleted-project-create",
        ),
      ).toThrow(/project_not_active/i);
    } finally {
      await fixture.storage.close();
      await fixture.database.close();
    }
  });

  it("serializes stale derives and converges preview identity across independent connections", async () => {
    const fixture = await createFixture();
    const secondDatabase = await SqliteSystemDatabase.connect(
      fixture.databaseUrl,
      {
        appKey: Buffer.alloc(32, 7),
      },
    );
    const secondStorage = new FilesystemObjectStorage(fixture.objectRoot);
    const secondService = new CompositionService({
      transactions: secondDatabase.transactions,
      storage: secondStorage,
      applicationKey: Buffer.alloc(32, 8),
      clock: { now: () => 1_700_000_000_000 },
      idGenerator: {
        generate: () =>
          `00000000-0000-4000-8000-${String(++secondId).padStart(12, "0")}`,
      },
      quotaPolicyResolver: new BaselineQuotaPolicyResolver(),
    });
    try {
      const created = fixture.service.create(
        fixture.actor,
        fixture.projectId,
        { document: compositionFixture(), expectedProjectVersion: 1 },
        "concurrency-create",
      );
      const edits = {
        edits: [
          {
            type: "sceneText" as const,
            sceneId: compositionFixture().scenes[0]!.id,
            text: "Concurrent derive",
          },
        ],
        expectedProjectVersion: 2,
      };
      const firstDerive = fixture.service.derive(
        fixture.actor,
        created.composition.id,
        edits,
        "concurrency-derive-a",
      );
      expect(() =>
        secondService.derive(
          fixture.actor,
          created.composition.id,
          edits,
          "concurrency-derive-b",
        ),
      ).toThrow(/version_stale|parent_stale/i);
      expect(firstDerive.composition.versionNumber).toBe(2);

      const [firstPreview, secondPreview] = await Promise.all([
        fixture.service.requestPreview(
          fixture.actor,
          firstDerive.composition.id,
          "concurrency-preview-a",
        ),
        secondService.requestPreview(
          fixture.actor,
          firstDerive.composition.id,
          "concurrency-preview-b",
        ),
      ]);
      expect(firstPreview.preview.id).toBe(secondPreview.preview.id);
      expect(
        fixture.database.transactions.run("read", ({ database }) =>
          database
            .prepare("SELECT COUNT(*) AS count FROM preview_artifacts")
            .get(),
        ),
      ).toEqual({ count: 1 });
    } finally {
      await secondStorage.close();
      await secondDatabase.close();
      await fixture.storage.close();
      await fixture.database.close();
    }
  });
});

let secondId = 20_000;

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "oloka-composition-"));
  directories.push(directory);
  const database = await SqliteSystemDatabase.connect(
    pathToFileURL(join(directory, "database.sqlite")).href,
    { appKey: Buffer.alloc(32, 7) },
  );
  await database.migrate();
  const actor: AuthenticatedSession = {
    sessionId: "00000000-0000-4000-8000-000000000011",
    user: {
      id: "00000000-0000-4000-8000-000000000001",
      email: "owner@example.test",
      displayName: "Owner",
      avatarUrl: null,
      role: "member",
      status: "active",
      version: 1,
    },
  };
  const projectId = "00000000-0000-4000-8000-000000000002";
  database.transactions.run("immediate", ({ database }) => {
    database
      .prepare(
        `INSERT INTO users
          (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at,version)
         VALUES (?,?,?,'member','active',1,1,1,1)`,
      )
      .run(actor.user.id, actor.user.email, actor.user.displayName);
    database
      .prepare(
        `INSERT INTO projects
          (id,owner_user_id,name,description,favorite,status,created_at,updated_at,version)
         VALUES (?,?,?,NULL,0,'active',1,1,1)`,
      )
      .run(projectId, actor.user.id, "Project");
  });
  let id = 100;
  const storage = new FilesystemObjectStorage(join(directory, "objects"));
  const service = new CompositionService({
    transactions: database.transactions,
    storage,
    applicationKey: Buffer.alloc(32, 8),
    clock: { now: () => 1_700_000_000_000 },
    idGenerator: {
      generate: () =>
        `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    },
    quotaPolicyResolver: new BaselineQuotaPolicyResolver(),
  });
  return {
    actor,
    database,
    databaseUrl: pathToFileURL(join(directory, "database.sqlite")).href,
    objectRoot: join(directory, "objects"),
    projectId,
    service,
    storage,
  };
}

async function insertAsset(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  options: {
    id: string;
    projectId: string;
    ownerUserId: string;
    kind: "image" | "audio";
    ingestionStatus?: "ready" | "processing";
    lifecycleStatus?: "active" | "soft_deleted";
  },
) {
  const bytes = Buffer.from("asset-bytes");
  const checksum = sha256Hex(bytes);
  const storageKey = `v1/${options.id.slice(0, 2)}/${options.id}`;
  await fixture.storage.stage(`stage-${options.id}`);
  await fixture.storage.appendAtOffset(`stage-${options.id}`, 0, bytes);
  await fixture.storage.finalize(`stage-${options.id}`, storageKey);
  fixture.database.transactions.run("immediate", ({ database }) => {
    database
      .prepare(
        `INSERT INTO assets
          (id,project_id,owner_user_id,original_filename,kind,declared_mime,verified_mime,storage_key,byte_size,byte_checksum_sha256,metadata_json,ingestion_status,lifecycle_status,created_at,updated_at,deleted_at,purge_after,version)
         VALUES (?,?,?,'asset.bin',?, ?, ?, ?, ?, ?, '{}', ?, ?, 1, 1, ?, ?, 1)`,
      )
      .run(
        options.id,
        options.projectId,
        options.ownerUserId,
        options.kind,
        options.kind === "audio" ? "audio/mpeg" : "image/png",
        options.kind === "audio" ? "audio/mpeg" : "image/png",
        storageKey,
        bytes.length,
        checksum,
        options.ingestionStatus ?? "ready",
        options.lifecycleStatus ?? "active",
        options.lifecycleStatus === "soft_deleted" ? 2 : null,
        options.lifecycleStatus === "soft_deleted" ? 3 : null,
      );
  });
  return { id: options.id };
}

function withVisualAsset(assetId: string): CompositionDocumentV1 {
  const document = compositionFixture();
  return {
    ...document,
    scenes: document.scenes.map((scene) => ({
      ...scene,
      assetReferences: [{ assetId, usage: "visual" }],
    })),
  };
}

function compositionFixture(): CompositionDocumentV1 {
  return {
    schemaVersion: 1,
    compositionId: "10000000-0000-4000-8000-000000000001",
    name: "Bản dựng tiếng Việt",
    aspectRatio: "16:9",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 4_000,
    background: "#102030",
    scenes: [
      {
        id: "20000000-0000-4000-8000-000000000001",
        order: 0,
        startMs: 0,
        durationMs: 4_000,
        text: "Xin chào Việt Nam",
        narration: null,
        assetReferences: [],
        style: {
          layout: "center",
          foreground: "#ffffff",
          accent: "#ffd23f",
          paddingPercent: 8,
          gapPercent: 4,
        },
        tracks: [],
      },
    ],
    voiceConfig: null,
    captionConfig: {
      enabled: true,
      preset: "Clean",
      fontToken: "oloka-sans-v1",
      safeMarginPercent: 8,
      maxLines: 2,
    },
    bgmConfig: null,
    manifests: {
      dependency: { schemaVersion: 1, hashSha256: "a".repeat(64) },
      asset: { schemaVersion: 1, hashSha256: "b".repeat(64) },
      font: { schemaVersion: 1, hashSha256: "c".repeat(64) },
      caption: { schemaVersion: 1, hashSha256: "d".repeat(64) },
    },
    runtimeVersions: {
      materializer: "client-placeholder",
      renderer: "client-placeholder",
      renderProtocol: 1,
      hyperframes: "0.7.104",
      hyperframesRuntimeSha256: "e".repeat(64),
      templateRegistry: "client-placeholder",
    },
    metadata: {
      locale: "vi-VN",
      title: "Bản dựng",
      safeAreaMode: "action",
    },
  };
}
