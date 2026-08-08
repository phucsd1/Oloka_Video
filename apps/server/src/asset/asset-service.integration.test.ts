import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import type { AuthenticatedSession } from "../identity/identity-service.js";
import { ProjectService } from "../project/project-service.js";
import { FilesystemObjectStorage } from "../storage/filesystem-object-storage.js";
import { AssetService } from "./asset-service.js";
import { AssetMaintenanceService } from "./asset-maintenance-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Asset service", () => {
  it("creates one Asset identity, accepts a checked chunk, and finalizes it ready", async () => {
    const fixture = await createFixture();
    try {
      const initialized = await fixture.service.initializeUpload(
        fixture.actor,
        fixture.projectId,
        {
          originalFilename: "ảnh mùa hè.png",
          kind: "image",
          declaredMime: "image/png",
          declaredSize: PNG.length,
          declaredChecksumSha256: checksum(PNG),
        },
        "upload-create-1",
      );

      expect(initialized).toMatchObject({
        replayed: false,
        asset: {
          id: initialized.upload.assetId,
          originalFilename: "ảnh mùa hè.png",
          ingestionStatus: "upload_pending",
        },
        upload: { receivedSize: 0, status: "open" },
      });

      await expect(
        fixture.service.appendChunk(
          fixture.actor,
          initialized.upload.uploadId,
          0,
          PNG,
          checksum(PNG),
        ),
      ).resolves.toBe(PNG.length);
      await expect(
        fixture.service.appendChunk(
          fixture.actor,
          initialized.upload.uploadId,
          0,
          PNG,
          checksum(PNG),
        ),
      ).resolves.toBe(PNG.length);

      const completed = await fixture.service.completeUpload(
        fixture.actor,
        initialized.upload.uploadId,
        {},
        "upload-complete-1",
      );

      expect(completed.asset).toMatchObject({
        id: initialized.asset.id,
        ingestionStatus: "ready",
        lifecycleStatus: "active",
        verifiedMime: "image/png",
        byteSize: PNG.length,
        byteChecksumSha256: checksum(PNG),
      });
      expect(completed.asset.metadata).toMatchObject({ width: 1, height: 1 });
      expect(
        fixture.database.transactions.run("read", ({ database }) =>
          database.prepare("SELECT COUNT(*) AS count FROM assets").get(),
        ),
      ).toEqual({ count: 1 });
    } finally {
      await fixture.database.close();
      await fixture.storage.close();
    }
  });

  it("keeps duplicate filenames distinct and conceals cross-owner IDs", async () => {
    const fixture = await createFixture();
    try {
      const first = await fixture.service.initializeUpload(
        fixture.actor,
        fixture.projectId,
        { originalFilename: "video.mp4", kind: "video", declaredSize: 16 },
        "same-name-1",
      );
      const second = await fixture.service.initializeUpload(
        fixture.actor,
        fixture.projectId,
        { originalFilename: "video.mp4", kind: "video", declaredSize: 16 },
        "same-name-2",
      );
      const replay = await fixture.service.initializeUpload(
        fixture.actor,
        fixture.projectId,
        { originalFilename: "video.mp4", kind: "video", declaredSize: 16 },
        "same-name-1",
      );

      expect(first.asset.id).not.toBe(second.asset.id);
      expect(replay).toMatchObject({
        replayed: true,
        asset: { id: first.asset.id },
      });
      expect(() =>
        fixture.service.getAsset(fixture.otherActor, first.asset.id),
      ).toThrowError(
        expect.objectContaining({
          code: "RESOURCE_NOT_FOUND",
        }) as unknown as Error,
      );
    } finally {
      await fixture.database.close();
      await fixture.storage.close();
    }
  });

  it("truncates a file-ahead tail and rejects DB-ahead corruption", async () => {
    const fixture = await createFixture();
    try {
      const upload = await fixture.service.initializeUpload(
        fixture.actor,
        fixture.projectId,
        {
          originalFilename: "resume.png",
          kind: "image",
          declaredSize: PNG.length + 1,
        },
        "resume-upload",
      );
      await fixture.storage.appendAtOffset(
        upload.upload.uploadId,
        0,
        Buffer.from("tail"),
      );
      const first = PNG.subarray(0, 8);
      await expect(
        fixture.service.appendChunk(
          fixture.actor,
          upload.upload.uploadId,
          0,
          first,
          checksum(first),
        ),
      ).resolves.toBe(first.length);

      fixture.database.transactions.run("immediate", ({ database }) => {
        database
          .prepare(
            "UPDATE upload_sessions SET received_size = received_size + 1, last_chunk_size = last_chunk_size + 1 WHERE id = ?",
          )
          .run(upload.upload.uploadId);
      });
      const next = PNG.subarray(first.length);
      await expect(
        fixture.service.appendChunk(
          fixture.actor,
          upload.upload.uploadId,
          first.length + 1,
          next,
          checksum(next),
        ),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    } finally {
      await fixture.database.close();
      await fixture.storage.close();
    }
  });

  it("hashes scoped capabilities and revokes delivery on soft delete", async () => {
    const fixture = await createFixture();
    try {
      const initialized = await fixture.service.initializeUpload(
        fixture.actor,
        fixture.projectId,
        {
          originalFilename: "capability.png",
          kind: "image",
          declaredMime: "image/png",
          declaredSize: PNG.length,
        },
        "capability-upload",
      );
      await fixture.service.appendChunk(
        fixture.actor,
        initialized.upload.uploadId,
        0,
        PNG,
        checksum(PNG),
      );
      const ready = (
        await fixture.service.completeUpload(
          fixture.actor,
          initialized.upload.uploadId,
          {},
          "capability-complete",
        )
      ).asset;
      const capability = fixture.service.issueCapability(
        fixture.actor,
        ready.id,
        "stream",
      );
      const stored = fixture.database.transactions.run(
        "read",
        ({ database }) =>
          database
            .prepare(
              "SELECT token_hash_sha256, operation, status FROM delivery_capabilities",
            )
            .get() as {
            token_hash_sha256: Buffer;
            operation: string;
            status: string;
          },
      );
      expect(stored).toMatchObject({ operation: "stream", status: "active" });
      expect(stored.token_hash_sha256).toHaveLength(32);
      expect(stored.token_hash_sha256.toString("utf8")).not.toContain(
        capability.capability,
      );
      expect(
        fixture.service.authorizeCapabilityDelivery(
          ready.id,
          capability.capability,
          "stream",
        ),
      ).not.toBeNull();

      const deleted = fixture.service.softDelete(
        fixture.actor,
        ready.id,
        ready.version,
        "delete-capability-asset",
      );
      expect(deleted.lifecycleStatus).toBe("soft_deleted");
      expect(
        fixture.service.authorizeCapabilityDelivery(
          ready.id,
          capability.capability,
          "stream",
        ),
      ).toBeNull();
      await expect(
        fixture.storage.head(
          fixture.database.transactions.run(
            "read",
            ({ database }) =>
              (
                database
                  .prepare("SELECT storage_key FROM assets WHERE id = ?")
                  .get(ready.id) as { storage_key: string }
              ).storage_key,
          ),
        ),
      ).resolves.toMatchObject({ size: PNG.length });
    } finally {
      await fixture.database.close();
      await fixture.storage.close();
    }
  });

  it("aborts and expires uploads without deleting completed durable bytes", async () => {
    const fixture = await createFixture();
    try {
      const aborted = await fixture.service.initializeUpload(
        fixture.actor,
        fixture.projectId,
        { originalFilename: "abort.png", kind: "image", declaredSize: 20 },
        "abort-upload",
      );
      fixture.service.abortUpload(fixture.actor, aborted.upload.uploadId);
      expect(
        fixture.database.transactions.run("read", ({ database }) =>
          database
            .prepare("SELECT status FROM upload_sessions WHERE id = ?")
            .get(aborted.upload.uploadId),
        ),
      ).toEqual({ status: "aborted" });

      const expired = await fixture.service.initializeUpload(
        fixture.actor,
        fixture.projectId,
        { originalFilename: "expire.png", kind: "image", declaredSize: 20 },
        "expire-upload",
      );
      fixture.setNow(Date.parse(expired.upload.expiresAt) + 1);
      const maintenance = new AssetMaintenanceService(
        fixture.database.transactions,
        fixture.storage,
      );
      await expect(
        maintenance.run(Date.parse(expired.upload.expiresAt) + 1),
      ).resolves.toMatchObject({ expired: 1 });
      expect(
        fixture.database.transactions.run("read", ({ database }) =>
          database
            .prepare("SELECT status FROM upload_sessions WHERE id = ?")
            .get(expired.upload.uploadId),
        ),
      ).toEqual({ status: "expired" });
    } finally {
      await fixture.database.close();
      await fixture.storage.close();
    }
  });

  it("blocks chunk and finalize after the owning Project is soft deleted", async () => {
    const fixture = await createFixture();
    try {
      const initialized = await fixture.service.initializeUpload(
        fixture.actor,
        fixture.projectId,
        {
          originalFilename: "blocked.png",
          kind: "image",
          declaredSize: PNG.length,
        },
        "project-delete-upload",
      );
      fixture.projectService.softDelete(
        fixture.actor,
        fixture.projectId,
        1,
        "project-delete-during-upload",
      );
      await expect(
        fixture.service.appendChunk(
          fixture.actor,
          initialized.upload.uploadId,
          0,
          PNG,
          checksum(PNG),
        ),
      ).rejects.toMatchObject({ code: "RESOURCE_STATE_CONFLICT" });
      await expect(
        fixture.service.completeUpload(
          fixture.actor,
          initialized.upload.uploadId,
          {},
          "project-delete-complete",
        ),
      ).rejects.toMatchObject({ code: "RESOURCE_STATE_CONFLICT" });
    } finally {
      await fixture.database.close();
      await fixture.storage.close();
    }
  });

  it("rejects contradictory MIME and whole-file checksum without exposing bytes", async () => {
    const fixture = await createFixture();
    try {
      const mimeUpload = await fixture.service.initializeUpload(
        fixture.actor,
        fixture.projectId,
        {
          originalFilename: "wrong.jpg",
          kind: "image",
          declaredMime: "image/jpeg",
          declaredSize: PNG.length,
        },
        "wrong-mime-upload",
      );
      await fixture.service.appendChunk(
        fixture.actor,
        mimeUpload.upload.uploadId,
        0,
        PNG,
        checksum(PNG),
      );
      await expect(
        fixture.service.completeUpload(
          fixture.actor,
          mimeUpload.upload.uploadId,
          {},
          "wrong-mime-complete",
        ),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });

      const checksumUpload = await fixture.service.initializeUpload(
        fixture.actor,
        fixture.projectId,
        {
          originalFilename: "wrong-checksum.png",
          kind: "image",
          declaredMime: "image/png",
          declaredSize: PNG.length,
          declaredChecksumSha256: "0".repeat(64),
        },
        "wrong-checksum-upload",
      );
      await fixture.service.appendChunk(
        fixture.actor,
        checksumUpload.upload.uploadId,
        0,
        PNG,
        checksum(PNG),
      );
      await expect(
        fixture.service.completeUpload(
          fixture.actor,
          checksumUpload.upload.uploadId,
          {},
          "wrong-checksum-complete",
        ),
      ).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
    } finally {
      await fixture.database.close();
      await fixture.storage.close();
    }
  });
});

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlZJmAAAAAASUVORK5CYII=",
  "base64",
);

function checksum(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "oloka-asset-service-"));
  temporaryDirectories.push(directory);
  const database = await SqliteSystemDatabase.connect(
    pathToFileURL(join(directory, "database.sqlite")).href,
    { appBuildSha: "phase3d-test", appKey: Buffer.alloc(32, 5) },
  );
  await database.migrate();
  const actor = createActor(
    "00000000-0000-4000-8000-000000000001",
    "owner@example.test",
  );
  const otherActor = createActor(
    "00000000-0000-4000-8000-000000000002",
    "other@example.test",
  );
  database.transactions.run("immediate", ({ database }) => {
    const insert = database.prepare(
      `INSERT INTO users (id, email_normalized, display_name, role, status, approved_at, created_at, updated_at, version)
       VALUES (?, ?, ?, 'member', 'active', ?, ?, ?, 1)`,
    );
    for (const current of [actor, otherActor]) {
      insert.run(
        current.user.id,
        current.user.email,
        current.user.displayName,
        1_700_000_000_000,
        1_700_000_000_000,
        1_700_000_000_000,
      );
    }
  });
  let id = 100;
  let now = 1_700_000_000_000;
  const idGenerator = {
    generate: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  };
  const clock = { now: () => now++ };
  const projectService = new ProjectService({
    transactions: database.transactions,
    applicationKey: Buffer.alloc(32, 8),
    clock,
    idGenerator,
  });
  const projectId = projectService.create(
    actor,
    { name: "Asset project" },
    "asset-project",
  ).project.id;
  const storage = new FilesystemObjectStorage(join(directory, "objects-root"));
  const service = new AssetService({
    transactions: database.transactions,
    storage,
    applicationKey: Buffer.alloc(32, 8),
    clock,
    idGenerator,
  });
  return {
    database,
    storage,
    service,
    projectService,
    actor,
    otherActor,
    projectId,
    setNow: (value: number) => {
      now = value;
    },
  };
}

function createActor(id: string, email: string): AuthenticatedSession {
  return {
    sessionId: id.replace(/.$/, "9"),
    user: {
      id,
      email,
      displayName: email.split("@")[0]!,
      avatarUrl: null,
      role: "member",
      status: "active",
      version: 1,
    },
  };
}
