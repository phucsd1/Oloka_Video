import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AssetMaintenanceService } from "../asset/asset-maintenance-service.js";
import { AssetMaintenanceSnapshot } from "../asset/asset-maintenance-snapshot.js";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import { AuditEventRepository } from "../database/repositories/audit-event-repository.js";
import { registerErrorHandler } from "../http/error-handler.js";
import type {
  AuthenticatedSession,
  IdentityService,
} from "../identity/identity-service.js";
import { UuidIdGenerator } from "../kernel/id-generator.js";
import { FilesystemObjectStorage } from "../storage/filesystem-object-storage.js";
import { DurableJobDispatcher } from "./durable-job-dispatcher.js";
import { JobHandlerRegistry } from "./job-handler-registry.js";
import { JobOperationsActivity } from "./job-operations-activity.js";
import { ProviderReconciliationService } from "./job-provider-reconciliation.js";
import { JobRepository } from "./job-repository.js";
import { JobService } from "./job-service.js";
import { registerJobRoutes } from "./job-routes.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Job operations snapshot", () => {
  it("labels current database state without presenting it as activity counters", async () => {
    const harness = await createHarness();
    try {
      harness.database.transactions.run(
        "immediate",
        ({ database: connection }) => {
          for (const [id, status] of [
            ["30000000-0000-4000-8000-000000000001", "queued"],
            ["30000000-0000-4000-8000-000000000002", "waiting_provider"],
            ["30000000-0000-4000-8000-000000000003", "cancel_requested"],
          ] as const) {
            connection
              .prepare(
                `INSERT INTO jobs
                  (id,project_id,owner_user_id,type,status,request_json,current_step_key,
                   max_attempts,available_at,created_at,updated_at)
                 VALUES (?,?,?,?,?,'{"schemaVersion":1}',NULL,3,1,1,1)`,
              )
              .run(
                id,
                harness.projectId,
                harness.ownerId,
                "generation",
                status,
              );
          }
        },
      );

      const snapshot = harness.service.operations(harness.admin);

      expect(snapshot).toMatchObject({
        queuedJobsCurrent: 1,
        waitingProviderCurrent: 1,
        cancelRequestedCurrent: 1,
      });
      expect(snapshot).not.toHaveProperty("waitingProviderReconciliation");
      expect(snapshot).not.toHaveProperty("cancellationCleanup");
      expect(snapshot).not.toHaveProperty("assetStorageDivergence");
    } finally {
      await harness.database.close();
    }
  });

  it("increments cancellation cleanup only after the dispatcher completes cleanup", async () => {
    const harness = await createHarness();
    const activity = new JobOperationsActivity();
    const service = new JobService({
      transactions: harness.database.transactions,
      clock: harness.clock,
      idGenerator: harness.idGenerator,
      applicationKey: harness.applicationKey,
      repository: harness.repository,
      activitySnapshot: () => activity.snapshot(),
    });
    const dispatcher = new DurableJobDispatcher({
      transactions: harness.database.transactions,
      repository: harness.repository,
      handlers: new JobHandlerRegistry([]),
      clock: harness.clock,
      workerId: "cleanup-worker",
      activity,
    });
    try {
      harness.database.transactions.run(
        "immediate",
        ({ database: connection }) => {
          connection
            .prepare(
              `INSERT INTO jobs
                (id,project_id,owner_user_id,type,status,request_json,current_step_key,
                 max_attempts,available_at,cancel_requested_at,created_at,updated_at)
               VALUES (?,?,?,?,?,'{"schemaVersion":1}','inspect_asset',3,1,1,1,1)`,
            )
            .run(
              "30000000-0000-4000-8000-000000000010",
              harness.projectId,
              harness.ownerId,
              "asset_ingestion",
              "cancel_requested",
            );
          connection
            .prepare(
              `INSERT INTO job_steps
                (id,job_id,step_key,item_key,status,max_attempts,available_at,input_json,created_at,updated_at)
               VALUES (?,?,?,?,?,3,1,'{}',1,1)`,
            )
            .run(
              "40000000-0000-4000-8000-000000000010",
              "30000000-0000-4000-8000-000000000010",
              "inspect_asset",
              "",
              "pending",
            );
        },
      );

      expect(service.operations(harness.admin)).toMatchObject({
        cancelRequestedCurrent: 1,
        cancellationCleanupSinceProcessStart: 0,
      });

      await expect(dispatcher.runOnce()).resolves.toBe(true);

      expect(service.operations(harness.admin)).toMatchObject({
        cancelRequestedCurrent: 0,
        cancellationCleanupSinceProcessStart: 1,
      });
    } finally {
      await harness.database.close();
    }
  });

  it("increments waiting-provider activity only after a real reconciliation", async () => {
    const harness = await createHarness();
    const activity = new JobOperationsActivity();
    const service = new JobService({
      transactions: harness.database.transactions,
      clock: harness.clock,
      idGenerator: harness.idGenerator,
      applicationKey: harness.applicationKey,
      repository: harness.repository,
      activitySnapshot: () => activity.snapshot(),
    });
    const reconciliation = new ProviderReconciliationService({
      transactions: harness.database.transactions,
      repository: harness.repository,
      clock: harness.clock,
      workerId: "provider-reconciler",
      leaseDurationMs: 60_000,
      activity,
      adapter: {
        poll: () => Promise.resolve({ status: "pending" as const }),
        lookup: () => Promise.resolve({ status: "unknown" as const }),
      },
    });
    try {
      harness.database.transactions.run(
        "immediate",
        ({ database: connection }) => {
          connection
            .prepare(
              `INSERT INTO jobs
                (id,project_id,owner_user_id,type,status,request_json,current_step_key,
                 max_attempts,available_at,created_at,updated_at)
               VALUES (?,?,?,?,?,'{"schemaVersion":1}','provider_generation',3,1,1,1)`,
            )
            .run(
              "30000000-0000-4000-8000-000000000020",
              harness.projectId,
              harness.ownerId,
              "generation",
              "waiting_provider",
            );
          connection
            .prepare(
              `INSERT INTO job_steps
                (id,job_id,step_key,item_key,status,max_attempts,available_at,input_json,
                 provider_submission_state,provider_operation_id,
                 provider_request_hash_sha256,provider_idempotency_key_hash_sha256,
                 provider_submission_attempt,created_at,updated_at)
               VALUES (?,?,?,?,?,3,1,'{}','accepted','provider-operation',?,?,1,1,1)`,
            )
            .run(
              "40000000-0000-4000-8000-000000000020",
              "30000000-0000-4000-8000-000000000020",
              "provider_generation",
              "",
              "waiting_provider",
              "a".repeat(64),
              "b".repeat(64),
            );
        },
      );

      expect(service.operations(harness.admin)).toMatchObject({
        waitingProviderCurrent: 1,
        waitingProviderReconciliationsSinceProcessStart: 0,
      });

      await expect(reconciliation.runOnce()).resolves.toBe(true);

      expect(service.operations(harness.admin)).toMatchObject({
        waitingProviderCurrent: 1,
        waitingProviderReconciliationsSinceProcessStart: 1,
      });
    } finally {
      await harness.database.close();
    }
  });

  it("propagates real AssetMaintenance divergence into the operations snapshot", async () => {
    const harness = await createHarness();
    const storage = new FilesystemObjectStorage(
      join(harness.directory, "objects"),
    );
    const maintenance = new AssetMaintenanceService(
      harness.database.transactions,
      storage,
    );
    const latestMaintenance = new AssetMaintenanceSnapshot();
    const service = new JobService({
      transactions: harness.database.transactions,
      clock: harness.clock,
      idGenerator: harness.idGenerator,
      applicationKey: harness.applicationKey,
      repository: harness.repository,
      assetMaintenanceSnapshot: () => latestMaintenance.current(),
    });
    const app = Fastify({ logger: false });
    const identity = {
      getSession: (token: string | null) =>
        token === "admin-session" ? harness.admin : null,
      auditStatusDenial: () => undefined,
    } as unknown as IdentityService;
    registerErrorHandler(app);
    registerJobRoutes({
      app,
      identityService: identity,
      jobService: service,
      publicOrigin: undefined,
    });
    try {
      harness.database.transactions.run(
        "immediate",
        ({ database: connection }) => {
          connection
            .prepare(
              `INSERT INTO assets
                (id,project_id,owner_user_id,original_filename,kind,storage_key,
                 byte_size,byte_checksum_sha256,metadata_json,ingestion_status,
                 lifecycle_status,created_at,updated_at)
               VALUES (?,?,?,'missing.mp4','video','assets/missing.mp4',128,?,
                       '{}','ready','active',1,1)`,
            )
            .run(
              "50000000-0000-4000-8000-000000000001",
              harness.projectId,
              harness.ownerId,
              "a".repeat(64),
            );
        },
      );

      latestMaintenance.update(await maintenance.run(harness.clock.now()));

      expect(service.operations(harness.admin)).toMatchObject({
        assetMaintenanceCurrent: {
          missingDurable: 1,
          unreferencedDurable: 0,
          quarantinedDatabaseAhead: 0,
        },
        assetStorageDivergenceCurrent: 1,
      });
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/operations",
        headers: { cookie: "__Host-oloka_session=admin-session" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        assetMaintenanceCurrent: { missingDurable: 1 },
        assetStorageDivergenceCurrent: 1,
      });
      expect(response.body).not.toContain("assets/missing.mp4");

      harness.database.transactions.run(
        "immediate",
        ({ database: connection }) =>
          connection
            .prepare("DELETE FROM assets WHERE id = ?")
            .run("50000000-0000-4000-8000-000000000001"),
      );
      latestMaintenance.update(await maintenance.run(harness.clock.now()));
      expect(service.operations(harness.admin)).toMatchObject({
        assetMaintenanceCurrent: {
          missingDurable: 0,
          unreferencedDurable: 0,
          quarantinedDatabaseAhead: 0,
        },
        assetStorageDivergenceCurrent: 0,
      });
    } finally {
      await app.close();
      await storage.close();
      await harness.database.close();
    }
  });

  it("keeps durable reconciliation evidence while process counters reset", async () => {
    const harness = await createHarness();
    const activity = new JobOperationsActivity();
    const service = operationsService(harness, activity);
    const dispatcher = new DurableJobDispatcher({
      transactions: harness.database.transactions,
      repository: harness.repository,
      handlers: new JobHandlerRegistry([]),
      clock: harness.clock,
      workerId: "reconcile-worker",
      activity,
    });
    try {
      harness.database.transactions.run("immediate", (context) => {
        context.database
          .prepare(
            `INSERT INTO jobs
              (id,project_id,owner_user_id,type,status,request_json,current_step_key,
               max_attempts,available_at,lease_owner,lease_expires_at,heartbeat_at,
               created_at,updated_at)
             VALUES (?,?,?,?,?,'{"schemaVersion":1,"assetId":"asset"}',
                     'inspect_asset',3,1,'old-worker',9,1,1,1)`,
          )
          .run(
            "30000000-0000-4000-8000-000000000030",
            harness.projectId,
            harness.ownerId,
            "asset_ingestion",
            "running",
          );
        context.database
          .prepare(
            `INSERT INTO job_steps
              (id,job_id,step_key,item_key,status,max_attempts,available_at,input_json,
               lease_owner,lease_expires_at,heartbeat_at,created_at,updated_at)
             VALUES (?,?,?,?,?,3,1,'{}','old-worker',9,1,1,1)`,
          )
          .run(
            "40000000-0000-4000-8000-000000000030",
            "30000000-0000-4000-8000-000000000030",
            "inspect_asset",
            "",
            "running",
          );
        new AuditEventRepository(harness.idGenerator).append(context, {
          actorType: "system",
          action: "job.reconcile.run",
          resourceType: "job",
          outcome: "success",
          metadata: { created: 0 },
          createdAt: 1,
        });
      });

      dispatcher.reconcileOnce();

      expect(service.operations(harness.admin)).toMatchObject({
        queuedJobsCurrent: 1,
        reconciliationRunsDurable: 1,
        requeuedExpiredWorkDurable: 1,
        reconciliationRunsSinceProcessStart: 1,
        requeuedExpiredWorkSinceProcessStart: 1,
      });

      const restarted = operationsService(harness, new JobOperationsActivity());
      expect(restarted.operations(harness.admin)).toMatchObject({
        reconciliationRunsDurable: 1,
        requeuedExpiredWorkDurable: 1,
        reconciliationRunsSinceProcessStart: 0,
        requeuedExpiredWorkSinceProcessStart: 0,
      });
    } finally {
      await harness.database.close();
    }
  });
});

async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), "oloka-job-operations-"));
  temporaryDirectories.push(directory);
  const database = await SqliteSystemDatabase.connect(
    pathToFileURL(join(directory, "database.sqlite")).href,
  );
  await database.migrate();
  const ownerId = "10000000-0000-4000-8000-000000000001";
  const adminId = "10000000-0000-4000-8000-000000000002";
  const projectId = "20000000-0000-4000-8000-000000000001";
  database.transactions.run("immediate", ({ database: connection }) => {
    connection
      .prepare(
        `INSERT INTO users
          (id,email_normalized,display_name,role,status,approved_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?), (?,?,?,?,?,?,?,?)`,
      )
      .run(
        ownerId,
        "owner@example.test",
        "Owner",
        "member",
        "active",
        1,
        1,
        1,
        adminId,
        "admin@example.test",
        "Admin",
        "admin",
        "active",
        1,
        1,
        1,
      );
    connection
      .prepare(
        `INSERT INTO projects
          (id,owner_user_id,name,favorite,status,created_at,updated_at)
         VALUES (?,?,'Operations',0,'active',1,1)`,
      )
      .run(projectId, ownerId);
  });
  const clock = { now: () => 10_000 };
  const idGenerator = new UuidIdGenerator();
  const applicationKey = new Uint8Array(32).fill(3);
  const repository = new JobRepository(new UuidIdGenerator());
  const service = new JobService({
    transactions: database.transactions,
    clock,
    idGenerator,
    applicationKey,
    repository,
  });
  return {
    directory,
    database,
    service,
    clock,
    idGenerator,
    applicationKey,
    repository,
    ownerId,
    projectId,
    admin: session(adminId, "admin"),
  };
}

function session(
  userId: string,
  role: "member" | "admin",
): AuthenticatedSession {
  return {
    sessionId: `session-${userId}`,
    user: {
      id: userId,
      email: `${role}@example.test`,
      displayName: role,
      avatarUrl: null,
      role,
      status: "active",
      version: 1,
    },
  };
}

function operationsService(
  harness: Awaited<ReturnType<typeof createHarness>>,
  activity: JobOperationsActivity,
): JobService {
  return new JobService({
    transactions: harness.database.transactions,
    clock: harness.clock,
    idGenerator: harness.idGenerator,
    applicationKey: harness.applicationKey,
    repository: harness.repository,
    activitySnapshot: () => activity.snapshot(),
  });
}
