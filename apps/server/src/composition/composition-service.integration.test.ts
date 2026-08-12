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
import { PreviewArtifactMaintenanceService } from "./preview-artifact-maintenance-service.js";
import { PreviewArtifactMaintenanceRuntime } from "./preview-artifact-maintenance-runtime.js";

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
              "SELECT version_number, canonical_hash_sha256, semantic_request_hash_sha256 FROM composition_versions",
            )
            .get(),
        }),
      );
      expect(state.project).toEqual({
        current_composition_version_id: created.composition.id,
        version: 2,
      });
      expect(state.version).toMatchObject({
        version_number: 1,
        semantic_request_hash_sha256: null,
      });
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

  it("keeps canonical, command, generator, and artifact hashes semantically distinct", async () => {
    const fixture = await createFixture();
    try {
      const created = fixture.service.create(
        fixture.actor,
        fixture.projectId,
        { document: compositionFixture(), expectedProjectVersion: 1 },
        "semantic-lineage-create",
      );
      const preview = await fixture.service.requestPreview(
        fixture.actor,
        created.composition.id,
        "semantic-lineage-preview",
      );
      const hashes = fixture.database.transactions.run(
        "read",
        ({ database }) => ({
          composition: database
            .prepare(
              "SELECT canonical_hash_sha256, semantic_request_hash_sha256 FROM composition_versions WHERE id = ?",
            )
            .get(created.composition.id) as {
            canonical_hash_sha256: string;
            semantic_request_hash_sha256: string | null;
          },
          command: database
            .prepare(
              "SELECT semantic_request_hash_sha256 FROM idempotency_records WHERE operation = 'composition.create'",
            )
            .get() as { semantic_request_hash_sha256: string },
          artifact: database
            .prepare(
              "SELECT byte_checksum_sha256 FROM preview_artifacts WHERE id = ?",
            )
            .get(preview.preview.id) as { byte_checksum_sha256: string },
        }),
      );
      expect(hashes.composition.semantic_request_hash_sha256).toBeNull();
      expect(hashes.composition.canonical_hash_sha256).toBe(
        created.composition.canonicalHashSha256,
      );
      expect(hashes.artifact.byte_checksum_sha256).toBe(
        preview.preview.byteChecksumSha256,
      );
      expect(
        new Set([
          hashes.composition.canonical_hash_sha256,
          hashes.command.semantic_request_hash_sha256,
          hashes.artifact.byte_checksum_sha256,
        ]),
      ).toHaveLength(3);
    } finally {
      await fixture.storage.close();
      await fixture.database.close();
    }
  });

  it("rejects 16 MiB plus one before opening an Asset stream", async () => {
    const fixture = await createFixture();
    try {
      const asset = await insertAsset(fixture, {
        id: "30000000-0000-4000-8000-000000000098",
        projectId: fixture.projectId,
        ownerUserId: fixture.actor.user.id,
        kind: "image",
      });
      fixture.database.transactions.run("immediate", ({ database }) => {
        database
          .prepare("UPDATE assets SET byte_size = ? WHERE id = ?")
          .run(16 * 1024 * 1024 + 1, asset.id);
      });
      const created = fixture.service.create(
        fixture.actor,
        fixture.projectId,
        { document: withVisualAsset(asset.id), expectedProjectVersion: 1 },
        "preview-limit-create",
      );
      let opened = 0;
      const originalOpenRange = fixture.storage.openRange.bind(fixture.storage);
      fixture.storage.openRange = (...args) => {
        opened += 1;
        return originalOpenRange(...args);
      };

      await expect(
        fixture.service.requestPreview(
          fixture.actor,
          created.composition.id,
          "preview-limit-request",
        ),
      ).rejects.toThrow(/preview_embedded_media_limit/i);
      expect(opened).toBe(0);
    } finally {
      await fixture.storage.close();
      await fixture.database.close();
    }
  });

  it("revalidates current Asset availability without mutating historical validation", async () => {
    const fixture = await createFixture();
    try {
      const asset = await insertAsset(fixture, {
        id: "30000000-0000-4000-8000-000000000099",
        projectId: fixture.projectId,
        ownerUserId: fixture.actor.user.id,
        kind: "image",
      });
      const created = fixture.service.create(
        fixture.actor,
        fixture.projectId,
        {
          document: withVisualAsset(asset.id),
          expectedProjectVersion: 1,
        },
        "validate-current-asset-create",
      );
      const storedBefore = fixture.database.transactions.run(
        "read",
        ({ database }) =>
          database
            .prepare(
              "SELECT validation_json FROM composition_versions WHERE id = ?",
            )
            .get(created.composition.id) as { validation_json: string },
      );
      fixture.database.transactions.run("immediate", ({ database }) => {
        database
          .prepare(
            "UPDATE assets SET lifecycle_status = 'soft_deleted', deleted_at = 2, purge_after = 3, version = version + 1 WHERE id = ?",
          )
          .run(asset.id);
      });

      expect(() =>
        fixture.service.validate(
          fixture.actor,
          created.composition.id,
          "validate-current-asset",
        ),
      ).toThrow(/composition_asset_unavailable/i);
      expect(
        fixture.database.transactions.run("read", ({ database }) =>
          database
            .prepare(
              "SELECT validation_json FROM composition_versions WHERE id = ?",
            )
            .get(created.composition.id),
        ),
      ).toEqual(storedBefore);
    } finally {
      await fixture.storage.close();
      await fixture.database.close();
    }
  });

  it("rejects one validation idempotency key reused for another Composition", async () => {
    const fixture = await createFixture();
    try {
      const created = fixture.service.create(
        fixture.actor,
        fixture.projectId,
        { document: compositionFixture(), expectedProjectVersion: 1 },
        "validate-conflict-create",
      );
      const derived = fixture.service.derive(
        fixture.actor,
        created.composition.id,
        {
          edits: [
            {
              type: "sceneText",
              sceneId: compositionFixture().scenes[0]!.id,
              text: "A distinct canonical composition",
            },
          ],
          expectedProjectVersion: 2,
        },
        "validate-conflict-derive",
      );

      expect(
        fixture.service.validate(
          fixture.actor,
          created.composition.id,
          "validate-conflict-key",
        ),
      ).toMatchObject({ replayed: false });
      expect(() =>
        fixture.service.validate(
          fixture.actor,
          derived.composition.id,
          "validate-conflict-key",
        ),
      ).toThrow(/composition_idempotency_conflict/i);
    } finally {
      await fixture.storage.close();
      await fixture.database.close();
    }
  });

  it("purges expired preview bytes asynchronously while retaining row evidence", async () => {
    const fixture = await createFixture();
    try {
      const created = fixture.service.create(
        fixture.actor,
        fixture.projectId,
        { document: compositionFixture(), expectedProjectVersion: 1 },
        "preview-retention-create",
      );
      const preview = await fixture.service.requestPreview(
        fixture.actor,
        created.composition.id,
        "preview-retention-request",
      );
      fixture.database.transactions.run("immediate", ({ database }) => {
        database
          .prepare(
            "UPDATE preview_artifacts SET purge_after = created_at + 1 WHERE id = ?",
          )
          .run(preview.preview.id);
      });
      const maintenance = new PreviewArtifactMaintenanceService({
        transactions: fixture.database.transactions,
        storage: fixture.storage,
        idGenerator: {
          generate: () =>
            `00000000-0000-4000-8000-${String(++secondId).padStart(12, "0")}`,
        },
      });

      await expect(maintenance.run(1_700_000_000_002, 10)).resolves.toEqual({
        scheduled: 1,
        purged: 1,
        failed: 0,
      });
      expect(
        fixture.database.transactions.run("read", ({ database }) =>
          database
            .prepare("SELECT status FROM preview_artifacts WHERE id = ?")
            .get(preview.preview.id),
        ),
      ).toEqual({ status: "purged" });
      expect((await fixture.storage.listForReconciliation()).durable).toEqual(
        [],
      );
    } finally {
      await fixture.storage.close();
      await fixture.database.close();
    }
  });

  it("resumes a scheduled preview purge after storage failure and restart", async () => {
    const fixture = await createFixture();
    try {
      const created = fixture.service.create(
        fixture.actor,
        fixture.projectId,
        { document: compositionFixture(), expectedProjectVersion: 1 },
        "preview-purge-restart-create",
      );
      const preview = await fixture.service.requestPreview(
        fixture.actor,
        created.composition.id,
        "preview-purge-restart-request",
      );
      fixture.database.transactions.run("immediate", ({ database }) => {
        database
          .prepare(
            "UPDATE preview_artifacts SET purge_after = created_at + 1 WHERE id = ?",
          )
          .run(preview.preview.id);
      });
      const originalDelete = fixture.storage.delete.bind(fixture.storage);
      fixture.storage.delete = () =>
        Promise.reject(new Error("injected preview purge failure"));
      const firstMaintenance = new PreviewArtifactMaintenanceService({
        transactions: fixture.database.transactions,
        storage: fixture.storage,
        idGenerator: {
          generate: () =>
            `00000000-0000-4000-8000-${String(++secondId).padStart(12, "0")}`,
        },
      });
      await expect(
        firstMaintenance.run(1_700_000_000_002, 10),
      ).resolves.toEqual({ scheduled: 1, purged: 0, failed: 1 });
      expect(
        fixture.database.transactions.run("read", ({ database }) =>
          database
            .prepare("SELECT status FROM preview_artifacts WHERE id = ?")
            .get(preview.preview.id),
        ),
      ).toEqual({ status: "purge_scheduled" });

      fixture.storage.delete = originalDelete;
      const restartedMaintenance = new PreviewArtifactMaintenanceService({
        transactions: fixture.database.transactions,
        storage: fixture.storage,
        idGenerator: {
          generate: () =>
            `00000000-0000-4000-8000-${String(++secondId).padStart(12, "0")}`,
        },
      });
      await expect(
        restartedMaintenance.run(1_700_000_000_003, 10),
      ).resolves.toEqual({ scheduled: 0, purged: 1, failed: 0 });
      expect(
        fixture.database.transactions.run("read", ({ database }) =>
          database
            .prepare(
              "SELECT COUNT(*) AS count, MIN(status) AS status FROM preview_artifacts",
            )
            .get(),
        ),
      ).toEqual({ count: 1, status: "purged" });
    } finally {
      await fixture.storage.close();
      await fixture.database.close();
    }
  });

  it("rehydrates the same purged PreviewArtifact identity", async () => {
    const fixture = await createFixture();
    try {
      const created = fixture.service.create(
        fixture.actor,
        fixture.projectId,
        { document: compositionFixture(), expectedProjectVersion: 1 },
        "preview-rehydrate-create",
      );
      const first = await fixture.service.requestPreview(
        fixture.actor,
        created.composition.id,
        "preview-rehydrate-first",
      );
      fixture.database.transactions.run("immediate", ({ database }) => {
        database
          .prepare(
            "UPDATE preview_artifacts SET status = 'purge_scheduled' WHERE id = ?",
          )
          .run(first.preview.id);
      });
      const maintenance = new PreviewArtifactMaintenanceService({
        transactions: fixture.database.transactions,
        storage: fixture.storage,
        idGenerator: {
          generate: () =>
            `00000000-0000-4000-8000-${String(++secondId).padStart(12, "0")}`,
        },
      });
      await maintenance.run(1_700_000_000_010, 10);

      const rehydrated = await fixture.service.requestPreview(
        fixture.actor,
        created.composition.id,
        "preview-rehydrate-second",
      );
      expect(rehydrated.preview).toMatchObject({
        id: first.preview.id,
        byteChecksumSha256: first.preview.byteChecksumSha256,
        status: "ready",
      });
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
    } finally {
      await fixture.storage.close();
      await fixture.database.close();
    }
  });

  it("converges concurrent rehydration on one row and durable object", async () => {
    const fixture = await createFixture();
    const secondDatabase = await SqliteSystemDatabase.connect(
      fixture.databaseUrl,
      { appKey: Buffer.alloc(32, 7) },
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
        "concurrent-rehydrate-create",
      );
      const first = await fixture.service.requestPreview(
        fixture.actor,
        created.composition.id,
        "concurrent-rehydrate-first",
      );
      fixture.database.transactions.run("immediate", ({ database }) => {
        database
          .prepare(
            "UPDATE preview_artifacts SET status = 'purge_scheduled' WHERE id = ?",
          )
          .run(first.preview.id);
      });
      await new PreviewArtifactMaintenanceService({
        transactions: fixture.database.transactions,
        storage: fixture.storage,
        idGenerator: {
          generate: () =>
            `00000000-0000-4000-8000-${String(++secondId).padStart(12, "0")}`,
        },
      }).run(1_700_000_000_010, 10);

      const [left, right] = await Promise.all([
        fixture.service.requestPreview(
          fixture.actor,
          created.composition.id,
          "concurrent-rehydrate-left",
        ),
        secondService.requestPreview(
          fixture.actor,
          created.composition.id,
          "concurrent-rehydrate-right",
        ),
      ]);
      expect(left.preview.id).toBe(first.preview.id);
      expect(right.preview.id).toBe(first.preview.id);
      expect(
        fixture.database.transactions.run("read", ({ database }) =>
          database
            .prepare(
              "SELECT COUNT(*) AS count, MIN(status) AS status FROM preview_artifacts",
            )
            .get(),
        ),
      ).toEqual({ count: 1, status: "ready" });
      expect(
        (await fixture.storage.listForReconciliation()).durable,
      ).toHaveLength(1);
    } finally {
      await secondStorage.close();
      await secondDatabase.close();
      await fixture.storage.close();
      await fixture.database.close();
    }
  });

  it("single-flights purge ticks so no stale delete removes rehydrated bytes", async () => {
    const fixture = await createFixture();
    try {
      const created = fixture.service.create(
        fixture.actor,
        fixture.projectId,
        { document: compositionFixture(), expectedProjectVersion: 1 },
        "single-flight-purge-create",
      );
      const first = await fixture.service.requestPreview(
        fixture.actor,
        created.composition.id,
        "single-flight-purge-preview",
      );
      fixture.database.transactions.run("immediate", ({ database }) => {
        database
          .prepare(
            "UPDATE preview_artifacts SET purge_after = created_at + 1 WHERE id = ?",
          )
          .run(first.preview.id);
      });
      let deleteCalls = 0;
      let releaseDelete: (() => void) | undefined;
      let deletionStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        deletionStarted = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });
      const originalDelete = fixture.storage.delete.bind(fixture.storage);
      fixture.storage.delete = async (...args) => {
        deleteCalls += 1;
        deletionStarted?.();
        await release;
        return originalDelete(...args);
      };
      const runtime = new PreviewArtifactMaintenanceRuntime(
        new PreviewArtifactMaintenanceService({
          transactions: fixture.database.transactions,
          storage: fixture.storage,
          idGenerator: {
            generate: () =>
              `00000000-0000-4000-8000-${String(++secondId).padStart(12, "0")}`,
          },
        }),
        {
          pollIntervalMs: 60_000,
          clock: { now: () => 1_700_000_000_010 },
        },
      );

      const passA = runtime.start();
      await started;
      const passB = runtime.runOnce();
      await Promise.resolve();
      expect(deleteCalls).toBe(1);

      releaseDelete?.();
      await Promise.all([passA, passB]);
      const rehydrated = await fixture.service.requestPreview(
        fixture.actor,
        created.composition.id,
        "single-flight-purge-rehydrate",
      );
      await runtime.stop();
      await Promise.resolve();

      const state = fixture.database.transactions.run(
        "read",
        ({ database }) => ({
          preview: database
            .prepare(
              "SELECT COUNT(*) AS count, MIN(status) AS status, MIN(storage_key) AS storage_key, MIN(byte_checksum_sha256) AS byte_checksum_sha256 FROM preview_artifacts",
            )
            .get() as {
            count: number;
            status: string;
            storage_key: string;
            byte_checksum_sha256: string;
          },
          purgeAudits: database
            .prepare(
              "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'preview.purged'",
            )
            .get(),
        }),
      );
      expect(state.preview).toMatchObject({ count: 1, status: "ready" });
      expect(state.purgeAudits).toEqual({ count: 1 });
      expect(deleteCalls).toBe(1);
      expect(rehydrated.preview.id).toBe(first.preview.id);
      expect(await fixture.storage.createHash(state.preview.storage_key)).toBe(
        state.preview.byte_checksum_sha256,
      );
      expect(
        (await fixture.storage.listForReconciliation()).durable,
      ).toHaveLength(1);
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
