import { z } from "zod";

const uuidSchema = z.uuid();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const boundedTextSchema = z.string().max(4_000);
const rawExecutablePattern =
  /<\/?(?:script|style|iframe|object|embed|form|link|meta)\b|\bon[a-z]+\s*=|\b(?:javascript|data):/i;
const colorTokenSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/);
const finiteNumber = z
  .number()
  .finite()
  .refine((value) => !Object.is(value, -0), {
    message: "Negative zero is not allowed",
  });
const millisecondSchema = finiteNumber.int().nonnegative();
const durationSchema = finiteNumber.int().positive();

export const compositionAspectRatioSchema = z.enum([
  "16:9",
  "9:16",
  "1:1",
  "4:5",
]);
export const compositionFpsSchema = z.union([
  z.literal(24),
  z.literal(30),
  z.literal(60),
]);
export const compositionStatusSchema = z.enum(["draft", "valid", "invalid"]);
export const compositionAssetUsageSchema = z.enum(["visual", "audio", "font"]);
export const captionPresetSchema = z.enum(["Clean", "Bold"]);

const transitionSchema = z
  .object({
    type: z.enum(["none", "fade", "slide", "wipe"]),
    durationMs: millisecondSchema.max(5_000),
    easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]),
  })
  .strict();

const animationKeyframeSchema = z
  .object({
    offset: finiteNumber.min(0).max(1),
    value: finiteNumber,
  })
  .strict();

const animationSchema = z
  .object({
    property: z.enum([
      "opacity",
      "translateX",
      "translateY",
      "scale",
      "rotation",
    ]),
    easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]),
    keyframes: z.array(animationKeyframeSchema).min(2).max(20),
  })
  .strict()
  .superRefine((animation, context) => {
    for (let index = 1; index < animation.keyframes.length; index += 1) {
      if (
        animation.keyframes[index]!.offset <=
        animation.keyframes[index - 1]!.offset
      ) {
        context.addIssue({
          code: "custom",
          message: "Animation offsets must increase",
          path: ["keyframes", index, "offset"],
        });
      }
    }
  });

const boundsSchema = z
  .object({
    x: finiteNumber.min(0).max(1),
    y: finiteNumber.min(0).max(1),
    width: finiteNumber.positive().max(1),
    height: finiteNumber.positive().max(1),
    anchor: z.enum([
      "top-left",
      "top",
      "top-right",
      "left",
      "center",
      "right",
      "bottom-left",
      "bottom",
      "bottom-right",
    ]),
  })
  .strict()
  .refine(
    (value) => value.x + value.width <= 1 && value.y + value.height <= 1,
    {
      message: "Bounds must remain inside the frame",
    },
  );

const typographySchema = z
  .object({
    fontToken: z.enum(["oloka-sans-v1", "oloka-display-v1"]),
    size: finiteNumber.int().min(12).max(240),
    weight: z.union([
      z.literal(400),
      z.literal(600),
      z.literal(700),
      z.literal(800),
    ]),
    lineHeight: finiteNumber.min(0.8).max(2),
    align: z.enum(["left", "center", "right"]),
    color: colorTokenSchema,
    maxLines: finiteNumber.int().min(1).max(5),
    overflow: z.enum(["wrap", "clip"]),
  })
  .strict();

const clipBase = {
  id: uuidSchema,
  startMs: millisecondSchema,
  durationMs: durationSchema,
  layerOrder: finiteNumber.int().min(-100).max(100),
  transitionIn: transitionSchema.optional(),
  transitionOut: transitionSchema.optional(),
  animations: z.array(animationSchema).max(12),
};

const sceneClipSchema = z
  .object({
    ...clipBase,
    kind: z.literal("scene"),
    templateId: z.enum(["oloka-title-v1", "oloka-media-v1", "oloka-quote-v1"]),
    variables: z
      .record(
        z.string().max(64),
        z.union([boundedTextSchema, finiteNumber, z.boolean()]),
      )
      .refine((value) => Object.keys(value).length <= 32),
  })
  .strict();

const assetClipSchema = z
  .object({
    ...clipBase,
    kind: z.literal("asset"),
    assetId: uuidSchema,
    mediaKind: z.enum(["image", "video"]),
    fit: z.enum(["cover", "contain"]),
    crop: z
      .object({
        x: finiteNumber.min(0).max(1),
        y: finiteNumber.min(0).max(1),
        width: finiteNumber.positive().max(1),
        height: finiteNumber.positive().max(1),
      })
      .strict()
      .refine(
        (value) => value.x + value.width <= 1 && value.y + value.height <= 1,
        { message: "Crop must remain inside the source" },
      ),
    focalPoint: z
      .object({ x: finiteNumber.min(0).max(1), y: finiteNumber.min(0).max(1) })
      .strict(),
    bounds: boundsSchema,
  })
  .strict();

const textClipSchema = z
  .object({
    ...clipBase,
    kind: z.literal("text"),
    text: boundedTextSchema,
    typography: typographySchema,
    bounds: boundsSchema,
  })
  .strict();

const shapeClipSchema = z
  .object({
    ...clipBase,
    kind: z.literal("shape"),
    primitive: z.enum(["rectangle", "ellipse", "line"]),
    fill: colorTokenSchema,
    stroke: colorTokenSchema.nullable(),
    strokeWidth: finiteNumber.min(0).max(40),
    radius: finiteNumber.min(0).max(200),
    bounds: boundsSchema,
  })
  .strict();

const captionClipSchema = z
  .object({
    ...clipBase,
    kind: z.literal("caption"),
    sourceId: z.string().min(1).max(120),
    preset: captionPresetSchema,
    timingPolicy: z.literal("scene"),
  })
  .strict();

const audioClipSchema = z
  .object({
    ...clipBase,
    kind: z.literal("audio"),
    assetId: uuidSchema,
    gain: finiteNumber.min(0).max(2),
    fadeInMs: millisecondSchema.max(5_000),
    fadeOutMs: millisecondSchema.max(5_000),
    trimStartMs: millisecondSchema,
  })
  .strict();

export const compositionClipV1Schema = z.discriminatedUnion("kind", [
  sceneClipSchema,
  assetClipSchema,
  textClipSchema,
  shapeClipSchema,
  captionClipSchema,
  audioClipSchema,
]);

const trackSchema = z
  .object({
    id: uuidSchema,
    type: z.enum(["visual", "overlay", "caption", "voice", "music", "sfx"]),
    order: finiteNumber.int().nonnegative(),
    clips: z.array(compositionClipV1Schema).max(100),
  })
  .strict();

const assetReferenceSchema = z
  .object({
    assetId: uuidSchema,
    usage: compositionAssetUsageSchema,
    crop: z
      .object({
        x: finiteNumber.min(0).max(1),
        y: finiteNumber.min(0).max(1),
        width: finiteNumber.positive().max(1),
        height: finiteNumber.positive().max(1),
      })
      .strict()
      .refine(
        (value) => value.x + value.width <= 1 && value.y + value.height <= 1,
        { message: "Crop must remain inside the source" },
      )
      .optional(),
    trimStartMs: millisecondSchema.optional(),
    trimDurationMs: durationSchema.optional(),
  })
  .strict();

const narrationSchema = z
  .object({
    itemKey: z.string().min(1).max(120),
    text: boundedTextSchema,
    silence: z.boolean(),
    locale: z.enum(["vi-VN", "en-US"]),
    rate: finiteNumber.min(0.5).max(2),
    gainDb: finiteNumber.min(-24).max(12),
  })
  .strict()
  .refine((value) => value.silence || value.text.trim().length > 0, {
    message: "Narration text is required unless silence is explicit",
  });

const sceneStyleSchema = z
  .object({
    layout: z.enum(["center", "split", "full-bleed", "lower-third"]),
    foreground: colorTokenSchema,
    accent: colorTokenSchema,
    paddingPercent: finiteNumber.min(0).max(20),
    gapPercent: finiteNumber.min(0).max(20),
  })
  .strict();

export const compositionSceneV1Schema = z
  .object({
    id: uuidSchema,
    order: finiteNumber.int().nonnegative(),
    startMs: millisecondSchema,
    durationMs: durationSchema,
    text: boundedTextSchema,
    narration: narrationSchema.nullable(),
    assetReferences: z.array(assetReferenceSchema).max(40),
    style: sceneStyleSchema,
    tracks: z.array(trackSchema).max(20),
  })
  .strict();

const manifestReferenceSchema = z
  .object({ schemaVersion: z.literal(1), hashSha256: sha256Schema })
  .strict();
const manifestsSchema = z
  .object({
    dependency: manifestReferenceSchema,
    asset: manifestReferenceSchema,
    font: manifestReferenceSchema,
    caption: manifestReferenceSchema,
  })
  .strict();

const runtimeVersionsSchema = z
  .object({
    materializer: z.string().min(1).max(100),
    renderer: z.string().min(1).max(100),
    renderProtocol: z.number().int().positive(),
    hyperframes: z.literal("0.7.104"),
    hyperframesRuntimeSha256: sha256Schema,
    templateRegistry: z.string().min(1).max(100),
  })
  .strict();

const voiceConfigSchema = z
  .object({
    voiceToken: z.enum(["neutral-vi-v1", "warm-vi-v1"]),
    locale: z.enum(["vi-VN", "en-US"]),
    rate: finiteNumber.min(0.5).max(2),
    gainDb: finiteNumber.min(-24).max(12),
  })
  .strict();

const captionConfigSchema = z
  .object({
    enabled: z.boolean(),
    preset: captionPresetSchema,
    fontToken: z.enum(["oloka-sans-v1", "oloka-display-v1"]),
    safeMarginPercent: finiteNumber.min(5).max(20),
    maxLines: finiteNumber.int().min(1).max(3),
  })
  .strict();

const bgmConfigSchema = z
  .object({
    assetId: uuidSchema,
    volume: finiteNumber.min(0).max(1),
    ducking: z
      .object({
        enabled: z.boolean(),
        targetVolume: finiteNumber.min(0).max(1),
        attackMs: millisecondSchema.max(5_000),
        releaseMs: millisecondSchema.max(5_000),
      })
      .strict(),
  })
  .strict();

const metadataSchema = z
  .object({
    locale: z.enum(["vi-VN", "en-US"]),
    title: z.string().trim().min(1).max(200),
    safeAreaMode: z.enum(["title", "action"]),
  })
  .strict();

export const compositionDocumentV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    compositionId: uuidSchema,
    name: z.string().trim().min(1).max(120),
    aspectRatio: compositionAspectRatioSchema,
    width: finiteNumber.int().positive(),
    height: finiteNumber.int().positive(),
    fps: compositionFpsSchema,
    durationMs: durationSchema,
    background: colorTokenSchema,
    scenes: z.array(compositionSceneV1Schema).min(1).max(60),
    voiceConfig: voiceConfigSchema.nullable(),
    captionConfig: captionConfigSchema,
    bgmConfig: bgmConfigSchema.nullable(),
    manifests: manifestsSchema,
    runtimeVersions: runtimeVersionsSchema,
    metadata: metadataSchema,
  })
  .strict()
  .superRefine((document, context) => {
    const presets = {
      "16:9": [1920, 1080],
      "9:16": [1080, 1920],
      "1:1": [1080, 1080],
      "4:5": [1080, 1350],
    } as const;
    const [width, height] = presets[document.aspectRatio];
    if (document.width !== width || document.height !== height) {
      context.addIssue({
        code: "custom",
        message: "Frame dimensions do not match the aspect-ratio preset",
        path: ["width"],
      });
    }
    const identifiers = new Set<string>();
    document.scenes.forEach((scene, sceneIndex) => {
      if (scene.order !== sceneIndex)
        context.addIssue({
          code: "custom",
          message: "Scene order must match array order",
          path: ["scenes", sceneIndex, "order"],
        });
      if (sceneIndex > 0) {
        const previous = document.scenes[sceneIndex - 1]!;
        if (scene.startMs < previous.startMs + previous.durationMs)
          context.addIssue({
            code: "custom",
            message: "Scenes must not overlap",
            path: ["scenes", sceneIndex, "startMs"],
          });
      }
      if (scene.startMs + scene.durationMs > document.durationMs)
        context.addIssue({
          code: "custom",
          message: "Scene exceeds composition duration",
          path: ["scenes", sceneIndex, "durationMs"],
        });
      for (const identifier of [
        scene.id,
        ...scene.tracks.flatMap((track) => [
          track.id,
          ...track.clips.map((clip) => clip.id),
        ]),
      ]) {
        if (identifiers.has(identifier))
          context.addIssue({
            code: "custom",
            message: "Composition identifiers must be unique",
            path: ["scenes", sceneIndex],
          });
        identifiers.add(identifier);
      }
      scene.tracks.forEach((track, trackIndex) => {
        if (track.order !== trackIndex)
          context.addIssue({
            code: "custom",
            message: "Track order must match array order",
            path: ["scenes", sceneIndex, "tracks", trackIndex, "order"],
          });
        const sorted = [...track.clips].sort(
          (left, right) =>
            left.startMs - right.startMs ||
            left.layerOrder - right.layerOrder ||
            left.id.localeCompare(right.id),
        );
        if (track.clips.some((clip, index) => clip !== sorted[index]))
          context.addIssue({
            code: "custom",
            message: "Clips must use deterministic timeline order",
            path: ["scenes", sceneIndex, "tracks", trackIndex, "clips"],
          });
        track.clips.forEach((clip, clipIndex) => {
          if (clip.startMs + clip.durationMs > document.durationMs)
            context.addIssue({
              code: "custom",
              message: "Clip exceeds composition duration",
              path: [
                "scenes",
                sceneIndex,
                "tracks",
                trackIndex,
                "clips",
                clipIndex,
              ],
            });
          if (
            clip.startMs < scene.startMs ||
            clip.startMs + clip.durationMs > scene.startMs + scene.durationMs
          )
            context.addIssue({
              code: "custom",
              message: "Clip must remain inside its scene",
              path: [
                "scenes",
                sceneIndex,
                "tracks",
                trackIndex,
                "clips",
                clipIndex,
              ],
            });
          if (
            clip.transitionIn !== undefined &&
            clip.transitionIn.durationMs > clip.durationMs
          )
            context.addIssue({
              code: "custom",
              message: "Incoming transition exceeds clip duration",
              path: [
                "scenes",
                sceneIndex,
                "tracks",
                trackIndex,
                "clips",
                clipIndex,
                "transitionIn",
                "durationMs",
              ],
            });
          if (
            clip.transitionOut !== undefined &&
            clip.transitionOut.durationMs > clip.durationMs
          )
            context.addIssue({
              code: "custom",
              message: "Outgoing transition exceeds clip duration",
              path: [
                "scenes",
                sceneIndex,
                "tracks",
                trackIndex,
                "clips",
                clipIndex,
                "transitionOut",
                "durationMs",
              ],
            });
        });
      });
    });
    const inspect = (value: unknown, path: Array<string | number>): void => {
      if (typeof value === "string" && rawExecutablePattern.test(value))
        context.addIssue({
          code: "custom",
          message: "Raw executable authoring input is forbidden",
          path,
        });
      else if (Array.isArray(value))
        value.forEach((entry, index) => inspect(entry, [...path, index]));
      else if (value !== null && typeof value === "object")
        Object.entries(value).forEach(([key, entry]) =>
          inspect(entry, [...path, key]),
        );
    };
    inspect(document, []);
  });

export const compositionValidationResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    valid: z.boolean(),
    issues: z
      .array(
        z
          .object({
            code: z.enum([
              "COMPOSITION_INVALID",
              "ASSET_UNAVAILABLE",
              "DEPENDENCY_MISSING",
              "QUOTA_EXCEEDED",
            ]),
            path: z.string().max(500),
            messageKey: z.string().max(200),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export const compositionVersionSchema = z
  .object({
    id: uuidSchema,
    projectId: uuidSchema,
    versionNumber: z.number().int().positive(),
    parentVersionId: uuidSchema.nullable(),
    document: compositionDocumentV1Schema,
    canonicalHashSha256: sha256Schema,
    status: compositionStatusSchema,
    validation: compositionValidationResultV1Schema,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const compositionListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(2048).optional(),
    status: compositionStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const compositionListResponseSchema = z
  .object({
    compositions: z.array(compositionVersionSchema).max(100),
    nextCursor: z.string().min(1).max(2048).nullable(),
  })
  .strict();

export const createCompositionRequestSchema = z
  .object({
    document: compositionDocumentV1Schema,
    expectedProjectVersion: z.number().int().positive(),
  })
  .strict();

const sceneTextEditSchema = z
  .object({
    type: z.literal("sceneText"),
    sceneId: uuidSchema,
    text: boundedTextSchema,
  })
  .strict();
const sceneDurationEditSchema = z
  .object({
    type: z.literal("sceneDuration"),
    sceneId: uuidSchema,
    durationMs: durationSchema,
  })
  .strict();
const sceneOrderEditSchema = z
  .object({
    type: z.literal("sceneOrder"),
    sceneId: uuidSchema,
    order: z.number().int().nonnegative(),
  })
  .strict();
const sceneAssetEditSchema = z
  .object({
    type: z.literal("sceneAsset"),
    sceneId: uuidSchema,
    references: z.array(assetReferenceSchema).max(40),
  })
  .strict();
const sceneStyleEditSchema = z
  .object({
    type: z.literal("sceneStyle"),
    sceneId: uuidSchema,
    style: sceneStyleSchema,
  })
  .strict();
const aspectRatioEditSchema = z
  .object({
    type: z.literal("aspectRatio"),
    aspectRatio: compositionAspectRatioSchema,
  })
  .strict();
const voiceEditSchema = z
  .object({
    type: z.literal("voice"),
    voiceConfig: voiceConfigSchema.nullable(),
  })
  .strict();
const captionEditSchema = z
  .object({ type: z.literal("caption"), captionConfig: captionConfigSchema })
  .strict();
const bgmEditSchema = z
  .object({ type: z.literal("bgm"), bgmConfig: bgmConfigSchema.nullable() })
  .strict();

export const compositionEditOperationSchema = z.discriminatedUnion("type", [
  sceneTextEditSchema,
  sceneDurationEditSchema,
  sceneOrderEditSchema,
  sceneAssetEditSchema,
  sceneStyleEditSchema,
  aspectRatioEditSchema,
  voiceEditSchema,
  captionEditSchema,
  bgmEditSchema,
]);

export const deriveCompositionRequestSchema = z
  .object({
    expectedProjectVersion: z.number().int().positive(),
    edits: z.array(compositionEditOperationSchema).min(1).max(100),
  })
  .strict();

export const previewArtifactStatusSchema = z.enum([
  "ready",
  "quarantined",
  "purge_scheduled",
  "purged",
]);
export const previewArtifactSchema = z
  .object({
    id: uuidSchema,
    compositionVersionId: uuidSchema,
    renderContractFingerprintSha256: sha256Schema,
    materializerVersion: z.string().min(1).max(100),
    hyperframesVersion: z.literal("0.7.104"),
    cspProfileVersion: z.number().int().positive(),
    byteChecksumSha256: sha256Schema,
    status: previewArtifactStatusSchema,
    createdAt: z.iso.datetime({ offset: true }),
    contentUrl: z.string().startsWith("/api/v1/previews/"),
  })
  .strict();

export const requestPreviewRequestSchema = z.object({}).strict();

export type CompositionDocumentV1 = z.infer<typeof compositionDocumentV1Schema>;
export type CompositionSceneV1 = z.infer<typeof compositionSceneV1Schema>;
export type CompositionClipV1 = z.infer<typeof compositionClipV1Schema>;
export type CompositionValidationResultV1 = z.infer<
  typeof compositionValidationResultV1Schema
>;
export type CompositionVersion = z.infer<typeof compositionVersionSchema>;
export type CompositionListQuery = z.infer<typeof compositionListQuerySchema>;
export type CompositionEditOperation = z.infer<
  typeof compositionEditOperationSchema
>;
export type DeriveCompositionRequest = z.infer<
  typeof deriveCompositionRequestSchema
>;
export type PreviewArtifact = z.infer<typeof previewArtifactSchema>;
