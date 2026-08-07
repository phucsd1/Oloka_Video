import fastifyStatic from "@fastify/static";
import {
  healthResponseSchema,
  readyResponseSchema,
  versionResponseSchema,
} from "@oloka/contracts";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type { AppEnvironment } from "./config/environment.js";
import { createDatabase } from "./database/create-database.js";
import { FilesystemObjectStorage } from "./storage/filesystem-object-storage.js";
import { HealthService } from "./system/health-service.js";
import { ReadinessService } from "./system/readiness-service.js";
import { VersionService } from "./system/version-service.js";
import { RuntimeWitnessService } from "./system/runtime-witness-service.js";
import { SystemClock } from "./kernel/clock.js";
import { OperationalMetrics } from "./observability/operational-metrics.js";
import { registerIdentityRoutes } from "./identity/identity-routes.js";
import type { OidcProviderClient } from "./identity/oidc-provider-client.js";
import { IdentityMaintenanceService } from "./identity/identity-maintenance-service.js";

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

  app.setErrorHandler((error, _request, reply) => {
    const errorDetails: { statusCode?: unknown; code?: unknown } =
      typeof error === "object" && error !== null ? error : {};
    const validationFailure =
      errorDetails.statusCode === 400 ||
      errorDetails.code === "FST_ERR_VALIDATION";
    return reply.code(validationFailure ? 400 : 500).send({
      error: {
        code: validationFailure ? "VALIDATION_FAILED" : "INTERNAL_ERROR",
        message: validationFailure
          ? "The request did not match the required contract"
          : "The request could not be completed",
        correlationId: randomUUID(),
        retryable: !validationFailure,
      },
    });
  });

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

  registerIdentityRoutes({
    app,
    database,
    environment,
    ...(options.oidcClient === undefined
      ? {}
      : { oidcClient: options.oidcClient }),
  });
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
        return reply.code(404).send({
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "The requested API resource was not found",
            correlationId: randomUUID(),
            retryable: false,
          },
        });
      return reply.sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler(async (_request, reply) =>
      reply.code(404).send({
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "The requested API resource was not found",
          correlationId: randomUUID(),
          retryable: false,
        },
      }),
    );
  }

  app.addHook("onClose", async () => {
    clearInterval(identityMaintenanceInterval);
    await Promise.all([storage.close(), database.close()]);
  });

  metrics.observe("startup", performance.now() - startupStartedAt);

  return app;
}
