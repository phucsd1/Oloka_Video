import { describe, expect, it } from "vitest";
import { parseEnvironment } from "./environment.js";

describe("parseEnvironment", () => {
  it("rejects an invalid public port", () => {
    expect(() => parseEnvironment({ PORT: "70000" })).toThrow(/PORT/);
  });

  it("rejects an invalid application key without revealing it", () => {
    expect(() => parseEnvironment({ OLOKA_APP_KEY: "not+a+key" })).toThrow(
      /base64url/i,
    );
  });
});
