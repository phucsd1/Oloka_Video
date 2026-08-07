import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE_NAME,
  createSessionCookie,
  generateOpaqueToken,
  hashCoarseIpPrefix,
  hashOpaqueToken,
  readSessionCookie,
  summarizeUserAgent,
} from "./session-security.js";

describe("session security", () => {
  it("uses the HKDF-derived key as an HMAC-SHA256 key for coarse IP metadata", () => {
    const result = hashCoarseIpPrefix(Buffer.alloc(32, 4), "203.0.113.99");

    expect(result).toHaveLength(32);
    expect(result.toString("hex")).toBe(
      "905f70865ad13197807e7e409d9eee5424b3a75172d676b86545dc63a63e73b2",
    );
    expect(result.toString("hex")).not.toBe(
      "82c44d8f7f33667942e3e1c969ee7e81d7ea2c1c44ad5ffbda7f0825fa0f3ba6",
    );
  });

  it("normalizes IPv4, mapped IPv4, IPv6, invalid input, and application keys", () => {
    const key = Buffer.alloc(32, 4);
    const otherKey = Buffer.alloc(32, 5);
    expect(
      hashCoarseIpPrefix(key, "203.0.113.99").equals(
        hashCoarseIpPrefix(key, "::FFFF:203.0.113.12"),
      ),
    ).toBe(true);
    expect(
      hashCoarseIpPrefix(key, "2001:db8:abcd:1::1").equals(
        hashCoarseIpPrefix(key, "2001:db8:abcd:ffff::9"),
      ),
    ).toBe(true);
    expect(
      hashCoarseIpPrefix(key, "not-an-ip").equals(
        hashCoarseIpPrefix(key, "also-invalid"),
      ),
    ).toBe(true);
    expect(
      hashCoarseIpPrefix(key, "203.0.113.99").equals(
        hashCoarseIpPrefix(otherKey, "203.0.113.99"),
      ),
    ).toBe(false);
  });

  it("stores only hashes, coarsens IP metadata, and emits a host-only secure cookie", () => {
    const applicationKey = Buffer.alloc(32, 4);
    const rawToken = "a-raw-session-token";
    const generatedToken = generateOpaqueToken();

    expect(Buffer.from(generatedToken, "base64url")).toHaveLength(32);
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
    expect(readSessionCookie(cookie)).toBe(rawToken);
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=%not-valid`)).toBeNull();
    expect(
      summarizeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0) Chrome/123.4 private-free-form",
      ),
    ).toBe("Chrome; Windows; desktop");
  });
});
