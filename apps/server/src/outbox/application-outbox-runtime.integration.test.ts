import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApplication } from "../app.js";
import { parseEnvironment } from "../config/environment.js";
import { createDatabase } from "../database/create-database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("application outbox runtime", () => {
  it("drains a known pending event during application startup", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "oloka-outbox-app-"));
    temporaryDirectories.push(dataDirectory);
    const environment = parseEnvironment({
      NODE_ENV: "test",
      OBJECT_STORAGE_ROOT: join(dataDirectory, "objects"),
      DATABASE_PATH: join(dataDirectory, "database", "test.db"),
      OLOKA_DATABASE_BOOTSTRAP_MODE: "fresh-if-replica-missing",
      OLOKA_APP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      LOG_LEVEL: "silent",
    });
    const database = await createDatabase(environment);
    await database.migrate();
    database.transactions.run("immediate", ({ database: connection }) => {
      connection
        .prepare(
          `INSERT INTO outbox_events
            (id, topic, aggregate_type, aggregate_id, payload_json, status,
             available_at, created_at)
           VALUES (?, 'job.state.changed', 'job', ?, ?, 'pending', 0, 0)`,
        )
        .run(
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000002",
          JSON.stringify({
            schemaVersion: 1,
            jobId: "00000000-0000-4000-8000-000000000002",
            status: "completed",
          }),
        );
    });
    await database.close();

    const app = await buildApplication({ environment, serveFrontend: false });
    try {
      const connection = new DatabaseSync(environment.databasePath);
      const event = connection
        .prepare("SELECT status, attempt_count FROM outbox_events")
        .get();
      connection.close();

      expect(event).toEqual({ status: "published", attempt_count: 1 });
    } finally {
      await app.close();
    }
  });

  it("continues polling for events created after startup", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "oloka-outbox-poll-"));
    temporaryDirectories.push(dataDirectory);
    const environment = parseEnvironment({
      NODE_ENV: "test",
      OBJECT_STORAGE_ROOT: join(dataDirectory, "objects"),
      DATABASE_PATH: join(dataDirectory, "database", "test.db"),
      OLOKA_DATABASE_BOOTSTRAP_MODE: "fresh-if-replica-missing",
      OLOKA_APP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      LOG_LEVEL: "silent",
    });
    const app = await buildApplication({ environment, serveFrontend: false });
    try {
      const connection = new DatabaseSync(environment.databasePath);
      try {
        connection
          .prepare(
            `INSERT INTO outbox_events
              (id, topic, aggregate_type, aggregate_id, payload_json, status,
               available_at, created_at)
             VALUES (?, 'job.state.changed', 'job', ?, ?, 'pending', 0, 0)`,
          )
          .run(
            "00000000-0000-4000-8000-000000000003",
            "00000000-0000-4000-8000-000000000004",
            JSON.stringify({
              schemaVersion: 1,
              jobId: "00000000-0000-4000-8000-000000000004",
              status: "completed",
            }),
          );

        await vi.waitFor(
          () => {
            expect(
              connection
                .prepare("SELECT status FROM outbox_events WHERE id = ?")
                .get("00000000-0000-4000-8000-000000000003"),
            ).toEqual({ status: "published" });
          },
          { timeout: 2_000, interval: 25 },
        );
      } finally {
        connection.close();
      }
    } finally {
      await app.close();
    }
  });

  it("drains duplicate historical wakes without replaying completed domain work", async () => {
    const dataDirectory = await mkdtemp(
      join(tmpdir(), "oloka-outbox-backlog-"),
    );
    temporaryDirectories.push(dataDirectory);
    const environment = parseEnvironment({
      NODE_ENV: "test",
      OBJECT_STORAGE_ROOT: join(dataDirectory, "objects"),
      DATABASE_PATH: join(dataDirectory, "database", "test.db"),
      OLOKA_DATABASE_BOOTSTRAP_MODE: "fresh-if-replica-missing",
      OLOKA_APP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      LOG_LEVEL: "silent",
    });
    const database = await createDatabase(environment);
    await database.migrate();
    const userId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const assetId = "33333333-3333-4333-8333-333333333333";
    const jobId = "44444444-4444-4444-8444-444444444444";
    const stepId = "55555555-5555-4555-8555-555555555555";
    database.transactions.run("immediate", ({ database: connection }) => {
      connection.exec(`
        INSERT INTO users
          (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
          VALUES ('${userId}','owner@example.test','Owner','member','active',1,1,1);
        INSERT INTO projects (id,owner_user_id,name,favorite,status,created_at,updated_at)
          VALUES ('${projectId}','${userId}','Project',0,'active',1,1);
        INSERT INTO assets
          (id,project_id,owner_user_id,original_filename,kind,storage_key,byte_size,
           byte_checksum_sha256,metadata_json,ingestion_status,lifecycle_status,created_at,updated_at)
          VALUES ('${assetId}','${projectId}','${userId}','clip.mp4','video','asset/key',128,
                  '${"a".repeat(64)}','{}','ready','active',1,4);
        INSERT INTO jobs
          (id,project_id,owner_user_id,type,status,request_json,result_json,
           progress_basis_points,current_step_key,attempt_count,max_attempts,available_at,
           created_at,started_at,finished_at,updated_at,version)
          VALUES ('${jobId}','${projectId}','${userId}','asset_ingestion','completed',
                  '{"schemaVersion":1,"assetId":"${assetId}"}',
                  '{"schemaVersion":1,"assetId":"${assetId}"}',10000,'inspect_asset',1,3,1,
                  1,2,4,4,3);
        INSERT INTO job_steps
          (id,job_id,step_key,item_key,status,attempt_count,max_attempts,available_at,
           input_json,result_json,started_at,completed_at,created_at,updated_at,version)
          VALUES ('${stepId}','${jobId}','inspect_asset','','completed',1,3,1,
                  '{"schemaVersion":1,"assetId":"${assetId}"}',
                  '{"schemaVersion":1,"assetId":"${assetId}"}',2,4,1,4,3);
        INSERT INTO quota_reservations
          (id,user_id,project_id,resource_type,resource_id,amount,status,created_at,updated_at)
          VALUES ('66666666-6666-4666-8666-666666666666','${userId}','${projectId}',
                  'upload_bytes','${assetId}',128,'consumed',1,4);
      `);
      const insertEvent = connection.prepare(
        "INSERT INTO job_events (id,job_id,sequence,type,payload_json,created_at) VALUES (?,?,?,?,?,?)",
      );
      for (const [index, type] of [
        "job.queued",
        "job.started",
        "job.progress",
        "job.succeeded",
      ].entries()) {
        insertEvent.run(
          `77777777-7777-4777-8777-${String(index + 1).padStart(12, "0")}`,
          jobId,
          index + 1,
          type,
          JSON.stringify({ schemaVersion: 1, jobId }),
          index + 1,
        );
      }
      const insertOutbox = connection.prepare(
        `INSERT INTO outbox_events
          (id,topic,aggregate_type,aggregate_id,payload_json,status,available_at,created_at)
         VALUES (?,?,?,?,?,'pending',0,0)`,
      );
      const topics = [
        "job.dispatch.requested",
        "job.state.changed",
        "job.reconcile.requested",
      ];
      let outboxIndex = 1;
      for (const topic of topics) {
        for (let delivery = 0; delivery < 2; delivery += 1) {
          insertOutbox.run(
            `88888888-8888-4888-8888-${String(outboxIndex++).padStart(12, "0")}`,
            topic,
            "job",
            jobId,
            JSON.stringify({ schemaVersion: 1, jobId }),
          );
        }
      }
    });
    await database.close();

    const app = await buildApplication({ environment, serveFrontend: false });
    try {
      const connection = new DatabaseSync(environment.databasePath);
      try {
        expect(
          connection
            .prepare(
              `SELECT
                 (SELECT COUNT(*) FROM outbox_events WHERE status = 'published') AS published,
                 (SELECT status FROM jobs WHERE id = ?) AS job_status,
                 (SELECT attempt_count FROM jobs WHERE id = ?) AS job_attempts,
                 (SELECT attempt_count FROM job_steps WHERE id = ?) AS step_attempts,
                 (SELECT COUNT(*) FROM job_events WHERE job_id = ?) AS job_events,
                 (SELECT ingestion_status FROM assets WHERE id = ?) AS asset_status,
                 (SELECT version FROM assets WHERE id = ?) AS asset_version,
                 (SELECT status FROM quota_reservations WHERE resource_id = ?) AS quota_status,
                 (SELECT version FROM quota_reservations WHERE resource_id = ?) AS quota_version`,
            )
            .get(
              jobId,
              jobId,
              stepId,
              jobId,
              assetId,
              assetId,
              assetId,
              assetId,
            ),
        ).toEqual({
          published: 6,
          job_status: "completed",
          job_attempts: 1,
          step_attempts: 1,
          job_events: 4,
          asset_status: "ready",
          asset_version: 1,
          quota_status: "consumed",
          quota_version: 1,
        });
      } finally {
        connection.close();
      }
    } finally {
      await app.close();
    }
  });

  it("starts with the application and drains a reconciled Asset-ingestion Job", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "oloka-outbox-admit-"));
    temporaryDirectories.push(dataDirectory);
    const environment = parseEnvironment({
      NODE_ENV: "test",
      OBJECT_STORAGE_ROOT: join(dataDirectory, "objects"),
      DATABASE_PATH: join(dataDirectory, "database", "test.db"),
      OLOKA_DATABASE_BOOTSTRAP_MODE: "fresh-if-replica-missing",
      OLOKA_APP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      LOG_LEVEL: "silent",
    });
    const assetId = "99999999-9999-4999-8999-999999999991";
    const userId = "99999999-9999-4999-8999-999999999992";
    const projectId = "99999999-9999-4999-8999-999999999993";
    const storageKey = `v1/99/${assetId}`;
    const storagePath = join(
      environment.objectStorageRoot,
      "objects",
      storageKey,
    );
    await mkdir(dirname(storagePath), { recursive: true });
    await writeFile(storagePath, Buffer.alloc(128));
    const database = await createDatabase(environment);
    await database.migrate();
    database.transactions.run("immediate", ({ database: connection }) => {
      connection.exec(`
        INSERT INTO users
          (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
          VALUES ('${userId}','reconciled@example.test','Reconciled','member','active',1,1,1);
        INSERT INTO projects (id,owner_user_id,name,favorite,status,created_at,updated_at)
          VALUES ('${projectId}','${userId}','Project',0,'active',1,1);
        INSERT INTO assets
          (id,project_id,owner_user_id,original_filename,kind,storage_key,byte_size,
           metadata_json,ingestion_status,lifecycle_status,created_at,updated_at)
          VALUES ('${assetId}','${projectId}','${userId}','reconciled.mp4','video','${storageKey}',128,
                  '{}','processing','active',1,1);
      `);
    });
    await database.close();

    const app = await buildApplication({ environment, serveFrontend: false });
    try {
      const connection = new DatabaseSync(environment.databasePath);
      try {
        await vi.waitFor(
          () => {
            expect(
              connection
                .prepare(
                  `SELECT
                     j.status AS job_status,
                     j.attempt_count AS job_attempts,
                     s.status AS step_status,
                     a.ingestion_status AS asset_status,
                     (SELECT COUNT(*) FROM outbox_events WHERE status = 'pending') AS pending
                   FROM jobs j
                   JOIN job_steps s ON s.job_id = j.id
                   JOIN assets a ON a.id = ?`,
                )
                .get(assetId),
            ).toEqual({
              job_status: "completed",
              job_attempts: 1,
              step_status: "completed",
              asset_status: "ready",
              pending: 0,
            });
          },
          { timeout: 3_000, interval: 25 },
        );
      } finally {
        connection.close();
      }
    } finally {
      await app.close();
    }
  });

  it("drains a durable backlog after an application restart", async () => {
    const dataDirectory = await mkdtemp(
      join(tmpdir(), "oloka-outbox-restart-"),
    );
    temporaryDirectories.push(dataDirectory);
    const environment = parseEnvironment({
      NODE_ENV: "test",
      OBJECT_STORAGE_ROOT: join(dataDirectory, "objects"),
      DATABASE_PATH: join(dataDirectory, "database", "test.db"),
      OLOKA_DATABASE_BOOTSTRAP_MODE: "fresh-if-replica-missing",
      OLOKA_APP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      LOG_LEVEL: "silent",
    });
    const firstApp = await buildApplication({
      environment,
      serveFrontend: false,
    });
    await firstApp.close();

    const connection = new DatabaseSync(environment.databasePath);
    connection
      .prepare(
        `INSERT INTO outbox_events
          (id, topic, aggregate_type, aggregate_id, payload_json, status,
           available_at, created_at)
         VALUES (?, 'job.state.changed', 'job', ?, ?, 'pending', 0, 0)`,
      )
      .run(
        "00000000-0000-4000-8000-000000000005",
        "00000000-0000-4000-8000-000000000006",
        JSON.stringify({ schemaVersion: 1, status: "completed" }),
      );
    connection.close();

    const restartedApp = await buildApplication({
      environment,
      serveFrontend: false,
    });
    try {
      const restored = new DatabaseSync(environment.databasePath);
      try {
        expect(
          restored
            .prepare(
              "SELECT status, attempt_count FROM outbox_events WHERE id = ?",
            )
            .get("00000000-0000-4000-8000-000000000005"),
        ).toEqual({ status: "published", attempt_count: 1 });
      } finally {
        restored.close();
      }
    } finally {
      await restartedApp.close();
    }
  });
});
