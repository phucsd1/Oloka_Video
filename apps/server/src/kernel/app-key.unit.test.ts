import { describe, expect, it } from "vitest";
import { decodeApplicationKey } from "./app-key.js";

describe("decodeApplicationKey", () => {
  it("accepts only an unpadded base64url encoding of exactly 32 bytes", () => {
    const encoded = Buffer.alloc(32, 7).toString("base64url");
    expect(decodeApplicationKey(encoded)).toEqual(Buffer.alloc(32, 7));
    expect(() => decodeApplicationKey(`${encoded}=`)).toThrow(/base64url/i);
    expect(() =>
      decodeApplicationKey(Buffer.alloc(31).toString("base64url")),
    ).toThrow(/32 bytes/i);
  });
});
