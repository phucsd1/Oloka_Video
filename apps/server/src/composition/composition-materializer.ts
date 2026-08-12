import type {
  CompositionClipV1,
  CompositionDocumentV1,
} from "@oloka/contracts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  HYPERFRAMES_RUNTIME_SHA256,
  OLOKA_FONT_SHA256,
} from "./composition-manifests.js";

export interface MaterializedAssetBytes {
  id: string;
  mime: string;
  bytes: Uint8Array;
}

export interface MaterializedComposition {
  bytes: Uint8Array;
  checksumSha256: string;
}

const MATERIALIZATION_STAGES = [
  "load-runtime",
  "load-font",
  "encode-assets",
  "build-style",
  "build-markup",
  "build-script",
  "build-csp",
  "encode-html",
] as const;
type MaterializationStage = (typeof MATERIALIZATION_STAGES)[number];

export function readMaterializationStage(
  error: unknown,
): MaterializationStage | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const stage = (error as { materializationStage?: unknown })
    .materializationStage;
  return typeof stage === "string" &&
    MATERIALIZATION_STAGES.includes(stage as MaterializationStage)
    ? (stage as MaterializationStage)
    : undefined;
}

export async function materializeCompositionPreview(
  document: CompositionDocumentV1,
  assets: MaterializedAssetBytes[],
): Promise<MaterializedComposition> {
  let stage: MaterializationStage = "load-runtime";
  try {
    const runtimeSource = await loadRuntimeSource();
    stage = "load-font";
    const fontDataUrl = await loadFontDataUrl();
    stage = "encode-assets";
    const dataUrls = Object.fromEntries(
      [...assets]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((asset) => [
          asset.id,
          `data:${asset.mime};base64,${Buffer.from(asset.bytes).toString("base64")}`,
        ]),
    );
    stage = "build-style";
    const style = buildStyle(document, fontDataUrl);
    stage = "build-markup";
    const markup = buildMarkup(document, dataUrls);
    stage = "build-script";
    const compositionScript = buildCompositionScript(document);
    const wrapperScript = buildPreviewWrapperScript();
    stage = "build-csp";
    const csp = [
      "default-src 'none'",
      `script-src ${[wrapperScript, compositionScript, runtimeSource].map(cspHash).join(" ")}`,
      `style-src ${cspHash(style)}`,
      "img-src data: blob:",
      "media-src data: blob:",
      "font-src data:",
      "connect-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "navigate-to 'none'",
    ].join("; ");
    stage = "encode-html";
    const html = `<!doctype html>
<html lang="vi" data-oloka-preview-adapter-version="2" data-oloka-csp-profile-version="1">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="referrer" content="no-referrer">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>${style}</style>
</head>
<body>
${markup}
<script>${wrapperScript}</script>
<script>${compositionScript}</script>
<script>${runtimeSource}</script>
</body>
</html>`;
    const bytes = new TextEncoder().encode(html);
    return { bytes, checksumSha256: sha256(bytes) };
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      Object.defineProperty(error, "materializationStage", {
        value: stage,
        enumerable: false,
      });
    }
    throw error;
  }
}

let runtimePromise: Promise<string> | undefined;
async function loadRuntimeSource(): Promise<string> {
  runtimePromise ??= readFile(
    new URL(
      "../../../../third_party/hyperframes/v0.7.104/hyperframe.runtime.iife.js",
      import.meta.url,
    ),
    "utf8",
  ).then((source) => {
    if (
      Buffer.byteLength(source) !== 342_023 ||
      sha256(source) !== HYPERFRAMES_RUNTIME_SHA256
    )
      throw new Error("Vendored HyperFrames runtime integrity mismatch");
    if (/<\/script/i.test(source))
      throw new Error("Vendored runtime cannot be embedded safely");
    return source;
  });
  return runtimePromise;
}

let fontPromise: Promise<string> | undefined;
async function loadFontDataUrl(): Promise<string> {
  fontPromise ??= readFile(
    new URL(
      "../../../../third_party/fonts/noto-sans/NotoSans-VF.ttf",
      import.meta.url,
    ),
  ).then((bytes) => {
    if (bytes.byteLength !== 2_049_096 || sha256(bytes) !== OLOKA_FONT_SHA256)
      throw new Error("Vendored Oloka font integrity mismatch");
    return `data:font/ttf;base64,${bytes.toString("base64")}`;
  });
  return fontPromise;
}

function buildStyle(
  document: CompositionDocumentV1,
  fontDataUrl: string,
): string {
  const caption = document.captionConfig;
  const clipRules = document.scenes
    .flatMap((scene) => scene.tracks.flatMap((track) => track.clips))
    .map((clip) => {
      const bounds = "bounds" in clip ? clip.bounds : undefined;
      const boundsRule =
        bounds === undefined
          ? ""
          : `left:${(bounds.x * 100).toFixed(4)}%;top:${(bounds.y * 100).toFixed(4)}%;width:${(bounds.width * 100).toFixed(4)}%;height:${(bounds.height * 100).toFixed(4)}%;`;
      const typography =
        clip.kind === "text"
          ? `font-family:${clip.typography.fontToken === "oloka-display-v1" ? "Oloka Display" : "Oloka Sans"};font-size:${clip.typography.size}px;font-weight:${clip.typography.weight};line-height:${clip.typography.lineHeight};text-align:${clip.typography.align};color:${clip.typography.color};-webkit-line-clamp:${clip.typography.maxLines};overflow:${clip.typography.overflow === "clip" ? "hidden" : "visible"};`
          : "";
      const shape =
        clip.kind === "shape"
          ? `background:${clip.fill};border:${clip.stroke === null ? "0" : `${clip.strokeWidth}px solid ${clip.stroke}`};border-radius:${clip.primitive === "ellipse" ? "50%" : `${clip.radius}px`};`
          : "";
      const media =
        clip.kind === "asset"
          ? `object-fit:${clip.fit};object-position:${(clip.focalPoint.x * 100).toFixed(2)}% ${(clip.focalPoint.y * 100).toFixed(2)}%;`
          : "";
      return `[data-clip-id="${clip.id}"]{${boundsRule}${typography}${shape}${media}}`;
    })
    .join("");
  return `
@font-face{font-family:"Oloka Sans";src:url(${fontDataUrl}) format("truetype");font-style:normal;font-weight:100 900;font-display:block}
@font-face{font-family:"Oloka Display";src:url(${fontDataUrl}) format("truetype");font-style:normal;font-weight:100 900;font-display:block}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${document.background};font-family:"Oloka Sans",sans-serif}
#oloka-stage{position:relative;width:${document.width}px;height:${document.height}px;overflow:hidden;background:${document.background};transform-origin:top left}
.oloka-scene{position:absolute;inset:0;display:none;overflow:hidden;color:#fff}
.oloka-scene[data-active="true"]{display:block}
.oloka-visual{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.oloka-copy{position:absolute;inset:${caption.safeMarginPercent}%;display:grid;place-content:center;text-align:center;font-size:${Math.round(document.height * 0.055)}px;line-height:1.15;white-space:pre-wrap}
.oloka-caption{position:absolute;left:${caption.safeMarginPercent}%;right:${caption.safeMarginPercent}%;bottom:${caption.safeMarginPercent}%;text-align:center;font-size:${Math.round(document.height * 0.04)}px;line-height:1.2;font-weight:${caption.preset === "Bold" ? 800 : 600};text-shadow:0 2px 8px #000;display:-webkit-box;-webkit-line-clamp:${caption.maxLines};-webkit-box-orient:vertical;overflow:hidden}
.oloka-caption[data-preset="Bold"]{background:#ffd23f;color:#101010;padding:.18em .42em;text-shadow:none}
.oloka-clip{position:absolute;display:none;box-sizing:border-box;transform-origin:center center;white-space:pre-wrap}
.oloka-clip[data-active="true"]{display:block}
.oloka-clip[data-kind="shape"]{min-width:1px;min-height:1px}
.oloka-clip[data-kind="asset"]{object-fit:cover}
audio{display:none}
${clipRules}`;
}

function buildMarkup(
  document: CompositionDocumentV1,
  dataUrls: Record<string, string>,
): string {
  const scenes = document.scenes
    .map((scene) => {
      const visual = scene.assetReferences.find(
        (reference) => reference.usage === "visual",
      );
      const visualMarkup =
        visual === undefined || dataUrls[visual.assetId] === undefined
          ? ""
          : `<img class="oloka-visual" alt="" src="${dataUrls[visual.assetId]}">`;
      const caption = document.captionConfig.enabled
        ? `<div class="oloka-caption" data-preset="${document.captionConfig.preset}">${escapeHtml(scene.text)}</div>`
        : "";
      const clips = scene.tracks
        .flatMap((track) => track.clips)
        .sort(
          (left, right) =>
            left.startMs - right.startMs ||
            left.layerOrder - right.layerOrder ||
            left.id.localeCompare(right.id),
        )
        .map((clip) => buildClipMarkup(clip, scene.text, dataUrls))
        .join("");
      return `<section class="oloka-scene" data-scene-id="${scene.id}" data-start-ms="${scene.startMs}" data-duration-ms="${scene.durationMs}">${visualMarkup}<div class="oloka-copy">${escapeHtml(scene.text)}</div>${caption}${clips}</section>`;
    })
    .join("");
  const bgm =
    document.bgmConfig === null ||
    dataUrls[document.bgmConfig.assetId] === undefined
      ? ""
      : `<audio id="oloka-bgm" preload="auto" src="${dataUrls[document.bgmConfig.assetId]}" data-volume="${document.bgmConfig.volume}"></audio>`;
  return `<main id="oloka-stage" data-composition-id="${document.compositionId}" data-width="${document.width}" data-height="${document.height}" data-start="0" data-duration="${document.durationMs / 1000}">${scenes}${bgm}</main>`;
}

function buildClipMarkup(
  clip: CompositionClipV1,
  sceneText: string,
  dataUrls: Record<string, string>,
): string {
  const base = `class="oloka-clip" data-clip-id="${clip.id}" data-kind="${clip.kind}" data-start-ms="${clip.startMs}" data-duration-ms="${clip.durationMs}" data-active="false"`;
  if (clip.kind === "asset") {
    const source = dataUrls[clip.assetId] ?? "";
    return clip.mediaKind === "video"
      ? `<video ${base} muted playsinline preload="auto" src="${source}"></video>`
      : `<img ${base} alt="" src="${source}">`;
  }
  if (clip.kind === "text")
    return `<div ${base}>${escapeHtml(clip.text)}</div>`;
  if (clip.kind === "shape") return `<div ${base} aria-hidden="true"></div>`;
  if (clip.kind === "caption")
    return `<div ${base} data-preset="${clip.preset}">${escapeHtml(sceneText)}</div>`;
  if (clip.kind === "audio")
    return `<audio ${base} preload="auto" src="${dataUrls[clip.assetId] ?? ""}" data-gain="${clip.gain}" data-trim-start-ms="${clip.trimStartMs}" data-fade-in-ms="${clip.fadeInMs}" data-fade-out-ms="${clip.fadeOutMs}"></audio>`;
  const variables = Object.entries(clip.variables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(" | ");
  return `<div ${base} data-template-id="${clip.templateId}"><strong>${escapeHtml(variables || clip.templateId)}</strong></div>`;
}

function buildCompositionScript(document: CompositionDocumentV1): string {
  const timeline = document.scenes.map((scene) => ({
    id: scene.id,
    startMs: scene.startMs,
    durationMs: scene.durationMs,
    narration:
      scene.narration === null || scene.narration.silence
        ? null
        : {
            startMs: scene.startMs,
            endMs: scene.startMs + scene.durationMs,
          },
  }));
  const clips = document.scenes.flatMap((scene) =>
    scene.tracks.flatMap((track) =>
      track.clips.map((clip) => ({
        id: clip.id,
        startMs: clip.startMs,
        durationMs: clip.durationMs,
        transitionIn: clip.transitionIn ?? null,
        transitionOut: clip.transitionOut ?? null,
        animations: clip.animations,
        kind: clip.kind,
        gain: clip.kind === "audio" ? clip.gain : null,
        trimStartMs: clip.kind === "audio" ? clip.trimStartMs : 0,
        fadeInMs: clip.kind === "audio" ? clip.fadeInMs : 0,
        fadeOutMs: clip.kind === "audio" ? clip.fadeOutMs : 0,
      })),
    ),
  );
  const bgm = document.bgmConfig;
  return `(() => {
  "use strict";
  const durationSeconds = ${JSON.stringify(document.durationMs / 1000)};
  const scenes = ${safeScriptJson(timeline)};
  const clips = ${safeScriptJson(clips)};
  const bgmConfig = ${safeScriptJson(bgm)};
  let currentTime = 0;
  let playing = false;
  let playbackRate = 1;
  const ease = (value, kind) => kind === "ease-in" ? value * value : kind === "ease-out" ? 1 - (1 - value) * (1 - value) : kind === "ease-in-out" ? value < .5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2 : value;
  const interpolate = (frames, progress) => { const first = frames[0], last = frames[frames.length - 1]; if (progress <= first.offset) return first.value; if (progress >= last.offset) return last.value; for (let index = 1; index < frames.length; index += 1) { const right = frames[index], left = frames[index - 1]; if (progress <= right.offset) { const span = right.offset - left.offset; const ratio = ease((progress - left.offset) / span, "linear"); return left.value + (right.value - left.value) * ratio; } } return last.value; };
  const transitionProgress = (local, length, transition, incoming) => { if (!transition || transition.type === "none" || transition.durationMs === 0) return 1; const ratio = Math.max(0, Math.min(1, local / transition.durationMs)); return incoming ? ease(ratio, transition.easing) : ease(Math.max(0, Math.min(1, (length - local) / transition.durationMs)), transition.easing); };
  const setMedia = (element, seconds, volume, shouldPlay) => { if (!(element instanceof HTMLMediaElement)) return; if (Math.abs(element.currentTime - seconds) > .05) element.currentTime = Math.max(0, seconds); element.volume = Math.max(0, Math.min(1, volume)); if (shouldPlay) void element.play().catch(() => undefined); else element.pause(); };
  const render = (seconds) => {
    currentTime = Math.max(0, Math.min(durationSeconds, Number(seconds) || 0));
    const milliseconds = currentTime * 1000;
    document.querySelectorAll(".oloka-scene").forEach((element) => {
      const definition = scenes.find((scene) => scene.id === element.dataset.sceneId);
      const active = definition && milliseconds >= definition.startMs && milliseconds < definition.startMs + definition.durationMs;
      element.dataset.active = active ? "true" : "false";
      if (active) {
        const local = milliseconds - definition.startMs;
        const edge = Math.min(1, local / 300, (definition.durationMs - local) / 300);
        element.style.opacity = String(Math.max(0, edge).toFixed(6));
      }
    });
    const narrationActive = scenes.some((scene) => scene.narration !== null && milliseconds >= scene.narration.startMs && milliseconds < scene.narration.endMs);
    document.querySelectorAll(".oloka-clip").forEach((element) => {
      const definition = clips.find((clip) => clip.id === element.dataset.clipId);
      if (!definition) return;
      const local = milliseconds - definition.startMs;
      const active = local >= 0 && local < definition.durationMs;
      element.dataset.active = active ? "true" : "false";
      if (!active) { element.style.opacity = "0"; return; }
      let opacity = 1;
      if (definition.transitionIn) opacity *= transitionProgress(local, definition.durationMs, definition.transitionIn, true);
      if (definition.transitionOut) opacity *= transitionProgress(local, definition.durationMs, definition.transitionOut, false);
      let tx = 0, ty = 0, scale = 1, rotation = 0;
      const progress = definition.durationMs === 0 ? 1 : local / definition.durationMs;
      for (const animation of definition.animations) { const value = interpolate(animation.keyframes, progress); if (animation.property === "opacity") opacity *= Math.max(0, Math.min(1, value)); else if (animation.property === "translateX") tx += value; else if (animation.property === "translateY") ty += value; else if (animation.property === "scale") scale *= value; else if (animation.property === "rotation") rotation += value; }
      if (definition.transitionIn?.type === "slide") tx += (1 - transitionProgress(local, definition.durationMs, definition.transitionIn, true)) * -${document.width * 0.12};
      element.style.opacity = String(Math.max(0, Math.min(1, opacity)).toFixed(6));
      element.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ") rotate(" + rotation + "deg)";
      if (definition.transitionIn?.type === "wipe" || definition.transitionOut?.type === "wipe") element.style.clipPath = "inset(0 " + Math.round((1 - opacity) * 100) + "% 0 0)";
      if (definition.kind === "audio") setMedia(element, (definition.trimStartMs + local) / 1000, definition.gain, playing);
    });
    const bgmElement = document.querySelector("#oloka-bgm");
    if (bgmElement instanceof HTMLMediaElement && bgmConfig !== null) setMedia(bgmElement, currentTime, narrationActive && bgmConfig.ducking.enabled ? bgmConfig.ducking.targetVolume : bgmConfig.volume, playing);
    document.querySelector("#oloka-stage").dataset.previewTime = currentTime.toFixed(6);
  };
  const timeline = {
    duration: () => durationSeconds,
    play: () => { playing = true; render(currentTime); },
    pause: () => { playing = false; render(currentTime); },
    seek: (time) => render(time),
    totalTime: (time) => render(time),
    timeScale: (rate) => { if (Number.isFinite(rate)) playbackRate = rate; return playbackRate; },
    isActive: () => playing,
    isPlaying: () => playing,
    get time() { return currentTime; },
  };
  window.__timelines = { [${JSON.stringify(document.compositionId)}]: timeline };
  render(0);
})();`;
}

function buildPreviewWrapperScript(): string {
  return `(() => {
  "use strict";
  const protocol="oloka-preview",version=1;
  let channel=null,tickHandle=0;
  const keys=(value,expected)=>{const actual=Object.keys(value).sort();expected=[...expected].sort();return actual.length===expected.length&&actual.every((key,index)=>key===expected[index])};
  const validChannel=(value)=>typeof value==="string"&&/^[a-f0-9]{32}$/.test(value);
  const valid=(value)=>{if(!value||typeof value!=="object"||Array.isArray(value)||value.protocol!==protocol||value.version!==version||value.direction!=="parent-to-preview"||!validChannel(value.channel)||typeof value.type!=="string")return false;const base=["protocol","version","channel","direction","type"];if(channel===null)return value.type==="initialize"&&keys(value,base);if(value.channel!==channel||value.type==="initialize")return false;if(["play","pause"].includes(value.type))return keys(value,base);if(value.type==="seek")return keys(value,[...base,"timeSeconds"])&&Number.isFinite(value.timeSeconds)&&value.timeSeconds>=0;if(value.type==="setPlaybackRate")return keys(value,[...base,"playbackRate"])&&Number.isFinite(value.playbackRate)&&value.playbackRate>=.25&&value.playbackRate<=4;if(value.type==="setMuted")return keys(value,[...base,"muted"])&&typeof value.muted==="boolean";return false};
  const player=()=>window.__player;
  const duration=()=>Math.max(0,Number(player()?.getDuration?.())||0);
  const time=()=>Math.max(0,Number(player()?.getTime?.())||0);
  const post=(type,payload={})=>{if(channel!==null)parent.postMessage({protocol,version,channel,direction:"preview-to-parent",type,...payload},"*")};
  const stop=()=>{if(tickHandle)cancelAnimationFrame(tickHandle);tickHandle=0};
  const tick=()=>{post("timeUpdate",{timeSeconds:time()});if(player()?.isPlaying?.()){if(duration()>0&&time()>=duration()){stop();post("ended");return}tickHandle=requestAnimationFrame(tick)}else tickHandle=0};
  addEventListener("message",(event)=>{event.stopImmediatePropagation();if(event.source!==parent||!valid(event.data))return;try{const command=event.data,runtime=player();if(!runtime)return;if(command.type==="initialize"){channel=command.channel;runtime.pause?.();const durationSeconds=duration();post("duration",{durationSeconds});post("ready",{durationSeconds});post("timeUpdate",{timeSeconds:time()});return}if(command.type==="play"){runtime.play?.();stop();tick()}else if(command.type==="pause"){runtime.pause?.();stop();post("timeUpdate",{timeSeconds:time()})}else if(command.type==="seek"){(runtime.renderSeek??runtime.seek)?.call(runtime,command.timeSeconds);post("timeUpdate",{timeSeconds:time()})}else if(command.type==="setPlaybackRate")runtime.setPlaybackRate?.(command.playbackRate);else if(command.type==="setMuted")document.querySelectorAll("audio,video").forEach((element)=>{element.muted=command.muted})}catch{post("safeRuntimeError",{code:"RUNTIME_FAILURE"})}},true);
  addEventListener("click",(event)=>{if(event.target instanceof Element&&event.target.closest("a[href]")){event.preventDefault();event.stopImmediatePropagation()}},true);
  addEventListener("submit",(event)=>{event.preventDefault();event.stopImmediatePropagation()},true);
})();`;
}

function cspHash(value: string): string {
  return `'sha256-${createHash("sha256").update(value, "utf8").digest("base64")}'`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
