import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLinearNotesFromCues,
  formatTime,
  nextCanvasPosition,
  nextThemeCandidate,
  noteAtTime,
  normaliseStructuredNotes,
  normaliseStudyBundle,
  parseSrt,
  parseTimecode,
} from "../js/core.js";

function validStudyBundle() {
  return {
    schemaVersion: 1,
    title: "MIT 8.01 测试片段",
    source: {
      fileName: "lecture.mp4",
      fileSha256: "a".repeat(64),
      transcriptSha256: "b".repeat(64),
      sourceLanguage: "en",
      outputLanguage: "zh-CN",
      segmentStart: 0,
      duration: 30,
      boundaryMode: "natural",
    },
    cues: [
      {
        id: "cue-000001",
        start: 0,
        end: 4,
        sourceText: "Velocity is a vector.",
        translatedText: "速度是矢量。",
        reviewStatus: "verified",
        boundaryRisk: "none",
      },
      {
        id: "cue-000002",
        start: 5,
        end: 8,
        sourceText: "This sign is easy to miss.",
        translatedText: "这个符号很容易漏掉。",
        reviewStatus: "needs-review",
        boundaryRisk: "none",
      },
    ],
    notes: [
      {
        id: "note-2",
        start: 5,
        end: 8,
        title: "符号提醒",
        summary: "检查方向与符号。",
        themeId: "map-topic",
        themeTitle: "运动学",
        evidenceCueIds: ["cue-000002"],
        reviewStatus: "needs-review",
      },
      {
        id: "note-1",
        start: 0,
        end: 4,
        title: "速度",
        summary: "速度既有大小也有方向。",
        themeId: "map-topic",
        themeTitle: "运动学",
        evidenceCueIds: ["cue-000001"],
        reviewStatus: "verified",
      },
    ],
    map: {
      nodes: [
        { id: "map-course", label: "8.01", kind: "course", parentId: null, start: 0, evidenceCueIds: ["cue-000001", "cue-000002"], reviewStatus: "verified" },
        { id: "map-topic", label: "运动学", kind: "topic", parentId: "map-course", start: 0, evidenceCueIds: ["cue-000001"], reviewStatus: "verified" },
        { id: "map-concept", label: "速度", kind: "concept", parentId: "map-topic", start: 0, evidenceCueIds: ["cue-000001"], reviewStatus: "verified" },
        { id: "map-formula", label: "v=dx/dt", kind: "formula", parentId: "map-concept", start: 0, evidenceCueIds: ["cue-000001"], reviewStatus: "verified" },
        { id: "map-example", label: "一维运动", kind: "example", parentId: "map-formula", start: 0, evidenceCueIds: ["cue-000001"], reviewStatus: "verified" },
        { id: "map-warning", label: "方向符号", kind: "warning", parentId: "map-topic", start: 5, evidenceCueIds: ["cue-000002"], reviewStatus: "needs-review" },
      ],
      edges: [
        { id: "edge-1", from: "map-formula", to: "map-example", relation: "applies", evidenceCueIds: ["cue-000001"], reviewStatus: "verified" },
      ],
    },
  };
}

test("formatTime formats minute and hour values", () => {
  assert.equal(formatTime(65.8), "01:05");
  assert.equal(formatTime(3661), "01:01:01");
});

test("parseTimecode accepts SRT commas", () => {
  assert.equal(parseTimecode("01:02:03,500"), 3723.5);
});

test("parseSrt reads text and time ranges", () => {
  const cues = parseSrt("1\n00:00:01,000 --> 00:00:04,500\n第一句\n\n2\n00:00:05,000 --> 00:00:08,000\n第二句");
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[1].text, "第二句");
});

test("linear notes merge nearby short cues", () => {
  const notes = buildLinearNotesFromCues([
    { start: 0, end: 2, text: "第一句" },
    { start: 3, end: 5, text: "第二句" },
  ]);
  assert.equal(notes.length, 1);
  assert.match(notes[0].summary, /第一句 第二句/);
});

test("noteAtTime selects the current linear note", () => {
  const notes = [
    { id: "a", start: 0, end: 10 },
    { id: "b", start: 10, end: 20 },
  ];
  assert.equal(noteAtTime(notes, 14).id, "b");
});

test("nextThemeCandidate respects time unless forced", () => {
  const themes = [
    { id: "a", start: 20, status: "candidate" },
    { id: "b", start: 40, status: "candidate" },
  ];
  assert.equal(nextThemeCandidate(themes, 10), null);
  assert.equal(nextThemeCandidate(themes, 10, true).id, "a");
  assert.equal(nextThemeCandidate(themes, 45).id, "b");
});

test("canvas placement advances across columns", () => {
  const objects = Array.from({ length: 4 }, () => ({ type: "anchor" }));
  assert.equal(nextCanvasPosition(objects).x, 80);
  assert.ok(nextCanvasPosition(objects).y > 80);
});

test("schemaVersion 1 bundle validates and keeps notes chronological", () => {
  const bundle = normaliseStudyBundle(validStudyBundle());
  assert.equal(bundle.schemaVersion, 1);
  assert.deepEqual(bundle.notes.map((note) => note.id), ["note-1", "note-2"]);
  assert.deepEqual(bundle.map.nodes.map((node) => node.kind), [
    "course",
    "topic",
    "concept",
    "formula",
    "example",
    "warning",
  ]);
  assert.equal(bundle.map.edges[0].relation, "applies");
  assert.equal(bundle.source.boundaryMode, "natural");
  assert.equal(bundle.source.transcriptSha256, "b".repeat(64));
  assert.equal(bundle.cues[0].boundaryRisk, "none");
  assert.equal(bundle.map.edges[0].reviewStatus, "verified");
});

test("legacy note arrays and notes objects remain supported", () => {
  const raw = [{ id: "legacy", start: 2, end: 3, text: "旧笔记" }];
  assert.equal(normaliseStructuredNotes(raw)[0].summary, "旧笔记");
  assert.equal(normaliseStudyBundle({ title: "旧格式", notes: raw }).title, "旧格式");
});

test("bundle rejects negative, non-finite, and reversed times", () => {
  const invalidCases = [
    ["negative source time", (bundle) => { bundle.source.segmentStart = -1; }],
    ["NaN duration", (bundle) => { bundle.source.duration = Number.NaN; }],
    ["negative cue time", (bundle) => { bundle.cues[0].start = -1; }],
    ["reversed cue range", (bundle) => { bundle.cues[0].end = -0.1; }],
    ["NaN note time", (bundle) => { bundle.notes[0].start = Number.NaN; }],
    ["reversed note range", (bundle) => { bundle.notes[0].end = 4; }],
    ["negative map time", (bundle) => { bundle.map.nodes[0].start = -1; }],
  ];

  for (const [name, mutate] of invalidCases) {
    const bundle = validStudyBundle();
    mutate(bundle);
    assert.throws(() => normaliseStudyBundle(bundle), undefined, name);
  }
});

test("bundle rejects duplicate IDs and invalid evidence", () => {
  const duplicate = validStudyBundle();
  duplicate.notes[0].id = "cue-000001";
  assert.throws(() => normaliseStudyBundle(duplicate), /重复/);

  const emptyEvidence = validStudyBundle();
  emptyEvidence.map.edges[0].evidenceCueIds = [];
  assert.throws(() => normaliseStudyBundle(emptyEvidence), /不能为空/);

  const unknownEvidence = validStudyBundle();
  unknownEvidence.map.nodes[1].evidenceCueIds = ["missing-cue"];
  assert.throws(() => normaliseStudyBundle(unknownEvidence), /未知 cue/);
});

test("bundle rejects dangling, self-loop, and illegal map edges", () => {
  const dangling = validStudyBundle();
  dangling.map.edges[0].to = "missing-node";
  assert.throws(() => normaliseStudyBundle(dangling), /悬空端点/);

  const selfLoop = validStudyBundle();
  selfLoop.map.edges[0].to = selfLoop.map.edges[0].from;
  assert.throws(() => normaliseStudyBundle(selfLoop), /自环/);

  const illegalRelation = validStudyBundle();
  illegalRelation.map.edges[0].relation = "causes";
  assert.throws(() => normaliseStudyBundle(illegalRelation), /relation 非法/);
});

test("bundle rejects missing, self, and cyclic parents", () => {
  const missing = validStudyBundle();
  missing.map.nodes[1].parentId = "missing-node";
  assert.throws(() => normaliseStudyBundle(missing), /parentId 不存在/);

  const selfParent = validStudyBundle();
  selfParent.map.nodes[1].parentId = selfParent.map.nodes[1].id;
  assert.throws(() => normaliseStudyBundle(selfParent), /自身为 parent/);

  const cycle = validStudyBundle();
  cycle.map.nodes[1].parentId = "map-concept";
  assert.throws(() => normaliseStudyBundle(cycle), /形成循环/);
});

test("bundle enforces boundary fields and source interval", () => {
  const invalidMode = validStudyBundle();
  invalidMode.source.boundaryMode = "guessed";
  assert.throws(() => normaliseStudyBundle(invalidMode), /boundaryMode 非法/);

  const invalidRisk = validStudyBundle();
  invalidRisk.cues[0].boundaryRisk = "maybe";
  assert.throws(() => normaliseStudyBundle(invalidRisk), /boundaryRisk 非法/);

  const missingTranscriptHash = validStudyBundle();
  delete missingTranscriptHash.source.transcriptSha256;
  assert.throws(() => normaliseStudyBundle(missingTranscriptHash), /transcriptSha256/);

  const outsideSource = validStudyBundle();
  outsideSource.source.duration = 3;
  assert.throws(() => normaliseStudyBundle(outsideSource), /超出 source 时间区间/);

  const missingEdgeStatus = validStudyBundle();
  delete missingEdgeStatus.map.edges[0].reviewStatus;
  assert.throws(() => normaliseStudyBundle(missingEdgeStatus), /reviewStatus 非法/);

  const inconsistentNaturalBoundary = validStudyBundle();
  inconsistentNaturalBoundary.cues[0].boundaryRisk = "hard-both";
  assert.throws(() => normaliseStudyBundle(inconsistentNaturalBoundary), /boundaryMode 不一致/);

  const validHardBoundary = validStudyBundle();
  validHardBoundary.source.boundaryMode = "hard";
  validHardBoundary.cues[0].boundaryRisk = "hard-start";
  validHardBoundary.cues[1].boundaryRisk = "hard-end";
  assert.equal(normaliseStudyBundle(validHardBoundary).cues[1].boundaryRisk, "hard-end");
});

test("bundle enforces evidence order and exact evidence times", () => {
  const reversedEvidence = validStudyBundle();
  reversedEvidence.notes[0] = {
    ...reversedEvidence.notes[0],
    start: 0,
    end: 8,
    evidenceCueIds: ["cue-000002", "cue-000001"],
  };
  assert.throws(() => normaliseStudyBundle(reversedEvidence), /时间顺序/);

  const wrongNoteTime = validStudyBundle();
  wrongNoteTime.notes[0].start = 5.5;
  assert.throws(() => normaliseStudyBundle(wrongNoteTime), /证据最大结束/);

  const wrongNodeTime = validStudyBundle();
  wrongNodeTime.map.nodes[1].start = 0.5;
  assert.throws(() => normaliseStudyBundle(wrongNodeTime), /精确匹配首个证据/);

  const nestedCues = validStudyBundle();
  nestedCues.cues[0].end = 10;
  const spanningNote = nestedCues.notes.find((note) => note.id === "note-1");
  spanningNote.end = 10;
  spanningNote.evidenceCueIds = ["cue-000001", "cue-000002"];
  assert.equal(normaliseStudyBundle(nestedCues).notes[0].end, 10);
});

test("bundle requires nonempty layers and consistent note themes", () => {
  for (const [path, mutate] of [
    ["cues", (bundle) => { bundle.cues = []; }],
    ["notes", (bundle) => { bundle.notes = []; }],
    ["map.nodes", (bundle) => { bundle.map.nodes = []; }],
  ]) {
    const bundle = validStudyBundle();
    mutate(bundle);
    assert.throws(() => normaliseStudyBundle(bundle), /不能为空/, path);
  }

  const missingTheme = validStudyBundle();
  missingTheme.notes[0].themeId = "node-missing";
  assert.throws(() => normaliseStudyBundle(missingTheme), /themeId 不存在/);

  const wrongThemeTitle = validStudyBundle();
  wrongThemeTitle.notes[0].themeTitle = "错误标题";
  assert.throws(() => normaliseStudyBundle(wrongThemeTitle), /themeTitle/);

  const noReliableRelations = validStudyBundle();
  noReliableRelations.map.edges = [];
  assert.equal(normaliseStudyBundle(noReliableRelations).map.edges.length, 0);
});

test("bundle requires complete cue coverage and evidence-backed edges", () => {
  const uncoveredByNotes = validStudyBundle();
  uncoveredByNotes.notes = uncoveredByNotes.notes.filter((note) => note.id !== "note-2");
  assert.throws(() => normaliseStudyBundle(uncoveredByNotes), /notes 未覆盖 cue/);

  const incompleteRoot = validStudyBundle();
  incompleteRoot.map.nodes[0].evidenceCueIds = ["cue-000001"];
  assert.throws(() => normaliseStudyBundle(incompleteRoot), /course 根节点/);

  const unsupportedEdge = validStudyBundle();
  unsupportedEdge.map.edges[0].evidenceCueIds = ["cue-000002"];
  assert.throws(() => normaliseStudyBundle(unsupportedEdge), /证据未与 from 节点相交/);
});

test("bundle rejects map hierarchies deeper than the UI limit", () => {
  const bundle = validStudyBundle();
  const root = bundle.map.nodes[0];
  const chain = [root];
  for (let index = 1; index <= 65; index += 1) {
    chain.push({
      id: `node-depth-${index}`,
      label: `层级 ${index}`,
      kind: "concept",
      parentId: index === 1 ? root.id : `node-depth-${index - 1}`,
      start: 0,
      evidenceCueIds: ["cue-000001"],
      reviewStatus: "needs-review",
    });
  }
  bundle.map.nodes = chain;
  assert.throws(() => normaliseStudyBundle(bundle), /最大层级/);
});
