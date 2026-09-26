import { CHANNEL_NAME, formatTime, shortcutFromEvent } from "./core.js";
import { mountQuestionScreen } from './question-screen.js';
import { captionTextAt, parseWebVtt } from './captions.js';

const elements = {
  body: document.body,
  video: document.querySelector("#course-video"),
  shell: document.querySelector(".player-shell"),
  controls: document.querySelector(".player-controls"),
  empty: document.querySelector("#player-empty"),
  courseTitle: document.querySelector("#player-course-title"),
  theme: document.querySelector("#player-theme"),
  status: document.querySelector("#player-status"),
  toggle: document.querySelector("#player-toggle"),
  time: document.querySelector("#player-time"),
  seek: document.querySelector("#player-seek"),
  rate: document.querySelector("#player-rate"),
  captions: document.querySelector("#player-captions"),
  captionOverlay: document.querySelector('#player-caption-overlay'),
  fullscreen: document.querySelector("#player-fullscreen"),
};

const CONTROL_HIDE_DELAY = 2000;
const session = new URL(location.href).searchParams.get('session') || 'standalone';
const channel = new BroadcastChannel(`${CHANNEL_NAME}-${session}`);
const viewerId = crypto.randomUUID();
const questionScreen = mountQuestionScreen({ channel, viewerId, toggleFullscreen });
let lessonId = '';
let loadingVideo = true;
let pendingResumeTime = 0;
let lastStateSentAt = 0;
let controlHideTimer = 0;
let controlInteractionActive = false;
let keyboardNavigationActive = false;
let captionCues = [];
let captionLoad = 0;
let captionStatus = 'none';
let captionsVisible = true;
let fullscreenPreferred = false;

function playerSnapshot() {
  return {
    currentTime: Number(elements.video.currentTime || 0),
    duration: Number.isFinite(elements.video.duration) ? elements.video.duration : 0,
    rate: Number(elements.video.playbackRate || 1),
    playing: !elements.video.paused && !elements.video.ended,
  };
}

function sendState(force = false) {
  if (loadingVideo || !lessonId || !elements.video.src) return;
  const now = performance.now();
  if (!force && now - lastStateSentAt < 180) return;
  lastStateSentAt = now;
  channel.postMessage({ type: "player-state", lessonId, player: playerSnapshot() });
  renderControls();
}

function renderControls() {
  const snapshot = playerSnapshot();
  elements.toggle.textContent = snapshot.playing ? "暂停" : "播放";
  elements.time.textContent = `${formatTime(snapshot.currentTime)} / ${formatTime(snapshot.duration)}`;
  elements.seek.max = String(snapshot.duration || 0);
  elements.seek.value = String(snapshot.currentTime || 0);
  elements.rate.value = String(snapshot.rate);
  elements.captions.hidden = captionStatus === 'none';
  elements.captions.disabled = captionStatus !== 'ready';
  elements.captions.textContent = captionStatus === 'loading' ? '字幕载入中' : captionStatus === 'error' ? '字幕失败' : captionsVisible ? '字幕：开' : '字幕：关';
  elements.captions.setAttribute('aria-pressed', String(captionStatus === 'ready' && captionsVisible));
}

function renderCaption() {
  const text = captionStatus === 'ready' && captionsVisible ? captionTextAt(captionCues, elements.video.currentTime) : '';
  elements.captionOverlay.textContent = text;
  elements.captionOverlay.hidden = !text;
}

async function loadCaptions(captions) {
  const request = ++captionLoad;
  captionCues = []; captionStatus = captions?.url ? 'loading' : 'none';
  elements.captionOverlay.textContent = ''; elements.captionOverlay.hidden = true; renderControls();
  if (!captions?.url) return;
  try {
    const response = await fetch(captions.url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`字幕请求失败：${response.status}`);
    const cues = parseWebVtt(await response.text());
    if (request !== captionLoad) return;
    captionCues = cues; captionStatus = 'ready'; renderCaption(); renderControls();
  } catch (error) {
    if (request !== captionLoad) return;
    captionStatus = 'error'; renderCaption(); renderControls(); reportError(error.message || '字幕加载失败');
  }
}

function renderFullscreenControl() {
  const active = Boolean(document.fullscreenElement);
  const label = active ? "退出全屏" : "全屏";
  elements.fullscreen.textContent = label;
  elements.fullscreen.setAttribute("aria-label", active ? "退出全屏" : "进入全屏");
  elements.fullscreen.setAttribute("aria-pressed", String(active));
  elements.fullscreen.title = `${active ? "退出全屏" : "进入全屏"} (F)`;
}

function clearControlHideTimer() {
  window.clearTimeout(controlHideTimer);
  controlHideTimer = 0;
}

function scheduleControlHide() {
  clearControlHideTimer();
  if (questionScreen.isActive()) return;
  if (!elements.video.src || elements.video.ended) return;
  controlHideTimer = window.setTimeout(() => {
    if (elements.video.ended) {
      elements.body.classList.remove("controls-hidden");
      return;
    }
    const keyboardFocusInControls = keyboardNavigationActive
      && elements.controls.contains(document.activeElement);
    if (controlInteractionActive || keyboardFocusInControls) {
      scheduleControlHide();
      return;
    }
    elements.body.classList.add("controls-hidden");
  }, CONTROL_HIDE_DELAY);
}

function revealControls() {
  elements.body.classList.remove("controls-hidden");
  scheduleControlHide();
}

async function toggleFullscreen() {
  revealControls();
  try {
    if (document.fullscreenElement) {
      fullscreenPreferred = false;
      await document.exitFullscreen();
    } else if (document.documentElement.requestFullscreen) {
      fullscreenPreferred = true;
      await document.documentElement.requestFullscreen();
    } else {
      reportError("当前浏览器不支持页面全屏。 ");
    }
  } catch {
    fullscreenPreferred = false;
    reportError("浏览器未允许进入全屏，请点击全屏按钮后重试。 ");
  }
}

async function togglePlayback() {
  if (!elements.video.src) {
    reportError("请先在主屏选择本地视频。");
    return;
  }
  if (elements.video.paused) {
    try {
      await elements.video.play();
    } catch {
      reportError("浏览器未允许开始播放，请在播放器窗口点击一次播放。 ");
    }
  } else {
    elements.video.pause();
  }
  sendState(true);
}

function loadVideo(message) {
  if (!message.url) return;
  void loadCaptions(message.captions);
  if (elements.video.src === new URL(message.url, location.href).href) return;
  loadingVideo = true;
  pendingResumeTime = Number(message.currentTime || 0);
  elements.video.src = message.url;
  elements.video.playbackRate = Number(message.rate || 1);
  elements.empty.hidden = true;
  elements.status.textContent = message.name || "本地课程";
  elements.video.load();
  revealControls();
}

function seekTo(time) {
  if (!elements.video.src) return;
  if (loadingVideo || elements.video.readyState < 1) { pendingResumeTime = Math.max(0, Number(time || 0)); return; }
  elements.video.currentTime = Math.max(0, Number(time || 0));
  renderCaption(); sendState(true);
}

function seekFromMain(targetLessonId, time) {
  if (!Number.isFinite(Number(time)) || targetLessonId !== lessonId) return false;
  seekTo(time);
  if (fullscreenPreferred && !document.fullscreenElement && document.documentElement.requestFullscreen) {
    void document.documentElement.requestFullscreen().catch(() => {
      reportError("已跳到笔记时间；浏览器未允许自动恢复全屏，请按 F 恢复。 ");
      window.focus();
    });
  } else {
    window.focus();
  }
  return true;
}

window.studyDeskPlayerBridge = Object.freeze({ seekFromMain });

function captureFrame() {
  if (!elements.video.src || elements.video.readyState < 2) {
    reportError("当前没有可截图的视频画面。 ");
    return;
  }
  try {
    const sourceWidth = elements.video.videoWidth;
    const sourceHeight = elements.video.videoHeight;
    const width = Math.min(960, sourceWidth || 960);
    const height = Math.max(1, Math.round(width * (sourceHeight || 540) / (sourceWidth || 960)));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    context.drawImage(elements.video, 0, 0, width, height);
    channel.postMessage({
      type: "screenshot",
      lessonId,
      time: Number(elements.video.currentTime || 0),
      image: canvas.toDataURL("image/jpeg", 0.76),
    });
  } catch {
    reportError("无法读取当前视频帧。受保护或跨域媒体可能禁止截图。 ");
  }
}

function reportError(message) {
  channel.postMessage({ type: "player-error", lessonId, message });
  elements.status.textContent = message;
}

function handleMainMessage(message) {
  if (message.type === 'presentation-fullscreen') { questionScreen.ensureFullscreen(); return; }
  if (message.type === 'question-view') {
    if (message.active) { elements.video.pause(); sendState(true); clearControlHideTimer(); elements.body.classList.remove('controls-hidden'); }
    questionScreen.show(message); return;
  }
  if (message.type === 'main-disconnected') { questionScreen.disconnected(); return; }
  if (message.type === 'unload-video') {
    loadingVideo = true;
    elements.video.pause(); elements.video.removeAttribute('src'); elements.video.load();
    void loadCaptions(null); lessonId = ''; elements.empty.hidden = false; elements.status.textContent = '请在主屏选择本课视频'; return;
  }
  if (message.type === "init") {
    lessonId = message.lessonId;
    elements.courseTitle.textContent = message.courseTitle || "课程播放器";
    elements.theme.textContent = `当前主题: ${message.theme || "未归类"}`;
    if (!elements.video.src) pendingResumeTime = Number(message.player?.currentTime || 0);
    if (message.player?.rate) elements.video.playbackRate = Number(message.player.rate);
    renderControls();
  } else if (message.type === "load-video") {
    loadVideo(message);
  } else if (message.type === "set-theme") {
    elements.theme.textContent = `当前主题: ${message.theme || "未归类"}`;
  } else if (message.type === "player-command") {
    if (questionScreen.isActive()) return;
    if (message.command === "toggle") togglePlayback();
    else if (message.command === "pause") elements.video.pause();
    else if (message.command === "seek") seekTo(message.time);
    else if (message.command === "capture") captureFrame();
  }
}

channel.addEventListener("message", (event) => handleMainMessage(event.data || {}));

elements.toggle.addEventListener("click", togglePlayback);
elements.seek.addEventListener("input", () => seekTo(elements.seek.value));
elements.rate.addEventListener("change", () => {
  elements.video.playbackRate = Number(elements.rate.value);
  sendState(true);
});
elements.captions.addEventListener('click', () => {
  if (captionStatus !== 'ready') return;
  captionsVisible = !captionsVisible;
  renderCaption(); renderControls(); revealControls();
});
elements.fullscreen.addEventListener("click", toggleFullscreen);
document.addEventListener("pointerdown", (event) => {
  keyboardNavigationActive = false;
  controlInteractionActive = elements.controls.contains(event.target);
  revealControls();
});
document.addEventListener("pointerup", () => {
  controlInteractionActive = false;
  revealControls();
});
document.addEventListener("pointercancel", () => {
  controlInteractionActive = false;
  revealControls();
});
document.addEventListener("pointermove", () => {
  keyboardNavigationActive = false;
  revealControls();
});
document.addEventListener("focusin", revealControls);
document.addEventListener("focusout", () => window.setTimeout(revealControls, 0));
elements.video.addEventListener("loadedmetadata", () => {
  if (pendingResumeTime > 0 && pendingResumeTime < elements.video.duration) {
    elements.video.currentTime = pendingResumeTime;
  }
  pendingResumeTime = 0;
  loadingVideo = false;
  elements.status.textContent = "视频已就绪";
  renderCaption(); sendState(true);
  revealControls();
});
elements.video.addEventListener("timeupdate", () => { renderCaption(); sendState(false); });
elements.video.addEventListener("play", () => {
  sendState(true);
  revealControls();
});
elements.video.addEventListener("pause", () => {
  sendState(true);
  revealControls();
});
elements.video.addEventListener("ended", () => {
  sendState(true);
  clearControlHideTimer();
  elements.body.classList.remove("controls-hidden");
});
elements.video.addEventListener("durationchange", () => sendState(true));
elements.video.addEventListener("error", () => reportError("视频加载失败，请重新选择文件。 "));
elements.shell.addEventListener("dblclick", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  if (document.fullscreenElement) fullscreenPreferred = true;
  else if (document.hasFocus()) fullscreenPreferred = false;
  renderFullscreenControl();
  revealControls();
});

document.addEventListener("keydown", (event) => {
  if (["Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.code)) {
    keyboardNavigationActive = true;
  }
  revealControls();
  const target = event.target;
  const editing = target instanceof HTMLElement
    && (target.matches("input, textarea, select") || target.isContentEditable);
  if (!editing && !event.ctrlKey && !event.altKey && !event.metaKey && event.code === "KeyF") {
    event.preventDefault();
    toggleFullscreen();
    return;
  }
  if (questionScreen.isActive()) return;
  const action = shortcutFromEvent(event);
  if (!action) return;
  event.preventDefault();
  if (event.repeat && action === "toggle-playback") return;
  if (action === "toggle-playback") togglePlayback();
  else channel.postMessage({ type: "player-shortcut", lessonId, action });
});

window.addEventListener("beforeunload", () => {
  channel.postMessage({ type: 'player-closed', viewerId });
  clearControlHideTimer();
  sendState(true);
  channel.close();
});

renderControls();
renderFullscreenControl();
channel.postMessage({ type: "player-ready" });
