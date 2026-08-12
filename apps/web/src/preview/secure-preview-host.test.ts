import { describe, expect, it, vi } from "vitest";
import { mountSecurePreviewHost } from "./secure-preview-host";

describe("secure preview host", () => {
  it("creates an allow-scripts-only iframe and accepts only its source window and channel", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const onEvent = vi.fn();
    const controller = mountSecurePreviewHost({
      container,
      artifactHtml: "<!doctype html><title>fixture</title>",
      channel: "0123456789abcdef0123456789abcdef",
      onEvent,
    });

    expect(controller.iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(controller.iframe.getAttribute("sandbox")).not.toContain(
      "allow-same-origin",
    );

    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: {
          protocol: "oloka-preview",
          version: 1,
          channel: "0123456789abcdef0123456789abcdef",
          direction: "preview-to-parent",
          type: "ready",
          durationSeconds: 4,
        },
      }),
    );

    expect(onEvent).not.toHaveBeenCalled();

    const previewWindow = controller.iframe.contentWindow;
    expect(previewWindow).not.toBeNull();
    window.dispatchEvent(
      new MessageEvent("message", {
        source: previewWindow,
        data: {
          protocol: "oloka-preview",
          version: 1,
          channel: "ffffffffffffffffffffffffffffffff",
          direction: "preview-to-parent",
          type: "ready",
          durationSeconds: 4,
        },
      }),
    );
    expect(onEvent).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent("message", {
        source: previewWindow,
        data: {
          protocol: "oloka-preview",
          version: 1,
          channel: "0123456789abcdef0123456789abcdef",
          direction: "preview-to-parent",
          type: "ready",
          durationSeconds: 4,
        },
      }),
    );
    expect(onEvent).toHaveBeenCalledOnce();
    controller.destroy();
    container.remove();
  });
});
