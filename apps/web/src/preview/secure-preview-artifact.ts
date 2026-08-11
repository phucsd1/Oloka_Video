import { previewChannelSchema } from "./secure-preview-protocol";

export const OLOKA_PREVIEW_ADAPTER_VERSION = "1" as const;

export interface BuildSecurePreviewArtifactOptions {
  channel: string;
  nonce: string;
  runtimeSource: string;
  compositionMarkup: string;
  compositionScript: string;
  compositionStyle: string;
}

export function buildSecurePreviewArtifact(
  options: BuildSecurePreviewArtifactOptions,
): string {
  previewChannelSchema.parse(options.channel);
  if (!/^[A-Za-z0-9+/_=-]{16,}$/.test(options.nonce)) {
    throw new Error("Preview nonce is invalid");
  }
  assertInlineScript(options.runtimeSource);
  assertInlineScript(options.compositionScript);
  assertInlineStyle(options.compositionStyle);
  assertTrustedCompositionMarkup(options.compositionMarkup);

  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${options.nonce}'`,
    `style-src 'nonce-${options.nonce}'`,
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
  const wrapperSource = buildChildWrapperSource(options.channel);

  return `<!doctype html>
<html lang="vi" data-oloka-preview-adapter-version="${OLOKA_PREVIEW_ADAPTER_VERSION}">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="referrer" content="no-referrer">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style nonce="${options.nonce}">${options.compositionStyle}</style>
</head>
<body>
  ${options.compositionMarkup}
  <script nonce="${options.nonce}">${wrapperSource}</script>
  <script nonce="${options.nonce}">${options.compositionScript}</script>
  <script nonce="${options.nonce}">${options.runtimeSource}</script>
</body>
</html>`;
}

function assertInlineScript(source: string): void {
  if (/<\/script/i.test(source)) {
    throw new Error("Inline script contains a closing script tag");
  }
}

function assertInlineStyle(source: string): void {
  if (/<\/style/i.test(source)) {
    throw new Error("Inline style contains a closing style tag");
  }
}

function assertTrustedCompositionMarkup(markup: string): void {
  const forbidden =
    /<(?:script|iframe|frame|object|embed|link|meta|base|form)\b|\son[a-z]+\s*=|javascript:|https?:\/\//i;
  if (forbidden.test(markup)) {
    throw new Error("Composition markup contains forbidden active content");
  }
}

function buildChildWrapperSource(channelValue: string): string {
  return String.raw`(() => {
  "use strict";
  const protocol = "oloka-preview";
  const version = 1;
  const channel = ${JSON.stringify(channelValue)};
  let initialized = false;
  let tickHandle = 0;

  const post = (type, payload = {}) => {
    parent.postMessage({
      protocol,
      version,
      channel,
      direction: "preview-to-parent",
      type,
      ...payload,
    }, "*");
  };

  const runtimeError = (code) => post("safeRuntimeError", { code });
  const player = () => window.__player;
  const duration = () => Math.max(0, Number(player()?.getDuration?.()) || 0);
  const currentTime = () => Math.max(0, Number(player()?.getTime?.()) || 0);
  const exactKeys = (value, keys) => {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  };
  const validCommand = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (
      value.protocol !== protocol ||
      value.version !== version ||
      value.channel !== channel ||
      value.direction !== "parent-to-preview" ||
      typeof value.type !== "string"
    ) return false;
    const base = ["protocol", "version", "channel", "direction", "type"];
    if (["initialize", "play", "pause"].includes(value.type)) return exactKeys(value, base);
    if (value.type === "seek") {
      return exactKeys(value, [...base, "timeSeconds"]) && Number.isFinite(value.timeSeconds) && value.timeSeconds >= 0;
    }
    if (value.type === "setPlaybackRate") {
      return exactKeys(value, [...base, "playbackRate"]) && Number.isFinite(value.playbackRate) && value.playbackRate >= 0.25 && value.playbackRate <= 4;
    }
    if (value.type === "setMuted") {
      return exactKeys(value, [...base, "muted"]) && typeof value.muted === "boolean";
    }
    return false;
  };

  document.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a[href]")) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  const stopTicks = () => {
    if (tickHandle) cancelAnimationFrame(tickHandle);
    tickHandle = 0;
  };
  const emitTime = () => post("timeUpdate", { timeSeconds: currentTime() });
  const tick = () => {
    emitTime();
    if (player()?.isPlaying?.()) {
      if (duration() > 0 && currentTime() >= duration()) {
        stopTicks();
        post("ended");
        return;
      }
      tickHandle = requestAnimationFrame(tick);
    } else {
      tickHandle = 0;
    }
  };

  const handleCommand = (command) => {
    const runtime = player();
    if (!runtime) {
      runtimeError("RUNTIME_UNAVAILABLE");
      return;
    }
    if (command.type === "initialize") {
      initialized = true;
      runtime.pause?.();
      const durationSeconds = duration();
      post("duration", { durationSeconds });
      post("ready", { durationSeconds });
      emitTime();
      return;
    }
    if (!initialized) {
      runtimeError("INVALID_COMMAND");
      return;
    }
    if (command.type === "play") {
      runtime.play?.();
      stopTicks();
      tick();
    } else if (command.type === "pause") {
      runtime.pause?.();
      stopTicks();
      emitTime();
    } else if (command.type === "seek") {
      (runtime.renderSeek ?? runtime.seek)?.call(runtime, command.timeSeconds);
      emitTime();
    } else if (command.type === "setPlaybackRate") {
      runtime.setPlaybackRate?.(command.playbackRate);
    } else if (command.type === "setMuted") {
      document.querySelectorAll("audio,video").forEach((element) => {
        element.muted = command.muted;
      });
    }
  };

  window.addEventListener("message", (event) => {
    event.stopImmediatePropagation();
    if (event.source !== parent || !validCommand(event.data)) return;
    try {
      handleCommand(event.data);
    } catch {
      runtimeError("RUNTIME_FAILURE");
    }
  }, true);
})();`;
}
