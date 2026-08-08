import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import type {
  TransactionContext,
  TransactionMode,
  TransactionRunner,
} from "../database/database.js";
import type { AuthenticatedSession } from "../identity/identity-service.js";
import { ProjectService } from "../project/project-service.js";
import { FilesystemObjectStorage } from "../storage/filesystem-object-storage.js";
import { AssetService } from "./asset-service.js";
import { AssetMaintenanceService } from "./asset-maintenance-service.js";
import { BaselineQuotaPolicyResolver } from "../quota/quota-policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Asset service", () => {
  it("uses the injected quota policy for Asset admission", async () => {
    const fixture = await createFixture({
      maxAssetSizeBytes: 8,
      maxProjectStorageBytes: 16,
    });
    try {
      await expect(
        fixture.service.initializeUpload(
          fixture.actor,
          fixture.projectId,
          { originalFilename: "too-large.png", kind: "image", declaredSize: 9 },
          "quota-asset-limit",
        ),
      ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    } finally {
      await fixture.database.close();
      await fixture.storage.close();
    }
  });

  it("enforces project storage policy and does not double-reserve an idempotent replay", async () => {
    const fixture = await createFixture({
      maxAssetSizeBytes: 16,
      maxProjectStorageBytes: 16,
    });
    try {
      const first = await fixture.service.initializeUpload(
        fixture.actor,
        fixture.projectId,
        {
          originalFilename: "quota-project.png",
          kind: "image",
          declaredSize: 12,
        },
        "quota-project-key",
      );
      const replay = await fixture.service.initializeUpload(
        fixture.actor,
        fixture.projectId,
        {
          originalFilename: "quota-project.png",
          kind: "image",
          declaredSize: 12,
        },
        "quota-project-key",
      );
      expect(replay.replayed).toBe(true);
      expect(replay.upload.uploadId).toBe(first.upload.uploadId);
      await expect(
        fixture.service.initializeUpload(
          fixture.actor,
          fixture.projectId,
          {
            originalFilename: "quota-project-2.png",
            kind: "image",
            declaredSize: 5,
          },
          "quota-project-key-2",
        ),
      ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
      fixture.service.abortUpload(fixture.actor, first.upload.uploadId);
      await expect(
        fixture.service.initializeUpload(
          fixture.actor,
          fixture.projectId,
          {
            originalFilename: "quota-project-3.png",
            kind: "image",
            declaredSize: 12,
          },
          "quota-project-key-3",
        ),
      ).resolves.toMatchObject({ upload: { status: "open" } });
    } finally {
      await fixture.database.close();
      await fixture.storage.close();
    }
  });

  it("does not persist a successful initialization replay when staging fails", async () => {
    const fixture = await createFixture(undefined, true);
    try {
      await expect(
        fixture.service.initializeUpload(
          fixture.actor,
          fixture.projectId,
          {
            originalFilename: "stage-failure.png",
            kind: "image",
            declaredSize: 8,
          },
          "stage-failure",
        ),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect(
        fixture.database.transactions.run("read", ({ database }) =>
          database.prepare("SELECT COUNT(*) AS count FROM assets").get(),
        ),
      ).toEqual({ count: 0 });

      fixture.setStageFailure(false);
      await expect(
        fixture.service.initializeUpload(
          fixture.actor,
          fixture.projectId,
          {
            originalFilename: "stage-failure.png",
            kind: "image",
            declaredSize: 8,
          },
          "stage-failure",
        ),
      ).resolves.toMatchObject({ replayed: false, upload: { status: "open" } });
    } finally {
      await fixture.database.close();
      await fixture.storage.close();
    }
  });

  it("cleans staging after admission DB failure and allows a fresh retry", async () => {
    const fixture = await createFixture();
    try {
      fixture.setNextImmediateFailure(true);
      await expect(
        fixture.service.initializeUpload(
          fixture.actor,
          fixture.projectId,
          {
            originalFilename: "db-admission-failure.png",
            kind: "image",
            declaredSize: 8,
          },
          "db-admission-failure",
        ),
      ).rejects.toThrow("injected finalize DB failure");
      expect(
        fixture.database.transactions.run("read", ({ database }) =>
          database.prepare("SELECT COUNT(*) AS count FROM assets").get(),
        ),
      ).toEqual({ count: 0 });
      fixture.setNextImmediateFailure(false);
      await expect(
        fixture.service.initializeUpload(
          fixture.actor,
          fixture.projectId,
          {
            originalFilename: "db-admission-failure.png",
            kind: "image",
            declaredSize: 8,
          },
          "db-admission-failure",
        ),
      ).resolves.toMatchObject({ replayed: false, upload: { status: "open" } });
    } finally {
      await fixture.database.close();
      await fixture.storage.close();
    }
  });

  it("reopens a verifying upload when staging verification infrastructure fails", async () => {
    const fixture = await createFixture();
    try {
      const initialized = await fixture.service.initializeUpload(
        fixture.actor,
        fixture.projectId,
        {
          originalFilename: "verify-retry.png",
          kind: "image",
          declaredSize: PNG.length,
        },
        "verify-retry-upload",
      );
      await fixture.service.appendChunk(
        fixture.actor,
        initialized.upload.uploadId,
        0,
        PNG,
        checksum(PNG),
      );
      fixture.setCreateStagingHashFailure(true);
      await expect(
        fixture.service.completeUpload(
          fixture.actor,
          initialized.upload.uploadId,
          {},
          "verify-retry-complete",
        ),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect(
        fixture.database.transactions.run("read", ({ database }) =>
          database
            .prepare("SELECT status FROM upload_sessions WHERE id = ?")
            .get(initialized.upload.uploadId),
        ),
      ).toEqual({ status: "open" });
      fixture.setCreateStagingHashFailure(false);
      await expect(
        fixture.service.completeUpload(
          fixture.actor,
          initialized.upload.uploadId,
          {},
          "verify-retry-complete",
        ),
      ).resolves.toMatchObject({
        replayed: false,
        asset: { ingestionStatus: "ready" },
      });
    } finally {
      await fixture.database.close();
      await fixture.storage.close();
    }
  });

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
        "capability-stream",
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

  it("replays capability issuance without creating another capability", async () => {
    const fixture = await createFixture();
    try {
      const ready = await createReadyAsset(fixture, "capability-idempotency");
      const first = fixture.service.issueCapability(
        fixture.actor,
        ready.id,
        "preview",
        "capability-idempotency-key",
      );
      const replay = fixture.service.issueCapability(
        fixture.actor,
        ready.id,
        "preview",
        "capability-idempotency-key",
      );
      expect(replay).toEqual(first);
      expect(
        fixture.database.transactions.run("read", ({ database }) =>
          database
            .prepare("SELECT COUNT(*) AS count FROM delivery_capabilities")
            .get(),
        ),
      ).toEqual({ count: 1 });
      expect(() =>
        fixture.service.issueCapability(
          fixture.actor,
          ready.id,
          "download",
          "capability-idempotency-key",
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "IDEMPOTENCY_CONFLICT",
        }) as unknown as Error,
      );
    } finally {
      await fixture.database.close();
      await fixture.storage.close();
    }
  });

  it("isolates stream, preview, and download capability operations", async () => {
    const fixture = await createFixture();
    try {
      const ready = await createReadyAsset(fixture, "capability-scope");
      const operations = ["stream", "preview", "download"] as const;
      const capabilities = new Map(
        operations.map((operation) => [
          operation,
          fixture.service.issueCapability(
            fixture.actor,
            ready.id,
            operation,
            `capability-scope-${operation}`,
          ).capability,
        ]),
      );
      for (const issuedOperation of operations) {
        for (const requestedOperation of operations) {
          const descriptor = fixture.service.authorizeCapabilityDelivery(
            ready.id,
            capabilities.get(issuedOperation)!,
            requestedOperation,
          );
          if (issuedOperation === requestedOperation) {
            expect(descriptor?.capabilityOperation).toBe(issuedOperation);
          } else {
            expect(descriptor).toBeNull();
          }
        }
      }
    } finally {
      await fixture.database.close();
      await fixture.storage.close();
    }
  });

  it("retries failed ingestion idempotently with a new attempt for the same Asset", async () => {
    const fixture = await createFixture();
    try {
      const failed = await createFailedAsset(fixture, "retry-ingestion");
      const first = await fixture.service.retryIngestion(
        fixture.actor,
        failed.asset.id,
        failed.asset.version,
        "retry-ingestion-key",
      );
      const replay = await fixture.service.retryIngestion(
        fixture.actor,
        failed.asset.id,
        failed.asset.version,
        "retry-ingestion-key",
      );
      expect(first).toMatchObject({
        replayed: false,
        asset: {
          id: failed.asset.id,
          ingestionStatus: "upload_pending",
          lifecycleStatus: "active",
        },
        upload: { status: "open", receivedSize: 0 },
      });
      expect(first.upload.uploadId).not.toBe(failed.uploadId);
      await expect(
        fixture.storage.statStaging(failed.uploadId),
      ).rejects.toThrow();
      expect(replay).toMatchObject({
        replayed: true,
        upload: { uploadId: first.upload.uploadId },
      });
      expect(
        fixture.database.transactions.run("read", ({ database }) =>
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'asset.ingestion_retry'",
            )
            .get(),
        ),
      ).toEqual({ count: 1 });
      await expect(
        fixture.service.retryIngestion(
          fixture.actor,
          failed.asset.id,
          first.asset.version,
          "retry-ingestion-key",
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
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

  it("reconciles a stranded verifying upload back to open when staging remains", async () => {
    const fixture = await createFixture();
    try {
      const initialized = await fixture.service.initializeUpload(
        fixture.actor,
        fixture.projectId,
        {
          originalFilename: "maintenance-verifying.png",
          kind: "image",
          declaredSize: PNG.length,
        },
        "maintenance-verifying-upload",
      );
      await fixture.service.appendChunk(
        fixture.actor,
        initialized.upload.uploadId,
        0,
        PNG,
        checksum(PNG),
      );
      fixture.database.transactions.run("immediate", ({ database }) => {
        database
          .prepare(
            "UPDATE upload_sessions SET status = 'verifying' WHERE id = ?",
          )
          .run(initialized.upload.uploadId);
      });
      const maintenance = new AssetMaintenanceService(
        fixture.database.transactions,
        fixture.storage,
      );
      await maintenance.run(1_700_000_000_100);
      expect(
        fixture.database.transactions.run("read", ({ database }) =>
          database
            .prepare("SELECT status FROM upload_sessions WHERE id = ?")
            .get(initialized.upload.uploadId),
        ),
      ).toEqual({ status: "open" });
    } finally {
      await fixture.database.close();
      await fixture.storage.close();
    }
  });

  it("rolls a finalized object back to staging when the finalize DB commit fails", async () => {
    const fixture = await createFixture();
    try {
      const initialized = await fixture.service.initializeUpload(
        fixture.actor,
        fixture.projectId,
        {
          originalFilename: "db-failure.png",
          kind: "image",
          declaredSize: PNG.length,
        },
        "db-failure-upload",
      );
      await fixture.service.appendChunk(
        fixture.actor,
        initialized.upload.uploadId,
        0,
        PNG,
        checksum(PNG),
      );
      fixture.setFinalizeCommitFailure(true);
      await expect(
        fixture.service.completeUpload(
          fixture.actor,
          initialized.upload.uploadId,
          {},
          "db-failure-complete",
        ),
      ).rejects.toThrow();
      await expect(
        fixture.storage.statStaging(initialized.upload.uploadId),
      ).resolves.toMatchObject({ size: PNG.length });
      await expect(
        fixture.storage.head(
          fixture.database.transactions.run(
            "read",
            ({ database }) =>
              (
                database
                  .prepare("SELECT storage_key FROM assets WHERE id = ?")
                  .get(initialized.asset.id) as { storage_key: string }
              ).storage_key,
          ),
        ),
      ).rejects.toThrow();
      expect(
        fixture.database.transactions.run("read", ({ database }) =>
          database
            .prepare("SELECT status FROM upload_sessions WHERE id = ?")
            .get(initialized.upload.uploadId),
        ),
      ).toEqual({ status: "open" });
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

async function createReadyAsset(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  key: string,
) {
  const initialized = await fixture.service.initializeUpload(
    fixture.actor,
    fixture.projectId,
    {
      originalFilename: `${key}.png`,
      kind: "image",
      declaredMime: "image/png",
      declaredSize: PNG.length,
    },
    `${key}-upload`,
  );
  await fixture.service.appendChunk(
    fixture.actor,
    initialized.upload.uploadId,
    0,
    PNG,
    checksum(PNG),
  );
  return (
    await fixture.service.completeUpload(
      fixture.actor,
      initialized.upload.uploadId,
      {},
      `${key}-complete`,
    )
  ).asset;
}

async function createFailedAsset(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  key: string,
) {
  const initialized = await fixture.service.initializeUpload(
    fixture.actor,
    fixture.projectId,
    {
      originalFilename: `${key}.jpg`,
      kind: "image",
      declaredMime: "image/jpeg",
      declaredSize: PNG.length,
    },
    `${key}-upload`,
  );
  await fixture.service.appendChunk(
    fixture.actor,
    initialized.upload.uploadId,
    0,
    PNG,
    checksum(PNG),
  );
  await expect(
    fixture.service.completeUpload(
      fixture.actor,
      initialized.upload.uploadId,
      {},
      `${key}-complete`,
    ),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
  return {
    asset: fixture.service.getAsset(fixture.actor, initialized.asset.id),
    uploadId: initialized.upload.uploadId,
  };
}

async function createFixture(
  quota:
    | {
        maxAssetSizeBytes: number;
        maxProjectStorageBytes: number;
      }
    | undefined = undefined,
  stageFailure = false,
) {
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
  let shouldFailStage = stageFailure;
  let shouldFailCreateStagingHash = false;
  let shouldFailFinalizeCommit = false;
  let failNextImmediate = false;
  const serviceTransactions: TransactionRunner = {
    run<T>(
      mode: TransactionMode,
      operation: (context: TransactionContext) => T,
    ): T {
      if (mode === "immediate" && failNextImmediate) {
        failNextImmediate = false;
        throw new Error("injected finalize DB failure");
      }
      return database.transactions.run(mode, operation);
    },
  };
  const serviceStorage = new Proxy(storage, {
    get(target, property, receiver) {
      if (property === "stage" && shouldFailStage)
        return () => Promise.reject(new Error("injected stage failure"));
      if (property === "createStagingHash" && shouldFailCreateStagingHash)
        return () => Promise.reject(new Error("injected staging hash failure"));
      if (property === "finalize" && shouldFailFinalizeCommit)
        return async (stagingKey: string, storageKey: string) => {
          await target.finalize(stagingKey, storageKey);
          failNextImmediate = true;
        };
      const value = Reflect.get(target, property, receiver) as unknown;
      return (
        typeof value === "function" ? value.bind(target) : value
      ) as never;
    },
  });
  const service = new AssetService({
    transactions: serviceTransactions,
    storage: serviceStorage,
    applicationKey: Buffer.alloc(32, 8),
    clock,
    idGenerator,
    quotaPolicyResolver: new BaselineQuotaPolicyResolver({
      version: "asset-service-test",
      ...(quota ?? {
        maxAssetSizeBytes: 500 * 1024 * 1024,
        maxProjectStorageBytes: 5 * 1024 * 1024 * 1024,
      }),
    }),
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
    setStageFailure: (value: boolean) => {
      shouldFailStage = value;
    },
    setCreateStagingHashFailure: (value: boolean) => {
      shouldFailCreateStagingHash = value;
    },
    setFinalizeCommitFailure: (value: boolean) => {
      shouldFailFinalizeCommit = value;
    },
    setNextImmediateFailure: (value: boolean) => {
      failNextImmediate = value;
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
