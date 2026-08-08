import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerErrorHandler } from "../http/error-handler.js";
import type {
  AuthenticatedSession,
  IdentityService,
} from "../identity/identity-service.js";
import { registerProjectRoutes } from "./project-routes.js";

describe("Project account status gate", () => {
  it("blocks disabled and rejected accounts on the Project list route", async () => {
    for (const [status, code] of [
      ["disabled", "ACCOUNT_DISABLED"],
      ["rejected", "ACCOUNT_REJECTED"],
    ] as const) {
      const app = Fastify({ logger: false });
      const identityService = {
        getSession: () => session(status),
        auditStatusDenial: () => undefined,
      } as unknown as IdentityService;
      registerProjectRoutes({
        app,
        identityService,
        projectService: undefined,
        publicOrigin: "https://oloka.example.test",
      });
      registerErrorHandler(app);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: { cookie: "__Host-oloka_session=status-gate-token" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe(code);
      await app.close();
    }
  });
});

function session(
  status: AuthenticatedSession["user"]["status"],
): AuthenticatedSession {
  return {
    sessionId: "00000000-0000-4000-8000-000000000401",
    user: {
      id: "00000000-0000-4000-8000-000000000402",
      email: "member@example.test",
      displayName: "Member",
      avatarUrl: null,
      role: "member",
      status,
      version: 1,
    },
  };
}
