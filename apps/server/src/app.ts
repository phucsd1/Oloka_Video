import fastifyStatic from "@fastify/static";
import {
  healthResponseSchema,
  readyResponseSchema,
  versionResponseSchema,
} from "@oloka/contracts";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { AppEnvironment } from "./config/environment.js";
import { createDatabase } from "./database/create-database.js";
import { FilesystemObjectStorage } from "./storage/filesystem-object-storage.js";
import { HealthService } from "./system/health-service.js";
import { ReadinessService } from "./system/readiness-service.js";
import { VersionService } from "./system/version-service.js";
import { RuntimeWitnessService } from "./system/runtime-witness-service.js";
import { SystemClock } from "./kernel/clock.js";
import { UuidIdGenerator } from "./kernel/id-generator.js";
import { OperationalMetrics } from "./observability/operational-metrics.js";
import { registerIdentityRoutes } from "./identity/identity-routes.js";
import type { OidcProviderClient } from "./identity/oidc-provider-client.js";
import { IdentityMaintenanceService } from "./identity/identity-maintenance-service.js";
import { registerErrorHandler } from "./http/error-handler.js";
import { ApplicationError } from "./http/application-error.js";
import { ProjectService } from "./project/project-service.js";
import { registerProjectRoutes } from "./project/project-routes.js";
import { AssetService } from "./asset/asset-service.js";
import { registerAssetRoutes } from "./asset/asset-routes.js";
import { AssetMaintenanceService } from "./asset/asset-maintenance-service.js";
import { AssetMaintenanceSnapshot } from "./asset/asset-maintenance-snapshot.js";
import {
  BaselineQuotaPolicyResolver,
  DatabaseQuotaPolicyResolver,
} from "./quota/quota-policy.js";
import { QuotaPolicyService } from "./quota/quota-policy-service.js";
import { registerQuotaRoutes } from "./quota/quota-routes.js";
import { JobAdmissionService } from "./job/job-admission-service.js";
import { JobRepository } from "./job/job-repository.js";
import { JobService } from "./job/job-service.js";
import { JobHandlerRegistry } from "./job/job-handler-registry.js";
import { AssetIngestionJobHandler } from "./job/handlers/asset-ingestion-job-handler.js";
import { DurableJobDispatcher } from "./job/durable-job-dispatcher.js";
import { JobOperationsActivity } from "./job/job-operations-activity.js";
import { registerJobRoutes } from "./job/job-routes.js";
import {
  JobRetryPolicyRegistry,
  JobRetryService,
} from "./job/job-retry-service.js";
import { OutboxRepository } from "./database/repositories/outbox-repository.js";
import { OutboxConsumer } from "./outbox/consumer.js";
import { OutboxRuntime } from "./outbox/runtime.js";
import { createPhase3EOutboxHandlerRegistry } from "./outbox/phase3e-handlers.js";
import { CompositionService } from "./composition/composition-service.js";
import { registerCompositionRoutes } from "./composition/composition-routes.js";
import { PreviewArtifactMaintenanceService } from "./composition/preview-artifact-maintenance-service.js";

export interface BuildApplicationOptions {
  environment: AppEnvironment;
  serveFrontend?: boolean;
  metrics?: OperationalMetrics;
  oidcClient?: OidcProviderClient;
}

export async function buildApplication(
  options: BuildApplicationOptions,
): Promise<FastifyInstance> {
  const { environment } = options;
  const startupStartedAt = performance.now();
  const metrics = options.metrics ?? new OperationalMetrics();
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger:
      environment.logLevel === "silent"
        ? false
        : { level: environment.logLevel },
  });
  const database = await createDatabase(environment, metrics);
  try {
    await database.migrate();
    const runtimeWitnessUpdate = new RuntimeWitnessService(
      database.transactions,
      new SystemClock(),
    ).record(environment.gitCommitSha);
    app.log.info(
      {
        event: "deployment.runtime.updated",
        startupCount: runtimeWitnessUpdate.witness.startupCount,
        metadataVersion: runtimeWitnessUpdate.metadataVersion,
        buildSha: runtimeWitnessUpdate.witness.lastBuildSha,
      },
      "database runtime witness recorded",
    );
  } catch (error) {
    await database.close();
    throw error;
  }
  const storage = new FilesystemObjectStorage(environment.objectStorageRoot);
  const initialStorageState = await storage.checkReadiness();
  if (initialStorageState.status !== "ready") {
    await database.close();
    throw new Error(
      `Persistent storage startup check failed: ${initialStorageState.message ?? "unknown error"}`,
    );
  }
  const assetMaintenance = new AssetMaintenanceService(
    database.transactions,
    storage,
  );
  const assetMaintenanceSnapshot = new AssetMaintenanceSnapshot();
  assetMaintenanceSnapshot.update(await assetMaintenance.run(Date.now()));

  registerErrorHandler(app);

  app.get("/api/health", () =>
    healthResponseSchema.parse(new HealthService().getHealth()),
  );
  const readinessService = new ReadinessService(database, storage);
  app.get("/api/ready", async (_request, reply) => {
    const result = readyResponseSchema.parse(
      await readinessService.getReadiness(),
    );
    return reply.code(result.status === "ready" ? 200 : 503).send(result);
  });
  app.get("/api/version", () =>
    versionResponseSchema.parse(new VersionService(environment).getVersion()),
  );

  const identityService = registerIdentityRoutes({
    app,
    database,
    environment,
    ...(options.oidcClient === undefined
      ? {}
      : { oidcClient: options.oidcClient }),
  });
  const projectService =
    environment.appKey === undefined
      ? undefined
      : new ProjectService({
          transactions: database.transactions,
          applicationKey: environment.appKey,
          clock: new SystemClock(),
          idGenerator: new UuidIdGenerator(),
        });
  registerProjectRoutes({
    app,
    identityService,
    projectService,
    publicOrigin: environment.identity?.publicOrigin,
  });
  const clock = new SystemClock();
  const idGenerator = new UuidIdGenerator();
  const quotaPolicyResolver = new DatabaseQuotaPolicyResolver(
    database.transactions,
    new BaselineQuotaPolicyResolver(),
  );
  const jobAdmissionService =
    environment.appKey === undefined
      ? undefined
      : new JobAdmissionService({
          transactions: database.transactions,
          clock,
          idGenerator,
          quotaPolicyResolver,
        });
  const assetService =
    environment.appKey === undefined
      ? undefined
      : new AssetService({
          transactions: database.transactions,
          storage,
          applicationKey: environment.appKey,
          clock,
          idGenerator,
          quotaPolicyResolver,
          ...(jobAdmissionService === undefined ? {} : { jobAdmissionService }),
        });
  registerAssetRoutes({
    app,
    identityService,
    assetService,
    storage,
    publicOrigin: environment.identity?.publicOrigin,
  });
  const compositionService =
    environment.appKey === undefined
      ? undefined
      : new CompositionService({
          transactions: database.transactions,
          storage,
          applicationKey: environment.appKey,
          clock,
          idGenerator,
          quotaPolicyResolver,
        });
  registerCompositionRoutes({
    app,
    identityService,
    compositionService,
    storage,
    publicOrigin: environment.identity?.publicOrigin,
  });
  const previewMaintenance = new PreviewArtifactMaintenanceService({
    transactions: database.transactions,
    storage,
    idGenerator,
  });
  await previewMaintenance.run(Date.now());
  const jobRepository = new JobRepository(idGenerator);
  const jobOperationsActivity = new JobOperationsActivity();
  const jobDispatcher =
    jobAdmissionService === undefined
      ? undefined
      : new DurableJobDispatcher({
          transactions: database.transactions,
          repository: jobRepository,
          handlers: new JobHandlerRegistry([
            new AssetIngestionJobHandler({
              transactions: database.transactions,
              repository: jobRepository,
              clock,
              inspect: async (storageKey) => {
                const stat = await storage.head(storageKey);
                return { byteSize: stat.size };
              },
            }),
          ]),
          clock,
          workerId: idGenerator.generate(),
          activity: jobOperationsActivity,
        });
  const outboxRuntime =
    jobDispatcher === undefined
      ? undefined
      : new OutboxRuntime(
          new OutboxConsumer(
            database.transactions,
            new OutboxRepository(idGenerator),
            createPhase3EOutboxHandlerRegistry({ dispatcher: jobDispatcher }),
            clock,
            {
              leaseOwner: idGenerator.generate(),
              batchSize: 25,
              concurrency: 4,
              leaseDurationMs: 30_000,
              maxAttempts: 5,
              retryDelayMs: (attempt) =>
                Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1)),
            },
          ),
          {
            pollIntervalMs: 250,
            onError: (error) => {
              app.log.error(
                {
                  event: "outbox.runtime.failed",
                  errorType:
                    error instanceof Error ? error.name : "UnknownError",
                },
                "Outbox runtime pass failed",
              );
            },
          },
        );
  if (jobAdmissionService !== undefined) {
    jobAdmissionService.reconcileProcessingAssets();
    jobDispatcher?.start();
    await outboxRuntime?.start();
    const jobService = new JobService({
      transactions: database.transactions,
      clock,
      idGenerator,
      applicationKey: environment.appKey as Uint8Array,
      repository: jobRepository,
      retryService: new JobRetryService({
        transactions: database.transactions,
        clock,
        idGenerator,
        quotaPolicyResolver,
        policies: new JobRetryPolicyRegistry([]),
      }),
      ...(jobDispatcher === undefined
        ? {}
        : { dispatcherSnapshot: () => jobDispatcher.snapshot() }),
      activitySnapshot: () => jobOperationsActivity.snapshot(),
      assetMaintenanceSnapshot: () => assetMaintenanceSnapshot.current(),
    });
    registerJobRoutes({
      app,
      identityService,
      jobService,
      publicOrigin: environment.identity?.publicOrigin,
    });
    const quotaPolicyService = new QuotaPolicyService(
      database.transactions,
      clock,
      idGenerator,
    );
    registerQuotaRoutes({
      app,
      identityService,
      quotaPolicyService,
      publicOrigin: environment.identity?.publicOrigin,
    });
  }
  const assetMaintenanceInterval = setInterval(() => {
    void assetMaintenance.run(Date.now()).then(
      (result) => {
        assetMaintenanceSnapshot.update(result);
        if (
          result.quarantinedDatabaseAhead > 0 ||
          result.missingDurable > 0 ||
          result.unreferencedDurable > 0
        ) {
          app.log.error(
            { event: "asset.reconciliation.incident", ...result },
            "Asset reconciliation found storage divergence",
          );
        }
      },
      (error: unknown) => {
        app.log.error(
          {
            event: "asset.reconciliation.failed",
            errorType: error instanceof Error ? error.name : "UnknownError",
          },
          "Asset reconciliation failed",
        );
      },
    );
  }, 60_000);
  assetMaintenanceInterval.unref();
  const identityMaintenance = new IdentityMaintenanceService(
    database.transactions,
  );
  identityMaintenance.run(Date.now());
  const identityMaintenanceInterval = setInterval(
    () => {
      try {
        identityMaintenance.run(Date.now());
      } catch (error) {
        app.log.error(
          {
            event: "identity.maintenance.failed",
            errorType: error instanceof Error ? error.name : "UnknownError",
          },
          "identity retention maintenance failed",
        );
      }
    },
    60 * 60 * 1000,
  );
  identityMaintenanceInterval.unref();
  const previewMaintenanceInterval = setInterval(() => {
    void previewMaintenance.run(Date.now()).catch((error: unknown) => {
      app.log.error(
        {
          event: "preview.maintenance.failed",
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "preview retention maintenance failed",
      );
    });
  }, 60_000);
  previewMaintenanceInterval.unref();

  if (options.serveFrontend !== false) {
    const webRoot = resolve(process.cwd(), "apps/web/dist");
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/"))
        throw new ApplicationError("RESOURCE_NOT_FOUND", "api_route_not_found");
      return reply.sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler(() => {
      throw new ApplicationError("RESOURCE_NOT_FOUND", "api_route_not_found");
    });
  }

  app.addHook("onClose", async () => {
    clearInterval(identityMaintenanceInterval);
    clearInterval(assetMaintenanceInterval);
    clearInterval(previewMaintenanceInterval);
    await outboxRuntime?.stop();
    await jobDispatcher?.stop();
    await Promise.all([storage.close(), database.close()]);
  });

  metrics.observe("startup", performance.now() - startupStartedAt);

  return app;
}
