import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { JobEvent } from "@oloka/contracts";
import type {
  AuthenticatedSession,
  IdentityService,
} from "../identity/identity-service.js";
import { registerErrorHandler } from "../http/error-handler.js";
import { ApplicationError } from "../http/application-error.js";
import { registerJobRoutes, writeJobSseEvent } from "./job-routes.js";

const applications: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

describe("Job events SSE HTTP", () => {
  it("replays from Last-Event-ID, tails live events, and never mutates on disconnect", async () => {
    const events: JobEvent[] = [event(1), event(2)];
    let calls = 0;
    const owner = session("owner", "active");
    const other = session("other", "active");
    const sessions = new Map([
      ["owner-session", owner],
      ["other-session", other],
    ]);
    const identity = {
      getSession: (cookie: string | null) => sessions.get(cookie ?? "") ?? null,
      auditStatusDenial: () => undefined,
    } as unknown as IdentityService;
    const jobService = {
      resolveEventSequence: (
        actor: AuthenticatedSession,
        _jobId: string,
        id: string,
      ) => {
        if (actor.user.id !== owner.user.id)
          throw new ApplicationError("RESOURCE_NOT_FOUND", "job_not_found");
        const found = events.find((candidate) => candidate.id === id);
        if (found === undefined)
          throw new ApplicationError(
            "RESOURCE_STATE_CONFLICT",
            "job_event_replay_window",
          );
        return found.sequence;
      },
      listEventsAfter: (
        actor: AuthenticatedSession,
        _jobId: string,
        sequence: number,
      ) => {
        calls += 1;
        if (actor.user.id !== owner.user.id)
          throw new ApplicationError("RESOURCE_NOT_FOUND", "job_not_found");
        return events.filter((candidate) => candidate.sequence > sequence);
      },
    };
    const app = Fastify({ logger: false });
    applications.push(app);
    registerErrorHandler(app);
    registerJobRoutes({
      app,
      identityService: identity,
      jobService: jobService as never,
      publicOrigin: undefined,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string")
      throw new Error("server did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    const controller = new AbortController();
    const first = await fetch(
      `${base}/api/v1/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/events`,
      {
        headers: { cookie: "__Host-oloka_session=owner-session" },
        signal: controller.signal,
      },
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/event-stream");
    const firstReader = first.body!.getReader();
    await readUntil(firstReader, "id: event-2");
    await firstReader.cancel();
    controller.abort();
    const event2 = events[1]!;
    events.push(event(3), event(4));
    const reconnectController = new AbortController();
    const reconnect = await fetch(
      `${base}/api/v1/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/events`,
      {
        headers: {
          cookie: "__Host-oloka_session=owner-session",
          "last-event-id": event2.id,
        },
        signal: reconnectController.signal,
      },
    );
    const reconnectReader = reconnect.body!.getReader();
    const replay = await readUntil(reconnectReader, "id: event-4");
    expect(replay).toContain("id: event-3");
    expect(replay).toContain("id: event-4");
    events.push(event(5));
    const live = await readUntil(reconnectReader, "id: event-5");
    expect(live).toContain("id: event-5");
    await reconnectReader.cancel();
    reconnectController.abort();
    expect(calls).toBeGreaterThan(2);
  });

  it("conceals cross-owner and status-gated access before stream hijack", async () => {
    const owner = session("owner", "active");
    const sessions = new Map<string, AuthenticatedSession>([
      ["owner-session", owner],
    ]);
    const identity = {
      getSession: (cookie: string | null) => sessions.get(cookie ?? "") ?? null,
      auditStatusDenial: () => undefined,
    } as unknown as IdentityService;
    const jobService = {
      resolveEventSequence: () => {
        throw new ApplicationError(
          "RESOURCE_STATE_CONFLICT",
          "job_event_replay_window",
        );
      },
      listEventsAfter: (actor: AuthenticatedSession) => {
        if (actor.user.id !== owner.user.id)
          throw new ApplicationError("RESOURCE_NOT_FOUND", "job_not_found");
        return [];
      },
    };
    const app = Fastify({ logger: false });
    applications.push(app);
    registerErrorHandler(app);
    registerJobRoutes({
      app,
      identityService: identity,
      jobService: jobService as never,
      publicOrigin: undefined,
    });
    await app.ready();
    const other = session("other", "active");
    const disabled = session("owner", "disabled");
    sessions.set("other-session", other);
    sessions.set("disabled-session", disabled);
    const otherResponse = await app.inject({
      method: "GET",
      url: "/api/v1/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/events",
      headers: { cookie: "__Host-oloka_session=other-session" },
    });
    expect(otherResponse.statusCode).toBe(404);
    const disabledResponse = await app.inject({
      method: "GET",
      url: "/api/v1/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/events",
      headers: { cookie: "__Host-oloka_session=disabled-session" },
    });
    expect(disabledResponse.statusCode).toBe(403);
    const unknownCursor = await app.inject({
      method: "GET",
      url: "/api/v1/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/events",
      headers: {
        cookie: "__Host-oloka_session=owner-session",
        "last-event-id": "missing-event",
      },
    });
    expect(unknownCursor.statusCode).toBe(409);
  });

  it("closes deterministically on raw.write backpressure without retaining an event buffer", () => {
    let destroyed = 0;
    let writes = 0;
    const accepted = writeJobSseEvent(
      {
        write: () => {
          writes += 1;
          return false;
        },
        destroy: () => {
          destroyed += 1;
        },
      },
      event(1),
    );
    expect(accepted).toBe(false);
    expect(writes).toBe(1);
    expect(destroyed).toBe(1);
  });
});

function session(
  id: string,
  status: AuthenticatedSession["user"]["status"],
): AuthenticatedSession {
  return {
    sessionId: `${id}-session-id`,
    user: {
      id,
      email: `${id}@example.test`,
      displayName: id,
      avatarUrl: null,
      role: "member",
      status,
      version: 1,
    },
  };
}

function event(sequence: number): JobEvent {
  return {
    schemaVersion: 1,
    id: `event-${sequence}`,
    jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sequence,
    type: "job.progress",
    payload: {
      schemaVersion: 1,
      jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      progressBasisPoints: sequence,
    },
    createdAt: new Date(sequence).toISOString(),
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  token: string,
): Promise<string> {
  let output = "";
  const deadline = Date.now() + 3_000;
  while (!output.includes(token)) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${token}`);
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SSE read timeout")), 1_000),
      ),
    ]);
    if (result.done) break;
    output += new TextDecoder().decode(result.value);
  }
  return output;
}
