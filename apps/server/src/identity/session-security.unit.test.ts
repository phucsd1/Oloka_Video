import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE_NAME,
  createSessionCookie,
  hashCoarseIpPrefix,
  hashOpaqueToken,
  summarizeUserAgent,
} from "./session-security.js";

describe("session security", () => {
  it("stores only hashes, coarsens IP metadata, and emits a host-only secure cookie", () => {
    const applicationKey = Buffer.alloc(32, 4);
    const rawToken = "a-raw-session-token";

    expect(hashOpaqueToken(rawToken)).toHaveLength(32);
    expect(hashOpaqueToken(rawToken).toString("utf8")).not.toContain(rawToken);
    expect(
      hashCoarseIpPrefix(applicationKey, "203.0.113.99").equals(
        hashCoarseIpPrefix(applicationKey, "203.0.113.12"),
      ),
    ).toBe(true);
    expect(
      hashCoarseIpPrefix(applicationKey, "203.0.114.12").equals(
        hashCoarseIpPrefix(applicationKey, "203.0.113.12"),
      ),
    ).toBe(false);

    const cookie = createSessionCookie(rawToken, 60);
    expect(SESSION_COOKIE_NAME).toBe("__Host-oloka_session");
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=${rawToken}`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Domain=");
    expect(
      summarizeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0) Chrome/123.4 private-free-form",
      ),
    ).toBe("Chrome; Windows; desktop");
  });
});
