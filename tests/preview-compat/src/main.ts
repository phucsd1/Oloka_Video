import runtimeSource from "../../../third_party/hyperframes/v0.7.104/hyperframe.runtime.iife.js?raw";
import { buildSecurePreviewArtifact } from "../../../apps/web/src/preview/secure-preview-artifact";
import { mountSecurePreviewHost } from "../../../apps/web/src/preview/secure-preview-host";

const channel = "0123456789abcdef0123456789abcdef";
const nonce = "b2xva2EtcHJldmlldy1ub25jZQ==";
const compositionMarkup = `
<section id="stage" data-composition-id="secure-fixture" data-width="640" data-height="360" data-start="0" data-duration="4">
  <div id="background" aria-hidden="true"></div>
  <div id="copy" data-state="intro">
    <strong id="headline">Xin chào từ Oloka</strong>
    <span id="phase">Mở đầu</span>
  </div>
</section>`;
const compositionStyle = `
  :root { color-scheme: light; font-family: sans-serif; }
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
  #stage { position: relative; width: 640px; height: 360px; background: #0b132b; color: #f7f4ea; }
  #background { position: absolute; inset: 0; background: linear-gradient(135deg, #0b132b, #1c7293); }
  #copy { position: absolute; inset: 0; display: grid; place-content: center; gap: 12px; text-align: center; }
  #headline { font-size: 42px; letter-spacing: 0.02em; }
  #phase { font-size: 20px; opacity: 0.8; }
  @keyframes fixture-fade { from { opacity: 0.4; } to { opacity: 1; } }
  #copy { animation: fixture-fade 1s linear 1 both; animation-play-state: paused; }
`;
const compositionScript = `
(() => {
  const stage = document.querySelector("#stage");
  const copy = document.querySelector("#copy");
  const phase = document.querySelector("#phase");
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
  };
  const timeline = {
    duration: () => 4,
    play: () => { playing = true; },
    pause: () => { playing = false; },
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
  channel,
  nonce,
  runtimeSource,
  compositionMarkup,
  compositionScript,
  compositionStyle,
});
const events: unknown[] = [];
const controller = mountSecurePreviewHost({
  container: document.querySelector("#preview-host"),
  artifactHtml,
  channel,
  onEvent: (event) => events.push(event),
});

Object.assign(window, {
  __previewController: controller,
  __previewEvents: events,
  __previewArtifactHtml: artifactHtml,
});
