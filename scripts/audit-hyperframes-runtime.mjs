import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const runtimePath = resolve(
  repoRoot,
  "third_party/hyperframes/v0.7.104/hyperframe.runtime.iife.js",
);
const source = await readFile(runtimePath, "utf8");
const bytes = (await readFile(runtimePath)).byteLength;
const sha256 = createHash("sha256")
  .update(await readFile(runtimePath))
  .digest("hex");
const count = (pattern) => (source.match(pattern) ?? []).length;
const audit = {
  runtimePath: "third_party/hyperframes/v0.7.104/hyperframe.runtime.iife.js",
  bytes,
  sha256,
  counts: {
    eval: count(/\beval\s*\(/g),
    newFunction: count(/\bnew\s+Function\s*\(/g),
    fetch: count(/\bfetch\s*\(/g),
    xhr: count(/\bXMLHttpRequest\b/g),
    webSocket: count(/\bWebSocket\b/g),
    eventSource: count(/\bEventSource\b/g),
    worker: count(/\b(?:Worker|SharedWorker)\s*\(/g),
    dynamicScriptCreation: count(/createElement\(["']script["']\)/g),
    dynamicImport: count(/\bimport\s*\(/g),
    iframeCreation: count(/createElement\(["']iframe["']\)/g),
    documentNavigation: count(
      /\b(?:window\.)?location\.(?:href|assign|replace)\b/g,
    ),
    storage: count(/\b(?:localStorage|sessionStorage|indexedDB)\b/g),
    cookie: count(/\bdocument\.cookie\b/g),
    top: count(/\b(?:window\.top|top\.location|window\[["']top["']\])/g),
    opener: count(/\bopener\b/g),
  },
  classifications: {
    fetch:
      "unreachable in the approved simple self-contained fixture path; browser network-denial test is mandatory",
    dynamicScriptCreation:
      "unreachable in the approved simple fixture path; used only for external composition loading",
    eval: "absent",
    newFunction: "absent",
    xhr: "absent",
    webSocket: "absent",
    eventSource: "absent",
    worker: "absent",
    storage: "absent",
    cookie: "absent",
    opener: "absent",
    top: "absent",
    iframeCreation: "absent",
    documentNavigation: "absent",
  },
  reviewedOccurrences: {
    fetch: [
      {
        sourcePath: "packages/core/src/runtime/captionOverrides.ts",
        classification: "unreachable without a caption override reference",
      },
      {
        sourcePath: "packages/core/src/runtime/compositionLoader.ts",
        classification: "unreachable without data-composition-src",
      },
      {
        sourcePath: "packages/core/src/runtime/colorGrading.ts",
        classification: "unreachable without an external LUT reference",
      },
      {
        sourcePath: "packages/core/src/runtime/webAudioTransport.ts",
        classification: "unreachable without media elements",
      },
    ],
    dynamicScriptCreation: [
      {
        sourcePath: "packages/core/src/runtime/compositionLoader.ts",
        classification: "unreachable without external composition loading",
      },
    ],
  },
};

const expectedSha =
  "a61e40e57329eeb9941c35ff9dac3ed8f0abfcee3246d2c5bfa2332e2df0c0c0";
if (bytes !== 342023 || sha256 !== expectedSha) {
  throw new Error(
    `HyperFrames runtime fingerprint mismatch: ${bytes} bytes ${sha256}`,
  );
}
if (audit.counts.eval !== 0 || audit.counts.newFunction !== 0) {
  throw new Error("HyperFrames runtime requires dynamic code execution");
}
console.log(JSON.stringify(audit, null, 2));
