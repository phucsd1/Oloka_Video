import { createHash } from "node:crypto";
import { copyFile, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import type { AuthenticatedSession } from "../identity/identity-service.js";
import { ProjectService } from "../project/project-service.js";
import { FilesystemObjectStorage } from "../storage/filesystem-object-storage.js";
import { AssetService } from "./asset-service.js";
import { BaselineQuotaPolicyResolver } from "../quota/quota-policy.js";

const temporaryDirectories: string[] = [];
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlZJmAAAAAASUVORK5CYII=",
  "base64",
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Asset three-boot recovery", () => {
  it("separately restores SQLite state while durable media stays under object root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-asset-recovery-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "database.sqlite");
    const snapshotPath = join(directory, "sqlite-replica.snapshot");
    const objectRoot = join(directory, "data");
    const actor = actorFixture();
    let sequence = 100;
    const idGenerator = {
      generate: () =>
        `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    };
    const clock = { now: () => 1_700_000_000_000 + sequence };
    const key = Buffer.alloc(32, 12);
    let database = await SqliteSystemDatabase.connect(
      pathToFileURL(databasePath).href,
      { appBuildSha: "boot-1", appKey: key },
    );
    await database.migrate();
    seedUser(database, actor);
    const projectService = new ProjectService({
      transactions: database.transactions,
      applicationKey: key,
      clock,
      idGenerator,
    });
    const projectId = projectService.create(
      actor,
      { name: "Recovery" },
      "recovery-project",
    ).project.id;
    const storage = new FilesystemObjectStorage(objectRoot);
    const service = new AssetService({
      transactions: database.transactions,
      storage,
      applicationKey: key,
      clock,
      idGenerator,
      quotaPolicyResolver: new BaselineQuotaPolicyResolver(),
    });
    const initialized = await service.initializeUpload(
      actor,
      projectId,
      {
        originalFilename: "recovery.png",
        kind: "image",
        declaredMime: "image/png",
        declaredSize: PNG.length,
        declaredChecksumSha256: checksum(PNG),
      },
      "recovery-upload",
    );
    await service.appendChunk(
      actor,
      initialized.upload.uploadId,
      0,
      PNG,
      checksum(PNG),
    );
    const completed = await service.completeUpload(
      actor,
      initialized.upload.uploadId,
      {},
      "recovery-complete",
    );
    expect(completed.asset.ingestionStatus).toBe("processing");
    await service.processIngestion(completed.asset.id);
    database.checkpoint();
    await database.close();
    await storage.close();
    await copyFile(databasePath, snapshotPath);

    for (const boot of [2, 3]) {
      await unlink(databasePath).catch(() => undefined);
      await unlink(`${databasePath}-wal`).catch(() => undefined);
      await unlink(`${databasePath}-shm`).catch(() => undefined);
      await copyFile(snapshotPath, databasePath);
      database = await SqliteSystemDatabase.connect(
        pathToFileURL(databasePath).href,
        { appBuildSha: `boot-${boot}`, appKey: key },
      );
      await database.migrate();
      const recoveredStorage = new FilesystemObjectStorage(objectRoot);
      const recovered = new AssetService({
        transactions: database.transactions,
        storage: recoveredStorage,
        applicationKey: key,
        clock,
        idGenerator,
        quotaPolicyResolver: new BaselineQuotaPolicyResolver(),
      });
      const asset = recovered.getAsset(actor, completed.asset.id);
      expect(asset).toMatchObject({
        id: completed.asset.id,
        ingestionStatus: "ready",
        lifecycleStatus: "active",
        byteChecksumSha256: checksum(PNG),
        metadata: { width: 1, height: 1 },
      });
      const objects = await recoveredStorage.listForReconciliation();
      expect(objects.durable.length).toBe(1);
      await recoveredStorage.close();
      await database.close();
    }
  });
});

function checksum(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function actorFixture(): AuthenticatedSession {
  return {
    sessionId: "00000000-0000-4000-8000-000000000009",
    user: {
      id: "00000000-0000-4000-8000-000000000001",
      email: "recovery@example.test",
      displayName: "Recovery",
      avatarUrl: null,
      role: "member",
      status: "active",
      version: 1,
    },
  };
}

function seedUser(
  database: SqliteSystemDatabase,
  actor: AuthenticatedSession,
): void {
  database.transactions.run("immediate", ({ database: connection }) =>
    connection
      .prepare(
        `INSERT INTO users (id, email_normalized, display_name, role, status, approved_at, created_at, updated_at, version)
         VALUES (?, ?, ?, 'member', 'active', 1, 1, 1, 1)`,
      )
      .run(actor.user.id, actor.user.email, actor.user.displayName),
  );
}
