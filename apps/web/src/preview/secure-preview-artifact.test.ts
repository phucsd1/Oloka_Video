import { describe, expect, it } from "vitest";
import { buildSecurePreviewArtifact } from "./secure-preview-artifact";

describe("secure preview artifact", () => {
  it("materializes identical bytes without persisting bootstrap entropy", () => {
    const input = {
      runtimeSource: "window.__runtimeFixture = true;",
      compositionMarkup: '<main data-composition-id="fixture"></main>',
      compositionScript: "window.__compositionFixture = true;",
      compositionStyle: "main { background: #fff; }",
    };

    const first = buildSecurePreviewArtifact(input);
    const second = buildSecurePreviewArtifact({ ...input });

    expect(first).toBe(second);
    expect(first).not.toContain("0123456789abcdef0123456789abcdef");
    expect(first).not.toContain("nonce=");
  });

  it("builds a self-contained hash-bound document with a strict CSP", () => {
    const html = buildSecurePreviewArtifact({
      runtimeSource: "window.__runtimeFixture = true;",
      compositionMarkup: '<main data-composition-id="fixture"></main>',
      compositionScript: "window.__compositionFixture = true;",
      compositionStyle: "main { background: #fff; }",
    });

    expect(html).toContain("default-src 'none'");
    expect(html).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(html).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(html).not.toContain("'unsafe-eval'");
    expect(html).not.toContain("allow-same-origin");
    expect(html).not.toContain("nonce=");
    expect(html).toContain("event.source !== parent");
    expect(html).toContain("event.stopImmediatePropagation()");
    expect(html).toContain("let channel = null");
  });

  it("rejects script-closing input that would escape an inline script", () => {
    expect(() =>
      buildSecurePreviewArtifact({
        runtimeSource: "</script><script>alert(1)</script>",
        compositionMarkup: "<main></main>",
        compositionScript: "",
        compositionStyle: "",
      }),
    ).toThrow("Inline script contains a closing script tag");
  });
});
