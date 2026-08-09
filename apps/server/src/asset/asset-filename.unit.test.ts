import { describe, expect, it } from "vitest";
import { normalizeFilename } from "./asset-service.js";

describe("Asset filename normalization", () => {
  it.each([
    ["  video.mp4  ", "video.mp4"],
    ["thư mục/ảnh đẹp.png", "thư mục_ảnh đẹp.png"],
    ["thư mục\\âm thanh.wav", "thư mục_âm thanh.wav"],
    ["emoji-🎬.mp4", "emoji-🎬.mp4"],
    ["control\u0000name.png", "control name.png"],
    ["a\u0301nh.png", "ánh.png"],
  ])("normalizes %s without deriving storage identity", (input, expected) => {
    expect(normalizeFilename(input)).toBe(expected);
  });

  it("rejects empty and overlong normalized names", () => {
    const validationError = expect.objectContaining({
      code: "VALIDATION_ERROR",
    }) as unknown as Error;
    expect(() => normalizeFilename("\u0000 ")).toThrowError(validationError);
    expect(() => normalizeFilename("x".repeat(256))).toThrowError(
      validationError,
    );
  });
});
