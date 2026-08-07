import { describe, expect, it } from "vitest";
import { BoundedIdentityRateLimiter } from "./identity-routes.js";
import { IdentityError } from "./identity-service.js";

describe("identity rate limiter", () => {
  it("returns canonical RATE_LIMITED metadata with a bounded Retry-After", () => {
    const limiter = new BoundedIdentityRateLimiter(Buffer.alloc(32, 6));
    limiter.check("login", "203.0.113.42", 1, 5_000);

    expect(
      captureIdentityError(() =>
        limiter.check("login", "203.0.113.99", 1, 5_000),
      ),
    ).toMatchObject({
      code: "RATE_LIMITED",
      statusCode: 429,
      responseHeaders: {
        "retry-after": expect.stringMatching(/^[1-5]$/),
      },
    });
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
