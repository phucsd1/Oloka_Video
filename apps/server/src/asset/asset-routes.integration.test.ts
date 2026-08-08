import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";
import { registerErrorHandler } from "../http/error-handler.js";
import type {
  AuthenticatedSession,
  IdentityService,
} from "../identity/identity-service.js";
import { ProjectService } from "../project/project-service.js";
import { FilesystemObjectStorage } from "../storage/filesystem-object-storage.js";
import { registerAssetRoutes } from "./asset-routes.js";
import { AssetService } from "./asset-service.js";
import { BaselineQuotaPolicyResolver } from "../quota/quota-policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Asset HTTP routes", () => {
  it("does not expose a public Asset restore route", async () => {
    const fixture = await createFixture();
    try {
      expect(
        fixture.app.hasRoute({
          method: "POST",
          url: "/api/v1/assets/:assetId/restore",
        }),
      ).toBe(false);
    } finally {
      await fixture.app.close();
      await fixture.database.close();
    }
  });

  it("requires idempotency and expectedVersion for retry-ingestion", async () => {
    const fixture = await createFixture();
    try {
      const headers = {
        cookie: "__Host-oloka_session=test",
        origin: "https://oloka.example.test",
        "x-oloka-csrf": "csrf-test-token",
        "content-type": "application/json",
      };
      const assetId = "00000000-0000-4000-8000-000000000099";
      const missingKey = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/assets/${assetId}/retry-ingestion`,
        headers,
        payload: { expectedVersion: 1 },
      });
      expect(missingKey.statusCode).toBe(400);
      expect(missingKey.json().error.code).toBe("VALIDATION_ERROR");

      const missingVersion = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/assets/${assetId}/retry-ingestion`,
        headers: { ...headers, "idempotency-key": "retry-route-key" },
        payload: {},
      });
      expect(missingVersion.statusCode).toBe(400);
      expect(missingVersion.json().error.code).toBe("VALIDATION_ERROR");
    } finally {
      await fixture.app.close();
      await fixture.database.close();
    }
  });

  it("uploads and privately serves single byte ranges", async () => {
    const fixture = await createFixture();
    try {
      const common = {
        cookie: "__Host-oloka_session=test",
        origin: "https://oloka.example.test",
        "x-oloka-csrf": "csrf-test-token",
      };
      const initialized = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/projects/${fixture.projectId}/uploads`,
        headers: {
          ...common,
          "content-type": "application/json",
          "idempotency-key": "route-upload-create",
        },
        payload: {
          originalFilename: "private.png",
          kind: "image",
          declaredMime: "image/png",
          declaredSize: PNG.length,
          declaredChecksumSha256: checksum(PNG),
        },
      });
      expect(initialized.statusCode, initialized.body).toBe(201);
      const uploadId = initialized.json().upload.uploadId as string;
      const assetId = initialized.json().asset.id as string;

      const offset = await fixture.app.inject({
        method: "HEAD",
        url: `/api/v1/uploads/${uploadId}`,
        headers: { cookie: common.cookie },
      });
      expect(offset.statusCode).toBe(200);
      expect(offset.headers["upload-offset"]).toBe("0");
      expect(offset.body).toBe("");

      const append = await fixture.app.inject({
        method: "PATCH",
        url: `/api/v1/uploads/${uploadId}`,
        headers: {
          ...common,
          "content-type": "application/offset+octet-stream",
          "upload-offset": "0",
          "upload-chunk-sha256": checksum(PNG),
          "content-length": String(PNG.length),
        },
        payload: PNG,
      });
      expect(append.statusCode, append.body).toBe(204);
      expect(append.headers["upload-offset"]).toBe(String(PNG.length));

      const completed = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/uploads/${uploadId}/complete`,
        headers: {
          ...common,
          "content-type": "application/json",
          "idempotency-key": "route-upload-complete",
        },
        payload: {},
      });
      expect(completed.statusCode, completed.body).toBe(200);
      expect(completed.json()).toMatchObject({
        id: assetId,
        ingestionStatus: "ready",
      });

      const capabilityResponse = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/assets/${assetId}/delivery-capabilities`,
        headers: {
          ...common,
          "content-type": "application/json",
          "idempotency-key": "route-stream-capability",
        },
        payload: { operation: "stream" },
      });
      expect(capabilityResponse.statusCode, capabilityResponse.body).toBe(200);
      const capability = capabilityResponse.json().capability as string;
      const scopedStream = await fixture.app.inject({
        method: "GET",
        url: `/api/v1/assets/${assetId}/content?capability=${encodeURIComponent(capability)}&operation=stream`,
      });
      expect(scopedStream.statusCode, scopedStream.body).toBe(200);
      expect(scopedStream.headers["content-disposition"]).toMatch(/^inline;/);
      const wrongOperation = await fixture.app.inject({
        method: "GET",
        url: `/api/v1/assets/${assetId}/content?capability=${encodeURIComponent(capability)}&operation=download`,
      });
      expect(wrongOperation.statusCode).toBe(404);

      const head = await fixture.app.inject({
        method: "HEAD",
        url: `/api/v1/assets/${assetId}/content`,
        headers: { cookie: common.cookie },
      });
      expect(head.statusCode).toBe(200);
      expect(head.headers["content-length"]).toBe(String(PNG.length));
      expect(head.headers["accept-ranges"]).toBe("bytes");
      expect(head.body).toBe("");

      const range = await fixture.app.inject({
        method: "GET",
        url: `/api/v1/assets/${assetId}/content`,
        headers: { cookie: common.cookie, range: "bytes=0-7" },
      });
      expect(range.statusCode, range.body).toBe(206);
      expect(range.headers["content-range"]).toBe(`bytes 0-7/${PNG.length}`);
      expect(range.rawPayload).toEqual(PNG.subarray(0, 8));

      const invalidRange = await fixture.app.inject({
        method: "GET",
        url: `/api/v1/assets/${assetId}/content`,
        headers: { cookie: common.cookie, range: "bytes=0-1,4-5" },
      });
      expect(invalidRange.statusCode).toBe(416);
      expect(invalidRange.headers["content-range"]).toBe(
        `bytes */${PNG.length}`,
      );
      expect(invalidRange.json().error.code).toBe("RANGE_NOT_SATISFIABLE");
    } finally {
      await fixture.app.close();
      await fixture.database.close();
    }
  });
});

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlZJmAAAAAASUVORK5CYII=",
  "base64",
);

function checksum(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "oloka-asset-routes-"));
  temporaryDirectories.push(directory);
  const database = await SqliteSystemDatabase.connect(
    pathToFileURL(join(directory, "database.sqlite")).href,
    { appBuildSha: "phase3d-route-test", appKey: Buffer.alloc(32, 6) },
  );
  await database.migrate();
  const actor: AuthenticatedSession = {
    sessionId: "00000000-0000-4000-8000-000000000009",
    user: {
      id: "00000000-0000-4000-8000-000000000001",
      email: "owner@example.test",
      displayName: "Owner",
      avatarUrl: null,
      role: "member",
      status: "active",
      version: 1,
    },
  };
  database.transactions.run("immediate", ({ database }) => {
    database
      .prepare(
        `INSERT INTO users (id, email_normalized, display_name, role, status, approved_at, created_at, updated_at, version)
         VALUES (?, ?, ?, 'member', 'active', 1, 1, 1, 1)`,
      )
      .run(actor.user.id, actor.user.email, actor.user.displayName);
  });
  let id = 100;
  const idGenerator = {
    generate: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  };
  const clock = { now: () => 1_700_000_000_000 + id };
  const projectId = new ProjectService({
    transactions: database.transactions,
    applicationKey: Buffer.alloc(32, 7),
    clock,
    idGenerator,
  }).create(actor, { name: "Private media" }, "asset-route-project").project.id;
  const storage = new FilesystemObjectStorage(join(directory, "storage"));
  const service = new AssetService({
    transactions: database.transactions,
    storage,
    applicationKey: Buffer.alloc(32, 7),
    clock,
    idGenerator,
    quotaPolicyResolver: new BaselineQuotaPolicyResolver(),
  });
  const identityService = {
    getSession: () => actor,
    auditStatusDenial: () => undefined,
    verifyCsrfToken: (_sessionId: string, token: string) =>
      token === "csrf-test-token",
    auditCsrfFailure: () => undefined,
  } as unknown as IdentityService;
  const app = Fastify({ logger: false });
  registerAssetRoutes({
    app,
    identityService,
    assetService: service,
    storage,
    publicOrigin: "https://oloka.example.test",
  });
  registerErrorHandler(app);
  app.addHook("onClose", () => storage.close());
  return { app, database, projectId };
}
