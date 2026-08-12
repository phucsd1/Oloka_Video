import type { CompositionDocumentV1 } from "@oloka/contracts";
import { describe, expect, it } from "vitest";
import {
  materializeCompositionPreview,
  readMaterializationStage,
} from "./composition-materializer.js";

describe("composition preview materializer", () => {
  it("exposes only the fixed materialization stage attached to a failure", () => {
    const error = new Error("sensitive materializer detail");
    Object.defineProperty(error, "materializationStage", {
      value: "load-font",
    });

    expect(readMaterializationStage(error)).toBe("load-font");
    expect(readMaterializationStage({ materializationStage: "private/path" })).toBeUndefined();
  });

  it("produces identical self-contained bytes for the full structured fixture", async () => {
    const assets = [
      {
        id: AUDIO_ID,
        mime: "audio/wav",
        bytes: Buffer.from("deterministic-audio"),
      },
      {
        id: IMAGE_ID,
        mime: "image/png",
        bytes: Buffer.from("deterministic-image"),
      },
    ];
    const originalOrder = assets.map((asset) => asset.id);

    const first = await materializeCompositionPreview(fixture(), assets);
    const second = await materializeCompositionPreview(
      fixture(),
      [...assets].reverse(),
    );
    const html = Buffer.from(first.bytes).toString("utf8");

    expect(first.checksumSha256).toBe(second.checksumSha256);
    expect(
      Buffer.compare(Buffer.from(first.bytes), Buffer.from(second.bytes)),
    ).toBe(0);
    expect(first.bytes.byteLength).toBeGreaterThan(2_000_000);
    expect(assets.map((asset) => asset.id)).toEqual(originalOrder);
    expect(html).toContain("data:font/ttf;base64,");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("data:audio/wav;base64,");
    expect(html).toContain('data-kind="shape"');
    expect(html).toContain('data-kind="text"');
    expect(html).toContain("ducking");
    expect(html).not.toContain("nonce=");
    expect(html).not.toMatch(/channel=["'][a-f0-9]{32}/);
  });

  it("materializes all four exact frame presets deterministically", async () => {
    const presets = [
      ["16:9", 1920, 1080],
      ["9:16", 1080, 1920],
      ["1:1", 1080, 1080],
      ["4:5", 1080, 1350],
    ] as const;
    for (const [aspectRatio, width, height] of presets) {
      const first = await materializeCompositionPreview(
        fixture(aspectRatio),
        [],
      );
      const second = await materializeCompositionPreview(
        fixture(aspectRatio),
        [],
      );
      const html = Buffer.from(first.bytes).toString("utf8");
      expect(first.checksumSha256).toBe(second.checksumSha256);
      expect(html).toContain(`data-width="${width}" data-height="${height}"`);
    }
  });
});

const IMAGE_ID = "30000000-0000-4000-8000-000000000001";
const AUDIO_ID = "30000000-0000-4000-8000-000000000002";

function fixture(
  aspectRatio: CompositionDocumentV1["aspectRatio"] = "16:9",
): CompositionDocumentV1 {
  const dimensions = (
    {
      "16:9": [1920, 1080],
      "9:16": [1080, 1920],
      "1:1": [1080, 1080],
      "4:5": [1080, 1350],
    } satisfies Record<
      CompositionDocumentV1["aspectRatio"],
      readonly [number, number]
    >
  )[aspectRatio];
  return {
    schemaVersion: 1,
    compositionId: "10000000-0000-4000-8000-000000000001",
    name: "Bản dựng tiếng Việt",
    aspectRatio,
    width: dimensions[0],
    height: dimensions[1],
    fps: 30,
    durationMs: 4_000,
    background: "#102030",
    scenes: [
      {
        id: "20000000-0000-4000-8000-000000000001",
        order: 0,
        startMs: 0,
        durationMs: 4_000,
        text: "Cộng hòa Xã hội Chủ nghĩa Việt Nam\nDấu kết hợp: Việt Nam!",
        narration: {
          itemKey: "scene-1",
          text: "Xin chào Việt Nam",
          silence: false,
          locale: "vi-VN",
          rate: 1,
          gainDb: 0,
        },
        assetReferences: [
          { assetId: IMAGE_ID, usage: "visual" },
          { assetId: AUDIO_ID, usage: "audio" },
        ],
        style: {
          layout: "center",
          foreground: "#ffffff",
          accent: "#ffd23f",
          paddingPercent: 8,
          gapPercent: 4,
        },
        tracks: [
          {
            id: "40000000-0000-4000-8000-000000000001",
            type: "overlay",
            order: 0,
            clips: [
              {
                id: "50000000-0000-4000-8000-000000000001",
                kind: "shape",
                startMs: 0,
                durationMs: 4_000,
                layerOrder: 0,
                transitionIn: {
                  type: "wipe",
                  durationMs: 400,
                  easing: "ease-out",
                },
                transitionOut: {
                  type: "fade",
                  durationMs: 300,
                  easing: "ease-in",
                },
                animations: [
                  {
                    property: "scale",
                    easing: "ease-in-out",
                    keyframes: [
                      { offset: 0, value: 0.9 },
                      { offset: 1, value: 1 },
                    ],
                  },
                ],
                primitive: "rectangle",
                fill: "#102030cc",
                stroke: "#ffd23f",
                strokeWidth: 4,
                radius: 32,
                bounds: {
                  x: 0.1,
                  y: 0.2,
                  width: 0.8,
                  height: 0.6,
                  anchor: "center",
                },
              },
              {
                id: "50000000-0000-4000-8000-000000000002",
                kind: "text",
                startMs: 0,
                durationMs: 4_000,
                layerOrder: 1,
                animations: [],
                text: "Nội dung nhiều dòng, có dấu tiếng Việt.",
                typography: {
                  fontToken: "oloka-sans-v1",
                  size: 64,
                  weight: 700,
                  lineHeight: 1.2,
                  align: "center",
                  color: "#ffffff",
                  maxLines: 3,
                  overflow: "wrap",
                },
                bounds: {
                  x: 0.15,
                  y: 0.3,
                  width: 0.7,
                  height: 0.4,
                  anchor: "center",
                },
              },
            ],
          },
        ],
      },
    ],
    voiceConfig: {
      voiceToken: "neutral-vi-v1",
      locale: "vi-VN",
      rate: 1,
      gainDb: 0,
    },
    captionConfig: {
      enabled: true,
      preset: "Bold",
      fontToken: "oloka-sans-v1",
      safeMarginPercent: 8,
      maxLines: 3,
    },
    bgmConfig: {
      assetId: AUDIO_ID,
      volume: 0.5,
      ducking: {
        enabled: true,
        targetVolume: 0.2,
        attackMs: 150,
        releaseMs: 300,
      },
    },
    manifests: {
      dependency: { schemaVersion: 1, hashSha256: "a".repeat(64) },
      asset: { schemaVersion: 1, hashSha256: "b".repeat(64) },
      font: { schemaVersion: 1, hashSha256: "c".repeat(64) },
      caption: { schemaVersion: 1, hashSha256: "d".repeat(64) },
    },
    runtimeVersions: {
      materializer: "oloka-composition-v1.0.0",
      renderer: "oloka-browser-v1",
      renderProtocol: 1,
      hyperframes: "0.7.104",
      hyperframesRuntimeSha256: "e".repeat(64),
      templateRegistry: "oloka-registry-v1",
    },
    metadata: { locale: "vi-VN", title: "Bản dựng", safeAreaMode: "action" },
  };
}
