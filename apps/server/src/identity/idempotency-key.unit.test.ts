import { describe, expect, it } from "vitest";
import { parseIdempotencyKey } from "./idempotency-key.js";
import { IdentityError } from "./identity-service.js";

describe("Idempotency-Key", () => {
  it("accepts 1-128 safe ASCII characters and rejects every unsafe boundary", () => {
    expect(parseIdempotencyKey("a")).toBe("a");
    expect(parseIdempotencyKey("A._:-09".repeat(16))).toHaveLength(112);
    expect(parseIdempotencyKey("x".repeat(128))).toHaveLength(128);
    for (const invalid of [
      undefined,
      "",
      "x".repeat(129),
      "has space",
      "has\tcontrol",
      "unicode-ｅ",
      "slash/value",
      "back\\slash",
      'quote"value',
      ["one", "two"],
    ]) {
      expect(
        captureIdentityError(() => parseIdempotencyKey(invalid)).code,
      ).toBe("VALIDATION_ERROR");
    }
  });
});

function captureIdentityError(operation: () => unknown): IdentityError {
  try {
    operation();
  } catch (error) {
    if (error instanceof IdentityError) return error;
    throw error;
  }
  throw new Error("Expected an identity error");
}
