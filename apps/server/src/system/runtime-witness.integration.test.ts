import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import type { Clock } from "../kernel/clock.js";
import { RuntimeWitnessService } from "./runtime-witness-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("RuntimeWitnessService", () => {
  it("preserves first start and increments exactly once for each startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-witness-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();
    const clock = new SequenceClock([100, 200, 300]);

    const first = new RuntimeWitnessService(
      database.transactions,
      clock,
    ).record("build-one");
    const second = new RuntimeWitnessService(
      database.transactions,
      clock,
    ).record("build-two");
    const third = new RuntimeWitnessService(
      database.transactions,
      clock,
    ).record("build-three");

    expect(first).toEqual({
      metadataVersion: 1,
      witness: {
        schemaVersion: 1,
        firstStartedAt: 100,
        lastStartedAt: 100,
        startupCount: 1,
        lastBuildSha: "build-one",
        runtimeMode: "sqlite-local-hf-s3-replication",
      },
    });
    expect(second).toMatchObject({
      metadataVersion: 2,
      witness: {
        firstStartedAt: 100,
        lastStartedAt: 200,
        startupCount: 2,
        lastBuildSha: "build-two",
      },
    });
    expect(third).toMatchObject({
      metadataVersion: 3,
      witness: {
        firstStartedAt: 100,
        lastStartedAt: 300,
        startupCount: 3,
        lastBuildSha: "build-three",
      },
    });
    await database.close();
  });
});

class SequenceClock implements Clock {
  constructor(private readonly values: number[]) {}

  now(): number {
    const value = this.values.shift();
    if (value === undefined) throw new Error("Clock sequence exhausted");
    return value;
  }
}
