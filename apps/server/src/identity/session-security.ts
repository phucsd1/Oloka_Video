import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { isIP } from "node:net";

export const SESSION_COOKIE_NAME = "__Host-oloka_session";

export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function hashCoarseIpPrefix(
  applicationKey: Uint8Array,
  ipAddress: string,
): Buffer {
  const prefix = coarseIpPrefix(ipAddress);
  const key = hkdfSync(
    "sha256",
    applicationKey,
    Buffer.from("oloka-video-identity", "utf8"),
    Buffer.from("session-ip-prefix/v1", "utf8"),
    32,
  );
  return createHmac("sha256", Buffer.from(key)).update(prefix, "utf8").digest();
}

export function summarizeUserAgent(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 ? " " : character;
  })
    .join("")
    .trim();
  if (normalized.length === 0) return null;
  const browser = /Edg\//i.test(normalized)
    ? "Edge"
    : /Firefox\//i.test(normalized)
      ? "Firefox"
      : /Chrome\//i.test(normalized)
        ? "Chrome"
        : /Safari\//i.test(normalized)
          ? "Safari"
          : "Other browser";
  const operatingSystem = /Windows/i.test(normalized)
    ? "Windows"
    : /Android/i.test(normalized)
      ? "Android"
      : /iPhone|iPad|iOS/i.test(normalized)
        ? "iOS"
        : /Mac OS|Macintosh/i.test(normalized)
          ? "macOS"
          : /Linux/i.test(normalized)
            ? "Linux"
            : "Other OS";
  const device = /iPad|Tablet/i.test(normalized)
    ? "tablet"
    : /Mobile|Android|iPhone/i.test(normalized)
      ? "mobile"
      : "desktop";
  return `${browser}; ${operatingSystem}; ${device}`;
}

export function createSessionCookie(
  token: string,
  maxAgeSeconds: number,
): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function readSessionCookie(header: string | undefined): string | null {
  if (header === undefined) return null;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function coarseIpPrefix(ipAddress: string): string {
  const address = ipAddress.toLowerCase().startsWith("::ffff:")
    ? ipAddress.slice("::ffff:".length)
    : ipAddress;
  const family = isIP(address);
  if (family === 4) return `${address.split(".").slice(0, 3).join(".")}.0/24`;
  if (family === 6) {
    return `${expandIpv6(address).slice(0, 3).join(":")}:0:0:0:0:0/48`;
  }
  return "unknown";
}

function expandIpv6(address: string): string[] {
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return Array(8).fill("0") as string[];
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right =
    halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":");
  const missing = Math.max(0, 8 - left.length - right.length);
  return [...left, ...Array<string>(missing).fill("0"), ...right].map((part) =>
    Number.parseInt(part || "0", 16).toString(16),
  );
}
