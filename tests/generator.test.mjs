import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildModelPrompt,
  codexArguments,
  mergeBundle,
  parseSrt,
  publishAtomicNoOverwrite,
  validateModelOutput,
} from "../scripts/generate-study-bundle.mjs";
import { normaliseStudyBundle } from "../js/core.js";

const SRT = [
  "1",
  "00:00:01,000 --> 00:00:02,500",
  "Acceleration is negative, minus 9.8 meters per second squared.",
  "",
  "2",
  "00:00:03,000 --> 00:00:04,000",
  "That does not mean the object moves downward.",
].join("\n");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validModelOutput(cues, { includeEdge = true } = {}) {
  return {
    translations: cues.map((cue, index) => ({
      cueId: cue.id,
      translatedText: index === 0
        ? "加速度是负的，即 -9.8 米每二次方秒。"
        : "这并不意味着物体向下运动。",
      reviewStatus: "needs-review",
    })),
    notes: [
      {
        id: "note-001",
        title: "加速度符号与运动方向",
        summary: "负加速度不等于物体一定向下运动。",
        themeId: "node-sign",
        themeTitle: "符号与方向",
        evidenceCueIds: cues.map((cue) => cue.id),
        reviewStatus: "needs-review",
      },
    ],
    map: {
      nodes: [
        {
          id: "node-course",
          label: "本节课程",
          kind: "course",
          parentId: null,
          evidenceCueIds: cues.map((cue) => cue.id),
          reviewStatus: "needs-review",
        },
        {
          id: "node-sign",
          label: "符号与方向",
          kind: "concept",
          parentId: "node-course",
          evidenceCueIds: cues.map((cue) => cue.id),
          reviewStatus: "needs-review",
        },
      ],
      edges: includeEdge
        ? [
          {
            id: "edge-sign-course",
            from: "node-sign",
            to: "node-course",
            relation: "part-of",
            evidenceCueIds: cues.map((cue) => cue.id),
            reviewStatus: "needs-review",
          },
        ]
        : [],
    },
  };
}

test("parseSrt assigns stable IDs, absolute offsets, and local boundary risks", () => {
  const natural = parseSrt(SRT, 10.25, "natural");
  assert.deepEqual(natural.map((cue) => cue.id), ["cue-000001", "cue-000002"]);
  assert.equal(natural[0].start, 11.25);
  assert.equal(natural[1].end, 14.25);
  assert.deepEqual(natural.map((cue) => cue.boundaryRisk), ["none", "none"]);

  const hard = parseSrt(SRT, 10.25, "hard");
  assert.deepEqual(hard.map((cue) => cue.boundaryRisk), ["hard-start", "hard-end"]);

  const oneCue = parseSrt(SRT.split("\n\n")[0], 0, "hard");
  assert.equal(oneCue[0].boundaryRisk, "hard-both");
});

test("strict SRT parsing rejects decoding, block, and finite-time failures", async (t) => {
  await t.test("UTF-8 replacement character", () => {
    assert.throws(() => parseSrt(SRT.replace("Acceleration", "Accel\uFFFDation")), /not valid UTF-8/);
  });
  await t.test("second time range in one block", () => {
    const missingBlankLine = SRT.replace("\n\n2\n", "\n2\n");
    assert.throws(() => parseSrt(missingBlankLine), /second time range/);
  });
  await t.test("non-finite time", () => {
    const hugeHours = "9".repeat(400);
    assert.throws(
      () => parseSrt(`1\n${hugeHours}:00:00,000 --> ${hugeHours}:00:01,000\nx`),
      /not finite/,
    );
  });
});

test("model prompt contains only cue fields, including boundary risk", async () => {
  const cues = parseSrt(SRT, 0, "hard");
  const prompt = await buildModelPrompt(cues);
  assert.match(prompt, /cue-000001/);
  assert.match(prompt, /Acceleration is negative/);
  assert.match(prompt, /hard-start/);
  assert.match(prompt, /每条 translation 只翻译它自己的 `sourceText`/);
  assert.match(prompt, /仅把 cue ID 列入 `evidenceCueIds` 不算语义覆盖/);
  assert.match(prompt, /由三个及以上环节组成的推理链/);
  assert.match(prompt, /就把整个 `edges` 数组设为 `\[\]`/);
  assert.match(prompt, /仅把 `reviewStatus` 设为复核不能抵消边界补写/);
  assert.doesNotMatch(prompt, /F:\\物理/);
  assert.doesNotMatch(prompt, /[a-f0-9]{64}/i);
});

test("model schema excludes locally derived note and node timing fields", async () => {
  const schema = JSON.parse(await readFile(resolve("schemas/course-generation.schema.json"), "utf8"));
  for (const field of ["start", "end"]) {
    assert.equal(schema.$defs.note.required.includes(field), false);
    assert.equal(field in schema.$defs.note.properties, false);
  }
  assert.equal(schema.$defs.note.additionalProperties, false);
  assert.equal(schema.$defs.node.required.includes("start"), false);
  assert.equal("start" in schema.$defs.node.properties, false);
  assert.equal(schema.$defs.node.additionalProperties, false);
});

test("Codex invocation is isolated and disables configured model tools", () => {
  const args = codexArguments("C:\\isolated\\model-result.json");
  assert.deepEqual(args.slice(0, 7), [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--ignore-user-config",
    "--ignore-rules",
  ]);
  for (const feature of [
    "shell_tool",
    "shell_snapshot",
    "browser_use",
    "browser_use_external",
    "apps",
    "computer_use",
  ]) {
    const index = args.indexOf(feature);
    assert.ok(index > 0, `${feature} must be disabled`);
    assert.equal(args[index - 1], "--disable");
  }
  assert.equal(args.at(-1), "-");
});

test("validated draft merges local timing, computed provenance, duration, and boundary risk", () => {
  const cues = parseSrt(SRT, 10, "hard");
  const modelOutput = validModelOutput(cues);
  assert.equal("start" in modelOutput.notes[0], false);
  assert.equal("end" in modelOutput.notes[0], false);
  assert.equal("start" in modelOutput.map.nodes[0], false);
  const bundle = mergeBundle({
    title: "MIT 8.01",
    sourceFile: "F:\\物理\\8.01\\lecture.mp4",
    sourceSha256: "a".repeat(64),
    transcriptSha256: "b".repeat(64),
    offsetSeconds: 10,
    segmentDuration: 5,
    boundaryMode: "hard",
    cues,
    modelOutput,
  });
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.source.fileName, "lecture.mp4");
  assert.equal(bundle.source.duration, 5);
  assert.equal(bundle.source.boundaryMode, "hard");
  assert.equal(bundle.source.transcriptSha256, "b".repeat(64));
  assert.deepEqual(bundle.cues.map((cue) => cue.boundaryRisk), ["hard-start", "hard-end"]);
  assert.equal(bundle.cues[1].translatedText, "这并不意味着物体向下运动。");
  assert.equal(bundle.notes[0].start, cues[0].start);
  assert.equal(bundle.notes[0].end, Math.max(...cues.map((cue) => cue.end)));
  assert.deepEqual(bundle.map.nodes.map((node) => node.start), [cues[0].start, cues[0].start]);
  const normalised = normaliseStudyBundle(bundle);
  assert.equal(normalised.notes[0].start, cues[0].start);
  assert.equal(normalised.notes[0].end, Math.max(...cues.map((cue) => cue.end)));
});

test("validation rejects self-verification for every generated item type", async (t) => {
  const cues = parseSrt(SRT);
  const cases = [
    ["translation", (payload) => { payload.translations[0].reviewStatus = "verified"; }],
    ["note", (payload) => { payload.notes[0].reviewStatus = "verified"; }],
    ["node", (payload) => { payload.map.nodes[0].reviewStatus = "verified"; }],
    ["edge", (payload) => { payload.map.edges[0].reviewStatus = "verified"; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const payload = validModelOutput(cues);
      mutate(payload);
      assert.throws(() => validateModelOutput(payload, cues), /cannot self-verify/);
    });
  }
});

test("validation derives evidence ranges and enforces coverage, strict fields, and graph evidence", async (t) => {
  const cues = parseSrt(SRT);
  await t.test("every cue must be covered by notes", () => {
    const payload = validModelOutput(cues);
    payload.notes[0].evidenceCueIds = [cues[0].id];
    assert.throws(() => validateModelOutput(payload, cues), /notes do not cover cues/);
  });
  await t.test("course root must cover every cue", () => {
    const payload = validModelOutput(cues);
    payload.map.nodes[0].evidenceCueIds = [cues[0].id];
    assert.throws(() => validateModelOutput(payload, cues), /course root evidenceCueIds/);
  });
  await t.test("nested cues derive note end from maximum evidence end", () => {
    const nested = parseSrt([
      "1",
      "00:00:00,000 --> 00:00:10,000",
      "long",
      "",
      "2",
      "00:00:01,000 --> 00:00:02,000",
      "short",
    ].join("\n"));
    const clean = validateModelOutput(validModelOutput(nested), nested);
    assert.equal(clean.notes[0].start, nested[0].start);
    assert.equal(clean.notes[0].end, nested[0].end);
    assert.deepEqual(Object.keys(clean.notes[0]), [
      "id",
      "start",
      "end",
      "title",
      "summary",
      "themeId",
      "themeTitle",
      "evidenceCueIds",
      "reviewStatus",
    ]);
    assert.deepEqual(Object.keys(clean.map.nodes[0]), [
      "id",
      "label",
      "kind",
      "parentId",
      "start",
      "evidenceCueIds",
      "reviewStatus",
    ]);
  });
  await t.test("edge evidence rejects a union of disjoint endpoint evidence", () => {
    const payload = validModelOutput(cues);
    payload.map.nodes[1].evidenceCueIds = [cues[0].id];
    payload.map.nodes.push({
      id: "node-direction",
      label: "运动方向",
      kind: "concept",
      parentId: "node-course",
      evidenceCueIds: [cues[1].id],
      reviewStatus: "needs-review",
    });
    payload.map.edges[0].to = "node-direction";
    payload.map.edges[0].evidenceCueIds = cues.map((cue) => cue.id);
    assert.throws(
      () => validateModelOutput(payload, cues),
      /evidenceCueIds cue cue-000001 must appear in both endpoint nodes; missing from to node node-direction/,
    );
  });
  await t.test("edge evidence accepts a non-empty common subset", () => {
    const payload = validModelOutput(cues);
    payload.map.edges[0].evidenceCueIds = [cues[1].id];
    const clean = validateModelOutput(payload, cues);
    assert.deepEqual(clean.map.edges[0].evidenceCueIds, [cues[1].id]);
  });
  await t.test("unexpected model fields are rejected", () => {
    const payload = validModelOutput(cues);
    payload.notes[0].secret = "must not persist";
    assert.throws(() => validateModelOutput(payload, cues), /unexpected properties: secret/);
  });
  await t.test("model-provided note times are rejected", () => {
    const payload = validModelOutput(cues);
    payload.notes[0].start = cues[0].start;
    payload.notes[0].end = Math.max(...cues.map((cue) => cue.end));
    assert.throws(
      () => validateModelOutput(payload, cues),
      /notes\[0\] contains unexpected properties: start, end/,
    );
  });
  await t.test("model-provided node start is rejected", () => {
    const payload = validModelOutput(cues);
    payload.map.nodes[0].start = cues[0].start;
    assert.throws(
      () => validateModelOutput(payload, cues),
      /map\.nodes\[0\] contains unexpected properties: start/,
    );
  });
  await t.test("edges=[] remains valid under the common-evidence contract", () => {
    const payload = validModelOutput(cues, { includeEdge: false });
    const clean = validateModelOutput(payload, cues);
    assert.deepEqual(clean.map.edges, []);
  });
});

test("validation still rejects invalid references, IDs, hierarchy, and endpoints", async (t) => {
  const cues = parseSrt(SRT);
  await t.test("unknown evidence cue", () => {
    const payload = validModelOutput(cues);
    payload.notes[0].evidenceCueIds = ["cue-999999"];
    assert.throws(() => validateModelOutput(payload, cues), /unknown cue/);
  });
  await t.test("repeated evidence cue", () => {
    const payload = validModelOutput(cues);
    payload.notes[0].evidenceCueIds = [cues[0].id, cues[0].id, cues[1].id];
    assert.throws(() => validateModelOutput(payload, cues), /repeats cue/);
  });
  await t.test("dangling edge endpoint", () => {
    const payload = validModelOutput(cues);
    payload.map.edges[0].to = "node-missing";
    assert.throws(() => validateModelOutput(payload, cues), /unknown node/);
  });
  await t.test("duplicate generated ID", () => {
    const payload = validModelOutput(cues);
    payload.map.edges[0].id = payload.notes[0].id;
    assert.throws(() => validateModelOutput(payload, cues), /duplicates ID/);
  });
  await t.test("unknown parent node", () => {
    const payload = validModelOutput(cues);
    payload.map.nodes[1].parentId = "node-missing";
    assert.throws(() => validateModelOutput(payload, cues), /unknown parent/);
  });
});

test("merge rejects cues outside the explicit segment", () => {
  const cues = parseSrt(SRT, 10, "natural");
  assert.throws(() => mergeBundle({
    title: "x",
    sourceFile: "lecture.mp4",
    sourceSha256: "a".repeat(64),
    transcriptSha256: "b".repeat(64),
    offsetSeconds: 10,
    segmentDuration: 3,
    boundaryMode: "natural",
    cues,
    modelOutput: validModelOutput(cues),
  }), /ends after segment end/);
});

test("merge rejects boundary risks inconsistent with boundary mode", () => {
  const cues = parseSrt(SRT, 0, "natural");
  assert.throws(() => mergeBundle({
    title: "x",
    sourceFile: "lecture.mp4",
    sourceSha256: "a".repeat(64),
    transcriptSha256: "b".repeat(64),
    offsetSeconds: 0,
    segmentDuration: 5,
    boundaryMode: "hard",
    cues,
    modelOutput: validModelOutput(cues),
  }), /boundaryRisk must be hard-start/);
});

test("atomic publication creates once, never overwrites, and cleans sibling temp files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "study-bundle-publish-test-"));
  try {
    const outputPath = join(directory, "draft.json");
    await publishAtomicNoOverwrite(outputPath, "first\n");
    assert.equal(await readFile(outputPath, "utf8"), "first\n");
    await assert.rejects(
      publishAtomicNoOverwrite(outputPath, "second\n"),
      /refusing to overwrite existing output/,
    );
    assert.equal(await readFile(outputPath, "utf8"), "first\n");
    assert.deepEqual(await readdir(directory), ["draft.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI dry-run hashes real source, is deterministic, and leaks no content or paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "study-bundle-test-"));
  try {
    const srtPath = join(directory, "input.srt");
    const sourcePath = join(directory, "lecture.mp4");
    const outputPath = join(directory, "output.json");
    const sourceBytes = Buffer.from("synthetic-video-bytes");
    await writeFile(srtPath, SRT, "utf8");
    await writeFile(sourcePath, sourceBytes);
    const script = resolve("scripts/generate-study-bundle.mjs");
    const args = [
      script,
      "--srt", srtPath,
      "--output", outputPath,
      "--title", "Synthetic 8.01",
      "--source-file", sourcePath,
      "--expected-source-sha256", sha256(sourceBytes),
      "--offset-seconds", "5",
      "--segment-duration", "10",
      "--boundary-mode", "hard",
      "--dry-run",
    ];
    const first = spawnSync(process.execPath, args, { encoding: "utf8" });
    const second = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const firstPlan = JSON.parse(first.stdout);
    const secondPlan = JSON.parse(second.stdout);
    assert.deepEqual(firstPlan, secondPlan);
    assert.equal(firstPlan.cueCount, 2);
    assert.equal(firstPlan.sourceSha256, sha256(sourceBytes));
    assert.equal(firstPlan.transcriptSha256, sha256(Buffer.from(SRT)));
    assert.deepEqual(
      firstPlan.modelInputFields,
      ["cueId", "start", "end", "sourceText", "boundaryRisk"],
    );
    assert.doesNotMatch(first.stdout, /Acceleration is negative/);
    assert.equal(first.stdout.includes(directory), false);
    assert.doesNotMatch(first.stdout, /prompt|outputWouldBe|localProvenance/i);
    await assert.rejects(readFile(outputPath), { code: "ENOENT" });

    const noTrust = spawnSync(
      process.execPath,
      args.filter((token) => token !== "--dry-run"),
      { encoding: "utf8" },
    );
    assert.equal(noTrust.status, 1);
    assert.match(noTrust.stderr, /requires --trusted-transcript/);
    assert.match(noTrust.stderr, /complete sourceText and absolute cue times will be sent to Codex/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI rejects false source hashes and invalid source files before model invocation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "study-bundle-source-test-"));
  try {
    const srtPath = join(directory, "input.srt");
    const sourcePath = join(directory, "lecture.mp4");
    const emptySourcePath = join(directory, "empty.mp4");
    const outputPath = join(directory, "output.json");
    await writeFile(srtPath, SRT, "utf8");
    await writeFile(sourcePath, "real bytes", "utf8");
    await writeFile(emptySourcePath, Buffer.alloc(0));
    const script = resolve("scripts/generate-study-bundle.mjs");
    const baseArgs = [
      script,
      "--srt", srtPath,
      "--output", outputPath,
      "--title", "Synthetic",
      "--source-file", sourcePath,
      "--offset-seconds", "0",
      "--segment-duration", "5",
      "--boundary-mode", "natural",
      "--dry-run",
    ];

    await t.test("hash mismatch", () => {
      const result = spawnSync(
        process.execPath,
        [...baseArgs, "--expected-source-sha256", "0".repeat(64)],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /mismatch/);
    });
    await t.test("missing source", () => {
      const args = [...baseArgs];
      args[args.indexOf(sourcePath)] = join(directory, "missing.mp4");
      const result = spawnSync(process.execPath, args, { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /does not exist/);
    });
    await t.test("empty source", () => {
      const args = [...baseArgs];
      args[args.indexOf(sourcePath)] = emptySourcePath;
      const result = spawnSync(process.execPath, args, { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must be non-empty/);
    });
    await t.test("missing output parent", () => {
      const args = [...baseArgs];
      args[args.indexOf(outputPath)] = join(directory, "missing-parent", "output.json");
      const result = spawnSync(process.execPath, args, { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /output parent directory does not exist/);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
