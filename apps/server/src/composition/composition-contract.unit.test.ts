import { describe, expect, it } from "vitest";
import { compositionDocumentV1Schema } from "@oloka/contracts";

describe("CompositionDocumentV1", () => {
  it("rejects unknown executable fields and mismatched frame presets", () => {
    const base = {
      schemaVersion: 1,
      compositionId: "11111111-1111-4111-8111-111111111111",
      name: "Bản dựng tiếng Việt",
      aspectRatio: "16:9",
      width: 1920,
      height: 1080,
      fps: 30,
      durationMs: 4_000,
      background: "#102030",
      scenes: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          order: 0,
          startMs: 0,
          durationMs: 4_000,
          text: "Tiếng Việt rõ ràng",
          narration: null,
          assetReferences: [],
          style: {
            layout: "center",
            foreground: "#ffffff",
            accent: "#ffd23f",
            paddingPercent: 8,
            gapPercent: 4,
          },
          tracks: [],
        },
      ],
      voiceConfig: null,
      captionConfig: {
        enabled: false,
        preset: "Clean",
        fontToken: "oloka-sans-v1",
        safeMarginPercent: 8,
        maxLines: 2,
      },
      bgmConfig: null,
      manifests: {
        dependency: { schemaVersion: 1, hashSha256: "a".repeat(64) },
        asset: { schemaVersion: 1, hashSha256: "b".repeat(64) },
        font: { schemaVersion: 1, hashSha256: "c".repeat(64) },
        caption: { schemaVersion: 1, hashSha256: "d".repeat(64) },
      },
      runtimeVersions: {
        materializer: "oloka-materializer-v1",
        renderer: "oloka-browser-v1",
        renderProtocol: 1,
        hyperframes: "0.7.104",
        hyperframesRuntimeSha256: "e".repeat(64),
        templateRegistry: "oloka-registry-v1",
      },
      metadata: { locale: "vi-VN", title: "Bản dựng", safeAreaMode: "action" },
    };

    expect(
      compositionDocumentV1Schema.safeParse({ ...base, html: "<script />" })
        .success,
    ).toBe(false);
    expect(
      compositionDocumentV1Schema.safeParse({ ...base, width: 1080 }).success,
    ).toBe(false);
    expect(
      compositionDocumentV1Schema.safeParse({
        ...base,
        scenes: [
          { ...base.scenes[0], text: '<script src="https://evil.test/x.js">' },
        ],
      }).success,
    ).toBe(false);
    expect(compositionDocumentV1Schema.safeParse(base).success).toBe(true);
  });
});
