import {
  parsePreviewEvent,
  PREVIEW_PROTOCOL,
  PREVIEW_PROTOCOL_VERSION,
  previewCommandSchema,
  type PreviewCommand,
  type PreviewEvent,
} from "./secure-preview-protocol";

export interface SecurePreviewController {
  iframe: HTMLIFrameElement;
  play(): void;
  pause(): void;
  seek(timeSeconds: number): void;
  setPlaybackRate(playbackRate: number): void;
  setMuted(muted: boolean): void;
  destroy(): void;
}

export interface MountSecurePreviewHostOptions {
  container: HTMLElement;
  artifactHtml: string;
  channel?: string;
  onEvent?: (event: PreviewEvent) => void;
}

type PreviewCommandInput = {
  [Type in PreviewCommand["type"]]: Omit<
    Extract<PreviewCommand, { type: Type }>,
    "protocol" | "version" | "channel" | "direction"
  >;
}[PreviewCommand["type"]];

export function mountSecurePreviewHost(
  options: MountSecurePreviewHostOptions,
): SecurePreviewController {
  const channel = options.channel ?? createPreviewChannel();
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.referrerPolicy = "no-referrer";
  iframe.title = "Oloka read-only preview";
  iframe.srcdoc = options.artifactHtml;

  const post = (command: PreviewCommandInput) => {
    const message = previewCommandSchema.parse({
      protocol: PREVIEW_PROTOCOL,
      version: PREVIEW_PROTOCOL_VERSION,
      channel,
      direction: "parent-to-preview",
      ...command,
    });
    iframe.contentWindow?.postMessage(message, "*");
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    try {
      options.onEvent?.(parsePreviewEvent(event.data, channel));
    } catch {
      // Unknown, malformed, or cross-channel messages are ignored.
    }
  };

  window.addEventListener("message", onMessage);
  iframe.addEventListener("load", () => post({ type: "initialize" }), {
    once: true,
  });
  options.container.replaceChildren(iframe);

  return {
    iframe,
    play: () => post({ type: "play" }),
    pause: () => post({ type: "pause" }),
    seek: (timeSeconds) => post({ type: "seek", timeSeconds }),
    setPlaybackRate: (playbackRate) =>
      post({ type: "setPlaybackRate", playbackRate }),
    setMuted: (muted) => post({ type: "setMuted", muted }),
    destroy: () => {
      window.removeEventListener("message", onMessage);
      iframe.remove();
    },
  };
}

function createPreviewChannel(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
