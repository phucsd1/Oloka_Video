import { describe, expect, it } from "vitest";
import { parseEnvironment } from "./environment.js";

describe("parseEnvironment", () => {
  it("rejects an invalid public port", () => {
    expect(() => parseEnvironment({ PORT: "70000" })).toThrow(/PORT/);
  });
});
