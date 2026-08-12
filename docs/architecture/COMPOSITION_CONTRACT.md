# Structured Composition Contract

## Canonical model

A CompositionVersion is immutable structured data. HTML/CSS/JavaScript may be generated as a render artifact by trusted adapters, but is not accepted as the canonical edit interface and is never directly edited by users.

The minimum document contains:

| Area         | Required contract                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------- |
| Identity     | `schemaVersion`, Project lineage, deterministic scene IDs within the version                       |
| Canvas       | `aspectRatio` from allowed presets; requested dimensions remain within quota                       |
| Scenes       | Ordered list with text, duration, allowed style fields, and Asset ID references                    |
| Voice        | Provider-independent voice capability/config reference                                             |
| Captions     | `enabled`, preset `Clean` or `Bold`, safe margins, wrapping/line limits, font manifest reference   |
| BGM          | Nullable audio Asset ID, volume, and basic ducking configuration                                   |
| Dependencies | Frozen registry/dependency manifest with content/version identifiers and manifest hash             |
| Assets       | Frozen manifest resolving owned `ready + active` Asset IDs to immutable object/checksum references |
| Runtime      | Renderer, HyperFrames, render protocol, font and caption manifest versions                         |

Runtime provenance is separate from the canonical document: Phase 3F.0 pins
the reviewed HyperFrames `0.7.104` runtime bytes and adapter fingerprint in
`third_party/hyperframes/PROVENANCE.json`. The official player/core package
graph is not part of the production dependency path.

## Structured edit operations

MVP permits changing scene text, duration, order, scene Asset references, voice, caption on/off/preset, aspect ratio, BGM Asset/volume, and schema-allowlisted style fields. Each accepted edit validates the whole document and creates a new CompositionVersion. It does not mutate the previous version.

MVP rejects direct HTML, CSS, DOM mutation, arbitrary JavaScript/code, unknown style fields, external URLs, cross-project assets, assets not in `ready + active`, arbitrary font URLs, and dependency entries not resolved through the manifest service.

## Validation

Validation is layered:

1. Schema and supported version.
2. Project/owner lineage for every Asset reference.
3. Duration/resolution/quota limits.
4. Scene order and unique IDs.
5. Caption/BGM/voice constraints.
6. Dependency, font, asset, caption, renderer, HyperFrames, and protocol manifest compatibility.
7. Deterministic materialization preflight.

Failures use `COMPOSITION_INVALID`, `ASSET_UNAVAILABLE`, `DEPENDENCY_MISSING`,
`QUOTA_EXCEEDED`, `RESOURCE_STATE_CONFLICT`, or `VERSION_CONFLICT`. Safe field
paths may be returned; generated source, internal prompts, secrets, and storage
paths may not.

## Version creation

Version numbers are monotonically increasing per Project and assigned transactionally. `createdByUserId` is present for edits; `createdByJobId` is present for generated versions; both may be present when a user command caused a job. The Project pointer changes only after the new version is durable and valid.

## Preview and render

Both operations consume the exact same CompositionVersion ID and frozen manifests. Materialization records `bundleChecksum`, `compositionSchemaVersion`, `renderProtocolVersion`, `rendererVersion`, `hyperframesVersion`, `dependencyManifestHash`, `assetManifestHash`, `fontManifestHash`, and `captionManifestHash`. A versioned canonical serialization of those values deterministically produces `renderContractFingerprint`.

The lineage values and fingerprint are stored directly in the immutable RenderOutput snapshot; larger manifests remain immutable references addressed by hash. Preview is read-only and reports the same fingerprint that final render must use. Any setting change creates a new version before preview/render. Provider adapters reject incompatible protocol or lineage before submission. See `PREVIEW_RENDER_PARITY.md`.
