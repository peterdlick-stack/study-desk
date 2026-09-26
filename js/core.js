export const CHANNEL_NAME = "local-study-desk-session-v1";
export const STORAGE_KEY = "local-study-desk-state-v1";
export const STAGE_SIZE = { width: 2400, height: 1600 };
export const REVIEW_STATUSES = new Set(["verified", "needs-review", "UNKNOWN"]);
export const BOUNDARY_MODES = new Set(["natural", "hard"]);
export const BOUNDARY_RISKS = new Set(["none", "hard-start", "hard-end", "hard-both"]);
export const MAP_NODE_KINDS = new Set(["course", "topic", "concept", "formula", "example", "warning", "UNKNOWN"]);
export const MAP_RELATIONS = new Set([
  "part-of",
  "explains",
  "derives",
  "applies",
  "contrasts",
  "requires",
  "example-of",
  "related-to",
  "UNKNOWN",
]);
const CUE_ID_PATTERN = /^cue-\d{6}$/;
const GENERATED_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TIME_TOLERANCE_SECONDS = 0.001;
const STUDY_BUNDLE_LIMITS = {
  cues: 12000,
  notes: 4000,
  nodes: 1500,
  edges: 4000,
  depth: 64,
};

export function createId(prefix = "item") {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function formatTime(value) {
  const seconds = Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const minuteText = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes).padStart(2, "0");
  const base = `${minuteText}:${String(remainder).padStart(2, "0")}`;
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${base}` : base;
}

export function parseTimecode(value) {
  const match = String(value).trim().match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?/);
  if (!match) return 0;
  const [, hours = "0", minutes = "0", seconds = "0", milliseconds = "0"] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(milliseconds.padEnd(3, "0")) / 1000;
}

export function parseSrt(source) {
  const blocks = String(source)
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .trim()
    .split(/\n{2,}/);

  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) continue;
    const [startValue, endValue] = lines[timeIndex].split("-->").map((part) => part.trim());
    const text = lines.slice(timeIndex + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (!text) continue;
    cues.push({
      id: createId("cue"),
      start: parseTimecode(startValue),
      end: parseTimecode(endValue),
      text,
    });
  }
  return cues;
}

export function buildLinearNotesFromCues(cues, options = {}) {
  const maxCharacters = options.maxCharacters ?? 110;
  const maxSpan = options.maxSpan ?? 45;
  const notes = [];
  let current = null;

  for (const cue of cues) {
    const clean = cue.text.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const canMerge = current
      && cue.start - current.start <= maxSpan
      && `${current.summary}${clean}`.length <= maxCharacters;

    if (!canMerge) {
      current = {
        id: createId("note"),
        start: cue.start,
        end: cue.end,
        title: `逐字稿 ${formatTime(cue.start)}`,
        summary: clean,
        themeId: "unclassified",
      };
      notes.push(current);
    } else {
      current.end = cue.end;
      current.summary = `${current.summary} ${clean}`;
    }
  }
  return notes;
}

function normaliseLegacyNotes(payload) {
  const rawNotes = Array.isArray(payload) ? payload : payload?.notes;
  if (!Array.isArray(rawNotes)) throw new Error("JSON中没有 notes 数组");
  if (rawNotes.length > STUDY_BUNDLE_LIMITS.notes) {
    throw new Error(`notes 超过上限 ${STUDY_BUNDLE_LIMITS.notes}`);
  }

  const ids = new Set();
  return rawNotes.map((note, index) => {
    assertObject(note, `notes[${index}]`);
    const id = note.id || createId("note");
    if (ids.has(id)) throw new Error(`notes[${index}].id 重复：${id}`);
    ids.add(id);
    const start = Number(note.start ?? 0);
    const end = Number(note.end ?? note.start ?? 0);
    assertTimeRange(start, end, `notes[${index}]`);
    return {
      id,
      start,
      end,
      title: String(note.title || `笔记 ${index + 1}`),
      summary: String(note.summary || note.text || ""),
      themeId: note.themeId || "unclassified",
      themeTitle: note.themeTitle ? String(note.themeTitle) : undefined,
      ...(note.timingStatus === 'untimed' ? { timingStatus: 'untimed', reviewStatus: 'needs-review' } : {}),
    };
  }).sort((a, b) => a.start - b.start);
}

function assertObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} 必须是对象`);
  }
  return value;
}

function assertNonEmptyString(value, path) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} 必须是非空字符串`);
  return value.trim();
}

function assertNonNegativeTime(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} 必须是非负有限数`);
  }
  return value;
}

function assertTimeRange(start, end, path) {
  assertNonNegativeTime(start, `${path}.start`);
  assertNonNegativeTime(end, `${path}.end`);
  if (end < start) throw new Error(`${path} 的 end 不能早于 start`);
}

function assertUniqueId(value, path, ids) {
  const id = assertNonEmptyString(value, path);
  if (ids.has(id)) throw new Error(`${path} 重复：${id}`);
  ids.add(id);
  return id;
}

function assertReviewStatus(value, path) {
  if (!REVIEW_STATUSES.has(value)) {
    throw new Error(`${path} 非法：${String(value)}`);
  }
  return value;
}

function assertEnum(value, allowed, path) {
  if (!allowed.has(value)) throw new Error(`${path} 非法：${String(value)}`);
  return value;
}

function assertGeneratedId(value, path, ids, pattern = GENERATED_ID_PATTERN) {
  const id = assertUniqueId(value, path, ids);
  if (!pattern.test(id)) throw new Error(`${path} 格式非法：${id}`);
  return id;
}

function assertArrayLimit(value, path, maximum, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) throw new Error(`${path} 必须是数组`);
  if (nonEmpty && value.length === 0) throw new Error(`${path} 不能为空`);
  if (value.length > maximum) throw new Error(`${path} 超过上限 ${maximum}`);
  return value;
}

function nearlyEqual(left, right) {
  return Math.abs(left - right) <= TIME_TOLERANCE_SECONDS;
}

function assertEvidence(value, path, cueIds, cueOrder) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${path} 不能为空`);
  const seen = new Set();
  let previousOrder = -1;
  return value.map((cueId, index) => {
    const id = assertNonEmptyString(cueId, `${path}[${index}]`);
    if (seen.has(id)) throw new Error(`${path} 含重复 cue：${id}`);
    if (!cueIds.has(id)) throw new Error(`${path} 引用了未知 cue：${id}`);
    const order = cueOrder.get(id);
    if (order <= previousOrder) throw new Error(`${path} 必须按 cue 时间顺序排列`);
    previousOrder = order;
    seen.add(id);
    return id;
  });
}

export function normaliseStudyBundle(payload) {
  if (payload?.schemaVersion === undefined) {
    return {
      schemaVersion: null,
      title: payload && !Array.isArray(payload) && payload.title ? String(payload.title) : undefined,
      source: null,
      cues: [],
      notes: normaliseLegacyNotes(payload),
      map: { nodes: [], edges: [] },
    };
  }

  assertObject(payload, "bundle");
  if (payload.schemaVersion !== 1) throw new Error(`不支持 schemaVersion=${String(payload.schemaVersion)}`);
  const title = assertNonEmptyString(payload.title, "title");
  const source = assertObject(payload.source, "source");
  const normalisedSource = {
    fileName: assertNonEmptyString(source.fileName, "source.fileName"),
    fileSha256: assertNonEmptyString(source.fileSha256, "source.fileSha256").toLowerCase(),
    transcriptSha256: assertNonEmptyString(source.transcriptSha256, "source.transcriptSha256").toLowerCase(),
    sourceLanguage: assertNonEmptyString(source.sourceLanguage, "source.sourceLanguage"),
    outputLanguage: assertNonEmptyString(source.outputLanguage, "source.outputLanguage"),
    segmentStart: assertNonNegativeTime(source.segmentStart, "source.segmentStart"),
    duration: assertNonNegativeTime(source.duration, "source.duration"),
    boundaryMode: assertEnum(source.boundaryMode, BOUNDARY_MODES, "source.boundaryMode"),
  };
  if (!/^[a-f0-9]{64}$/.test(normalisedSource.fileSha256)) {
    throw new Error("source.fileSha256 必须是 64 位十六进制 SHA-256");
  }
  if (!/^[a-f0-9]{64}$/.test(normalisedSource.transcriptSha256)) {
    throw new Error("source.transcriptSha256 必须是 64 位十六进制 SHA-256");
  }
  if (normalisedSource.duration <= 0) throw new Error("source.duration 必须大于 0");

  assertArrayLimit(payload.cues, "cues", STUDY_BUNDLE_LIMITS.cues, { nonEmpty: true });
  assertArrayLimit(payload.notes, "notes", STUDY_BUNDLE_LIMITS.notes, { nonEmpty: true });
  const map = assertObject(payload.map, "map");
  assertArrayLimit(map.nodes, "map.nodes", STUDY_BUNDLE_LIMITS.nodes, { nonEmpty: true });
  assertArrayLimit(map.edges, "map.edges", STUDY_BUNDLE_LIMITS.edges);

  const allIds = new Set();
  const cueIds = new Set();
  const cues = payload.cues.map((rawCue, index) => {
    const cue = assertObject(rawCue, `cues[${index}]`);
    const id = assertGeneratedId(cue.id, `cues[${index}].id`, allIds, CUE_ID_PATTERN);
    cueIds.add(id);
    assertTimeRange(cue.start, cue.end, `cues[${index}]`);
    return {
      id,
      start: cue.start,
      end: cue.end,
      sourceText: assertNonEmptyString(cue.sourceText, `cues[${index}].sourceText`),
      translatedText: assertNonEmptyString(cue.translatedText, `cues[${index}].translatedText`),
      reviewStatus: assertReviewStatus(cue.reviewStatus, `cues[${index}].reviewStatus`),
      boundaryRisk: assertEnum(cue.boundaryRisk, BOUNDARY_RISKS, `cues[${index}].boundaryRisk`),
    };
  }).sort((a, b) => a.start - b.start);
  const segmentEnd = normalisedSource.segmentStart + normalisedSource.duration;
  if (!Number.isFinite(segmentEnd)) throw new Error("source 时间区间必须是有限值");
  for (const cue of cues) {
    if (cue.start < normalisedSource.segmentStart - TIME_TOLERANCE_SECONDS
      || cue.end > segmentEnd + TIME_TOLERANCE_SECONDS) {
      throw new Error(`cue ${cue.id} 超出 source 时间区间`);
    }
  }
  const expectedBoundaryRisks = normalisedSource.boundaryMode === "natural"
    ? cues.map(() => "none")
    : cues.length === 1
      ? ["hard-both"]
      : cues.map((_, index) => (index === 0 ? "hard-start" : index === cues.length - 1 ? "hard-end" : "none"));
  for (const [index, cue] of cues.entries()) {
    if (cue.boundaryRisk !== expectedBoundaryRisks[index]) {
      throw new Error(`cue ${cue.id} 的 boundaryRisk 与 source.boundaryMode 不一致`);
    }
  }
  const cueById = new Map(cues.map((cue) => [cue.id, cue]));
  const cueOrder = new Map(cues.map((cue, index) => [cue.id, index]));

  const notes = payload.notes.map((rawNote, index) => {
    const note = assertObject(rawNote, `notes[${index}]`);
    const id = assertGeneratedId(note.id, `notes[${index}].id`, allIds);
    assertTimeRange(note.start, note.end, `notes[${index}]`);
    const evidenceCueIds = assertEvidence(note.evidenceCueIds, `notes[${index}].evidenceCueIds`, cueIds, cueOrder);
    const firstEvidence = cueById.get(evidenceCueIds[0]);
    const evidenceEnd = Math.max(...evidenceCueIds.map((cueId) => cueById.get(cueId).end));
    if (!nearlyEqual(note.start, firstEvidence.start) || !nearlyEqual(note.end, evidenceEnd)) {
      throw new Error(`notes[${index}] 的时间必须匹配首个证据开始与证据最大结束时间`);
    }
    return {
      id,
      start: note.start,
      end: note.end,
      title: assertNonEmptyString(note.title, `notes[${index}].title`),
      summary: assertNonEmptyString(note.summary, `notes[${index}].summary`),
      themeId: assertNonEmptyString(note.themeId, `notes[${index}].themeId`),
      themeTitle: assertNonEmptyString(note.themeTitle, `notes[${index}].themeTitle`),
      evidenceCueIds,
      reviewStatus: assertReviewStatus(note.reviewStatus, `notes[${index}].reviewStatus`),
    };
  }).sort((a, b) => a.start - b.start);
  const noteCoveredCueIds = new Set(notes.flatMap((note) => note.evidenceCueIds));
  const uncoveredCueIds = cues.filter((cue) => !noteCoveredCueIds.has(cue.id)).map((cue) => cue.id);
  if (uncoveredCueIds.length) throw new Error(`notes 未覆盖 cue：${uncoveredCueIds.join(", ")}`);

  const nodes = map.nodes.map((rawNode, index) => {
    const node = assertObject(rawNode, `map.nodes[${index}]`);
    const id = assertGeneratedId(node.id, `map.nodes[${index}].id`, allIds);
    if (!MAP_NODE_KINDS.has(node.kind)) throw new Error(`map.nodes[${index}].kind 非法：${String(node.kind)}`);
    if (node.parentId !== null && (typeof node.parentId !== "string" || !node.parentId.trim())) {
      throw new Error(`map.nodes[${index}].parentId 必须是节点 ID 或 null`);
    }
    const start = assertNonNegativeTime(node.start, `map.nodes[${index}].start`);
    const evidenceCueIds = assertEvidence(node.evidenceCueIds, `map.nodes[${index}].evidenceCueIds`, cueIds, cueOrder);
    if (!nearlyEqual(start, cueById.get(evidenceCueIds[0]).start)) {
      throw new Error(`map.nodes[${index}].start 必须精确匹配首个证据 cue`);
    }
    return {
      id,
      label: assertNonEmptyString(node.label, `map.nodes[${index}].label`),
      kind: node.kind,
      parentId: node.parentId === null ? null : node.parentId.trim(),
      start,
      evidenceCueIds,
      reviewStatus: assertReviewStatus(node.reviewStatus, `map.nodes[${index}].reviewStatus`),
    };
  });

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const courseRoots = nodes.filter((node) => node.kind === "course" && node.parentId === null);
  if (courseRoots.length !== 1) throw new Error("map 必须且只能有一个 parentId=null 的 course 根节点");
  const courseRoot = courseRoots[0];
  if (courseRoot.evidenceCueIds.length !== cues.length
    || courseRoot.evidenceCueIds.some((cueId, index) => cueId !== cues[index].id)) {
    throw new Error("course 根节点必须按顺序覆盖全部 cue");
  }
  for (const node of nodes) {
    if (node.kind === "course" && node.parentId !== null) throw new Error(`course 节点 ${node.id} 的 parentId 必须为 null`);
    if (node.kind !== "course" && !node.parentId) throw new Error(`非 course 节点 ${node.id} 必须有 parentId`);
    if (node.parentId === node.id) throw new Error(`节点 ${node.id} 不能以自身为 parent`);
    if (node.parentId && !nodeById.has(node.parentId)) throw new Error(`节点 ${node.id} 的 parentId 不存在：${node.parentId}`);

    const ancestors = new Set([node.id]);
    let parentId = node.parentId;
    let depth = 0;
    while (parentId) {
      if (ancestors.has(parentId)) throw new Error(`节点 ${node.id} 的 parent 链形成循环`);
      ancestors.add(parentId);
      depth += 1;
      if (depth > STUDY_BUNDLE_LIMITS.depth) {
        throw new Error(`节点 ${node.id} 超过最大层级 ${STUDY_BUNDLE_LIMITS.depth}`);
      }
      parentId = nodeById.get(parentId)?.parentId || null;
    }
    const rootId = [...ancestors].at(-1);
    if (rootId !== courseRoot.id) throw new Error(`节点 ${node.id} 未回溯到 course 根节点`);
  }

  const edges = map.edges.map((rawEdge, index) => {
    const edge = assertObject(rawEdge, `map.edges[${index}]`);
    const id = assertGeneratedId(edge.id, `map.edges[${index}].id`, allIds);
    const from = assertNonEmptyString(edge.from, `map.edges[${index}].from`);
    const to = assertNonEmptyString(edge.to, `map.edges[${index}].to`);
    if (!nodeById.has(from) || !nodeById.has(to)) throw new Error(`map.edges[${index}] 存在悬空端点`);
    if (from === to) throw new Error(`map.edges[${index}] 不能自环`);
    if (!MAP_RELATIONS.has(edge.relation)) throw new Error(`map.edges[${index}].relation 非法：${String(edge.relation)}`);
    const evidenceCueIds = assertEvidence(edge.evidenceCueIds, `map.edges[${index}].evidenceCueIds`, cueIds, cueOrder);
    const evidenceSet = new Set(evidenceCueIds);
    if (!nodeById.get(from).evidenceCueIds.some((cueId) => evidenceSet.has(cueId))) {
      throw new Error(`map.edges[${index}] 的证据未与 from 节点相交`);
    }
    if (!nodeById.get(to).evidenceCueIds.some((cueId) => evidenceSet.has(cueId))) {
      throw new Error(`map.edges[${index}] 的证据未与 to 节点相交`);
    }
    return {
      id,
      from,
      to,
      relation: edge.relation,
      evidenceCueIds,
      reviewStatus: assertReviewStatus(edge.reviewStatus, `map.edges[${index}].reviewStatus`),
    };
  });

  for (const [index, note] of notes.entries()) {
    const theme = nodeById.get(note.themeId);
    if (!theme) throw new Error(`notes[${index}].themeId 不存在：${note.themeId}`);
    if (note.themeTitle !== theme.label) {
      throw new Error(`notes[${index}].themeTitle 必须与对应地图节点 label 完全相同`);
    }
  }

  return {
    schemaVersion: 1,
    title,
    source: normalisedSource,
    cues,
    notes,
    map: { nodes, edges },
  };
}

export function normaliseStructuredNotes(payload) {
  return payload?.schemaVersion === undefined
    ? normaliseLegacyNotes(payload)
    : normaliseStudyBundle(payload).notes;
}

export function themeCandidatesFromNotes(notes) {
  const seen = new Set();
  const themes = [{ id: "unclassified", title: "未归类", start: 0, status: "confirmed" }];
  for (const note of notes) {
    if (!note.themeId || note.themeId === "unclassified" || seen.has(note.themeId)) continue;
    seen.add(note.themeId);
    themes.push({
      id: note.themeId,
      title: note.themeTitle || note.title,
      start: note.start,
      status: "candidate",
    });
  }
  return themes;
}

export function noteAtTime(notes, time) {
  if (!notes.length) return null;
  return notes.find((note) => time >= note.start && time < Math.max(note.end, note.start + 0.5))
    || [...notes].reverse().find((note) => time >= note.start)
    || notes[0];
}

export function nextThemeCandidate(themes, time, force = false) {
  const candidates = themes.filter((theme) => theme.status === "candidate").sort((a, b) => a.start - b.start);
  if (force) return candidates.find((theme) => theme.start >= time) || candidates[0] || null;
  return [...candidates].reverse().find((theme) => time >= theme.start) || null;
}

export function nextCanvasPosition(objects, width = 320, height = 210) {
  const index = objects.filter((object) => ["screenshot", "anchor", "question"].includes(object.type)).length;
  const columns = 4;
  return {
    x: 80 + (index % columns) * (width + 34),
    y: 80 + Math.floor(index / columns) * (height + 34),
  };
}

export function shortcutFromEvent(event) {
  const target = event.target;
  const editing = target instanceof HTMLElement
    && (target.matches("input, textarea, select") || target.isContentEditable);
  if (editing) return null;

  if (!event.ctrlKey && event.code === "Space") return "toggle-playback";
  if (!event.ctrlKey) return null;

  const shortcuts = {
    Digit1: "add-anchor",
    Digit2: "capture-frame",
    Digit3: "capture-and-annotate",
    Digit4: "start-derivation",
    KeyG: "geometry-tools",
    KeyQ: "add-question",
    KeyT: "show-theme-suggestion",
    Enter: "confirm-theme",
  };
  return shortcuts[event.code] || null;
}

export function createDefaultState() {
  return {
    version: 1,
    course: {
      title: "普通物理演示课",
      videoName: "",
      transcriptName: "演示内容",
      transcriptFormat: "demo",
      demo: true,
    },
    player: {
      currentTime: 0,
      duration: 0,
      rate: 1,
      playing: false,
    },
    layout: {
      leftWidth: 440,
      rightWidth: 520,
      focusMode: false,
    },
    activeThemeId: "kinematics",
    contentView: "notes",
    studyBundle: null,
    themes: [
      { id: "unclassified", title: "未归类", start: 0, status: "confirmed" },
      { id: "kinematics", title: "质点运动的描述", start: 0, status: "confirmed" },
      { id: "newton", title: "牛顿运动定律", start: 300, status: "candidate" },
      { id: "momentum", title: "动量与冲量", start: 720, status: "candidate" },
    ],
    notes: [
      {
        id: "demo-note-1",
        start: 0,
        end: 300,
        title: "参考系与质点模型",
        summary: "演示数据：先明确参考系、坐标系与研究对象，再描述位置随时间的变化。",
        themeId: "kinematics",
      },
      {
        id: "demo-note-2",
        start: 300,
        end: 720,
        title: "力与运动状态变化",
        summary: "演示数据：从受力分析进入运动方程，注意坐标方向与分量形式。",
        themeId: "newton",
        themeTitle: "牛顿运动定律",
      },
      {
        id: "demo-note-3",
        start: 720,
        end: 1080,
        title: "冲量与动量变化",
        summary: "演示数据：关注积分形式、方向关系与适用条件，必要时保存板书截图。",
        themeId: "momentum",
        themeTitle: "动量与冲量",
      },
    ],
    map: { nodes: [], edges: [] },
    canvasObjects: [],
  };
}
