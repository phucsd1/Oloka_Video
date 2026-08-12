import { describe, expect, it } from "vitest";
import {
  assertPreviewEmbeddedAssetBudgetV1,
  MAX_PREVIEW_EMBEDDED_ASSET_BYTES_V1,
} from "./preview-materialization-policy.js";

describe("preview materialization policy", () => {
  it("accepts exactly 16 MiB and rejects 16 MiB plus one byte", () => {
    expect(MAX_PREVIEW_EMBEDDED_ASSET_BYTES_V1).toBe(16 * 1024 * 1024);
    expect(() =>
      assertPreviewEmbeddedAssetBudgetV1(MAX_PREVIEW_EMBEDDED_ASSET_BYTES_V1),
    ).not.toThrow();
    expect(() =>
      assertPreviewEmbeddedAssetBudgetV1(
        MAX_PREVIEW_EMBEDDED_ASSET_BYTES_V1 + 1,
      ),
    ).toThrow(/preview_embedded_media_limit/i);
  });
});
