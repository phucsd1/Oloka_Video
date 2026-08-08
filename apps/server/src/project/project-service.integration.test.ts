import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import type { AuthenticatedSession } from "../identity/identity-service.js";
import { ProjectService } from "./project-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Project service", () => {
  it("creates exactly one canonical active Project for the actor", async () => {
    const fixture = await createFixture();
    try {
      const result = fixture.service.create(
        fixture.actor,
        { name: "Chiến dịch mùa hè", description: "Video ra mắt" },
        "create-project-1",
      );

      expect(result).toMatchObject({
        replayed: false,
        project: {
          id: "00000000-0000-4000-8000-000000000101",
          name: "Chiến dịch mùa hè",
          description: "Video ra mắt",
          favorite: false,
          status: "active",
          version: 1,
        },
      });
      const count = fixture.database.transactions.run(
        "read",
        ({ database }) =>
          (
            database
              .prepare("SELECT COUNT(*) AS count FROM projects")
              .get() as {
              count: number;
            }
          ).count,
      );
      expect(count).toBe(1);
    } finally {
      await fixture.database.close();
    }
  });

  it("lists only the current owner's active Projects", async () => {
    const fixture = await createFixture();
    try {
      fixture.service.create(
        fixture.actor,
        { name: "Owned project" },
        "create-owned",
      );
      fixture.service.create(
        fixture.otherActor,
        { name: "Private project" },
        "create-private",
      );

      const result = fixture.service.listActive(fixture.actor, { limit: 25 });

      expect(result.projects.map((project) => project.name)).toEqual([
        "Owned project",
      ]);
      expect(result.nextCursor).toBeNull();
    } finally {
      await fixture.database.close();
    }
  });

  it("returns RESOURCE_NOT_FOUND when another user reads a private Project", async () => {
    const fixture = await createFixture();
    try {
      const created = fixture.service.create(
        fixture.actor,
        { name: "Owner only" },
        "create-owner-only",
      );

      expectErrorCode(
        () => fixture.service.getActive(fixture.otherActor, created.project.id),
        "RESOURCE_NOT_FOUND",
      );
    } finally {
      await fixture.database.close();
    }
  });

  it("renames without changing identity and rejects a stale version", async () => {
    const fixture = await createFixture();
    try {
      const created = fixture.service.create(
        fixture.actor,
        { name: "Original" },
        "create-for-update",
      ).project;

      const updated = fixture.service.update(
        fixture.actor,
        created.id,
        { name: "Renamed", favorite: true, expectedVersion: 1 },
        "update-project-1",
      ).project;

      expect(updated).toMatchObject({
        id: created.id,
        name: "Renamed",
        favorite: true,
        version: 2,
      });
      expect(
        fixture.service.getActive(fixture.actor, created.id).favorite,
      ).toBe(true);
      expectErrorCode(
        () => fixture.service.getActive(fixture.otherActor, created.id),
        "RESOURCE_NOT_FOUND",
      );
      expectErrorCode(
        () =>
          fixture.service.update(
            fixture.actor,
            created.id,
            { description: "Stale write", expectedVersion: 1 },
            "update-project-stale",
          ),
        "VERSION_CONFLICT",
      );
    } finally {
      await fixture.database.close();
    }
  });

  it("soft deletes to trash and restores within the 30-day retention window", async () => {
    const fixture = await createFixture();
    try {
      const created = fixture.service.create(
        fixture.actor,
        { name: "Recoverable" },
        "create-recoverable",
      ).project;

      const deleted = fixture.service.softDelete(
        fixture.actor,
        created.id,
        1,
        "delete-recoverable",
      ).project;
      expect(deleted).toMatchObject({ status: "soft_deleted", version: 2 });
      expect(
        fixture.service.listActive(fixture.actor, { limit: 25 }).projects,
      ).toEqual([]);
      expect(
        fixture.service.listTrash(fixture.actor, { limit: 25 }).projects,
      ).toHaveLength(1);

      const restored = fixture.service.restore(
        fixture.actor,
        created.id,
        2,
        "restore-recoverable",
      ).project;
      expect(restored).toMatchObject({
        id: created.id,
        status: "active",
        version: 3,
      });
    } finally {
      await fixture.database.close();
    }
  });

  it("rolls back Project, audit, and idempotency writes when audit append fails", async () => {
    const fixture = await createFixture();
    try {
      fixture.database.transactions.run("immediate", ({ database }) => {
        database.exec(`CREATE TRIGGER fail_project_create_audit
          BEFORE INSERT ON audit_events
          WHEN NEW.action = 'project.create'
          BEGIN
            SELECT RAISE(ABORT, 'forced project audit failure');
          END`);
      });

      expect(() =>
        fixture.service.create(
          fixture.actor,
          { name: "Must roll back" },
          "create-audit-failure",
        ),
      ).toThrow(/forced project audit failure/);

      const counts = fixture.database.transactions.run(
        "read",
        ({ database }) => ({
          projects: (
            database
              .prepare("SELECT COUNT(*) AS count FROM projects")
              .get() as {
              count: number;
            }
          ).count,
          audits: (
            database
              .prepare(
                "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'project.create'",
              )
              .get() as { count: number }
          ).count,
          idempotency: (
            database
              .prepare(
                "SELECT COUNT(*) AS count FROM idempotency_records WHERE operation = 'project.create'",
              )
              .get() as { count: number }
          ).count,
        }),
      );
      expect(counts).toEqual({ projects: 0, audits: 0, idempotency: 0 });
    } finally {
      await fixture.database.close();
    }
  });

  it("replays an idempotent create and rejects a changed semantic request", async () => {
    const fixture = await createFixture();
    try {
      const first = fixture.service.create(
        fixture.actor,
        { name: "Idempotent" },
        "same-create-key",
      );
      const replay = fixture.service.create(
        fixture.actor,
        { name: "Idempotent" },
        "same-create-key",
      );

      expect(replay).toEqual({ project: first.project, replayed: true });
      expectErrorCode(
        () =>
          fixture.service.create(
            fixture.actor,
            { name: "Changed request" },
            "same-create-key",
          ),
        "IDEMPOTENCY_CONFLICT",
      );
    } finally {
      await fixture.database.close();
    }
  });

  it("rejects restore at the retention deadline and hides ownership across restore", async () => {
    const fixture = await createFixture();
    try {
      const project = fixture.service.create(
        fixture.actor,
        { name: "Retention bounded" },
        "create-retention",
      ).project;
      fixture.service.softDelete(
        fixture.actor,
        project.id,
        1,
        "delete-retention",
      );
      expectErrorCode(
        () =>
          fixture.service.restore(
            fixture.otherActor,
            project.id,
            2,
            "cross-user-restore",
          ),
        "RESOURCE_NOT_FOUND",
      );

      fixture.setNow(1_700_000_000_000 + 30 * 24 * 60 * 60 * 1000);
      expectErrorCode(
        () =>
          fixture.service.restore(
            fixture.actor,
            project.id,
            2,
            "expired-restore",
          ),
        "RESOURCE_STATE_CONFLICT",
      );
    } finally {
      await fixture.database.close();
    }
  });

  it("serializes competing updates, deletes, and restore races without overwrite", async () => {
    const fixture = await createFixture();
    try {
      const project = fixture.service.create(
        fixture.actor,
        { name: "Race target" },
        "race-create",
      ).project;
      const winner = fixture.service.update(
        fixture.actor,
        project.id,
        { name: "Winner", expectedVersion: 1 },
        "race-update-winner",
      ).project;
      expect(winner.version).toBe(2);
      expectErrorCode(
        () =>
          fixture.service.update(
            fixture.actor,
            project.id,
            { name: "Loser", expectedVersion: 1 },
            "race-update-loser",
          ),
        "VERSION_CONFLICT",
      );

      const deleted = fixture.service.softDelete(
        fixture.actor,
        project.id,
        2,
        "race-delete-winner",
      ).project;
      expect(deleted.version).toBe(3);
      expectErrorCode(
        () =>
          fixture.service.softDelete(
            fixture.actor,
            project.id,
            2,
            "race-delete-loser",
          ),
        "RESOURCE_STATE_CONFLICT",
      );
      expectErrorCode(
        () =>
          fixture.service.update(
            fixture.actor,
            project.id,
            { favorite: true, expectedVersion: 3 },
            "race-update-deleted",
          ),
        "RESOURCE_STATE_CONFLICT",
      );
      const restored = fixture.service.restore(
        fixture.actor,
        project.id,
        3,
        "race-restore-winner",
      ).project;
      expect(restored).toMatchObject({ status: "active", version: 4 });
    } finally {
      await fixture.database.close();
    }
  });

  it("paginates with an authenticated filter-bound cursor and favorite ordering", async () => {
    const fixture = await createFixture();
    try {
      const first = fixture.service.create(
        fixture.actor,
        { name: "First" },
        "page-first",
      ).project;
      fixture.service.create(fixture.actor, { name: "Second" }, "page-second");
      fixture.service.update(
        fixture.actor,
        first.id,
        { favorite: true, expectedVersion: 1 },
        "page-favorite",
      );

      const pageOne = fixture.service.listActive(fixture.actor, { limit: 1 });
      expect(pageOne.projects[0]).toMatchObject({
        name: "First",
        favorite: true,
      });
      expect(pageOne.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      const pageTwo = fixture.service.listActive(fixture.actor, {
        limit: 1,
        cursor: pageOne.nextCursor as string,
      });
      expect(pageTwo.projects[0]?.name).toBe("Second");
      expectErrorCode(
        () =>
          fixture.service.listActive(fixture.actor, {
            limit: 1,
            cursor: pageOne.nextCursor as string,
            favorite: true,
          }),
        "INVALID_CURSOR",
      );
    } finally {
      await fixture.database.close();
    }
  });
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "oloka-project-service-"));
  temporaryDirectories.push(directory);
  const database = await SqliteSystemDatabase.connect(
    pathToFileURL(join(directory, "project.db")).href,
    { appBuildSha: "phase3c-test", appKey: Buffer.alloc(32, 4) },
  );
  await database.migrate();
  const actor: AuthenticatedSession = {
    sessionId: "00000000-0000-4000-8000-000000000011",
    user: {
      id: "00000000-0000-4000-8000-000000000001",
      email: "member@example.test",
      displayName: "Member",
      avatarUrl: null,
      role: "member",
      status: "active",
      version: 1,
    },
  };
  const otherActor: AuthenticatedSession = {
    sessionId: "00000000-0000-4000-8000-000000000012",
    user: {
      id: "00000000-0000-4000-8000-000000000002",
      email: "other@example.test",
      displayName: "Other Member",
      avatarUrl: null,
      role: "member",
      status: "active",
      version: 1,
    },
  };
  database.transactions.run("immediate", ({ database }) => {
    const insert = database.prepare(
      `INSERT INTO users
          (id, email_normalized, display_name, role, status, approved_at,
           created_at, updated_at, version)
         VALUES (?, ?, ?, 'member', 'active', ?, ?, ?, 1)`,
    );
    insert.run(
      actor.user.id,
      actor.user.email,
      actor.user.displayName,
      1_700_000_000_000,
      1_700_000_000_000,
      1_700_000_000_000,
    );
    insert.run(
      otherActor.user.id,
      otherActor.user.email,
      otherActor.user.displayName,
      1_700_000_000_000,
      1_700_000_000_000,
      1_700_000_000_000,
    );
  });
  let id = 100;
  let now = 1_700_000_000_000;
  const service = new ProjectService({
    transactions: database.transactions,
    applicationKey: Buffer.alloc(32, 9),
    clock: { now: () => now },
    idGenerator: {
      generate: () =>
        `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    },
  });
  return {
    database,
    service,
    actor,
    otherActor,
    setNow: (value: number) => {
      now = value;
    },
  };
}

function expectErrorCode(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code}`);
}
