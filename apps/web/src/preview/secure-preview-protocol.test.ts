import { describe, expect, it } from "vitest";
import {
  parsePreviewCommand,
  parsePreviewEvent,
  previewInitializeCommandSchema,
} from "./secure-preview-protocol";

describe("secure preview protocol", () => {
  it("rejects unknown command fields and child events from another channel", () => {
    expect(
      previewInitializeCommandSchema.safeParse({
        protocol: "oloka-preview",
        version: 1,
        channel: "0123456789abcdef0123456789abcdef",
        direction: "parent-to-preview",
        type: "initialize",
        unexpected: true,
      }).success,
    ).toBe(false);

    expect(() =>
      parsePreviewEvent(
        {
          protocol: "oloka-preview",
          version: 1,
          channel: "ffffffffffffffffffffffffffffffff",
          direction: "preview-to-parent",
          type: "ready",
          durationSeconds: 4,
        },
        "0123456789abcdef0123456789abcdef",
      ),
    ).toThrow("Preview channel mismatch");
  });

  it("accepts only commands for the expected bootstrap channel", () => {
    const channel = "0123456789abcdef0123456789abcdef";
    expect(
      parsePreviewCommand(
        {
          protocol: "oloka-preview",
          version: 1,
          channel,
          direction: "parent-to-preview",
          type: "seek",
          timeSeconds: 1.5,
        },
        channel,
      ),
    ).toMatchObject({ type: "seek", timeSeconds: 1.5 });

    expect(() =>
      parsePreviewCommand(
        {
          protocol: "oloka-preview",
          version: 1,
          channel: "ffffffffffffffffffffffffffffffff",
          direction: "parent-to-preview",
          type: "pause",
        },
        channel,
      ),
    ).toThrow("Preview channel mismatch");

    expect(() =>
      parsePreviewCommand(
        {
          protocol: "oloka-preview",
          version: 1,
          channel,
          direction: "parent-to-preview",
          type: "seek",
          timeSeconds: -1,
        },
        channel,
      ),
    ).toThrow();
  });
});
