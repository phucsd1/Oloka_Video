import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApplication } from "../app.js";
import { parseEnvironment } from "../config/environment.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("legacy bucket database isolation", () => {
  it("never opens or mutates the legacy database under object storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "oloka-legacy-"));
    temporaryDirectories.push(root);
    const objectStorageRoot = join(root, "objects");
    const legacyPath = join(objectStorageRoot, "database", "oloka-dev.db");
    const legacyEvidence = Buffer.from("legacy-evidence-must-remain-untouched");
    await mkdir(join(objectStorageRoot, "database"), { recursive: true });
    await writeFile(legacyPath, legacyEvidence);

    const app = await buildApplication({
      environment: parseEnvironment({
        NODE_ENV: "test",
        DATABASE_PATH: join(root, "local", "oloka.db"),
        OBJECT_STORAGE_ROOT: objectStorageRoot,
        OLOKA_DATABASE_BOOTSTRAP_MODE: "fresh-if-replica-missing",
        LOG_LEVEL: "silent",
      }),
      serveFrontend: false,
    });
    await app.close();

    await expect(readFile(legacyPath)).resolves.toEqual(legacyEvidence);
  });
});
