import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "./sqlite-system-database.js";
import { PersistenceBusyError } from "./database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SQLite transaction runner", () => {
  it("rolls back a write when the synchronous callback throws", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-transaction-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();

    const pragmas = database.transactions.run(
      "read",
      ({ database: connection }) => ({
        foreignKeys: connection.prepare("PRAGMA foreign_keys").get(),
        journalMode: connection.prepare("PRAGMA journal_mode").get(),
        synchronous: connection.prepare("PRAGMA synchronous").get(),
        busyTimeout: connection.prepare("PRAGMA busy_timeout").get(),
      }),
    );
    expect(pragmas).toEqual({
      foreignKeys: { foreign_keys: 1 },
      journalMode: { journal_mode: "wal" },
      synchronous: { synchronous: 2 },
      busyTimeout: { timeout: 5000 },
    });

    expect(() =>
      database.transactions.run("immediate", ({ database: connection }) => {
        connection
          .prepare(
            "INSERT INTO system_metadata (key, value_json, updated_at, version) VALUES (?, ?, ?, 1)",
          )
          .run("kernel.schema", "{}", 1);
        throw new Error("stop");
      }),
    ).toThrow("stop");
    const count = database.transactions.run(
      "read",
      ({ database: connection }) =>
        connection
          .prepare("SELECT COUNT(*) AS count FROM system_metadata")
          .get(),
    );
    expect(count).toEqual({ count: 0 });
    await database.close();
  });

  it("rejects thenables and nested write transactions at runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-transaction-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();

    expect(() =>
      database.transactions.run("immediate", () => Promise.resolve("invalid")),
    ).toThrow(/synchronous/i);
    expect(() =>
      database.transactions.run("deferred", () =>
        database.transactions.run("immediate", () => "invalid"),
      ),
    ).toThrow(/nested write/i);
    await database.close();
  });

  it("maps a SQLite write-lock conflict to PersistenceBusyError", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-transaction-"));
    temporaryDirectories.push(directory);
    const databaseUrl = pathToFileURL(join(directory, "database.sqlite")).href;
    const first = await SqliteSystemDatabase.connect(databaseUrl);
    await first.migrate();
    const second = await SqliteSystemDatabase.connect(databaseUrl);
    second.transactions.run("read", ({ database }) =>
      database.exec("PRAGMA busy_timeout=1"),
    );

    expect(() =>
      first.transactions.run("immediate", () =>
        second.transactions.run("immediate", () => undefined),
      ),
    ).toThrow(PersistenceBusyError);
    await Promise.all([first.close(), second.close()]);
  });
});
