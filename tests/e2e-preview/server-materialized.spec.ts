import { expect, test } from "@playwright/test";
import type { CompositionDocumentV1 } from "@oloka/contracts";
import { createHash } from "node:crypto";
import { materializeCompositionPreview } from "../../apps/server/src/composition/composition-materializer.js";

const IMAGE_ID = "30000000-0000-4000-8000-000000000011";
const AUDIO_ID = "30000000-0000-4000-8000-000000000012";
const CHANNEL = "0123456789abcdef0123456789abcdef";

test("renders server-materialized full fixtures deterministically in all frame presets", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const attempted: string[] = [];
  await page.route("**/*", async (route) => {
    if (route.request().frame() !== page.mainFrame()) {
      attempted.push(route.request().url());
      await route.abort();
      return;
    }
    await route.continue();
  });

  const presets = ["16:9", "9:16", "1:1", "4:5"] as const;
  const evidence: Array<{ preset: string; hashes: string[] }> = [];
  for (const preset of presets) {
    const materialized = await materializeCompositionPreview(fixture(preset), [
      {
        id: IMAGE_ID,
        mime: "image/png",
        bytes: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      },
      { id: AUDIO_ID, mime: "audio/wav", bytes: silentWav() },
    ]);
    await mount(page, Buffer.from(materialized.bytes).toString("utf8"));
    const frame = page
      .frames()
      .find((candidate) => candidate !== page.mainFrame());
    if (!frame) throw new Error("Materialized preview iframe did not load");
    await frame.evaluate(async () => {
      await document.fonts.ready;
      for (const image of Array.from(document.images)) {
        try {
          await image.decode();
        } catch {
          // The deterministic data URL remains visible even if Edge skips decode.
        }
      }
    });
    const timestamps = preset === "16:9" ? [0, 0.4, 1.5, 2, 3.999] : [0, 3.999];
    const hashes: string[] = [];
    for (const timestamp of timestamps) {
      const repeated: string[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await seek(page, timestamp);
        const screenshot = await frame.locator("#oloka-stage").screenshot();
        repeated.push(createHash("sha256").update(screenshot).digest("hex"));
      }
      const [firstHash, secondHash] = repeated;
      if (firstHash === undefined || secondHash === undefined)
        throw new Error("Repeated screenshot hash evidence is incomplete");
      expect(firstHash).toBe(secondHash);
      hashes.push(firstHash);
    }
    evidence.push({ preset, hashes });
  }

  expect(attempted).toEqual([]);
  expect(evidence).toHaveLength(4);
  expect(
    new Set(evidence.flatMap(({ hashes }) => hashes)).size,
  ).toBeGreaterThan(4);
});

test("meets the warm realistic preview startup target without iframe networking", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const attempted: string[] = [];
  await page.route("**/*", async (route) => {
    if (route.request().frame() !== page.mainFrame()) {
      attempted.push(route.request().url());
      await route.abort();
      return;
    }
    await route.continue();
  });
  const materialized = await materializeCompositionPreview(fixture("16:9"), [
    {
      id: IMAGE_ID,
      mime: "image/png",
      bytes: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    },
    { id: AUDIO_ID, mime: "audio/wav", bytes: silentWav() },
  ]);
  const artifact = Buffer.from(materialized.bytes).toString("utf8");
  await mount(page, artifact);
  const durations: number[] = [];
  for (let run = 0; run < 20; run += 1) {
    const startedAt = performance.now();
    await mount(page, artifact);
    durations.push(performance.now() - startedAt);
  }
  const sorted = [...durations].sort((left, right) => left - right);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const max = Math.max(...sorted);
  process.stdout.write(
    `warm_preview_benchmark=${JSON.stringify({ scenes: 2, assets: 2, captions: "Bold", bgm: true, preset: "16:9", runs: durations.length, p50Ms: Math.round(p50), p95Ms: Math.round(p95), maxMs: Math.round(max), iframeNetworkRequests: attempted.length })}\n`,
  );
  expect(p95).toBeLessThanOrEqual(5_000);
  expect(attempted).toEqual([]);
});

async function mount(page: import("@playwright/test").Page, artifact: string) {
  await page.setContent(
    `<!doctype html><html><body><iframe id="preview" sandbox="allow-scripts"></iframe><script>window.__events=[];addEventListener("message",event=>window.__events.push(event.data));</script></body></html>`,
  );
  await page.evaluate((html) => {
    const iframe = document.querySelector("#preview");
    if (!(iframe instanceof HTMLIFrameElement))
      throw new Error("Missing iframe");
    iframe.srcdoc = html;
  }, artifact);
  const frame = await waitForChildFrame(page);
  await frame.waitForFunction(
    () =>
      typeof (window as unknown as { __player?: unknown }).__player ===
      "object",
  );
  await page.evaluate((channel) => {
    const iframe = document.querySelector("#preview");
    if (!(iframe instanceof HTMLIFrameElement))
      throw new Error("Missing iframe");
    iframe.contentWindow?.postMessage(
      {
        protocol: "oloka-preview",
        version: 1,
        channel,
        direction: "parent-to-preview",
        type: "initialize",
      },
      "*",
    );
  }, CHANNEL);
  await page.waitForFunction(() =>
    (
      window as unknown as { __events?: Array<{ type?: string }> }
    ).__events?.some(({ type }) => type === "ready"),
  );
}

async function waitForChildFrame(page: import("@playwright/test").Page) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const frame = page
      .frames()
      .find((candidate) => candidate !== page.mainFrame());
    if (frame) return frame;
    await page.waitForTimeout(10);
  }
  throw new Error("Child frame did not attach");
}

async function seek(
  page: import("@playwright/test").Page,
  timeSeconds: number,
) {
  await page.evaluate(
    ({ channel, timeSeconds }) => {
      const iframe = document.querySelector("#preview");
      if (!(iframe instanceof HTMLIFrameElement))
        throw new Error("Missing iframe");
      iframe.contentWindow?.postMessage(
        {
          protocol: "oloka-preview",
          version: 1,
          channel,
          direction: "parent-to-preview",
          type: "seek",
          timeSeconds,
        },
        "*",
      );
    },
    { channel: CHANNEL, timeSeconds },
  );
  await page.waitForTimeout(20);
}

function silentWav(): Buffer {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8_000, 24);
  bytes.writeUInt32LE(16_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(0, 40);
  return bytes;
}

function percentile(sorted: number[], value: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * value) - 1);
  return sorted[index] ?? Number.POSITIVE_INFINITY;
}

function fixture(
  aspectRatio: CompositionDocumentV1["aspectRatio"],
): CompositionDocumentV1 {
  const [width, height] = (
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
  const baseScene = {
    narration: {
      itemKey: "scene",
      text: "Xin chào Việt Nam",
      silence: false,
      locale: "vi-VN" as const,
      rate: 1,
      gainDb: 0,
    },
    assetReferences: [
      { assetId: IMAGE_ID, usage: "visual" as const },
      { assetId: AUDIO_ID, usage: "audio" as const },
    ],
    style: {
      layout: "center" as const,
      foreground: "#ffffff",
      accent: "#ffd23f",
      paddingPercent: 8,
      gapPercent: 4,
    },
  };
  return {
    schemaVersion: 1,
    compositionId: "10000000-0000-4000-8000-000000000011",
    name: "Bản dựng Edge",
    aspectRatio,
    width,
    height,
    fps: 30,
    durationMs: 4_000,
    background: "#102030",
    scenes: [
      {
        ...baseScene,
        id: "20000000-0000-4000-8000-000000000011",
        order: 0,
        startMs: 0,
        durationMs: 2_000,
        text: "Cộng hòa Xã hội Chủ nghĩa Việt Nam\nDấu kết hợp: Việt Nam!",
        tracks: [
          {
            id: "40000000-0000-4000-8000-000000000011",
            type: "overlay",
            order: 0,
            clips: [
              {
                id: "50000000-0000-4000-8000-000000000011",
                kind: "shape",
                startMs: 0,
                durationMs: 2_000,
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
            ],
          },
        ],
      },
      {
        ...baseScene,
        id: "20000000-0000-4000-8000-000000000012",
        order: 1,
        startMs: 2_000,
        durationMs: 2_000,
        text: "Phụ đề dài để kiểm tra xuống dòng tiếng Việt chính xác, rõ ràng và ổn định.",
        tracks: [],
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
