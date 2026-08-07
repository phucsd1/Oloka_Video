import { describe, expect, it } from "vitest";
import { requireActiveUser } from "./identity-routes.js";
import {
  IdentityError,
  type AuthenticatedSession,
} from "./identity-service.js";

describe("account status authorization", () => {
  it.each([
    ["pending", "ACCOUNT_PENDING"],
    ["disabled", "ACCOUNT_DISABLED"],
    ["rejected", "ACCOUNT_REJECTED"],
  ] as const)("rejects %s users with a stable code", (status, code) => {
    expect(identityErrorCode(() => requireActiveUser(session(status)))).toBe(
      code,
    );
  });

  it("admits an active account to role-specific authorization", () => {
    expect(() => requireActiveUser(session("active"))).not.toThrow();
  });
});

function session(
  status: AuthenticatedSession["user"]["status"],
): AuthenticatedSession {
  return {
    sessionId: "00000000-0000-4000-8000-000000000301",
    user: {
      id: "00000000-0000-4000-8000-000000000302",
      email: "member@example.test",
      displayName: "Member",
      avatarUrl: null,
      role: "member",
      status,
      version: 1,
    },
  };
}

function identityErrorCode(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    if (error instanceof IdentityError) return error.code;
    throw error;
  }
  throw new Error("Expected an identity error");
}
