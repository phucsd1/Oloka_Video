import { describe, expect, it } from "vitest";
import { buildSecurePreviewArtifact } from "./secure-preview-artifact";

describe("secure preview artifact", () => {
  it("builds a self-contained nonce-bound document with a strict CSP", () => {
    const html = buildSecurePreviewArtifact({
      channel: "0123456789abcdef0123456789abcdef",
      nonce: "b2xva2EtcHJldmlldy1ub25jZQ==",
      runtimeSource: "window.__runtimeFixture = true;",
      compositionMarkup: '<main data-composition-id="fixture"></main>',
      compositionScript: "window.__compositionFixture = true;",
      compositionStyle: "main { background: #fff; }",
    });

    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-b2xva2EtcHJldmlldy1ub25jZQ=='");
    expect(html).toContain("style-src 'nonce-b2xva2EtcHJldmlldy1ub25jZQ=='");
    expect(html).not.toContain("'unsafe-eval'");
    expect(html).not.toContain("allow-same-origin");
    expect(html.match(/nonce="b2xva2EtcHJldmlldy1ub25jZQ=="/g)).toHaveLength(4);
    expect(html).toContain("event.source !== parent");
    expect(html).toContain("event.stopImmediatePropagation()");
    expect(html).toContain(
      'const channel = "0123456789abcdef0123456789abcdef"',
    );
  });

  it("rejects script-closing input that would escape an inline script", () => {
    expect(() =>
      buildSecurePreviewArtifact({
        channel: "0123456789abcdef0123456789abcdef",
        nonce: "b2xva2EtcHJldmlldy1ub25jZQ==",
        runtimeSource: "</script><script>alert(1)</script>",
        compositionMarkup: "<main></main>",
        compositionScript: "",
        compositionStyle: "",
      }),
    ).toThrow("Inline script contains a closing script tag");
  });
});
