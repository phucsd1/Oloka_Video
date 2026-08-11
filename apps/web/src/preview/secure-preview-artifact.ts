export const OLOKA_PREVIEW_ADAPTER_VERSION = "2" as const;
export const OLOKA_PREVIEW_CSP_PROFILE_VERSION = 1 as const;

export interface BuildSecurePreviewArtifactOptions {
  runtimeSource: string;
  compositionMarkup: string;
  compositionScript: string;
  compositionStyle: string;
}

export function buildSecurePreviewArtifact(
  options: BuildSecurePreviewArtifactOptions,
): string {
  assertInlineScript(options.runtimeSource);
  assertInlineScript(options.compositionScript);
  assertInlineStyle(options.compositionStyle);
  assertTrustedCompositionMarkup(options.compositionMarkup);

  const wrapperSource = buildChildWrapperSource();
  const scriptHashes = [
    wrapperSource,
    options.compositionScript,
    options.runtimeSource,
  ].map((source) => `'sha256-${sha256Base64(source)}'`);
  const styleHash = `'sha256-${sha256Base64(options.compositionStyle)}'`;
  const csp = [
    "default-src 'none'",
    `script-src ${scriptHashes.join(" ")}`,
    `style-src ${styleHash}`,
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

  return `<!doctype html>
<html lang="vi" data-oloka-preview-adapter-version="${OLOKA_PREVIEW_ADAPTER_VERSION}" data-oloka-csp-profile-version="${OLOKA_PREVIEW_CSP_PROFILE_VERSION}">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="referrer" content="no-referrer">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>${options.compositionStyle}</style>
</head>
<body>
  ${options.compositionMarkup}
  <script>${wrapperSource}</script>
  <script>${options.compositionScript}</script>
  <script>${options.runtimeSource}</script>
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

function buildChildWrapperSource(): string {
  return String.raw`(() => {
  "use strict";
  const protocol = "oloka-preview";
  const version = 1;
  let channel = null;
  let initialized = false;
  let tickHandle = 0;

  const post = (type, payload = {}) => {
    if (channel === null) return;
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
  const validChannel = (value) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
  const validCommand = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (
      value.protocol !== protocol ||
      value.version !== version ||
      value.direction !== "parent-to-preview" ||
      typeof value.type !== "string" ||
      !validChannel(value.channel)
    ) return false;
    const base = ["protocol", "version", "channel", "direction", "type"];
    if (channel === null) return value.type === "initialize" && exactKeys(value, base);
    if (value.channel !== channel || value.type === "initialize") return false;
    if (["play", "pause"].includes(value.type)) return exactKeys(value, base);
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
    if (!runtime) return;
    if (command.type === "initialize") {
      channel = command.channel;
      initialized = true;
      runtime.pause?.();
      const durationSeconds = duration();
      post("duration", { durationSeconds });
      post("ready", { durationSeconds });
      emitTime();
      return;
    }
    if (!initialized) return;
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

function sha256Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const words = new Uint32Array(64);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const constants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const rotateRight = (word: number, bits: number) =>
    (word >>> bits) | (word << (32 - bits));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1)
      words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15]!;
      const previous2 = words[index - 2]!;
      const sigma0 =
        rotateRight(previous15, 7) ^
        rotateRight(previous15, 18) ^
        (previous15 >>> 3);
      const sigma1 =
        rotateRight(previous2, 17) ^
        rotateRight(previous2, 19) ^
        (previous2 >>> 10);
      words[index] =
        (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 =
        rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temporary1 =
        (h! + sum1 + choice + constants[index]! + words[index]!) >>> 0;
      const sum0 =
        rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0;
    hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0;
    hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0;
    hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0;
    hash[7] = (hash[7]! + h!) >>> 0;
  }
  const output = new Uint8Array(32);
  const outputView = new DataView(output.buffer);
  hash.forEach((word, index) => outputView.setUint32(index * 4, word));
  let binary = "";
  output.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary);
}
