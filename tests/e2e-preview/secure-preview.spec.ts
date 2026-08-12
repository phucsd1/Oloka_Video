import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";

async function waitForPreview(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForFunction(() =>
    (
      window as unknown as { __previewEvents?: Array<{ type?: string }> }
    ).__previewEvents?.some((event) => event.type === "ready"),
  );
  const frame = page
    .frames()
    .find((candidate) => candidate !== page.mainFrame());
  if (!frame) throw new Error("Secure preview iframe did not load");
  return frame;
}

test("uses an opaque allow-scripts-only iframe and strict CSP", async ({
  page,
}) => {
  const frame = await waitForPreview(page);
  const iframe = page.locator("iframe");
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  await expect(iframe).not.toHaveAttribute("sandbox", /allow-same-origin/);
  expect(await frame.evaluate(() => location.origin)).toBe("null");
  const csp = await frame
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content");
  expect(csp).toContain("default-src 'none'");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(csp).not.toContain("https:");
  expect(csp).not.toContain("http:");
  expect(csp).not.toMatch(/(?:^|;\s*)\*(?:\s|;|$)/);
});

test("direct preview navigation keeps an opaque origin under HTTP sandbox CSP", async ({
  page,
}) => {
  await page.goto(
    "/api/v1/previews/00000000-0000-4000-8000-000000000001/content",
  );
  await expect(page.locator("#direct-preview-ready")).toHaveText("ready");
  const evidence = await page.evaluate(async () => {
    const denied = (operation: () => unknown) => {
      try {
        operation();
        return false;
      } catch {
        return true;
      }
    };
    let networkDenied = false;
    try {
      await fetch("/origin-probe");
    } catch {
      networkDenied = true;
    }
    return {
      effectiveOrigin: globalThis.origin,
      cookieDenied: denied(() => document.cookie),
      storageDenied: denied(() => localStorage.getItem("secret")),
      networkDenied,
    };
  });
  expect(evidence).toEqual({
    effectiveOrigin: "null",
    cookieDenied: true,
    storageDenied: true,
    networkDenied: true,
  });
  expect(
    await page.locator("#direct-preview-ready").getAttribute("data-csp"),
  ).toBe("sandbox allow-scripts");
});

test("denies outbound network while retaining runtime controls", async ({
  page,
}) => {
  const attempted: string[] = [];
  let bootstrapComplete = false;
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const isFixtureOrigin = url.origin === "http://127.0.0.1:4178";
    const frame = request.frame();
    const isPreviewFrame = frame !== page.mainFrame();
    if (bootstrapComplete && isPreviewFrame) {
      attempted.push(`${url.origin}${url.pathname}`);
      await route.abort();
      return;
    }
    if (!isFixtureOrigin) {
      await route.abort();
      return;
    }
    await route.continue();
  });
  const frame = await waitForPreview(page);
  bootstrapComplete = true;
  await page.evaluate(() => {
    const controller = (
      window as unknown as {
        __previewController: {
          seek: (time: number) => void;
          play: () => void;
          pause: () => void;
        };
      }
    ).__previewController;
    controller.seek(1);
    controller.play();
    controller.pause();
  });
  await expect(frame.locator("#copy")).toHaveAttribute(
    "data-state",
    "transition",
  );
  expect(attempted).toEqual([]);
  const events = await page.evaluate(
    () =>
      (window as unknown as { __previewEvents: Array<{ type: string }> })
        .__previewEvents,
  );
  expect(events.some((event) => event.type === "duration")).toBe(true);
  expect(events.some((event) => event.type === "timeUpdate")).toBe(true);
});

test("keeps realistic visual, Vietnamese caption, Clean/Bold, and BGM fixtures network-zero", async ({
  page,
}) => {
  const attempted: string[] = [];
  let bootstrapComplete = false;
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const isPreviewFrame = request.frame() !== page.mainFrame();
    if (bootstrapComplete && isPreviewFrame) {
      attempted.push(`${url.origin}${url.pathname}`);
      await route.abort();
      return;
    }
    if (url.origin !== "http://127.0.0.1:4178") {
      await route.abort();
      return;
    }
    await route.continue();
  });
  const frame = await waitForPreview(page);
  bootstrapComplete = true;
  await frame.evaluate(async () => {
    const image = document.querySelector("#visual-asset");
    if (image instanceof HTMLImageElement)
      await image.decode().catch(() => undefined);
    const audio = document.querySelector("#bgm");
    if (audio instanceof HTMLMediaElement) {
      audio.currentTime = 0;
      audio.volume = 0.2;
    }
  });
  await page.evaluate(() => {
    const controller = (
      window as unknown as {
        __previewController: {
          seek: (time: number) => void;
          pause: () => void;
        };
      }
    ).__previewController;
    controller.seek(1.5);
    controller.pause();
  });
  expect(attempted).toEqual([]);
  await expect(frame.locator("#caption-clean")).toBeVisible();
  await expect(frame.locator("#caption-bold")).toBeVisible();
});

test("blocks malformed, cross-channel, cross-window, and upstream bridge commands", async ({
  page,
}) => {
  const frame = await waitForPreview(page);
  await page.evaluate(() => {
    const iframe = document.querySelector("iframe");
    const target = iframe?.contentWindow;
    target?.postMessage(
      {
        protocol: "oloka-preview",
        version: 1,
        channel: "ffffffffffffffffffffffffffffffff",
        direction: "parent-to-preview",
        type: "seek",
        timeSeconds: 2,
      },
      "*",
    );
    target?.postMessage(
      {
        protocol: "oloka-preview",
        version: 1,
        channel: "0123456789abcdef0123456789abcdef",
        direction: "parent-to-preview",
        type: "seek",
        timeSeconds: 2,
        unexpected: true,
      },
      "*",
    );
    target?.postMessage(
      { source: "hf-parent", type: "control", action: "seek", timeSeconds: 2 },
      "*",
    );
    const attacker = document.createElement("iframe");
    attacker.srcdoc = `<script>parent.frames[0].postMessage({protocol:"oloka-preview",version:1,channel:"0123456789abcdef0123456789abcdef",direction:"parent-to-preview",type:"seek",timeSeconds:2},"*")</script>`;
    document.body.appendChild(attacker);
  });
  await page.waitForTimeout(100);
  await expect(frame.locator("#copy")).toHaveAttribute("data-state", "intro");

  await page.evaluate(() => {
    (
      window as unknown as {
        __previewController: { seek: (value: number) => void };
      }
    ).__previewController.seek(2);
  });
  await expect(frame.locator("#copy")).toHaveAttribute("data-state", "middle");
});

test("rejects sandbox escape capabilities and preserves deterministic seeks", async ({
  page,
}) => {
  const frame = await waitForPreview(page);
  const escapeRequests: string[] = [];
  let downloadTriggered = false;
  page.on("download", () => {
    downloadTriggered = true;
  });
  await page.route("https://example.invalid/**", async (route) => {
    escapeRequests.push(new URL(route.request().url()).pathname);
    await route.abort();
  });
  const capabilities = await frame.evaluate(() => {
    const denied = (operation: () => unknown) => {
      try {
        operation();
        return false;
      } catch {
        return true;
      }
    };
    const form = document.createElement("form");
    form.action = "https://example.invalid/submit";
    document.body.appendChild(form);
    form.requestSubmit();
    const download = document.createElement("a");
    download.href = "https://example.invalid/download";
    download.download = "blocked.txt";
    document.body.appendChild(download);
    download.click();
    const popup = window.open("https://example.invalid/popup");
    return {
      origin: location.origin,
      parentDomDenied: denied(() => parent.document.body),
      parentObjectDenied: denied(
        () => (parent as unknown as { __olokaSecret: unknown }).__olokaSecret,
      ),
      cookieDenied: denied(() => document.cookie),
      localStorageDenied: denied(() => localStorage.getItem("secret")),
      sessionStorageDenied: denied(() => sessionStorage.getItem("secret")),
      topNavigationDenied: denied(() => {
        const topWindow = window.top;
        if (!topWindow) throw new Error("Top window is unavailable");
        topWindow.location.href = "https://example.invalid/top";
      }),
      popupDenied: popup === null,
    };
  });
  await page.waitForTimeout(100);
  expect(capabilities).toMatchObject({
    origin: "null",
    parentDomDenied: true,
    parentObjectDenied: true,
    cookieDenied: true,
    localStorageDenied: true,
    sessionStorageDenied: true,
    topNavigationDenied: true,
    popupDenied: true,
  });
  expect(escapeRequests).toEqual([]);
  expect(downloadTriggered).toBe(false);

  const hashes: string[] = [];
  for (const timestamp of [0, 1, 2, 3.9]) {
    const buffers: Uint8Array[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.evaluate((time) => {
        (
          window as unknown as {
            __previewController: { seek: (value: number) => void };
          }
        ).__previewController.seek(time);
      }, timestamp);
      buffers.push(await frame.locator("#stage").screenshot());
    }
    const [firstBuffer, secondBuffer] = buffers;
    if (!firstBuffer || !secondBuffer)
      throw new Error("Screenshot capture failed");
    const first = createHash("sha256").update(firstBuffer).digest("hex");
    const second = createHash("sha256").update(secondBuffer).digest("hex");
    expect(first).toBe(second);
    hashes.push(first);
  }
  expect(new Set(hashes).size).toBeGreaterThan(1);
  await expect(frame.locator("#copy")).toHaveAttribute("data-state", "final");
});
