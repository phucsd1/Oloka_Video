# Preview and Render Parity

## Contract

Preview and final render consume the same immutable CompositionVersion ID and the same frozen:

- composition schema version;
- renderer and HyperFrames versions;
- render protocol version;
- registry/dependency manifest;
- font manifest;
- asset manifest and checksums;
- caption implementation/preset version;
- runtime assumptions including aspect ratio, dimensions, timing, codecs, and browser/runtime capability profile.

There is one preview contract and one final-render contract sharing the same materialization pipeline. The UI does not maintain static-project, child-preview, and Studio-specific composition paths.

## Preview behavior

Preview is read-only and renders the currently selected CompositionVersion. Any editor change creates a new version first. Preview may use a lower execution scale for responsiveness only when timing/layout semantics remain identical and the difference is declared in preview metadata. It never mutates canonical content or resolves missing dependencies differently from render.

## Preflight, manifests, and canonical lineage

Before preview or render, the system validates supported versions, resolves all dependencies, fonts, captions and assets, verifies ownership, `ready + active` status and checksums, and materializes a content-addressed bundle.

Canonical render lineage consists of `bundleChecksum`, `compositionSchemaVersion`, `renderProtocolVersion`, `rendererVersion`, `hyperframesVersion`, `dependencyManifestHash`, `assetManifestHash`, `fontManifestHash`, and `captionManifestHash`. `renderContractFingerprint` is a deterministic hash of a canonically serialized, versioned structure containing exactly those values. The serialization order, normalization rules, and hash algorithm are fixed by `renderProtocolVersion`.

Preview metadata, preflight, RenderJob, and RenderOutput record and compare the same fingerprint. Lineage scalars/hashes are stored directly in the immutable output snapshot; the bundle and larger immutable manifests are referenced by hash. A provider adapter rejects incompatible protocol versions or any lineage mismatch before submission.

A preview artifact identity includes CompositionVersion, render-contract
fingerprint, materializer version, HyperFrames version through the fingerprint,
and CSP profile version. Upgrading materializer, HyperFrames, CSP, registry, or
any manifest creates a new immutable artifact generation. Historical artifacts
remain addressable under retention and are never overwritten.

## Drift prevention

- A mismatch in schema, dependency, font, caption, renderer, HyperFrames, protocol, bundle, asset checksum, or render contract fingerprint fails with a typed error; no silent fallback.
- Modal performs a capability/version handshake before accepting the bundle.
- Font fallback is forbidden unless explicitly included in the versioned manifest.
- Registry dependencies are fully materialized before narration/render submission.
- Golden frame and Vietnamese caption fixtures compare preview and render at representative timestamps.

## Acceptance evidence

Contract tests assert deterministic fingerprints and identical lineage/materialization inputs across preview, preflight, adapter, and verification. Provider-sandbox tests assert Modal rejects incompatible protocol/runtime versions and mismatched lineage. Visual fixtures cover layout, safe margins, wrapping, BGM/voice timing, and reduced-motion UI behavior (the rendered composition itself follows its explicit motion contract).
