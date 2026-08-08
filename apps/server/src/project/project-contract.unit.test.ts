import { describe, expect, it } from "vitest";
import { createProjectRequestSchema } from "@oloka/contracts";

describe("Project HTTP contracts", () => {
  it("rejects unknown create request keys", () => {
    const result = createProjectRequestSchema.safeParse({
      name: "Launch video",
      description: "Vietnamese campaign",
      ownerUserId: "00000000-0000-4000-8000-000000000001",
    });

    expect(result.success).toBe(false);
  });
});
