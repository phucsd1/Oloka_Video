# Composition Schema V1

## Purpose and safety boundary

`CompositionDocumentV1` is the only authoring input accepted by generation, editor, preview, and render. It is structured data, not executable content. Unknown keys are rejected. Raw HTML, CSS, JavaScript, SQL, data URLs, arbitrary external URLs, event handlers, unknown style properties, and arbitrary font names are forbidden.

The Zod schema belongs in `packages/contracts`; the Phase 3F implementation is in review. Production remains schema v6 until cutover.

## Root document

| Field             | Type             | Rules                                                                                   |
| ----------------- | ---------------- | --------------------------------------------------------------------------------------- |
| `schemaVersion`   | literal `1`      | required                                                                                |
| `compositionId`   | UUIDv4           | stable logical identity; version row has its own ID                                     |
| `name`            | string           | normalized, 1-120 characters                                                            |
| `aspectRatio`     | enum             | exact `16:9`, `9:16`, `1:1`, or `4:5`                                                   |
| `width`, `height` | positive integer | exact preset pair only                                                                  |
| `fps`             | enum             | 24, 30, or 60                                                                           |
| `durationMs`      | integer          | positive; bounded by MVP quota                                                          |
| `background`      | `ColorToken`     | approved opaque/RGBA color value                                                        |
| `scenes`          | ordered array    | 1..bounded maximum; stable unique scene IDs; total timing fits root                     |
| `voiceConfig`     | object or null   | approved provider-neutral voice reference, locale/rate/gain; no credential/model secret |
| `captionConfig`   | object           | enabled flag, Clean or Bold preset, approved font/style token, safe margins             |
| `bgmConfig`       | object or null   | same-project ready+active audio Asset ID, bounded volume/basic ducking                  |
| `manifests`       | object           | dependency, asset, font and caption manifest schema versions + canonical hashes         |
| `runtimeVersions` | object           | materializer, renderer, render protocol, HyperFrames, template registry versions        |
| `metadata`        | object           | locale, title, safe-area mode; no provider/private payload                              |

### Frame presets

| Format label   | `aspectRatio` | Exact V1 frame | Orientation-safe rule                                                    |
| -------------- | ------------- | -------------- | ------------------------------------------------------------------------ |
| `landscape`    | 16:9          | 1920 x 1080    | use landscape layout variant                                             |
| `portrait`     | 9:16          | 1080 x 1920    | use portrait layout variant; no rotated landscape coordinate assumptions |
| `square`       | 1:1           | 1080 x 1080    | square layout variant                                                    |
| `portrait_4_5` | 4:5           | 1080 x 1350    | 4:5 layout variant                                                       |

Layouts use normalized anchors, constraints, and format-specific variants. An element must remain within the configured title/action safe-area inset; schema validation rejects negative/off-frame bounds except approved clipped decoration. Orientation is represented by frame preset, never EXIF/rotation side effects.

## Ordered scenes and timeline structure

| Entity             | Required fields and invariants                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SceneV1`          | stable UUID `id`, integer `order`, `startMs`, `durationMs`, bounded plain `text`, optional bounded `narration`, `assetReferences`, allowlisted `style`, and ordered `tracks`; scene ranges are contiguous or have an explicit approved gap policy |
| `NarrationV1`      | bounded plain text or explicit silence, voice-config override from allowlist, stable scene item key; no provider prompt/payload                                                                                                                   |
| `AssetReferenceV1` | Asset UUID plus declared usage/crop/trim; authorization and `ready + active` checked outside pure shape validation                                                                                                                                |
| `TrackV1`          | UUID `id`, enum visual/overlay/caption/voice/music/sfx, integer `order`, non-overlapping policy appropriate to type, bounded `clips`                                                                                                              |
| `ClipV1`           | UUID `id`, discriminated `kind`, `startMs >= 0`, `durationMs > 0`, `start+duration <= document.durationMs`, optional bounded transitions                                                                                                          |
| `SceneClipV1`      | approved template/block ID + typed variables; no registry URL/path                                                                                                                                                                                |
| `AssetClipV1`      | authorized Asset ID, fit enum, normalized crop/focal point, volume only for media supporting audio                                                                                                                                                |
| `TextClipV1`       | bounded plain text, approved typography/style tokens, layout constraints                                                                                                                                                                          |
| `ShapeClipV1`      | approved primitive, color/stroke/radius tokens, bounds                                                                                                                                                                                            |
| `CaptionClipV1`    | transcript/caption source ID, approved template token, timing policy                                                                                                                                                                              |
| `AudioClipV1`      | authorized Asset/derived-audio ID, gain/fades/trim, no raw URL                                                                                                                                                                                    |
| `TransitionV1`     | approved type, bounded duration, easing token; cannot extend clip/root duration                                                                                                                                                                   |
| `AnimationV1`      | approved property/keyframe set driven only by composition time; finite and seekable                                                                                                                                                               |

All scene, track, and clip IDs are unique inside the document. Scene array order must equal its integer `order`; tracks have deterministic integer order; clips sort by `(startMs, layerOrder, id)`. Scene/clip timing resolves exactly within root duration. Same-layer overlaps require an explicit stacking/blend rule. Numeric values must be finite—no `NaN`, infinity, implicit string number, negative zero ambiguity, or excessive precision.

## Approved styling vocabulary

- Bounds: normalized or integer frame coordinates, anchors, alignment, padding, gap, max width/height.
- Typography: approved font token, size, weight, line-height, alignment, color, maximum lines, overflow policy.
- Visual: opacity, approved color/gradient token, border, radius, shadow token, fit/crop, transform (translate/scale/rotation).
- Animation: opacity, transform, approved color/border-radius changes with finite keyframes and approved easing.
- No `display`, arbitrary `visibility`, filters/blend modes outside an explicit allowlist, selector strings, custom properties, inline styles, or CSS text.

Fonts and templates are server registries with stable IDs, licensed/bundled assets, checksum, and version. A document can reference only versions enabled for its project and materializer. Missing/disabled registry entries make validation fail closed.

## Determinism

Materialized visuals are a pure function of immutable composition JSON, referenced immutable asset checksums, all canonical manifest hashes, registry versions, and declared runtime versions. No clock, unseeded randomness, network fetch, hover/scroll/pointer/focus state, infinite animation, or asynchronous timeline construction may influence a frame. Random-looking behavior requires an explicit seed stored in structured data.

These constraints match HyperFrames' seek model: the same time must produce the same pixels, timelines must be seekable, and required media must be bundled rather than fetched during render.

## Validation phases

1. strict Zod shape/range/unknown-key validation;
2. root preset/duration/timeline arithmetic;
3. unique IDs/order/overlap and reference graph validation;
4. authorization and active lifecycle of every asset/registry reference;
5. safe-area/text/layout constraints for each target format;
6. deterministic animation/property allowlist;
7. materializer compatibility and HyperFrames lint/check gate;
8. render admission checks including quota and technical quality policy.

Validation returns stable codes and JSON pointers; it does not embed generated HTML or provider prompts.

## Three different hashes

| Hash                  | Input                                                                                 | Use                                          |
| --------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------- |
| byte checksum         | exact uploaded/rendered/artifact bytes                                                | integrity, ETag, object verification         |
| canonical JSON hash   | SHA-256 of UTF-8 RFC 8785 JCS `CompositionDocumentV1`                                 | immutable composition identity/deduplication |
| semantic request hash | canonical normalized actor/operation/resource/options input excluding transport noise | idempotency and provider intent              |

These values are never substituted for one another. JCS preserves array order and recursively sorts object properties; the validated I-JSON-compatible value is canonicalized only after defaults are explicitly materialized.

## Evolution

A version 1 reader rejects any other `schemaVersion`. Additive behavior that changes pixel output requires a materializer/registry version fingerprint. Breaking document changes introduce `CompositionDocumentV2` with an explicit migration/derivation path; stored immutable V1 documents are never rewritten.

## Evidence and official references

- Phase 1 authority: `docs/architecture/COMPOSITION_CONTRACT.md`, `PREVIEW_RENDER_PARITY.md`, and `docs/product/ACCEPTANCE_CRITERIA.md`.
- HyperFrames deterministic HTML/video packages and player: <https://github.com/heygen-com/hyperframes>.
- JSON Canonicalization Scheme RFC 8785 and JavaScript implementation references: <https://www.rfc-editor.org/rfc/rfc8785>, <https://github.com/cyberphone/json-canonicalization>.
