import { describe, expect, it } from "vitest";
import { BaselineQuotaPolicyResolver } from "./quota-policy.js";

describe("BaselineQuotaPolicyResolver", () => {
  it("returns a versioned effective Asset policy", () => {
    const resolver = new BaselineQuotaPolicyResolver({
      version: "test-small",
      maxAssetSizeBytes: 32,
      maxProjectStorageBytes: 64,
    });

    expect(
      resolver.resolve({ userId: "user-1", projectId: "project-1", at: 1 }),
    ).toMatchObject({
      version: "test-small",
      maxAssetSizeBytes: 32,
      maxProjectStorageBytes: 64,
    });
  });
});
