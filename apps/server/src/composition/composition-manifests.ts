import type { CompositionDocumentV1 } from "@oloka/contracts";
import type { AssetRow } from "../database/repositories/asset-repository.js";
import { sha256CanonicalJson } from "../kernel/canonical-json.js";
import { ApplicationError } from "../http/application-error.js";

export const MATERIALIZER_VERSION = "oloka-composition-v1.0.0";
export const RENDERER_VERSION = "oloka-browser-v1";
export const RENDER_PROTOCOL_VERSION = 1;
export const HYPERFRAMES_VERSION = "0.7.104" as const;
export const HYPERFRAMES_RUNTIME_SHA256 =
  "a61e40e57329eeb9941c35ff9dac3ed8f0abfcee3246d2c5bfa2332e2df0c0c0";
export const OLOKA_FONT_SHA256 =
  "bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d";
export const TEMPLATE_REGISTRY_VERSION = "oloka-registry-v1";
export const CSP_PROFILE_VERSION = 1;

export interface ResolvedAsset {
  id: string;
  usage: "visual" | "audio" | "font";
  kind: "image" | "video" | "audio" | "font";
  mime: string;
  byteSize: number;
  checksumSha256: string;
  storageKey: string;
}

export interface FrozenCompositionManifests {
  dependency: {
    schemaVersion: 1;
    registryVersion: string;
    entries: Array<{ id: string; version: string }>;
  };
  asset: {
    schemaVersion: 1;
    entries: Array<Omit<ResolvedAsset, "storageKey">>;
  };
  font: {
    schemaVersion: 1;
    entries: Array<{
      token: string;
      family: string;
      version: string;
      checksumSha256: string;
    }>;
  };
  caption: {
    schemaVersion: 1;
    preset: "Clean" | "Bold";
    implementationVersion: string;
  };
  runtime: {
    schemaVersion: 1;
    materializerVersion: string;
    rendererVersion: string;
    renderProtocolVersion: number;
    hyperframesVersion: "0.7.104";
    hyperframesRuntimeSha256: string;
    templateRegistryVersion: string;
    cspProfileVersion: number;
  };
}

export interface ManifestResolution {
  document: CompositionDocumentV1;
  assets: ResolvedAsset[];
  manifests: FrozenCompositionManifests;
  hashes: {
    dependencyManifestHash: string;
    assetManifestHash: string;
    fontManifestHash: string;
    captionManifestHash: string;
    runtimeManifestHash: string;
  };
}

export function collectCompositionAssetReferences(
  document: CompositionDocumentV1,
): Array<{ assetId: string; usage: "visual" | "audio" | "font" }> {
  const references = new Map<
    string,
    { assetId: string; usage: "visual" | "audio" | "font" }
  >();
  const add = (assetId: string, usage: "visual" | "audio" | "font") =>
    references.set(`${usage}:${assetId}`, { assetId, usage });
  for (const scene of document.scenes) {
    for (const reference of scene.assetReferences)
      add(reference.assetId, reference.usage);
    for (const track of scene.tracks) {
      for (const clip of track.clips) {
        if (clip.kind === "asset") add(clip.assetId, "visual");
        if (clip.kind === "audio") add(clip.assetId, "audio");
      }
    }
  }
  if (document.bgmConfig !== null) add(document.bgmConfig.assetId, "audio");
  return [...references.values()].sort(
    (left, right) =>
      left.usage.localeCompare(right.usage) ||
      left.assetId.localeCompare(right.assetId),
  );
}

export function resolveCompositionManifests(
  document: CompositionDocumentV1,
  assetRows: AssetRow[],
): ManifestResolution {
  const references = collectCompositionAssetReferences(document);
  const rows = new Map(assetRows.map((row) => [row.id, row]));
  for (const scene of document.scenes) {
    for (const track of scene.tracks) {
      for (const clip of track.clips) {
        if (
          clip.kind === "asset" &&
          rows.get(clip.assetId)?.kind !== clip.mediaKind
        )
          throw new ApplicationError(
            "COMPOSITION_INVALID",
            "composition_asset_media_kind_invalid",
          );
      }
    }
  }
  const assets = references.map((reference): ResolvedAsset => {
    const row = rows.get(reference.assetId);
    if (
      row === undefined ||
      row.project_id === "" ||
      row.ingestion_status !== "ready" ||
      row.lifecycle_status !== "active" ||
      row.byte_size === null ||
      row.byte_checksum_sha256 === null ||
      row.verified_mime === null
    ) {
      throw new ApplicationError(
        "ASSET_UNAVAILABLE",
        "composition_asset_unavailable",
      );
    }
    const compatible =
      (reference.usage === "visual" &&
        (row.kind === "image" || row.kind === "video")) ||
      (reference.usage === "audio" && row.kind === "audio") ||
      (reference.usage === "font" && row.kind === "font");
    if (!compatible)
      throw new ApplicationError(
        "COMPOSITION_INVALID",
        "composition_asset_usage_invalid",
      );
    return {
      id: row.id,
      usage: reference.usage,
      kind: row.kind,
      mime: row.verified_mime,
      byteSize: row.byte_size,
      checksumSha256: row.byte_checksum_sha256,
      storageKey: row.storage_key,
    };
  });
  const templates = new Set<string>();
  for (const scene of document.scenes)
    for (const track of scene.tracks)
      for (const clip of track.clips)
        if (clip.kind === "scene") templates.add(clip.templateId);
  const manifests: FrozenCompositionManifests = {
    dependency: {
      schemaVersion: 1,
      registryVersion: TEMPLATE_REGISTRY_VERSION,
      entries: [...templates].sort().map((id) => ({ id, version: "1" })),
    },
    asset: {
      schemaVersion: 1,
      entries: assets.map((asset) => {
        const manifestAsset: Partial<ResolvedAsset> = { ...asset };
        delete manifestAsset.storageKey;
        return manifestAsset as Omit<ResolvedAsset, "storageKey">;
      }),
    },
    font: {
      schemaVersion: 1,
      entries: [
        {
          token: "oloka-display-v1",
          family: "Oloka Sans",
          version: "noto-sans-vf-2026-08-11",
          checksumSha256: OLOKA_FONT_SHA256,
        },
        {
          token: "oloka-sans-v1",
          family: "Oloka Sans",
          version: "noto-sans-vf-2026-08-11",
          checksumSha256: OLOKA_FONT_SHA256,
        },
      ],
    },
    caption: {
      schemaVersion: 1,
      preset: document.captionConfig.preset,
      implementationVersion: "oloka-caption-v1",
    },
    runtime: {
      schemaVersion: 1,
      materializerVersion: MATERIALIZER_VERSION,
      rendererVersion: RENDERER_VERSION,
      renderProtocolVersion: RENDER_PROTOCOL_VERSION,
      hyperframesVersion: HYPERFRAMES_VERSION,
      hyperframesRuntimeSha256: HYPERFRAMES_RUNTIME_SHA256,
      templateRegistryVersion: TEMPLATE_REGISTRY_VERSION,
      cspProfileVersion: CSP_PROFILE_VERSION,
    },
  };
  const hashes = {
    dependencyManifestHash: sha256CanonicalJson(manifests.dependency),
    assetManifestHash: sha256CanonicalJson(manifests.asset),
    fontManifestHash: sha256CanonicalJson(manifests.font),
    captionManifestHash: sha256CanonicalJson(manifests.caption),
    runtimeManifestHash: sha256CanonicalJson(manifests.runtime),
  };
  return {
    assets,
    manifests,
    hashes,
    document: {
      ...document,
      manifests: {
        dependency: {
          schemaVersion: 1,
          hashSha256: hashes.dependencyManifestHash,
        },
        asset: { schemaVersion: 1, hashSha256: hashes.assetManifestHash },
        font: { schemaVersion: 1, hashSha256: hashes.fontManifestHash },
        caption: { schemaVersion: 1, hashSha256: hashes.captionManifestHash },
      },
      runtimeVersions: {
        materializer: MATERIALIZER_VERSION,
        renderer: RENDERER_VERSION,
        renderProtocol: RENDER_PROTOCOL_VERSION,
        hyperframes: HYPERFRAMES_VERSION,
        hyperframesRuntimeSha256: HYPERFRAMES_RUNTIME_SHA256,
        templateRegistry: TEMPLATE_REGISTRY_VERSION,
      },
    },
  };
}

export function buildRenderContractFingerprint(input: {
  bundleChecksum: string;
  compositionSchemaVersion: number;
  renderProtocolVersion: number;
  rendererVersion: string;
  hyperframesVersion: string;
  dependencyManifestHash: string;
  assetManifestHash: string;
  fontManifestHash: string;
  captionManifestHash: string;
}): string {
  return sha256CanonicalJson({ schemaVersion: 1, ...input });
}
