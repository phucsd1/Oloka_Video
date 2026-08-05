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

## Preflight and manifests

Before preview or render, the system validates supported versions, resolves all dependencies, fonts and assets, verifies ownership/readiness/checksums, and materializes a content-addressed bundle. The parity fingerprint hashes the version identifiers and manifests. Preview metadata, RenderJob, and RenderOutput record that fingerprint.

## Drift prevention

- A mismatch in schema, dependency, font, caption, renderer, HyperFrames, protocol, or asset checksum fails with a typed error; no silent fallback.
- Modal performs a capability/version handshake before accepting the bundle.
- Font fallback is forbidden unless explicitly included in the versioned manifest.
- Registry dependencies are fully materialized before narration/render submission.
- Golden frame and Vietnamese caption fixtures compare preview and render at representative timestamps.

## Acceptance evidence

Contract tests assert identical fingerprints and materialization inputs. Provider-sandbox tests assert Modal rejects incompatible protocol/runtime versions. Visual fixtures cover layout, safe margins, wrapping, BGM/voice timing, and reduced-motion UI behavior (the rendered composition itself follows its explicit motion contract).
