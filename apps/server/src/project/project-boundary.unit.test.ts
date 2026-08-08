import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Project Slice 3C boundaries", () => {
  it("keeps lifecycle DB-only with no object, provider, purge, Asset, or Job implementation", async () => {
    const [service, repository, migration] = await Promise.all([
      readFile(new URL("./project-service.ts", import.meta.url), "utf8"),
      readFile(
        new URL(
          "../database/repositories/project-repository.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../../migrations/0004-canonical-project.sql", import.meta.url),
        "utf8",
      ),
    ]);

    expect(service).not.toMatch(
      /object.?storage|provider|fetch\(|deleteObject|moveObject/i,
    );
    expect(repository).not.toMatch(/DELETE\s+FROM\s+projects/i);
    expect(migration).not.toMatch(
      /CREATE\s+TABLE\s+(assets|jobs|job_steps|upload_sessions)/i,
    );
    expect(migration.match(/CREATE\s+TABLE/gi)).toHaveLength(1);
  });
});
