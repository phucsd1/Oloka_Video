import { describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  sha256CanonicalJson,
  sha256Hex,
} from "./canonical-json.js";

describe("canonicalizeJson", () => {
  it("uses RFC 8785 property ordering", () => {
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("rejects values outside the JSON data model", () => {
    expect(() => canonicalizeJson({ value: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalizeJson({ value: undefined } as never)).toThrow(
      TypeError,
    );
    expect(() => canonicalizeJson("\ud800")).toThrow(/Unicode/);
  });

  it("matches the RFC 8785 serialization sample and stable SHA-256 helpers", () => {
    const value = {
      numbers: [Number("333333333.33333329"), 1e30, 4.5, 2e-3, 1e-27],
      string: '€$\u000f\nA\'B"\\"/',
      literals: [null, true, false],
    };
    const expected =
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\"/"}';
    expect(canonicalizeJson(value)).toBe(expected);
    expect(sha256CanonicalJson(value)).toBe(sha256Hex(expected));
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
