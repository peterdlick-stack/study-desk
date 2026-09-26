import {
  CHANNEL_NAME,
  STORAGE_KEY,
  STAGE_SIZE,
  buildLinearNotesFromCues,
  clamp,
  createDefaultState,
  createId,
  formatTime,
  nextCanvasPosition,
  nextThemeCandidate,
  normaliseStudyBundle,
  noteAtTime,
  parseSrt,
  shortcutFromEvent,
  themeCandidatesFromNotes,
} from "./core.js";
import { mountLibrary, api } from './workspace-library.js';
import { mountPractice } from './practice-workspace.js';
import { openTrainingWindow } from './screen-window.js';
import { mountCourseMaterials } from './course-materials.js';
import { detailedLearningItems, isTimedLearningItem } from './detailed-notes.js';

const elements = {
  workspace: document.querySelector("#workspace"),
  courseTitle: document.querySelector("#course-title"),
  courseMeta: document.querySelector("#course-meta"),
  headerTime: document.querySelector("#header-time"),
  currentTheme: document.querySelector("#current-theme"),
  suggestionBar: document.querySelector("#suggestion-bar"),
  suggestionTitle: document.querySelector("#suggestion-title"),
  sourceIntegrity: document.querySelector("#source-integrity"),
  sourceExpected: document.querySelector("#source-expected"),
  sourceWarning: document.querySelector("#source-warning"),
  learningContentTitle: document.querySelector("#learning-content-title"),
  learningContentDescription: document.querySelector("#learning-content-description"),
  showNotes: document.querySelector("#show-notes"),
  showCues: document.querySelector("#show-cues"),
  notesList: document.querySelector("#notes-list"),
  notesState: document.querySelector("#notes-state"),
  followNotes: document.querySelector("#follow-notes"),
  mindMap: document.querySelector("#mind-map"),
  videoInput: document.querySelector("#video-input"),
  transcriptInput: document.querySelector("#transcript-input"),
  openPlayer: document.querySelector("#open-player"),
  focusMode: document.querySelector("#focus-mode"),
  leftResizer: document.querySelector("#left-resizer"),
  rightResizer: document.querySelector("#right-resizer"),
  canvasViewport: document.querySelector("#canvas-viewport"),
  canvasStage: document.querySelector("#canvas-stage"),
  drawingLayer: document.querySelector("#drawing-layer"),
  objectLayer: document.querySelector("#object-layer"),
  canvasEmpty: document.querySelector("#canvas-empty"),
  canvasHint: document.querySelector("#canvas-hint"),
  undoObject: document.querySelector("#undo-object"),
  deleteObject: document.querySelector("#delete-object"),
  fitMap: document.querySelector("#fit-map"),
  toastRegion: document.querySelector("#toast-region"),
};

let legacyError = '';
const defaultState = createDefaultState();
const subject = document.body.dataset.subject || 'physics';
let state = subject === 'math' ? createDefaultState() : restoreState(defaultState);
if (subject === 'math') {
  state.lessonId = 'math-workspace'; state.entries = []; state.notes = []; state.canvasObjects = [];
  state.course = { ...state.course, title: '数学学习台', demo: true, transcriptName: '', transcriptFormat: '' };
  state.themes = [{ id: 'unclassified', title: '未归类', start: 0, status: 'confirmed' }];
}
state.lessonId ||= state.course.demo ? 'demo' : `legacy-${crypto.randomUUID()}`;
state.entries ||= [];
let library;
let practice;
let materials;
let playerWindow = null;
let videoObjectUrl = "";
let videoSha256 = '';
let mediaFile = null;
let changingCourse = false;
let activeTool = "select";
let selectedObjectId = null;
let pendingCaptureMode = "plain";
let forcedSuggestionId = null;
let saveTimer = null;
let pointerSession = null;
let draftElement = null;
const playerSession = crypto.randomUUID();
const channel = new BroadcastChannel(`${CHANNEL_NAME}-${playerSession}`);
const questionPeers = new Map();
function questionKey(view) { return `${view?.trainingId || ''}:${view?.item?.id || ''}`; }
function refreshQuestionConnection() {
  const view = practice?.getSecondaryQuestion();
  if (playerWindow?.closed) { playerWindow = null; questionPeers.clear(); }
  for (const [id, peer] of questionPeers) if (Date.now() - peer.at > 45000) questionPeers.delete(id);
  practice?.setQuestionScreenConnected(Boolean(view?.active && view.item && [...questionPeers.values()].some(p => p.key === questionKey(view))));
}
setInterval(refreshQuestionConnection, 3000);
document.querySelector('#player-tab-link').href = `./player.html?session=${encodeURIComponent(playerSession)}`;
const SVG_NS = "http://www.w3.org/2000/svg";

function restoreState(fallback) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved || saved.version !== 1) return fallback;
    let restoredBundle = null;
    let restoredNotes;
    let restoredMap;
    if (saved.studyBundle?.schemaVersion === 1) {
      restoredBundle = normaliseStudyBundle({
        schemaVersion: 1,
        title: saved.course?.title,
        source: saved.studyBundle.source,
        cues: saved.studyBundle.cues,
        notes: saved.notes,
        map: saved.map,
      });
      restoredNotes = restoredBundle.notes;
      restoredMap = restoredBundle.map;
    } else {
      restoredNotes = normaliseStudyBundle({ notes: saved.notes }).notes;
      restoredMap = { nodes: [], edges: [] };
    }

    const bundleThemes = restoredBundle
      ? themeCandidatesFromNotes(restoredNotes).map((theme) => ({ ...theme, status: "confirmed" }))
      : null;
    const restoredThemes = bundleThemes
      || (Array.isArray(saved.themes) ? saved.themes : fallback.themes);
    const activeThemeId = restoredThemes.some((theme) => theme.id === saved.activeThemeId)
      ? saved.activeThemeId
      : "unclassified";
    return {
      ...fallback,
      ...saved,
      course: { ...fallback.course, ...saved.course },
      player: { ...fallback.player, ...saved.player, playing: false },
      layout: { ...fallback.layout, ...saved.layout },
      themes: restoredThemes,
      activeThemeId,
      contentView: restoredBundle && saved.contentView === "cues" ? "cues" : "notes",
      studyBundle: restoredBundle
        ? { schemaVersion: 1, source: restoredBundle.source, cues: restoredBundle.cues }
        : null,
      notes: restoredNotes,
      map: restoredMap,
      canvasObjects: Array.isArray(saved.canvasObjects) ? saved.canvasObjects : [],
    };
  } catch (error) {
    legacyError = `旧浏览器记录无法解析，原缓存保留：${error.message}`;
    return fallback;
  }
}

function scheduleSave() {
  library?.markDirty();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveState().catch(() => {}); }, 1000);
}

async function saveState() {
  if (library?.isReady()) return library.save();
}

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast${type === "error" ? " error" : ""}`;
  toast.textContent = message;
  elements.toastRegion.append(toast);
  setTimeout(() => toast.remove(), 2600);
}

function activeTheme() {
  return state.themes.find((theme) => theme.id === state.activeThemeId)
    || state.themes.find((theme) => theme.id === "unclassified")
    || { id: "unclassified", title: "未归类" };
}

function currentSuggestion() {
  if (state.studyBundle?.schemaVersion === 1) return null;
  if (forcedSuggestionId) {
    return state.themes.find((theme) => theme.id === forcedSuggestionId && theme.status === "candidate") || null;
  }
  return nextThemeCandidate(state.themes, state.player.currentTime);
}

function renderAll() {
  applyLayout();
  renderHeader();
  renderSourceIntegrity();
  renderNotes();
  renderMap();
  renderCanvas();
  renderSuggestion();
  setTool(activeTool);
}

function shortSha256(value) {
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function sourceMatchState() {
  const source = state.studyBundle?.source;
  const expected = source?.fileSha256 || state.course.videoSha256;
  if (!expected) return { status: "none", seekAllowed: true };
  if (!videoObjectUrl || !state.course.videoName) return { status: "missing", seekAllowed: false };
  const matched = videoSha256 === expected;
  return { status: matched ? "matched" : "mismatch", seekAllowed: matched };
}

function renderSourceIntegrity() {
  const source = state.studyBundle?.source;
  elements.sourceIntegrity.hidden = !source && !state.course.videoSha256;
  if (!source && !state.course.videoSha256) {
    elements.sourceIntegrity.dataset.sourceStatus = "none";
    elements.sourceExpected.textContent = "";
    elements.sourceWarning.textContent = "";
    return;
  }

  const match = sourceMatchState();
  elements.sourceIntegrity.dataset.sourceStatus = match.status;
  elements.sourceExpected.textContent = source ? `预期 ${source.fileName} · 视频 ${shortSha256(source.fileSha256)} · 字幕 ${shortSha256(source.transcriptSha256)} · ${source.boundaryMode === "hard" ? "硬切片" : "自然边界"}` : `课程视频 ${state.course.videoName} · 复习稿无同步时间`;
  if (match.status === "matched") {
    elements.sourceWarning.textContent = "已核验所选视频 SHA-256，来源匹配";
  } else if (match.status === "mismatch") {
    elements.sourceWarning.textContent = `来源不匹配：当前为 ${state.course.videoName}，已禁止时间跳转`;
  } else {
    elements.sourceWarning.textContent = "尚未选择视频，已禁止时间跳转";
  }
}

function renderHeader() {
  const training = practice?.getSecondaryQuestion();
  const inTraining = Boolean(training?.active);
  document.body.dataset.lessonId = state.lessonId;
  elements.courseTitle.textContent = inTraining ? (training.mode === 'practice' ? training.groupTitle : `数学一 · ${training.groupTitle}`) : state.course.title;
  elements.courseMeta.textContent = inTraining
    ? training.item?.title || (training.mode === 'practice' ? '在作业区选择题目' : '选择题型，开始一组训练')
    : state.course.videoName || "尚未选择视频";
  elements.headerTime.textContent = inTraining
    ? training.total ? `第 ${training.position} / ${training.total} ${training.itemMode === 'pages' ? '页' : '题'}` : '尚未开始'
    : `${formatTime(state.player.currentTime)} / ${formatTime(state.player.duration)}`;
  document.querySelector('.theme-label').textContent = inTraining ? (training.mode === 'practice' ? '当前作业' : '当前题型') : '当前主题';
  elements.currentTheme.textContent = inTraining ? training.groupTitle : activeTheme().title;
  elements.currentTheme.disabled = inTraining;
  document.title = `${elements.courseTitle.textContent} · 学习台`;
  elements.focusMode.textContent = state.layout.focusMode ? "恢复三栏" : "书写专注";
}

function renderNotes() {
  elements.notesList.replaceChildren();
  const cues = state.studyBundle?.cues || [];
  if (state.contentView === "cues" && !cues.length) state.contentView = "notes";
  const showingCues = state.contentView === "cues";
  const detailed = state.course.transcriptFormat === 'aligned-detailed-notes';
  const items = detailedLearningItems(state, showingCues);
  elements.notesList.classList.toggle('detailed-notes', detailed);

  elements.showNotes.setAttribute("aria-selected", String(!showingCues));
  elements.showCues.setAttribute("aria-selected", String(showingCues));
  elements.showCues.disabled = cues.length === 0;
  const untimed = !showingCues && items.length && items.every(n => n.timingStatus === 'untimed');
  elements.showNotes.textContent = detailed ? '详细笔记' : untimed ? '复习笔记' : '线性笔记';
  elements.showCues.textContent = detailed ? '原文对照' : '逐句转译';
  elements.followNotes.disabled = Boolean(untimed);
  elements.learningContentTitle.textContent = detailed ? (showingCues ? '原文对照' : '详细课堂笔记') : showingCues ? "逐句转译" : untimed ? "复习笔记" : "线性笔记";
  elements.learningContentDescription.textContent = detailed
    ? showingCues ? '中文讲解与对应英文字幕，非逐句翻译' : '按课堂顺序展开概念、推导、实验与例题；点击时间回看'
    : showingCues
    ? "保留原文、中文转译与边界风险"
    : untimed ? "概念、推导与复述问题；未绑定视频时间" : "按讲课顺序保留定义、论证和例题步骤";
  renderNotesState();

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "canvas-empty";
    empty.textContent = showingCues ? "当前没有逐句转译。" : "尚未导入线性笔记。";
    elements.notesList.append(empty);
    return;
  }

  const current = noteAtTime(items.filter(isTimedLearningItem), state.player.currentTime);
  for (const itemData of items) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `${showingCues ? "cue-item" : "note-item"} learning-item${current?.id === itemData.id ? " current" : ""}`;
    item.dataset.learningId = itemData.id;
    if (showingCues) item.dataset.cueId = itemData.id;
    else item.dataset.noteId = itemData.id;
    if (itemData.reviewStatus) item.dataset.reviewStatus = itemData.reviewStatus;

    const time = document.createElement("span");
    time.className = "note-time";
    time.textContent = !isTimedLearningItem(itemData) ? (detailed ? '原版补充' : '复习') : formatTime(itemData.start);
    if (detailed) time.title = isTimedLearningItem(itemData) ? `本地音频近似定位 ${formatTime(itemData.start)}—${formatTime(itemData.end)}` : '本地视频未定位，不提供跳转';

    const copy = document.createElement("span");
    copy.className = showingCues ? "cue-copy" : "note-copy";
    if (showingCues) {
      const translation = document.createElement("span");
      translation.className = "cue-translation";
      translation.textContent = itemData.translatedText;
      const source = document.createElement("span");
      source.className = "cue-source";
      source.textContent = itemData.sourceText;
      copy.append(translation, source);
    } else {
      const title = document.createElement("strong");
      title.textContent = itemData.title;
      const summary = document.createElement("span");
      summary.textContent = itemData.summary;
      copy.append(title, summary);
    }
    item.append(time, copy);
    if (detailed && !isTimedLearningItem(itemData)) {
      const sourceTime = document.createElement('span'); sourceTime.className = 'source-only-label';
      sourceTime.textContent = `原版 ${formatTime(itemData.sourceStart)} · 本地未定位`;
      copy.prepend(sourceTime);
    }
    if (itemData.reviewStatus) {
      const badges = document.createElement("span");
      badges.className = "review-badges learning-item-status";
      badges.append(createReviewBadge(itemData.reviewStatus));
      if (showingCues && itemData.boundaryRisk !== "none") badges.append(createBoundaryBadge(itemData.boundaryRisk));
      item.append(badges);
    }
    if (isTimedLearningItem(itemData)) item.addEventListener("click", () => seekTo(itemData.start));
    else { item.classList.add('untimed-note'); item.setAttribute('aria-label', `${itemData.title}，无同步时间`); }
    elements.notesList.append(item);
  }
  window.renderMathInElement?.(elements.notesList, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }], throwOnError: false, trust: false });
}

function layerStatusSummary(label, items) {
  const counts = { verified: 0, "needs-review": 0, UNKNOWN: 0 };
  for (const item of items) {
    if (Object.hasOwn(counts, item.reviewStatus)) counts[item.reviewStatus] += 1;
  }
  return `${label} ${items.length}（独立核验 ${counts.verified} / 待复核 ${counts["needs-review"]} / 无法确定 ${counts.UNKNOWN}）`;
}

function renderNotesState() {
  if (state.course.transcriptFormat === 'aligned-detailed-notes') {
    const audit = state.course.noteTimingAudit;
    elements.notesState.textContent = `${audit.noteCount} 条详细笔记 · ${audit.timedNoteCount} 条有本地时间${audit.sourceOnlyCount ? ` · ${audit.sourceOnlyCount} 条原版补充` : ''}。时间经本地音频匹配，为近似定位；正文待独立复核，疑点见完整笔记末尾。`;
    return;
  }
  if (state.course.transcriptFormat === 'course-materials') { elements.notesState.textContent = '中文复习稿待独立复核；完整英文原稿与配套资料见右侧。'; return; }
  if (state.studyBundle?.schemaVersion === 1) {
    const cues = state.studyBundle.cues;
    elements.notesState.textContent = [
      layerStatusSummary("转译", cues),
      layerStatusSummary("笔记", state.notes),
      layerStatusSummary("节点", state.map.nodes),
      layerStatusSummary("关系", state.map.edges),
    ].join("；");
    return;
  }
  if (state.course.transcriptFormat === "srt") {
    elements.notesState.textContent = `已导入 ${state.notes.length} 条逐字稿片段，尚未生成语义笔记`;
  } else if (state.course.transcriptFormat === "legacy-json") {
    elements.notesState.textContent = `已导入旧格式线性笔记 ${state.notes.length} 条`;
  } else {
    elements.notesState.textContent = "演示内容，导入SRT或学习包后替换";
  }
}

function createReviewBadge(status) {
  const badge = document.createElement("span");
  badge.className = "review-badge";
  badge.dataset.reviewStatus = status;
  badge.textContent = REVIEW_STATUS_LABELS[status];
  return badge;
}

function createBoundaryBadge(boundaryRisk) {
  const badge = document.createElement("span");
  badge.className = "boundary-badge";
  badge.dataset.boundaryRisk = boundaryRisk;
  badge.textContent = BOUNDARY_RISK_LABELS[boundaryRisk];
  return badge;
}

function updateTimeDependentView() {
  renderHeader();
  const learningItems = detailedLearningItems(state, state.contentView === "cues");
  const current = noteAtTime(learningItems.filter(isTimedLearningItem), state.player.currentTime);
  for (const item of elements.notesList.querySelectorAll(".learning-item")) {
    item.classList.toggle("current", item.dataset.learningId === current?.id);
  }
  if (current && elements.followNotes.checked) {
    const item = elements.notesList.querySelector(`[data-learning-id="${CSS.escape(current.id)}"]`);
    if (item && !isMostlyVisible(item, elements.notesList)) scrollWithin(elements.notesList, item);
  }
  const currentMapNodeId = currentStructuredMapNode()?.id;
  for (const item of elements.mindMap.querySelectorAll(".map-node[data-map-node-id]")) {
    item.classList.toggle("current", item.dataset.mapNodeId === currentMapNodeId);
  }
  renderSuggestion();
}

function isMostlyVisible(element, container) {
  const item = element.getBoundingClientRect();
  const viewport = container.getBoundingClientRect();
  return item.top >= viewport.top + 30 && item.bottom <= viewport.bottom - 30;
}

function scrollWithin(container, element) {
  const item = element.getBoundingClientRect();
  const viewport = container.getBoundingClientRect();
  const top = container.scrollTop + item.top - viewport.top - (container.clientHeight - item.height) / 2;
  container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

function renderSuggestion() {
  const suggestion = practice?.getSecondaryQuestion().active ? null : currentSuggestion();
  elements.suggestionBar.hidden = !suggestion;
  elements.suggestionTitle.textContent = suggestion?.title || "";
}

function renderMap() {
  elements.mindMap.replaceChildren();
  if (state.map?.nodes?.length) {
    renderStructuredMap();
    return;
  }

  const root = document.createElement("div");
  root.className = "map-root";
  const rootTitle = document.createElement("div");
  rootTitle.className = "map-root-title";
  rootTitle.textContent = state.course.title;
  const branches = document.createElement("div");
  branches.className = "map-branches";

  for (const theme of state.themes) {
    if (theme.id === "unclassified" && state.canvasObjects.every((object) => object.themeId !== theme.id)) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "map-node";
    if (theme.id === state.activeThemeId) button.classList.add("current");
    if (theme.status === "candidate") button.classList.add("candidate");
    if (["ignored", "merged"].includes(theme.status)) button.classList.add("ignored");
    button.dataset.themeId = theme.id;

    const title = document.createElement("span");
    title.className = "map-node-title";
    title.textContent = theme.title;
    const count = document.createElement("span");
    count.className = "map-node-count";
    count.textContent = String(state.canvasObjects.filter((object) => object.themeId === theme.id).length);
    button.append(title, count);
    button.addEventListener("click", () => selectMapTheme(theme));
    branches.append(button);
  }

  root.append(rootTitle, branches);
  elements.mindMap.append(root);
}

const MAP_KIND_LABELS = {
  course: "课程",
  topic: "主题",
  concept: "概念",
  formula: "公式",
  example: "例题",
  warning: "易错点",
  UNKNOWN: "类型未知",
};

const MAP_RELATION_LABELS = {
  "part-of": "属于",
  explains: "解释",
  derives: "推导出",
  applies: "应用于",
  contrasts: "对比",
  requires: "依赖",
  "example-of": "举例说明",
  "related-to": "相关",
  UNKNOWN: "关系未知",
};

const REVIEW_STATUS_LABELS = {
  verified: "独立核验通过",
  "needs-review": "待独立复核",
  UNKNOWN: "无法确定",
};

const BOUNDARY_RISK_LABELS = {
  "hard-start": "硬切片起点风险",
  "hard-end": "硬切片终点风险",
  "hard-both": "硬切片双侧风险",
};

function mapNodeDepth(node, nodeById) {
  let depth = 0;
  let parentId = node.parentId;
  const visited = new Set([node.id]);
  while (parentId && nodeById.has(parentId) && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = nodeById.get(parentId).parentId;
  }
  return depth;
}

function currentStructuredMapNode() {
  const nodes = state.map?.nodes || [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return nodes
    .filter((node) => Number.isFinite(node.start) && node.start <= state.player.currentTime)
    .sort((a, b) => a.start - b.start || mapNodeDepth(a, nodeById) - mapNodeDepth(b, nodeById))
    .at(-1) || null;
}

function renderStructuredMap() {
  const nodes = state.map.nodes;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    const key = node.parentId || "__root__";
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(node);
  }
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.start - b.start || a.label.localeCompare(b.label, "zh-CN"));
  }

  const tree = document.createElement("div");
  tree.className = "map-tree";
  const currentNodeId = currentStructuredMapNode()?.id;
  for (const rootNode of childrenByParent.get("__root__") || []) {
    appendStructuredMapNode(rootNode, tree, childrenByParent, currentNodeId);
  }
  elements.mindMap.append(tree);

  if (state.map.edges.length) {
    const relationSection = document.createElement("section");
    relationSection.className = "map-relations";
    const heading = document.createElement("h2");
    heading.textContent = `关系（${state.map.edges.length}）`;
    const list = document.createElement("ul");
    for (const edge of state.map.edges) {
      const item = document.createElement("li");
      const from = document.createElement("span");
      from.textContent = nodeById.get(edge.from)?.label || edge.from;
      const relation = document.createElement("strong");
      relation.textContent = MAP_RELATION_LABELS[edge.relation] || edge.relation;
      const to = document.createElement("span");
      to.textContent = nodeById.get(edge.to)?.label || edge.to;
      item.dataset.reviewStatus = edge.reviewStatus;
      item.append(from, relation, to, createReviewBadge(edge.reviewStatus));
      list.append(item);
    }
    relationSection.append(heading, list);
    elements.mindMap.append(relationSection);
  }
}

function appendStructuredMapNode(node, container, childrenByParent, currentNodeId) {
  const group = document.createElement("div");
  group.className = "map-tree-item";

  const button = document.createElement("button");
  button.type = "button";
  button.className = `map-node structured kind-${node.kind}`;
  button.dataset.mapNodeId = node.id;
  button.dataset.reviewStatus = node.reviewStatus;
  if (node.id === currentNodeId) button.classList.add("current");
  if (node.reviewStatus !== "verified") button.classList.add("needs-review");

  const copy = document.createElement("span");
  copy.className = "map-node-copy";
  const title = document.createElement("span");
  title.className = "map-node-title";
  title.textContent = node.label;
  const meta = document.createElement("span");
  meta.className = "map-node-meta";
  meta.textContent = `${MAP_KIND_LABELS[node.kind] || node.kind} · ${formatTime(node.start)}`;
  copy.append(title, meta);

  const status = document.createElement("span");
  status.className = "map-node-status";
  status.textContent = REVIEW_STATUS_LABELS[node.reviewStatus] || node.reviewStatus;
  button.append(copy, status);
  button.addEventListener("click", () => seekTo(node.start));
  group.append(button);

  const children = childrenByParent.get(node.id) || [];
  if (children.length) {
    const childContainer = document.createElement("div");
    childContainer.className = "map-children";
    for (const child of children) {
      appendStructuredMapNode(child, childContainer, childrenByParent, currentNodeId);
    }
    group.append(childContainer);
  }
  container.append(group);
}

function selectMapTheme(theme) {
  if (theme.status === "candidate") {
    forcedSuggestionId = theme.id;
    renderSuggestion();
    elements.suggestionBar.scrollIntoView({ block: "nearest" });
    return;
  }
  if (["ignored", "merged"].includes(theme.status)) return;
  state.activeThemeId = theme.id;
  forcedSuggestionId = null;
  seekTo(theme.start);
  renderHeader();
  renderMap();
  channel.postMessage({ type: "set-theme", theme: theme.title });
  scheduleSave();
}

function handleSuggestion(action) {
  if (state.studyBundle?.schemaVersion === 1) {
    showToast("结构化学习包的证据主题不可在此改写。", "error");
    return;
  }
  const suggestion = currentSuggestion();
  if (!suggestion) {
    showToast("当前没有待确认的主题建议。", "error");
    return;
  }

  if (action === "confirm") {
    suggestion.status = "confirmed";
    state.activeThemeId = suggestion.id;
    showToast(`已切换主题：${suggestion.title}`);
  } else if (action === "merge") {
    const targetId = state.activeThemeId;
    for (const note of state.notes) {
      if (note.themeId === suggestion.id) note.themeId = targetId;
    }
    suggestion.status = "merged";
    showToast(`已并入当前主题：${activeTheme().title}`);
  } else if (action === "ignore") {
    suggestion.status = "ignored";
    showToast(`已忽略主题建议：${suggestion.title}`);
  }

  forcedSuggestionId = null;
  renderHeader();
  renderNotes();
  renderMap();
  renderSuggestion();
  channel.postMessage({ type: "set-theme", theme: activeTheme().title });
  scheduleSave();
}

function applyLayout() {
  document.documentElement.style.setProperty("--left-width", `${state.layout.leftWidth}px`);
  document.documentElement.style.setProperty("--right-width", `${state.layout.rightWidth}px`);
  elements.workspace.classList.toggle("focus-mode", state.layout.focusMode);
}

function currentCanvasObjects() {
  return practice?.isActive() ? practice.getObjects() : state.canvasObjects;
}

function scheduleCanvasSave() {
  if (practice?.isActive()) practice.markDirty();
  else scheduleSave();
}

function renderCanvas() {
  renderDrawingObjects();
  renderCardObjects();
  elements.canvasEmpty.hidden = practice?.isActive() || currentCanvasObjects().length > 0;
  practice?.renderAnnotations();
  elements.deleteObject.disabled = !selectedObjectId;
  renderMap();
}

function renderDrawingObjects() {
  elements.drawingLayer.replaceChildren(createArrowDefinitions());
  for (const object of currentCanvasObjects()) {
    if (!["ink", "line", "arrow", "axes", "circle", "ellipse", "curve"].includes(object.type)) continue;
    const node = createDrawingNode(object);
    if (node) elements.drawingLayer.append(node);
  }
}

function createArrowDefinitions() {
  const defs = document.createElementNS(SVG_NS, "defs");
  const marker = document.createElementNS(SVG_NS, "marker");
  marker.setAttribute("id", "arrowhead");
  marker.setAttribute("markerWidth", "8");
  marker.setAttribute("markerHeight", "8");
  marker.setAttribute("refX", "6");
  marker.setAttribute("refY", "3");
  marker.setAttribute("orient", "auto");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M0,0 L0,6 L7,3 z");
  path.setAttribute("fill", "context-stroke");
  marker.append(path);
  defs.append(marker);
  return defs;
}

function createDrawingNode(object, isDraft = false) {
  const group = document.createElementNS(SVG_NS, "g");
  const offsetX = Number(object.offsetX || 0);
  const offsetY = Number(object.offsetY || 0);
  group.setAttribute("transform", `translate(${offsetX} ${offsetY})`);
  group.dataset.objectId = object.id;
  group.classList.add("drawing-object");
  if (object.id === selectedObjectId) group.classList.add("selected");
  if (isDraft) group.setAttribute("opacity", "0.72");
  const stroke = object.id === selectedObjectId ? "var(--pen-selected)" : object.id === "draft" ? "var(--pen-preview)" : "var(--pen)";

  if (object.type === "ink") {
    for (const [strokeIndex, points] of (object.strokes || []).entries()) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", pathFromPoints(points));
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", stroke);
      path.setAttribute("stroke-width", "2.6");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      path.dataset.objectId = object.id;
      path.dataset.strokeIndex = String(strokeIndex);
      group.append(path);
    }
    return group;
  }

  const start = object.start;
  const end = object.end;
  if (!start || !end) return null;
  const common = (node) => {
    node.setAttribute("fill", "none");
    node.setAttribute("stroke", stroke);
    node.setAttribute("stroke-width", "2.2");
    node.setAttribute("stroke-linecap", "round");
    node.dataset.objectId = object.id;
    group.append(node);
  };

  if (["line", "arrow"].includes(object.type)) {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", start.x);
    line.setAttribute("y1", start.y);
    line.setAttribute("x2", end.x);
    line.setAttribute("y2", end.y);
    if (object.type === "arrow") line.setAttribute("marker-end", "url(#arrowhead)");
    common(line);
  } else if (object.type === "axes") {
    const horizontal = document.createElementNS(SVG_NS, "line");
    horizontal.setAttribute("x1", Math.min(start.x, end.x));
    horizontal.setAttribute("y1", start.y);
    horizontal.setAttribute("x2", Math.max(start.x, end.x));
    horizontal.setAttribute("y2", start.y);
    horizontal.setAttribute("marker-end", "url(#arrowhead)");
    common(horizontal);
    const vertical = document.createElementNS(SVG_NS, "line");
    vertical.setAttribute("x1", start.x);
    vertical.setAttribute("y1", Math.max(start.y, end.y));
    vertical.setAttribute("x2", start.x);
    vertical.setAttribute("y2", Math.min(start.y, end.y));
    vertical.setAttribute("marker-end", "url(#arrowhead)");
    common(vertical);
  } else if (object.type === "circle") {
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", start.x);
    circle.setAttribute("cy", start.y);
    circle.setAttribute("r", Math.hypot(end.x - start.x, end.y - start.y));
    common(circle);
  } else if (object.type === "ellipse") {
    const ellipse = document.createElementNS(SVG_NS, "ellipse");
    ellipse.setAttribute("cx", (start.x + end.x) / 2);
    ellipse.setAttribute("cy", (start.y + end.y) / 2);
    ellipse.setAttribute("rx", Math.abs(end.x - start.x) / 2);
    ellipse.setAttribute("ry", Math.abs(end.y - start.y) / 2);
    common(ellipse);
  } else if (object.type === "curve") {
    const curve = document.createElementNS(SVG_NS, "path");
    const controlX = (start.x + end.x) / 2;
    const controlY = Math.min(start.y, end.y) - Math.max(50, Math.abs(end.x - start.x) * 0.22);
    curve.setAttribute("d", `M ${start.x} ${start.y} Q ${controlX} ${controlY} ${end.x} ${end.y}`);
    common(curve);
  }
  return group;
}

function pathFromPoints(points) {
  if (!points?.length) return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
}

async function exportPracticePage(objects) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('width', STAGE_SIZE.width);
  svg.setAttribute('height', STAGE_SIZE.height);
  svg.setAttribute('viewBox', `0 0 ${STAGE_SIZE.width} ${STAGE_SIZE.height}`);
  svg.append(createArrowDefinitions());
  for (const object of objects) {
    const node = createDrawingNode(object);
    if (node) svg.append(node);
  }
  for (const node of svg.querySelectorAll('[stroke]')) node.setAttribute('stroke', '#18211c');
  const data = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([data], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = STAGE_SIZE.width; canvas.height = STAGE_SIZE.height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    return canvas.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}

function renderCardObjects() {
  elements.objectLayer.replaceChildren();
  for (const object of currentCanvasObjects()) {
    if (!["screenshot", "anchor", "question"].includes(object.type)) continue;
    const card = document.createElement("article");
    card.className = `canvas-card ${object.type}-card${object.id === selectedObjectId ? " selected" : ""}`;
    card.dataset.objectId = object.id;
    card.style.left = `${object.x}px`;
    card.style.top = `${object.y}px`;
    if (object.type === "screenshot") {
      card.style.width = `${object.width || 360}px`;
      const image = document.createElement("img");
      image.src = object.image;
      image.alt = `课程截图 ${formatTime(object.time)}`;
      image.draggable = false;
      card.append(image);
    }

    const body = document.createElement("div");
    body.className = "card-body";
    const title = document.createElement("strong");
    title.className = "card-title";
    title.textContent = object.type === "screenshot"
      ? "课程画面"
      : object.type === "question" ? "疑问标记" : "时间锚点";
    const meta = document.createElement("div");
    meta.className = "card-meta";
    const time = document.createElement("button");
    time.type = "button";
    time.className = "card-time";
    time.textContent = formatTime(object.time);
    time.addEventListener("click", (event) => {
      event.stopPropagation();
      seekTo(object.time);
    });
    const theme = document.createElement("span");
    theme.textContent = state.themes.find((item) => item.id === object.themeId)?.title || "未归类";
    meta.append(time, theme);
    body.append(title, meta);
    card.append(body);
    elements.objectLayer.append(card);
  }
}

function pointFromEvent(event) {
  const bounds = elements.canvasStage.getBoundingClientRect();
  return {
    x: clamp(event.clientX - bounds.left, 0, STAGE_SIZE.width),
    y: clamp(event.clientY - bounds.top, 0, STAGE_SIZE.height),
    pressure: Number(event.pressure || 0.5),
  };
}

function beginPointerSession(event) {
  const point = pointFromEvent(event);
  const objectElement = event.target.closest?.("[data-object-id]");

  if (event.button === 1 || (event.pointerType === "pen" && event.button === 2)) {
    event.preventDefault();
    pointerSession = {
      type: "pan",
      startClientX: event.clientX,
      startClientY: event.clientY,
      startScrollLeft: elements.canvasViewport.scrollLeft,
      startScrollTop: elements.canvasViewport.scrollTop,
    };
    elements.canvasStage.setPointerCapture(event.pointerId);
    return;
  }

  if (event.button !== 0 || (practice?.isActive() && !practice.canEdit())) return;
  if (activeTool === "select") {
    if (!objectElement) {
      selectedObjectId = null;
      renderCanvas();
      return;
    }
    const object = currentCanvasObjects().find((item) => item.id === objectElement.dataset.objectId);
    if (!object) return;
    selectedObjectId = object.id;
    const position = objectPosition(object);
    pointerSession = {
      type: "drag",
      object,
      startPoint: point,
      startX: position.x,
      startY: position.y,
    };
    elements.canvasStage.setPointerCapture(event.pointerId);
    renderCanvas();
    return;
  }

  if (activeTool === "eraser") {
    event.preventDefault();
    pointerSession = { type: "erase" };
    elements.canvasStage.setPointerCapture(event.pointerId);
    eraseDrawingAt(point, event.clientX, event.clientY);
    return;
  }

  event.preventDefault();
  elements.canvasStage.setPointerCapture(event.pointerId);
  if (activeTool === "pen") {
    pointerSession = { type: "ink", points: [point] };
    createDraftInk(pointerSession.points);
  } else {
    pointerSession = { type: "shape", tool: activeTool, start: point, end: point };
    renderDraftShape(pointerSession);
  }
}

function movePointerSession(event) {
  if (!pointerSession) return;
  const point = pointFromEvent(event);
  if (pointerSession.type === "pan") {
    elements.canvasViewport.scrollLeft = pointerSession.startScrollLeft - (event.clientX - pointerSession.startClientX);
    elements.canvasViewport.scrollTop = pointerSession.startScrollTop - (event.clientY - pointerSession.startClientY);
  } else if (pointerSession.type === "drag") {
    setObjectPosition(
      pointerSession.object,
      pointerSession.startX + point.x - pointerSession.startPoint.x,
      pointerSession.startY + point.y - pointerSession.startPoint.y,
    );
    renderCanvas();
  } else if (pointerSession.type === "erase") {
    eraseDrawingAt(point, event.clientX, event.clientY);
  } else if (pointerSession.type === "ink") {
    const previous = pointerSession.points.at(-1);
    if (Math.hypot(point.x - previous.x, point.y - previous.y) >= 1.5) {
      pointerSession.points.push(point);
      draftElement?.setAttribute("d", pathFromPoints(pointerSession.points));
    }
  } else if (pointerSession.type === "shape") {
    pointerSession.end = point;
    renderDraftShape(pointerSession);
  }
}

function endPointerSession(event) {
  if (!pointerSession) return;
  if (pointerSession.type === "drag") {
    scheduleCanvasSave();
  } else if (pointerSession.type === "ink" && pointerSession.points.length > 1) {
    commitInkStroke(pointerSession.points);
  } else if (pointerSession.type === "shape") {
    const distance = Math.hypot(pointerSession.end.x - pointerSession.start.x, pointerSession.end.y - pointerSession.start.y);
    if (distance > 6) addCanvasObject({
      type: pointerSession.tool,
      start: pointerSession.start,
      end: pointerSession.end,
      offsetX: 0,
      offsetY: 0,
    });
  }
  removeDraft();
  pointerSession = null;
  if (elements.canvasStage.hasPointerCapture(event.pointerId)) elements.canvasStage.releasePointerCapture(event.pointerId);
}

function createDraftInk(points) {
  removeDraft();
  draftElement = document.createElementNS(SVG_NS, "path");
  draftElement.setAttribute("d", pathFromPoints(points));
  draftElement.setAttribute("fill", "none");
  draftElement.setAttribute("stroke", "var(--pen-preview)");
  draftElement.setAttribute("stroke-width", "2.6");
  draftElement.setAttribute("stroke-linecap", "round");
  draftElement.setAttribute("stroke-linejoin", "round");
  draftElement.setAttribute("pointer-events", "none");
  elements.drawingLayer.append(draftElement);
}

function renderDraftShape(session) {
  removeDraft();
  const draft = {
    id: "draft",
    type: session.tool,
    start: session.start,
    end: session.end,
    offsetX: 0,
    offsetY: 0,
  };
  draftElement = createDrawingNode(draft, true);
  if (draftElement) {
    draftElement.setAttribute("pointer-events", "none");
    elements.drawingLayer.append(draftElement);
  }
}

function removeDraft() {
  draftElement?.remove();
  draftElement = null;
}

function pointNearStroke(point, stroke, radius = 12) {
  for (let i = 1; i < stroke.length; i += 1) {
    const start = stroke[i - 1], end = stroke[i];
    const dx = end.x - start.x, dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const ratio = lengthSquared
      ? clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1)
      : 0;
    if (Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy)) <= radius) return true;
  }
  return false;
}

function eraseDrawingAt(point, clientX, clientY) {
  const objects = currentCanvasObjects();
  let index = -1, strokeIndex = -1;
  for (let objectIndex = objects.length - 1; objectIndex >= 0 && index < 0; objectIndex -= 1) {
    const object = objects[objectIndex];
    if (object.type !== "ink") continue;
    const localPoint = { x: point.x - Number(object.offsetX || 0), y: point.y - Number(object.offsetY || 0) };
    const strokes = object.strokes || [];
    for (let candidate = strokes.length - 1; candidate >= 0; candidate -= 1) {
      if (pointNearStroke(localPoint, strokes[candidate])) { index = objectIndex; strokeIndex = candidate; break; }
    }
  }
  if (index < 0) {
    const hit = document.elementsFromPoint(clientX, clientY).find((element) =>
      element.dataset?.objectId && element.closest?.("#drawing-layer"));
    if (!hit) return false;
    index = objects.findIndex((object) => object.id === hit.dataset.objectId);
    strokeIndex = Number.parseInt(hit.dataset.strokeIndex, 10);
  }
  if (index < 0) return false;
  const object = objects[index];
  if (object.type === "ink" && object.strokes?.length > 1 && Number.isInteger(strokeIndex)) {
    object.strokes.splice(strokeIndex, 1);
  } else {
    objects.splice(index, 1);
  }
  if (selectedObjectId === object.id) selectedObjectId = null;
  renderCanvas();
  scheduleCanvasSave();
  return true;
}

function commitInkStroke(points) {
  addCanvasObject({ type: "ink", strokes: [points], offsetX: 0, offsetY: 0 }, { select: false });
}

function objectPosition(object) {
  if (["screenshot", "anchor", "question"].includes(object.type)) return { x: object.x, y: object.y };
  return { x: Number(object.offsetX || 0), y: Number(object.offsetY || 0) };
}

function setObjectPosition(object, x, y) {
  if (["screenshot", "anchor", "question"].includes(object.type)) {
    object.x = clamp(x, 0, STAGE_SIZE.width - 80);
    object.y = clamp(y, 0, STAGE_SIZE.height - 60);
  } else {
    object.offsetX = x;
    object.offsetY = y;
  }
}

function addCanvasObject(partial, { select = true } = {}) {
  if (practice?.isActive() && !practice.canEdit()) return null;
  const object = {
    id: createId(partial.type || "object"),
    themeId: state.activeThemeId || "unclassified",
    time: state.player.currentTime,
    createdAt: Date.now(),
    ...partial,
  };
  currentCanvasObjects().push(object);
  selectedObjectId = select ? object.id : null;
  renderCanvas();
  scheduleCanvasSave();
  return object;
}

function addAnchor() {
  if (practice?.isActive()) { showToast('时间锚点请在课程笔记中记录'); return; }
  const position = nextCanvasPosition(currentCanvasObjects(), 230, 90);
  addCanvasObject({ type: "anchor", ...position });
  showToast(`已添加时间锚点 ${formatTime(state.player.currentTime)}`);
}

function addQuestion() {
  if (practice?.isActive()) { showToast('作答疑问请写在下方补充说明中'); return; }
  const position = nextCanvasPosition(currentCanvasObjects(), 280, 100);
  addCanvasObject({ type: "question", ...position });
  showToast(`已记录疑问位置 ${formatTime(state.player.currentTime)}`);
}

function addScreenshot(message) {
  if (practice?.isActive()) { showToast("课程截图请切回课程笔记后保存"); return; }
  const screenshotCount = currentCanvasObjects().filter((object) => object.type === "screenshot").length;
  if (screenshotCount >= 16) {
    showToast("原型最多保留16张截图，请先删除不需要的截图。", "error");
    return;
  }
  const position = nextCanvasPosition(currentCanvasObjects(), 360, 250);
  const object = addCanvasObject({
    type: "screenshot",
    image: message.image,
    time: message.time,
    width: 360,
    ...position,
  });
  if (pendingCaptureMode === "annotate") {
    setTool("pen");
    elements.canvasViewport.scrollTo({ left: Math.max(0, object.x - 80), top: Math.max(0, object.y - 80) });
    showToast("截图已加入画布，可以直接批注。按 Esc 返回选择工具。");
  } else {
    showToast(`已保存课程画面 ${formatTime(message.time)}`);
  }
  pendingCaptureMode = "plain";
}

function removeSelectedObject() {
  if (practice?.isActive() && !practice.canEdit()) return;
  if (!selectedObjectId) return;
  const index = currentCanvasObjects().findIndex((object) => object.id === selectedObjectId);
  if (index < 0) return;
  currentCanvasObjects().splice(index, 1);
  selectedObjectId = null;
  renderCanvas();
  scheduleCanvasSave();
}

function undoLastObject() {
  if (practice?.isActive() && !practice.canEdit()) return;
  const removed = currentCanvasObjects().pop();
  if (!removed) {
    showToast("画布中没有可撤销的对象。", "error");
    return;
  }
  if (selectedObjectId === removed.id) selectedObjectId = null;
  renderCanvas();
  scheduleCanvasSave();
  showToast("已撤销上一个画布对象。 ");
}

function setTool(tool) {
  activeTool = tool;
  if (tool !== "select" && selectedObjectId) {
    selectedObjectId = null;
    renderCanvas();
  }
  elements.canvasStage.dataset.tool = tool;
  for (const button of document.querySelectorAll("[data-tool]")) {
    button.classList.toggle("active", button.dataset.tool === tool);
  }
  const hints = {
    select: "选择对象后可移动，数位笔侧键用于平移",
    pen: "每次落笔独立保存，抬笔后不显示选框；按 Esc 返回选择",
    eraser: "按住并拖过笔迹即可擦除；旧的成组手写也按单条笔画擦除",
    line: "在画布拖动生成直线",
    arrow: "在画布拖动生成箭头",
    axes: "从原点向右上或右下拖动生成坐标轴",
    circle: "从圆心向外拖动生成圆",
    ellipse: "拖动外接矩形生成椭圆",
    curve: "拖动生成平滑曲线",
  };
  elements.canvasHint.textContent = hints[tool] || hints.select;
}

function flashGeometryTools() {
  const tools = document.querySelectorAll(".geometry-tool");
  for (const button of tools) button.classList.add("geometry-flash");
  tools[0]?.focus();
  setTimeout(() => {
    for (const button of tools) button.classList.remove("geometry-flash");
  }, 1200);
  showToast("请选择直线、箭头、坐标轴、圆、椭圆或曲线。 ");
}

let openingPlayer = false;
async function openPlayerWindow() {
  if (openingPlayer) return;
  openingPlayer = true;
  try {
    const training = practice?.getSecondaryQuestion().active;
    const url = `./player.html?session=${encodeURIComponent(playerSession)}${training ? '&present=1' : ''}`;
    playerWindow = training ? await openTrainingWindow({ url, name: `study-desk-player-${playerSession}`, existing: playerWindow, notify: showToast })
      : window.open(url, `study-desk-player-${playerSession}`, "popup,width=1200,height=780");
    if (!playerWindow) {
      showToast("浏览器阻止了副屏窗口，请允许本站弹出窗口，或使用“在新标签页打开”。", "error");
      return;
    }
    if (training) channel.postMessage({ type: 'presentation-fullscreen' });
    setTimeout(sendPlayerInit, 250);
  } catch (error) { showToast(`副屏打开失败：${error.message}`, 'error'); }
  finally { openingPlayer = false; }
}

function sendPlayerInit() {
  const question = practice?.getSecondaryQuestion() || { active: false };
  channel.postMessage({ type: 'question-view', ...question });
  elements.openPlayer.textContent = question.active ? '副屏看题' : '打开副屏播放器';
  refreshQuestionConnection();
  if (question.active) return;
  channel.postMessage({
    type: "init",
    lessonId: state.lessonId,
    courseTitle: state.course.title,
    theme: activeTheme().title,
    player: state.player,
  });
  if (videoObjectUrl) {
    channel.postMessage({
      type: "load-video",
      lessonId: state.lessonId,
      url: videoObjectUrl,
      name: state.course.videoName,
      currentTime: state.player.currentTime,
      rate: state.player.rate,
    });
  }
}

function sendPlayerCommand(command, detail = {}) {
  channel.postMessage({ type: "player-command", command, ...detail });
}

function seekTo(time) {
  const sourceState = sourceMatchState();
  if (!sourceState.seekAllowed) {
    renderSourceIntegrity();
    showToast(sourceState.status === "mismatch"
      ? "当前视频与学习包来源哈希不一致，未执行跳转。"
      : "请先选择学习包指定的视频，再执行跳转。", "error");
    return false;
  }
  state.player.currentTime = Number(time || 0);
  sendPlayerCommand("seek", { time: state.player.currentTime });
  updateTimeDependentView();
  scheduleSave();
  return true;
}

function captureFrame(mode = "plain") {
  if (!sourceMatchState().seekAllowed) { showToast('请先选择并核验课程视频', 'error'); return; }
  pendingCaptureMode = mode;
  sendPlayerCommand("capture");
  showToast("正在从副屏播放器获取当前画面。 ");
}

function handleShortcut(action) {
  if (!action) return;
  if (action === "toggle-playback") sendPlayerCommand("toggle");
  else if (action === "add-anchor") addAnchor();
  else if (action === "capture-frame") captureFrame("plain");
  else if (action === "capture-and-annotate") captureFrame("annotate");
  else if (action === "start-derivation") {
    sendPlayerCommand("pause");
    setTool("pen");
    elements.canvasStage.focus();
    showToast(`已暂停，推导绑定到 ${formatTime(state.player.currentTime)}`);
  } else if (action === "geometry-tools") flashGeometryTools();
  else if (action === "add-question") library.quickEntry().catch(error => showToast(error.message, 'error'));
  else if (action === "show-theme-suggestion") {
    const next = nextThemeCandidate(state.themes, state.player.currentTime, true);
    forcedSuggestionId = next?.id || null;
    renderSuggestion();
    if (!next) showToast("当前没有待确认的主题建议。", "error");
  } else if (action === "confirm-theme") handleSuggestion("confirm");
}

async function handleTranscriptFile(file) {
  if (changingCourse || !library.isReady()) { showToast('请等待课程库就绪', 'error'); return; }
  changingCourse = true;
  elements.transcriptInput.disabled = true;
  elements.videoInput.disabled = true;
  try {
    const text = await file.text();
    let notes;
    let map;
    let themes;
    let studyBundle = null;
    let title = file.name.replace(/\.[^.]+$/, '');
    let transcriptFormat;
    if (file.name.toLowerCase().endsWith(".json")) {
      const payload = JSON.parse(text);
      const bundle = normaliseStudyBundle(payload);
      notes = bundle.notes;
      map = bundle.map;
      title = String(bundle.title || title);
      transcriptFormat = bundle.schemaVersion === 1 ? "study-bundle" : "legacy-json";
      themes = themeCandidatesFromNotes(notes);
      if (bundle.schemaVersion === 1) {
        studyBundle = { schemaVersion: 1, source: bundle.source, cues: bundle.cues };
        themes = themes.map((theme) => ({ ...theme, status: "confirmed" }));
      }
    } else {
      const cues = parseSrt(text);
      notes = buildLinearNotesFromCues(cues);
      map = { nodes: [], edges: [] };
      themes = [{ id: "unclassified", title: "未归类", start: 0, status: "confirmed" }];
      transcriptFormat = "srt";
    }
    const identity = studyBundle ? text : `${videoSha256}\n${text}`;
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)))].map(b => b.toString(16).padStart(2, '0')).join('');
    const previousMedia = mediaFile;
    const compatibleMedia = previousMedia && (!studyBundle || studyBundle.source.fileSha256 === videoSha256);
    const fresh = {
      ...createDefaultState(),
      lessonId: `lesson-${hash}`,
      entries: [],
      canvasObjects: [],
      notes,
      map,
      themes,
      studyBundle,
      contentView: "notes",
      activeThemeId: "unclassified",
      course: {
        ...createDefaultState().course,
        title,
        transcriptName: file.name,
        transcriptFormat,
        demo: false,
      },
    };
    await library.importSnapshot(fresh);
    if (compatibleMedia) await handleVideoFile(previousMedia, true);
    showToast(`${studyBundle ? "已导入学习包" : "已导入逐字稿"}：${file.name}`);
  } catch (error) {
    showToast(`逐字稿导入失败：${error.message}`, "error");
  } finally { changingCourse = false; elements.transcriptInput.value = ''; elements.transcriptInput.disabled = false; elements.videoInput.disabled = false; }
}

async function handleVideoFile(file, internal = false) {
  if (!library.isReady() || (changingCourse && !internal)) { showToast('请等待课程库就绪', 'error'); return; }
  const lesson = state.lessonId;
  showToast('正在本机核验视频来源，不保存或上传原视频');
  const response = await fetch('/api/media-hash', { method: 'POST', headers: { 'X-Study-Desk': '1' }, body: file });
  if (!response.ok) throw new Error('视频来源核验失败');
  const hash = (await response.json()).sha256;
  if (state.lessonId !== lesson) throw new Error('核验期间课程已切换，请重新选择视频');
  if (state.studyBundle?.source.fileSha256 && state.studyBundle.source.fileSha256 !== hash) throw new Error('所选视频内容与学习包不一致，即使同名也不能绑定');
  if (!state.studyBundle && (state.course.demo || (state.course.videoSha256 && state.course.videoSha256 !== hash))) {
    const fresh = createDefaultState(); fresh.lessonId = `media-${hash}`; fresh.entries = []; fresh.notes = []; fresh.canvasObjects = []; fresh.studyBundle = null; fresh.map = { nodes: [], edges: [] };
    fresh.themes = [{ id: 'unclassified', title: '未归类', start: 0, status: 'confirmed' }]; fresh.activeThemeId = 'unclassified';
    fresh.course = { ...fresh.course, title: file.name, demo: false, videoSha256: hash, transcriptName: '', transcriptFormat: '' };
    await library.importSnapshot(fresh);
  }
  if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
  videoObjectUrl = URL.createObjectURL(file);
  videoSha256 = hash;
  mediaFile = file;
  state.course.videoName = file.name;
  state.course.videoSha256 = hash;
  if (state.course.demo) state.course.title = file.name.replace(/\.[^.]+$/, "");
  state.course.demo = false;
  renderHeader();
  renderSourceIntegrity();
  scheduleSave();
  if (playerWindow && !playerWindow.closed) sendPlayerInit();
  setTimeout(sendPlayerInit, 450);
}

function configureResizer(element, side) {
  element.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const start = event.clientX;
    const initial = side === "left" ? state.layout.leftWidth : state.layout.rightWidth;
    element.classList.add("dragging");
    element.setPointerCapture(event.pointerId);

    const move = (moveEvent) => {
      const delta = moveEvent.clientX - start;
      if (side === "left") state.layout.leftWidth = clamp(initial + delta, 340, 600);
      else state.layout.rightWidth = clamp(initial - delta, 420, 760);
      applyLayout();
    };
    const up = () => {
      element.classList.remove("dragging");
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      scheduleSave();
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
  });
}

channel.addEventListener("message", (event) => {
  const message = event.data || {};
  if (message.type === "player-ready") sendPlayerInit();
  else if (message.type === 'training-next') {
    practice?.navigateTraining(message).finally(sendPlayerInit);
  }
  else if (message.type === 'question-view-ready') {
    questionPeers.set(message.viewerId, { key: `${message.trainingId || ''}:${message.itemId || ''}`, at: Date.now() });
    refreshQuestionConnection();
  } else if (message.type === 'player-closed') {
    questionPeers.delete(message.viewerId); refreshQuestionConnection();
  }
  else if (message.lessonId !== state.lessonId || changingCourse || !videoObjectUrl) return;
  else if (message.type === "player-state") {
    state.player = { ...state.player, ...message.player };
    updateTimeDependentView();
    scheduleSave();
  } else if (message.type === "screenshot") addScreenshot(message);
  else if (message.type === "player-shortcut") handleShortcut(message.action);
  else if (message.type === "player-error") showToast(message.message || "播放器发生错误。", "error");
});

document.addEventListener("keydown", (event) => {
  if (event.target.closest?.('input, textarea, select, [contenteditable="true"]') || document.querySelector('#library-dialog[open], #practice-classroom-dialog[open]')) return;
  if (practice?.getSecondaryQuestion().active && ['Enter', 'ArrowRight'].includes(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey) return;
  const action = shortcutFromEvent(event);
  if (action) {
    event.preventDefault();
    if (event.repeat && action === "toggle-playback") return;
    handleShortcut(action);
    return;
  }
  if (event.key === "Escape") {
    setTool("select");
    selectedObjectId = null;
    renderCanvas();
  } else if ((event.key === "Delete" || event.key === "Backspace") && selectedObjectId) {
    event.preventDefault();
    removeSelectedObject();
  } else if (event.ctrlKey && event.code === "KeyZ") {
    event.preventDefault();
    undoLastObject();
  }
});

elements.videoInput.addEventListener("change", () => {
  const file = elements.videoInput.files?.[0];
  if (file) handleVideoFile(file).catch(error => showToast(error.message, 'error')).finally(() => { elements.videoInput.value = ''; });
});
elements.transcriptInput.addEventListener("change", () => {
  const file = elements.transcriptInput.files?.[0];
  if (file) handleTranscriptFile(file);
});
elements.showNotes.addEventListener("click", () => {
  state.contentView = "notes";
  renderNotes();
  scheduleSave();
});
elements.showCues.addEventListener("click", () => {
  if (!state.studyBundle?.cues?.length) return;
  state.contentView = "cues";
  renderNotes();
  scheduleSave();
});
elements.openPlayer.addEventListener("click", openPlayerWindow);
elements.focusMode.addEventListener("click", () => {
  state.layout.focusMode = !state.layout.focusMode;
  applyLayout();
  renderHeader();
  scheduleSave();
});
elements.currentTheme.addEventListener("click", () => handleShortcut("show-theme-suggestion"));
elements.suggestionBar.addEventListener("click", (event) => {
  const button = event.target.closest("[data-suggestion-action]");
  if (button) handleSuggestion(button.dataset.suggestionAction);
});
elements.fitMap.addEventListener("click", () => {
  const current = elements.mindMap.querySelector(".map-node.current");
  if (current) scrollWithin(elements.mindMap, current);
});
elements.undoObject.addEventListener("click", undoLastObject);
elements.deleteObject.addEventListener("click", removeSelectedObject);
document.querySelectorAll("[data-tool]").forEach((button) => {
  button.addEventListener("click", () => setTool(button.dataset.tool));
});

elements.canvasStage.addEventListener("pointerdown", beginPointerSession);
elements.canvasStage.addEventListener("pointermove", movePointerSession);
elements.canvasStage.addEventListener("pointerup", endPointerSession);
elements.canvasStage.addEventListener("pointercancel", endPointerSession);
elements.canvasStage.addEventListener("contextmenu", (event) => {
  if (event.pointerType === "pen") event.preventDefault();
});
configureResizer(elements.leftResizer, "left");
configureResizer(elements.rightResizer, "right");

window.addEventListener("beforeunload", () => {
  channel.postMessage({ type: 'main-disconnected' });
  if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
});

library = mountLibrary({ getState: () => state, setState: next => {
  clearTimeout(saveTimer);
  channel.postMessage({ type: 'unload-video' });
  if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
  videoObjectUrl = ''; videoSha256 = ''; mediaFile = null;
  selectedObjectId = null; forcedSuggestionId = null; pointerSession = null;
  state = next; practice?.onLessonChange(); renderAll(); materials?.refresh(); sendPlayerInit();
}, seek: time => { state.player.currentTime = time; updateTimeDependentView(); if (!seekTo(time)) scheduleSave(); }, toast: showToast });
practice = mountPractice({
  getState: () => state, api, toast: showToast,
  renderCanvas: () => { selectedObjectId = null; pointerSession = null; removeDraft(); renderCanvas(); },
  setTool, exportPage: exportPracticePage,
  saveCourse: () => library.save(),
  openQuestionScreen: openPlayerWindow, onQuestionChange: () => { renderHeader(); renderSuggestion(); sendPlayerInit(); },
});
renderAll();
if (subject === 'physics') materials = mountCourseMaterials({ getState: () => state, api, toast: showToast,
  openCourse: async id => { await practice.showCourse(); await library.openCourse(id); },
  openItem: async id => { await library.save(); await practice.openItem(id); },
  loadVideo: async video => {
    const expected = state.studyBundle?.source.fileSha256 || state.course.videoSha256;
    if (expected && expected !== video.sha256) throw new Error('所选视频与课程记录不一致');
    if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
    videoObjectUrl = new URL(video.url, location.href).href; videoSha256 = video.sha256; mediaFile = null;
    renderHeader(); renderSourceIntegrity(); sendPlayerInit();
  },
});
document.querySelector('#back-to-subjects').addEventListener('click', async event => {
  event.preventDefault();
  try {
    await practice.saveDrafts();
    await library.flush();
    channel.postMessage({ type: 'unload-video' });
    location.assign('./');
  } catch (error) { showToast(`尚未返回入口：${error.message}`, 'error'); }
});
await library.bootstrap();
await practice.bootstrap();
if (legacyError) showToast(legacyError, 'error');
setInterval(() => { if (library.isReady() && library.isDirty()) saveState().catch(() => {}); }, 10000);
