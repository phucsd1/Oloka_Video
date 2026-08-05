import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import {
  constants,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { Clock } from "../kernel/clock.js";
import {
  canonicalizeJson,
  sha256Hex,
  type JsonValue,
} from "../kernel/canonical-json.js";
import type { IdGenerator } from "../kernel/id-generator.js";

const BACKUP_HKDF_CONTEXT = "oloka/backup-manifest/v1";

export interface BackupManifest {
  manifestVersion: 1;
  createdAt: number;
  sourceSchemaVersion: number;
  targetSchemaVersion: number;
  appBuildSha: string;
  databaseFilename: "database.sqlite";
  databaseSizeBytes: number;
  databaseChecksumSha256: string;
  migrationVersionsPending: number[];
  objectManifestVersion: 1;
  objects: [];
  keyVersion: 1;
}

export interface CreateBackupOptions {
  database: DatabaseSync;
  backupRoot: string;
  applicationKey: Uint8Array;
  appBuildSha: string;
  clock: Clock;
  idGenerator: IdGenerator;
  sourceSchemaVersion: number;
  targetSchemaVersion: number;
  migrationVersionsPending: number[];
}

export async function createPreMigrationBackup(
  options: CreateBackupOptions,
): Promise<string> {
  if (options.applicationKey.length !== 32) {
    throw new Error("Application key must contain exactly 32 bytes");
  }
  const parentDirectory = join(options.backupRoot, "pre-migration");
  const backupDirectory = join(parentDirectory, options.idGenerator.generate());
  await mkdir(parentDirectory, { recursive: true });
  await mkdir(backupDirectory, { recursive: false });
  try {
    const databaseFilename = "database.sqlite";
    const databasePath = join(backupDirectory, databaseFilename);
    await backup(options.database, databasePath);
    const bytes = await readFile(databasePath);
    const manifest: BackupManifest = {
      manifestVersion: 1,
      createdAt: options.clock.now(),
      sourceSchemaVersion: options.sourceSchemaVersion,
      targetSchemaVersion: options.targetSchemaVersion,
      appBuildSha: options.appBuildSha,
      databaseFilename,
      databaseSizeBytes: bytes.length,
      databaseChecksumSha256: sha256Hex(bytes),
      migrationVersionsPending: [...options.migrationVersionsPending],
      objectManifestVersion: 1,
      objects: [],
      keyVersion: 1,
    };
    const canonicalManifest = canonicalizeJson(
      manifest as unknown as JsonValue,
    );
    const signature = signManifest(canonicalManifest, options.applicationKey);
    await writeFile(join(backupDirectory, "manifest.json"), canonicalManifest, {
      encoding: "utf8",
      flag: "wx",
    });
    await writeFile(join(backupDirectory, "manifest.hmac"), signature, {
      encoding: "utf8",
      flag: "wx",
    });
    await verifyBackupDirectory(backupDirectory, options.applicationKey);
    return backupDirectory;
  } catch (error) {
    await rm(backupDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyBackupDirectory(
  backupDirectory: string,
  applicationKey: Uint8Array,
): Promise<BackupManifest> {
  const manifestBytes = await readFile(join(backupDirectory, "manifest.json"));
  const manifestText = manifestBytes.toString("utf8");
  const parsed = JSON.parse(manifestText) as BackupManifest;
  if (canonicalizeJson(parsed as unknown as JsonValue) !== manifestText) {
    throw new Error("Backup manifest is not canonical JSON");
  }
  assertManifestShape(parsed);
  const expectedSignature = signManifest(manifestText, applicationKey);
  const actualSignature = (
    await readFile(join(backupDirectory, "manifest.hmac"), "utf8")
  ).trim();
  const expectedBytes = Buffer.from(expectedSignature, "hex");
  const actualBytes = Buffer.from(actualSignature, "hex");
  if (
    expectedBytes.length !== actualBytes.length ||
    !timingSafeEqual(expectedBytes, actualBytes)
  ) {
    throw new Error("Backup manifest authentication failed");
  }

  const databasePath = join(backupDirectory, parsed.databaseFilename);
  const databaseDetails = await stat(databasePath);
  const databaseBytes = await readFile(databasePath);
  if (
    databaseDetails.size !== parsed.databaseSizeBytes ||
    sha256Hex(databaseBytes) !== parsed.databaseChecksumSha256
  ) {
    throw new Error("Backup database checksum verification failed");
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const quickCheck = database.prepare("PRAGMA quick_check").get() as
      | Record<string, string>
      | undefined;
    if (quickCheck === undefined || Object.values(quickCheck)[0] !== "ok") {
      throw new Error("Backup database quick_check failed");
    }
    if (database.prepare("PRAGMA foreign_key_check").all().length > 0) {
      throw new Error("Backup database foreign_key_check failed");
    }
  } finally {
    database.close();
  }
  return parsed;
}

export async function restoreVerifiedBackup(
  backupDirectory: string,
  destinationDatabasePath: string,
  applicationKey: Uint8Array,
): Promise<void> {
  const manifest = await verifyBackupDirectory(backupDirectory, applicationKey);
  await mkdir(join(destinationDatabasePath, ".."), { recursive: true });
  await copyFile(
    join(backupDirectory, manifest.databaseFilename),
    destinationDatabasePath,
    constants.COPYFILE_EXCL,
  );
  const restored = new DatabaseSync(destinationDatabasePath, {
    readOnly: true,
  });
  try {
    const result = restored.prepare("PRAGMA quick_check").get() as Record<
      string,
      string
    >;
    if (Object.values(result)[0] !== "ok") {
      throw new Error("Restored database quick_check failed");
    }
  } catch (error) {
    restored.close();
    await rm(destinationDatabasePath, { force: true });
    throw error;
  }
  restored.close();
}

function signManifest(manifest: string, applicationKey: Uint8Array): string {
  const derivedKey = Buffer.from(
    hkdfSync(
      "sha256",
      applicationKey,
      new Uint8Array(),
      BACKUP_HKDF_CONTEXT,
      32,
    ),
  );
  return createHmac("sha256", derivedKey)
    .update(manifest, "utf8")
    .digest("hex");
}

function assertManifestShape(value: BackupManifest): void {
  if (
    value.manifestVersion !== 1 ||
    value.objectManifestVersion !== 1 ||
    value.keyVersion !== 1 ||
    value.databaseFilename !== "database.sqlite" ||
    value.objects.length !== 0 ||
    !Array.isArray(value.migrationVersionsPending) ||
    !Number.isSafeInteger(value.createdAt) ||
    !Number.isSafeInteger(value.databaseSizeBytes) ||
    !/^[0-9a-f]{64}$/.test(value.databaseChecksumSha256)
  ) {
    throw new Error("Backup manifest shape is invalid");
  }
}
