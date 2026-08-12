import { z } from "zod";

export const PREVIEW_PROTOCOL = "oloka-preview" as const;
export const PREVIEW_PROTOCOL_VERSION = 1 as const;

export const previewChannelSchema = z.string().regex(/^[a-f0-9]{32}$/);
const baseParentCommandSchema = z.object({
  protocol: z.literal(PREVIEW_PROTOCOL),
  version: z.literal(PREVIEW_PROTOCOL_VERSION),
  channel: previewChannelSchema,
  direction: z.literal("parent-to-preview"),
});

export const previewInitializeCommandSchema = baseParentCommandSchema
  .extend({ type: z.literal("initialize") })
  .strict();

export const previewCommandSchema = z.discriminatedUnion("type", [
  previewInitializeCommandSchema,
  baseParentCommandSchema.extend({ type: z.literal("play") }).strict(),
  baseParentCommandSchema.extend({ type: z.literal("pause") }).strict(),
  baseParentCommandSchema
    .extend({
      type: z.literal("seek"),
      timeSeconds: z.number().finite().nonnegative(),
    })
    .strict(),
  baseParentCommandSchema
    .extend({
      type: z.literal("setPlaybackRate"),
      playbackRate: z.number().finite().min(0.25).max(4),
    })
    .strict(),
  baseParentCommandSchema
    .extend({ type: z.literal("setMuted"), muted: z.boolean() })
    .strict(),
]);

const basePreviewEventSchema = z.object({
  protocol: z.literal(PREVIEW_PROTOCOL),
  version: z.literal(PREVIEW_PROTOCOL_VERSION),
  channel: previewChannelSchema,
  direction: z.literal("preview-to-parent"),
});

export const previewEventSchema = z.discriminatedUnion("type", [
  basePreviewEventSchema
    .extend({
      type: z.literal("ready"),
      durationSeconds: z.number().finite().positive(),
    })
    .strict(),
  basePreviewEventSchema
    .extend({
      type: z.literal("timeUpdate"),
      timeSeconds: z.number().finite().nonnegative(),
    })
    .strict(),
  basePreviewEventSchema
    .extend({
      type: z.literal("duration"),
      durationSeconds: z.number().finite().positive(),
    })
    .strict(),
  basePreviewEventSchema.extend({ type: z.literal("ended") }).strict(),
  basePreviewEventSchema
    .extend({
      type: z.literal("safeRuntimeError"),
      code: z.enum([
        "RUNTIME_UNAVAILABLE",
        "INVALID_COMMAND",
        "RUNTIME_FAILURE",
      ]),
    })
    .strict(),
]);

export type PreviewCommand = z.infer<typeof previewCommandSchema>;
export type PreviewEvent = z.infer<typeof previewEventSchema>;

export function parsePreviewCommand(
  value: unknown,
  expectedChannel: string,
): PreviewCommand {
  const command = previewCommandSchema.parse(value);
  assertExpectedChannel(command.channel, expectedChannel);
  return command;
}

export function parsePreviewEvent(
  value: unknown,
  expectedChannel: string,
): PreviewEvent {
  const event = previewEventSchema.parse(value);
  assertExpectedChannel(event.channel, expectedChannel);
  return event;
}

function assertExpectedChannel(channel: string, expectedChannel: string): void {
  if (channel !== expectedChannel) throw new Error("Preview channel mismatch");
}
