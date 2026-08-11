import runtimeSource from "../../../third_party/hyperframes/v0.7.104/hyperframe.runtime.iife.js?raw";
import { buildSecurePreviewArtifact } from "../../../apps/web/src/preview/secure-preview-artifact";
import { mountSecurePreviewHost } from "../../../apps/web/src/preview/secure-preview-host";

const compositionMarkup = `
<section id="stage" data-composition-id="secure-fixture" data-width="640" data-height="360" data-start="0" data-duration="4">
  <div id="background" aria-hidden="true"></div>
  <img id="visual-asset" alt="" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlZJmAAAAAASUVORK5CYII=">
  <div id="copy" data-state="intro">
    <strong id="headline">Xin chào từ Oloka</strong>
    <span id="phase">Mở đầu</span>
  </div>
  <div id="caption-clean">Tiếng Việt precomposed: Cộng hòa</div>
  <div id="caption-bold">Dấu kết hợp: Việt Nam</div>
  <audio id="bgm" preload="auto" src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAESsAAABAAgAZGF0YQAAAAA="></audio>
</section>`;
const compositionStyle = `
  :root { color-scheme: light; font-family: sans-serif; }
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
  #stage { position: relative; width: 640px; height: 360px; background: #0b132b; color: #f7f4ea; }
  #background { position: absolute; inset: 0; background: linear-gradient(135deg, #0b132b, #1c7293); }
  #visual-asset { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: .12; }
  #copy { position: absolute; inset: 0; display: grid; place-content: center; gap: 12px; text-align: center; }
  #headline { font-size: 42px; letter-spacing: 0.02em; }
  #phase { font-size: 20px; opacity: 0.8; }
  #caption-clean, #caption-bold { position: absolute; left: 8%; right: 8%; bottom: 12%; text-align: center; }
  #caption-bold { bottom: 4%; background: #ffd23f; color: #101010; font-weight: 800; }
  @keyframes fixture-fade { from { opacity: 0.4; } to { opacity: 1; } }
  #copy { animation: fixture-fade 1s linear 1 both; animation-play-state: paused; }
`;
const compositionScript = `
(() => {
  const stage = document.querySelector("#stage");
  const copy = document.querySelector("#copy");
  const phase = document.querySelector("#phase");
  const bgm = document.querySelector("#bgm");
  let currentTime = 0;
  let playing = false;
  const render = (time) => {
    currentTime = Math.max(0, Math.min(4, Number(time) || 0));
    const progress = currentTime / 4;
    stage.dataset.fixtureTime = currentTime.toFixed(6);
    copy.style.transform = "translateY(" + ((1 - progress) * 18).toFixed(3) + "px)";
    copy.style.opacity = String((0.4 + progress * 0.6).toFixed(6));
    const state = currentTime < 1 ? "intro" : currentTime < 2 ? "transition" : currentTime < 3.5 ? "middle" : "final";
    copy.dataset.state = state;
    phase.textContent = state === "intro" ? "Mở đầu" : state === "transition" ? "Chuyển cảnh" : state === "middle" ? "Giữa nhịp" : "Kết thúc";
    if (bgm) { bgm.currentTime = currentTime; bgm.volume = state === "transition" ? .2 : .5; }
  };
  const timeline = {
    duration: () => 4,
    play: () => { playing = true; void bgm?.play?.().catch(() => undefined); },
    pause: () => { playing = false; bgm?.pause?.(); },
    seek: (time) => render(time),
    totalTime: (time) => render(time),
    timeScale: () => undefined,
    isActive: () => playing,
    isPlaying: () => playing,
    get time() { return currentTime; },
  };
  window.__timelines = { "secure-fixture": timeline };
  window.__fixture = { render, timeline };
  render(0);
})();`;

const artifactHtml = buildSecurePreviewArtifact({
  runtimeSource,
  compositionMarkup,
  compositionScript,
  compositionStyle,
});
const events: unknown[] = [];
const controller = mountSecurePreviewHost({
  container: document.querySelector("#preview-host"),
  artifactHtml,
  onEvent: (event) => events.push(event),
});

Object.assign(window, {
  __previewController: controller,
  __previewEvents: events,
  __previewArtifactHtml: artifactHtml,
});
