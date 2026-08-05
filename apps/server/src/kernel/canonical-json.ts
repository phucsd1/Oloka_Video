import canonicalize from "canonicalize";
import { createHash } from "node:crypto";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export function canonicalizeJson(value: JsonValue): string {
  try {
    assertJsonValue(value, new WeakSet<object>());
    const result = canonicalize(value);
    if (result === undefined) {
      throw new TypeError("Value cannot be represented as canonical JSON");
    }
    return result;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("Value cannot be represented as canonical JSON", {
      cause: error,
    });
  }
}

function assertJsonValue(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertValidUnicode(value);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("JSON numbers must be finite");
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError("Value is outside the JSON data model");
  }
  if (seen.has(value))
    throw new TypeError("Cyclic JSON values are not allowed");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JSON objects must be plain records");
    }
    for (const [key, item] of Object.entries(value)) {
      assertValidUnicode(key);
      assertJsonValue(item, seen);
    }
  }
  seen.delete(value);
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError("JSON strings must contain valid Unicode");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("JSON strings must contain valid Unicode");
    }
  }
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256CanonicalJson(value: JsonValue): string {
  return sha256Hex(canonicalizeJson(value));
}
