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
  const assetService =
    environment.appKey === undefined
      ? undefined
      : new AssetService({
          transactions: database.transactions,
          storage,
          applicationKey: environment.appKey,
          clock: new SystemClock(),
          idGenerator: new UuidIdGenerator(),
        });
  registerAssetRoutes({
    app,
    identityService,
    assetService,
    storage,
    publicOrigin: environment.identity?.publicOrigin,
  });
  if (assetService !== undefined) await assetService.processPendingIngestion();
  const assetIngestionInterval = setInterval(() => {
    if (assetService !== undefined) {
      void assetService.processPendingIngestion().catch((error: unknown) => {
        app.log.error(
          {
            event: "asset.ingestion.failed",
            errorType: error instanceof Error ? error.name : "UnknownError",
          },
          "Asset ingestion handoff failed",
        );
      });
    }
  }, 1_000);
  assetIngestionInterval.unref();
  const assetMaintenance = new AssetMaintenanceService(
    database.transactions,
    storage,
  );
  await assetMaintenance.run(Date.now());
  const assetMaintenanceInterval = setInterval(() => {
    void assetMaintenance.run(Date.now()).then(
      (result) => {
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
    clearInterval(assetIngestionInterval);
    await Promise.all([storage.close(), database.close()]);
  });

  metrics.observe("startup", performance.now() - startupStartedAt);

  return app;
}
