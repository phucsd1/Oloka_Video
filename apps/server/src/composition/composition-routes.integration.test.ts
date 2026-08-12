import type { CompositionDocumentV1 } from "@oloka/contracts";
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
import { BaselineQuotaPolicyResolver } from "../quota/quota-policy.js";
import { FilesystemObjectStorage } from "../storage/filesystem-object-storage.js";
import { registerCompositionRoutes } from "./composition-routes.js";
import { CompositionService } from "./composition-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Composition HTTP routes", () => {
  it("serves the complete owner workflow with strict mutation and content contracts", async () => {
    const fixture = await createFixture();
    const mutationHeaders = headers("owner", true);
    try {
      const invalidKey = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/projects/${fixture.projectId}/compositions`,
        headers: { ...mutationHeaders, "idempotency-key": "bad key" },
        payload: { document: documentFixture(), expectedProjectVersion: 1 },
      });
      expect(invalidKey.statusCode).toBe(400);
      expect(invalidKey.json().error.code).toBe("VALIDATION_ERROR");

      const created = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/projects/${fixture.projectId}/compositions`,
        headers: {
          ...mutationHeaders,
          "idempotency-key": "composition-route-create",
        },
        payload: { document: documentFixture(), expectedProjectVersion: 1 },
      });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.headers["idempotency-replayed"]).toBe("false");
      const compositionId = created.json().id as string;

      const replay = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/projects/${fixture.projectId}/compositions`,
        headers: {
          ...mutationHeaders,
          "idempotency-key": "composition-route-create",
        },
        payload: { document: documentFixture(), expectedProjectVersion: 1 },
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.headers["idempotency-replayed"]).toBe("true");
      expect(replay.json().id).toBe(compositionId);

      const list = await fixture.app.inject({
        method: "GET",
        url: `/api/v1/projects/${fixture.projectId}/compositions`,
        headers: headers("owner"),
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().compositions).toHaveLength(1);
      const get = await fixture.app.inject({
        method: "GET",
        url: `/api/v1/compositions/${compositionId}`,
        headers: headers("owner"),
      });
      expect(get.statusCode).toBe(200);
      expect(get.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
      const current = await fixture.app.inject({
        method: "GET",
        url: `/api/v1/projects/${fixture.projectId}/compositions/current`,
        headers: headers("owner"),
      });
      expect(current.json().id).toBe(compositionId);

      const csrfDenied = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/compositions/${compositionId}/validate`,
        headers: headers("owner"),
        payload: {},
      });
      expect(csrfDenied.statusCode).toBe(403);
      const validated = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/compositions/${compositionId}/validate`,
        headers: mutationHeaders,
        payload: {},
      });
      expect(validated.statusCode).toBe(400);
      expect(validated.json().error.code).toBe("VALIDATION_ERROR");
      const validationHeaders = {
        ...mutationHeaders,
        "idempotency-key": "composition-route-validate",
      };
      const firstValidation = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/compositions/${compositionId}/validate`,
        headers: validationHeaders,
        payload: {},
      });
      expect(firstValidation.statusCode, firstValidation.body).toBe(200);
      expect(firstValidation.headers["idempotency-replayed"]).toBe("false");
      expect(firstValidation.json()).toMatchObject({
        schemaVersion: 1,
        valid: true,
      });
      const validationReplay = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/compositions/${compositionId}/validate`,
        headers: validationHeaders,
        payload: {},
      });
      expect(validationReplay.statusCode, validationReplay.body).toBe(200);
      expect(validationReplay.headers["idempotency-replayed"]).toBe("true");
      expect(
        fixture.database.transactions.run("read", ({ database }) =>
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'composition.validate'",
            )
            .get(),
        ),
      ).toEqual({ count: 1 });

      const derived = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/compositions/${compositionId}/derive`,
        headers: {
          ...mutationHeaders,
          "idempotency-key": "composition-route-derive",
        },
        payload: {
          expectedProjectVersion: 2,
          edits: [
            { type: "sceneText", sceneId: SCENE_ID, text: "Phiên bản thứ hai" },
          ],
        },
      });
      expect(derived.statusCode, derived.body).toBe(201);
      expect(derived.json()).toMatchObject({
        versionNumber: 2,
        parentVersionId: compositionId,
      });
      const derivedId = derived.json().id as string;

      const preview = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/compositions/${derivedId}/preview`,
        headers: {
          ...mutationHeaders,
          "idempotency-key": "composition-route-preview",
        },
        payload: {},
      });
      expect(preview.statusCode, preview.body).toBe(201);
      const previewId = preview.json().id as string;
      const descriptor = await fixture.app.inject({
        method: "GET",
        url: `/api/v1/previews/${previewId}`,
        headers: headers("owner"),
      });
      expect(descriptor.statusCode).toBe(200);
      expect(descriptor.json().contentUrl).toBe(
        `/api/v1/previews/${previewId}/content`,
      );

      const head = await fixture.app.inject({
        method: "HEAD",
        url: `/api/v1/previews/${previewId}/content`,
        headers: headers("owner"),
      });
      expect(head.statusCode).toBe(200);
      expect(Number(head.headers["content-length"])).toBeGreaterThan(2_000_000);
      expect(head.headers["x-content-type-options"]).toBe("nosniff");
      expect(head.headers["content-security-policy"]).toBe(
        "sandbox allow-scripts",
      );
      const range = await fixture.app.inject({
        method: "GET",
        url: `/api/v1/previews/${previewId}/content`,
        headers: { ...headers("owner"), range: "bytes=0-127" },
      });
      expect(range.statusCode).toBe(206);
      expect(range.rawPayload.byteLength).toBe(128);
      expect(range.headers["content-range"]).toMatch(/^bytes 0-127\//);
      expect(range.headers["content-security-policy"]).toBe(
        "sandbox allow-scripts",
      );
      const conditional = await fixture.app.inject({
        method: "GET",
        url: `/api/v1/previews/${previewId}/content`,
        headers: {
          ...headers("owner"),
          "if-none-match": descriptor.headers.etag as string,
        },
      });
      expect(conditional.statusCode).toBe(304);
      expect(conditional.headers["content-security-policy"]).toBe(
        "sandbox allow-scripts",
      );
      const invalidRange = await fixture.app.inject({
        method: "GET",
        url: `/api/v1/previews/${previewId}/content`,
        headers: { ...headers("owner"), range: "bytes=0-1,4-5" },
      });
      expect(invalidRange.statusCode).toBe(416);
      expect(invalidRange.headers["content-range"]).toMatch(/^bytes \*\//);
    } finally {
      await fixture.app.close();
      await fixture.database.close();
    }
  });

  it("conceals owner resources and rejects inactive accounts", async () => {
    const fixture = await createFixture();
    try {
      const created = fixture.service.create(
        fixture.sessions.owner,
        fixture.projectId,
        { document: documentFixture(), expectedProjectVersion: 1 },
        "authorization-create",
      );
      const preview = await fixture.service.requestPreview(
        fixture.sessions.owner,
        created.composition.id,
        "authorization-preview",
      );
      for (const token of ["other", "admin"] as const) {
        const composition = await fixture.app.inject({
          method: "GET",
          url: `/api/v1/compositions/${created.composition.id}`,
          headers: headers(token),
        });
        const artifact = await fixture.app.inject({
          method: "GET",
          url: `/api/v1/previews/${preview.preview.id}`,
          headers: headers(token),
        });
        expect(composition.statusCode).toBe(404);
        expect(artifact.statusCode).toBe(404);
      }
      for (const token of ["pending", "disabled", "rejected"] as const) {
        const response = await fixture.app.inject({
          method: "GET",
          url: `/api/v1/projects/${fixture.projectId}/compositions`,
          headers: headers(token),
        });
        expect(response.statusCode).toBe(403);
      }
    } finally {
      await fixture.app.close();
      await fixture.database.close();
    }
  });
});

function headers(token: string, mutation = false) {
  return {
    cookie: `__Host-oloka_session=${token}`,
    ...(mutation
      ? {
          origin: "https://oloka.example.test",
          "x-oloka-csrf": "csrf-test-token",
          "content-type": "application/json",
        }
      : {}),
  };
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "oloka-composition-routes-"));
  directories.push(directory);
  const database = await SqliteSystemDatabase.connect(
    pathToFileURL(join(directory, "database.sqlite")).href,
    { appKey: Buffer.alloc(32, 6) },
  );
  await database.migrate();
  const sessions = {
    owner: session("00000000-0000-4000-8000-000000000001", "member", "active"),
    other: session("00000000-0000-4000-8000-000000000003", "member", "active"),
    admin: session("00000000-0000-4000-8000-000000000004", "admin", "active"),
    pending: session(
      "00000000-0000-4000-8000-000000000005",
      "member",
      "pending",
    ),
    disabled: session(
      "00000000-0000-4000-8000-000000000006",
      "member",
      "disabled",
    ),
    rejected: session(
      "00000000-0000-4000-8000-000000000007",
      "member",
      "rejected",
    ),
  } as const;
  const projectId = "00000000-0000-4000-8000-000000000002";
  database.transactions.run("immediate", ({ database: connection }) => {
    for (const actor of Object.values(sessions))
      connection
        .prepare(
          `INSERT INTO users (id,email_normalized,display_name,role,status,approved_at,disabled_at,rejected_at,created_at,updated_at,version) VALUES (?,?,?,?,?,?,?,?,1,1,1)`,
        )
        .run(
          actor.user.id,
          actor.user.email,
          actor.user.displayName,
          actor.user.role,
          actor.user.status,
          actor.user.status === "active" || actor.user.status === "disabled"
            ? 1
            : null,
          actor.user.status === "disabled" ? 1 : null,
          actor.user.status === "rejected" ? 1 : null,
        );
    connection
      .prepare(
        `INSERT INTO projects (id,owner_user_id,name,description,favorite,status,created_at,updated_at,version) VALUES (?,?,?,NULL,0,'active',1,1,1)`,
      )
      .run(projectId, sessions.owner.user.id, "Composition routes");
  });
  let id = 100;
  const storage = new FilesystemObjectStorage(join(directory, "objects"));
  const service = new CompositionService({
    transactions: database.transactions,
    storage,
    applicationKey: Buffer.alloc(32, 8),
    clock: { now: () => 1_700_000_000_000 + id },
    idGenerator: {
      generate: () =>
        `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    },
    quotaPolicyResolver: new BaselineQuotaPolicyResolver(),
  });
  const identityService = {
    getSession: (token: string | null) =>
      token === null
        ? null
        : (sessions[token as keyof typeof sessions] ?? null),
    auditStatusDenial: () => undefined,
    verifyCsrfToken: (_sessionId: string, token: string) =>
      token === "csrf-test-token",
    auditCsrfFailure: () => undefined,
  } as unknown as IdentityService;
  const app = Fastify({ logger: false });
  registerCompositionRoutes({
    app,
    identityService,
    compositionService: service,
    storage,
    publicOrigin: "https://oloka.example.test",
  });
  registerErrorHandler(app);
  app.addHook("onClose", () => storage.close());
  return { app, database, projectId, service, sessions };
}

function session(
  id: string,
  role: "member" | "admin",
  status: "pending" | "active" | "disabled" | "rejected",
): AuthenticatedSession {
  return {
    sessionId: id.replace(/.$/, "9"),
    user: {
      id,
      email: `${id.slice(-1)}@example.test`,
      displayName: id,
      avatarUrl: null,
      role,
      status,
      version: 1,
    },
  };
}

const SCENE_ID = "20000000-0000-4000-8000-000000000001";
function documentFixture(): CompositionDocumentV1 {
  return {
    schemaVersion: 1,
    compositionId: "10000000-0000-4000-8000-000000000001",
    name: "Bản dựng tiếng Việt",
    aspectRatio: "16:9",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 4_000,
    background: "#102030",
    scenes: [
      {
        id: SCENE_ID,
        order: 0,
        startMs: 0,
        durationMs: 4_000,
        text: "Xin chào Việt Nam",
        narration: null,
        assetReferences: [],
        style: {
          layout: "center",
          foreground: "#ffffff",
          accent: "#ffd23f",
          paddingPercent: 8,
          gapPercent: 4,
        },
        tracks: [],
      },
    ],
    voiceConfig: null,
    captionConfig: {
      enabled: true,
      preset: "Clean",
      fontToken: "oloka-sans-v1",
      safeMarginPercent: 8,
      maxLines: 2,
    },
    bgmConfig: null,
    manifests: {
      dependency: { schemaVersion: 1, hashSha256: "a".repeat(64) },
      asset: { schemaVersion: 1, hashSha256: "b".repeat(64) },
      font: { schemaVersion: 1, hashSha256: "c".repeat(64) },
      caption: { schemaVersion: 1, hashSha256: "d".repeat(64) },
    },
    runtimeVersions: {
      materializer: "client",
      renderer: "client",
      renderProtocol: 1,
      hyperframes: "0.7.104",
      hyperframesRuntimeSha256: "e".repeat(64),
      templateRegistry: "client",
    },
    metadata: { locale: "vi-VN", title: "Bản dựng", safeAreaMode: "action" },
  };
}
