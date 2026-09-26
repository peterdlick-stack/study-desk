#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  link,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SCRIPT_DIR, "..");
const PROMPT_PATH = join(PROJECT_DIR, "prompts", "course-bundle.md");
const SCHEMA_PATH = join(PROJECT_DIR, "schemas", "course-generation.schema.json");

const REVIEW_STATUSES = new Set(["needs-review", "UNKNOWN"]);
const BOUNDARY_MODES = new Set(["natural", "hard"]);
const BOUNDARY_RISKS = new Set(["none", "hard-start", "hard-end", "hard-both"]);
const NODE_KINDS = new Set([
  "course",
  "topic",
  "concept",
  "formula",
  "example",
  "warning",
  "UNKNOWN",
]);
const EDGE_RELATIONS = new Set([
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
const GENERATED_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const TIME_TOLERANCE_SECONDS = 0.001;
const STUDY_BUNDLE_LIMITS = {
  cues: 12_000,
  notes: 4_000,
  nodes: 1_500,
  edges: 4_000,
  depth: 64,
};

function fail(message) {
  throw new Error(message);
}

function roundMilliseconds(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function parseTimecode(value, context) {
  const match = String(value).trim().match(/^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) fail(`${context}: invalid SRT timecode ${JSON.stringify(value)}`);
  const [, hours, minutes, seconds, milliseconds] = match;
  if (Number(minutes) > 59 || Number(seconds) > 59) {
    fail(`${context}: out-of-range SRT timecode ${JSON.stringify(value)}`);
  }
  const result = Number(hours) * 3600
    + Number(minutes) * 60
    + Number(seconds)
    + Number(milliseconds) / 1000;
  if (!Number.isFinite(result)) fail(`${context}: SRT timecode is not finite`);
  return result;
}

export function parseSrt(source, offsetSeconds = 0, boundaryMode = "natural") {
  if (!Number.isFinite(offsetSeconds)) fail("offsetSeconds must be finite");
  if (!BOUNDARY_MODES.has(boundaryMode)) fail("boundaryMode must be natural or hard");

  const decoded = String(source);
  if (decoded.includes("\uFFFD")) fail("SRT is not valid UTF-8: replacement character detected");
  const normalized = decoded.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) fail("SRT is empty");

  const blocks = normalized.split(/\n{2,}/);
  const cues = blocks.map((block, zeroBasedIndex) => {
    const sequence = zeroBasedIndex + 1;
    const lines = block.split("\n");
    const timeLineIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeLineIndex < 0) fail(`SRT block ${sequence}: missing time range`);
    if (lines.slice(timeLineIndex + 1).some((line) => (
      /^\s*\d{2,}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(line)
    ))) {
      fail(`SRT block ${sequence}: contains a second time range; cues must be separated by a blank line`);
    }

    const timeMatch = lines[timeLineIndex].trim().match(
      /^(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2,}:\d{2}:\d{2}[,.]\d{3})(?:\s+.*)?$/,
    );
    if (!timeMatch) fail(`SRT block ${sequence}: malformed time range`);

    const relativeStart = parseTimecode(timeMatch[1], `SRT block ${sequence}`);
    const relativeEnd = parseTimecode(timeMatch[2], `SRT block ${sequence}`);
    if (relativeEnd < relativeStart) fail(`SRT block ${sequence}: end precedes start`);

    const sourceText = lines.slice(timeLineIndex + 1).join("\n").trim();
    if (!sourceText) fail(`SRT block ${sequence}: empty cue text`);

    const start = roundMilliseconds(relativeStart + offsetSeconds);
    const end = roundMilliseconds(relativeEnd + offsetSeconds);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      fail(`SRT block ${sequence}: absolute video time is not finite`);
    }
    if (start < 0 || end < 0) {
      fail(`SRT block ${sequence}: offset makes absolute video time negative`);
    }

    const declaredIndex = lines.slice(0, timeLineIndex).join("").trim();
    if (declaredIndex && !/^\d+$/.test(declaredIndex)) {
      fail(`SRT block ${sequence}: cue index is not an integer`);
    }

    return {
      id: `cue-${String(sequence).padStart(6, "0")}`,
      start,
      end,
      sourceText,
      boundaryRisk: "none",
    };
  });
  if (cues.length > STUDY_BUNDLE_LIMITS.cues) {
    fail(`SRT contains more than ${STUDY_BUNDLE_LIMITS.cues} cues`);
  }

  for (let index = 1; index < cues.length; index += 1) {
    if (cues[index].start < cues[index - 1].start) {
      fail(`SRT cue ${cues[index].id}: start time is earlier than the preceding cue`);
    }
  }
  if (boundaryMode === "hard") {
    if (cues.length === 1) cues[0].boundaryRisk = "hard-both";
    else {
      cues[0].boundaryRisk = "hard-start";
      cues[cues.length - 1].boundaryRisk = "hard-end";
    }
  }
  return cues;
}

function parseArguments(argv) {
  const options = { offsetSeconds: 0, dryRun: false, trustedTranscript: false };
  const valueFlags = new Map([
    ["--srt", "srt"],
    ["--output", "output"],
    ["--title", "title"],
    ["--source-file", "sourceFile"],
    ["--expected-source-sha256", "expectedSourceSha256"],
    ["--offset-seconds", "offsetSeconds"],
    ["--segment-duration", "segmentDuration"],
    ["--boundary-mode", "boundaryMode"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--trusted-transcript") {
      options.trustedTranscript = true;
      continue;
    }
    const key = valueFlags.get(token);
    if (!key) fail(`unknown argument: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${token} requires a value`);
    options[key] = value;
    index += 1;
  }

  for (const key of ["srt", "output", "title", "sourceFile", "segmentDuration", "boundaryMode"]) {
    if (!String(options[key] ?? "").trim()) fail(`--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  }
  options.offsetSeconds = Number(options.offsetSeconds);
  if (!Number.isFinite(options.offsetSeconds)) fail("--offset-seconds must be a finite number");
  if (options.offsetSeconds < 0) fail("--offset-seconds must be non-negative");
  options.offsetSeconds = roundMilliseconds(options.offsetSeconds);
  options.segmentDuration = roundMilliseconds(Number(options.segmentDuration));
  if (!Number.isFinite(options.segmentDuration) || options.segmentDuration <= 0) {
    fail("--segment-duration must be a finite positive number");
  }
  const segmentEnd = options.offsetSeconds + options.segmentDuration;
  if (!Number.isFinite(segmentEnd)) fail("segment end must be finite");
  if (!BOUNDARY_MODES.has(options.boundaryMode)) fail("--boundary-mode must be natural or hard");
  if (options.expectedSourceSha256 !== undefined) {
    if (!SHA256.test(options.expectedSourceSha256)) {
      fail("--expected-source-sha256 must be exactly 64 hexadecimal characters");
    }
    options.expectedSourceSha256 = options.expectedSourceSha256.toLowerCase();
  }
  options.srt = resolve(options.srt);
  options.output = resolve(options.output);
  options.sourceFile = resolve(options.sourceFile);
  if (options.srt === options.output) fail("--output must not overwrite the SRT input");
  return options;
}

export async function buildModelPrompt(cues) {
  const instructions = await readFile(PROMPT_PATH, "utf8");
  const transcript = cues.map((cue) => ({
    cueId: cue.id,
    start: cue.start,
    end: cue.end,
    sourceText: cue.sourceText,
    boundaryRisk: cue.boundaryRisk,
  }));
  return `${instructions.trim()}\n\nTRANSCRIPT_CUES_JSON\n${JSON.stringify(transcript, null, 2)}\n`;
}

function requireObject(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${context} must be an object`);
  return value;
}

function requireExactKeys(value, allowedKeys, context) {
  const object = requireObject(value, context);
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(object).filter((key) => !allowed.has(key));
  if (unexpected.length) fail(`${context} contains unexpected properties: ${unexpected.join(", ")}`);
  return object;
}

function requireArray(value, context) {
  if (!Array.isArray(value)) fail(`${context} must be an array`);
  return value;
}

function requireString(value, context, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) fail(`${context} must be a non-empty string`);
  return value;
}

function requireFiniteTime(value, context) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`${context} must be a finite non-negative number`);
  }
  return value;
}

function validateGeneratedId(value, context, allIds) {
  requireString(value, context);
  if (!GENERATED_ID.test(value)) fail(`${context} has an invalid ID format: ${value}`);
  if (allIds.has(value)) fail(`${context} duplicates ID ${value}`);
  allIds.add(value);
}

function validateReviewStatus(value, context) {
  if (!REVIEW_STATUSES.has(value)) {
    fail(`${context} must be one of needs-review, UNKNOWN; AI drafts cannot self-verify`);
  }
}

function cueEvidence(value, context, cueById) {
  const ids = requireArray(value, context);
  if (!ids.length) fail(`${context} must contain at least one cue ID`);
  const seen = new Set();
  let previousIndex = -1;
  for (const id of ids) {
    requireString(id, `${context}[]`);
    const cue = cueById.get(id);
    if (!cue) fail(`${context} references unknown cue ${id}`);
    if (seen.has(id)) fail(`${context} repeats cue ${id}`);
    seen.add(id);
    const index = Number(id.slice("cue-".length)) - 1;
    if (index <= previousIndex) fail(`${context} must follow cue order`);
    previousIndex = index;
  }
  return ids.map((id) => cueById.get(id));
}

function validateCueSegmentBounds(cues, segmentStart, segmentDuration) {
  requireFiniteTime(segmentStart, "segmentStart");
  if (typeof segmentDuration !== "number" || !Number.isFinite(segmentDuration) || segmentDuration <= 0) {
    fail("segmentDuration must be a finite positive number");
  }
  const segmentEnd = roundMilliseconds(segmentStart + segmentDuration);
  if (!Number.isFinite(segmentEnd)) fail("segment end must be finite");
  for (const cue of cues) {
    if (!BOUNDARY_RISKS.has(cue.boundaryRisk)) fail(`cue ${cue.id} has an invalid boundaryRisk`);
    if (cue.start < segmentStart - TIME_TOLERANCE_SECONDS) {
      fail(`cue ${cue.id} starts before segmentStart ${segmentStart}`);
    }
    if (cue.end > segmentEnd + TIME_TOLERANCE_SECONDS) {
      fail(`cue ${cue.id} ends after segment end ${segmentEnd}`);
    }
  }
  return segmentEnd;
}

function validateBoundaryRisks(cues, boundaryMode) {
  if (!BOUNDARY_MODES.has(boundaryMode)) fail("boundaryMode must be natural or hard");
  const expected = cues.map(() => "none");
  if (boundaryMode === "hard") {
    if (cues.length === 1) expected[0] = "hard-both";
    else {
      expected[0] = "hard-start";
      expected[expected.length - 1] = "hard-end";
    }
  }
  for (const [index, cue] of cues.entries()) {
    if (cue.boundaryRisk !== expected[index]) {
      fail(`cue ${cue.id} boundaryRisk must be ${expected[index]} for boundaryMode=${boundaryMode}`);
    }
  }
}

export function validateModelOutput(payload, cues) {
  const root = requireExactKeys(payload, ["translations", "notes", "map"], "model output");
  const cueById = new Map(cues.map((cue) => [cue.id, cue]));
  const allIds = new Set(cueById.keys());

  const translations = requireArray(root.translations, "translations");
  if (translations.length !== cues.length) {
    fail(`translations must contain exactly one item per cue (${cues.length})`);
  }
  const translatedCueIds = new Set();
  const cleanTranslations = [];
  for (const [index, itemValue] of translations.entries()) {
    const item = requireExactKeys(
      itemValue,
      ["cueId", "translatedText", "reviewStatus"],
      `translations[${index}]`,
    );
    requireString(item.cueId, `translations[${index}].cueId`);
    if (!cueById.has(item.cueId)) fail(`translations[${index}] references unknown cue ${item.cueId}`);
    if (translatedCueIds.has(item.cueId)) fail(`translations repeats cue ${item.cueId}`);
    translatedCueIds.add(item.cueId);
    if (item.cueId !== cues[index].id) fail("translations must preserve cue order");
    requireString(item.translatedText, `translations[${index}].translatedText`);
    validateReviewStatus(item.reviewStatus, `translations[${index}].reviewStatus`);
    cleanTranslations.push({
      cueId: item.cueId,
      translatedText: item.translatedText,
      reviewStatus: item.reviewStatus,
    });
  }

  const notes = requireArray(root.notes, "notes");
  if (!notes.length) fail("notes must contain at least one chronological note");
  if (notes.length > STUDY_BUNDLE_LIMITS.notes) {
    fail(`notes must not exceed ${STUDY_BUNDLE_LIMITS.notes} items`);
  }
  let previousNoteStart = -1;
  const noteCoveredCueIds = new Set();
  const cleanNotes = [];
  for (const [index, itemValue] of notes.entries()) {
    const item = requireExactKeys(
      itemValue,
      [
        "id",
        "title",
        "summary",
        "themeId",
        "themeTitle",
        "evidenceCueIds",
        "reviewStatus",
      ],
      `notes[${index}]`,
    );
    validateGeneratedId(item.id, `notes[${index}].id`, allIds);
    requireString(item.title, `notes[${index}].title`);
    requireString(item.summary, `notes[${index}].summary`);
    requireString(item.themeId, `notes[${index}].themeId`);
    requireString(item.themeTitle, `notes[${index}].themeTitle`);
    validateReviewStatus(item.reviewStatus, `notes[${index}].reviewStatus`);
    const evidence = cueEvidence(item.evidenceCueIds, `notes[${index}].evidenceCueIds`, cueById);
    for (const cue of evidence) noteCoveredCueIds.add(cue.id);
    const start = evidence[0].start;
    const end = Math.max(...evidence.map((cue) => cue.end));
    if (start < previousNoteStart) fail("notes must be in chronological order");
    previousNoteStart = start;
    cleanNotes.push({
      id: item.id,
      start,
      end,
      title: item.title,
      summary: item.summary,
      themeId: item.themeId,
      themeTitle: item.themeTitle,
      evidenceCueIds: [...item.evidenceCueIds],
      reviewStatus: item.reviewStatus,
    });
  }
  const uncoveredCueIds = cues.filter((cue) => !noteCoveredCueIds.has(cue.id)).map((cue) => cue.id);
  if (uncoveredCueIds.length) fail(`notes do not cover cues: ${uncoveredCueIds.join(", ")}`);

  const map = requireExactKeys(root.map, ["nodes", "edges"], "map");
  const nodes = requireArray(map.nodes, "map.nodes");
  const edges = requireArray(map.edges, "map.edges");
  if (!nodes.length) fail("map.nodes must contain a course root");
  if (nodes.length > STUDY_BUNDLE_LIMITS.nodes) {
    fail(`map.nodes must not exceed ${STUDY_BUNDLE_LIMITS.nodes} items`);
  }
  if (edges.length > STUDY_BUNDLE_LIMITS.edges) {
    fail(`map.edges must not exceed ${STUDY_BUNDLE_LIMITS.edges} items`);
  }

  const cleanNodes = [];
  for (const [index, itemValue] of nodes.entries()) {
    const item = requireExactKeys(
      itemValue,
      ["id", "label", "kind", "parentId", "evidenceCueIds", "reviewStatus"],
      `map.nodes[${index}]`,
    );
    validateGeneratedId(item.id, `map.nodes[${index}].id`, allIds);
    requireString(item.label, `map.nodes[${index}].label`);
    if (!NODE_KINDS.has(item.kind)) fail(`map.nodes[${index}].kind is not allowed`);
    if (item.parentId !== null) requireString(item.parentId, `map.nodes[${index}].parentId`);
    validateReviewStatus(item.reviewStatus, `map.nodes[${index}].reviewStatus`);
    const evidence = cueEvidence(item.evidenceCueIds, `map.nodes[${index}].evidenceCueIds`, cueById);
    cleanNodes.push({
      id: item.id,
      label: item.label,
      kind: item.kind,
      parentId: item.parentId,
      start: evidence[0].start,
      evidenceCueIds: [...item.evidenceCueIds],
      reviewStatus: item.reviewStatus,
    });
  }

  const nodeById = new Map(cleanNodes.map((node) => [node.id, node]));
  const courseRoots = cleanNodes.filter((node) => node.kind === "course" && node.parentId === null);
  if (courseRoots.length !== 1) fail("map.nodes must contain exactly one course root with parentId=null");
  const courseRoot = courseRoots[0];
  if (
    courseRoot.evidenceCueIds.length !== cues.length
    || courseRoot.evidenceCueIds.some((id, index) => id !== cues[index].id)
  ) {
    fail("course root evidenceCueIds must cover every cue in cue order");
  }
  for (const node of cleanNodes) {
    if (node.id === courseRoot.id) continue;
    if (node.kind === "course") fail(`only ${courseRoot.id} may have kind=course`);
    if (node.parentId === null) fail(`non-course node ${node.id} must have a parentId`);
    if (!nodeById.has(node.parentId)) fail(`node ${node.id} references unknown parent ${node.parentId}`);
    if (node.parentId === node.id) fail(`node ${node.id} cannot parent itself`);
  }

  for (const node of cleanNodes) {
    const visited = new Set([node.id]);
    let cursor = node;
    let depth = 0;
    while (cursor.parentId !== null) {
      if (visited.has(cursor.parentId)) fail(`map hierarchy contains a cycle through ${cursor.parentId}`);
      visited.add(cursor.parentId);
      depth += 1;
      if (depth > STUDY_BUNDLE_LIMITS.depth) {
        fail(`node ${node.id} exceeds maximum hierarchy depth ${STUDY_BUNDLE_LIMITS.depth}`);
      }
      cursor = nodeById.get(cursor.parentId);
      if (!cursor) fail(`node hierarchy from ${node.id} has an unknown parent`);
    }
    if (cursor.id !== courseRoot.id) fail(`node ${node.id} does not descend from the course root`);
  }

  const cleanEdges = [];
  for (const [index, itemValue] of edges.entries()) {
    const item = requireExactKeys(
      itemValue,
      ["id", "from", "to", "relation", "evidenceCueIds", "reviewStatus"],
      `map.edges[${index}]`,
    );
    validateGeneratedId(item.id, `map.edges[${index}].id`, allIds);
    requireString(item.from, `map.edges[${index}].from`);
    requireString(item.to, `map.edges[${index}].to`);
    if (!nodeById.has(item.from)) fail(`map.edges[${index}].from references unknown node ${item.from}`);
    if (!nodeById.has(item.to)) fail(`map.edges[${index}].to references unknown node ${item.to}`);
    if (item.from === item.to) fail(`map.edges[${index}] cannot be a self-edge`);
    if (!EDGE_RELATIONS.has(item.relation)) fail(`map.edges[${index}].relation is not allowed`);
    validateReviewStatus(item.reviewStatus, `map.edges[${index}].reviewStatus`);
    cueEvidence(item.evidenceCueIds, `map.edges[${index}].evidenceCueIds`, cueById);
    const fromNode = nodeById.get(item.from);
    const toNode = nodeById.get(item.to);
    const fromEvidence = new Set(fromNode.evidenceCueIds);
    const toEvidence = new Set(toNode.evidenceCueIds);
    for (const cueId of item.evidenceCueIds) {
      const missingEndpoints = [];
      if (!fromEvidence.has(cueId)) missingEndpoints.push(`from node ${item.from}`);
      if (!toEvidence.has(cueId)) missingEndpoints.push(`to node ${item.to}`);
      if (missingEndpoints.length) {
        fail(
          `map.edges[${index}].evidenceCueIds cue ${cueId} must appear in both endpoint nodes; missing from ${missingEndpoints.join(" and ")}`,
        );
      }
    }
    cleanEdges.push({
      id: item.id,
      from: item.from,
      to: item.to,
      relation: item.relation,
      evidenceCueIds: [...item.evidenceCueIds],
      reviewStatus: item.reviewStatus,
    });
  }

  for (const [index, note] of cleanNotes.entries()) {
    const theme = nodeById.get(note.themeId);
    if (!theme) fail(`notes[${index}].themeId references unknown node ${note.themeId}`);
    if (note.themeTitle !== theme.label) {
      fail(`notes[${index}].themeTitle must equal the referenced node label`);
    }
  }
  return {
    translations: cleanTranslations,
    notes: cleanNotes,
    map: {
      nodes: cleanNodes,
      edges: cleanEdges,
    },
  };
}

export function mergeBundle({
  title,
  sourceFile,
  sourceSha256,
  transcriptSha256,
  offsetSeconds,
  segmentDuration,
  boundaryMode,
  cues,
  modelOutput,
}) {
  if (!SHA256.test(sourceSha256)) fail("sourceSha256 must be exactly 64 hexadecimal characters");
  if (!SHA256.test(transcriptSha256)) fail("transcriptSha256 must be exactly 64 hexadecimal characters");
  if (!BOUNDARY_MODES.has(boundaryMode)) fail("boundaryMode must be natural or hard");
  validateCueSegmentBounds(cues, offsetSeconds, segmentDuration);
  validateBoundaryRisks(cues, boundaryMode);
  const cleanModelOutput = validateModelOutput(modelOutput, cues);
  const translationByCueId = new Map(
    cleanModelOutput.translations.map((translation) => [translation.cueId, translation]),
  );
  return {
    schemaVersion: 1,
    title,
    source: {
      fileName: basename(sourceFile),
      fileSha256: sourceSha256.toLowerCase(),
      transcriptSha256: transcriptSha256.toLowerCase(),
      sourceLanguage: "en",
      outputLanguage: "zh-CN",
      segmentStart: offsetSeconds,
      duration: segmentDuration,
      boundaryMode,
    },
    cues: cues.map((cue) => {
      const translation = translationByCueId.get(cue.id);
      return {
        id: cue.id,
        start: cue.start,
        end: cue.end,
        sourceText: cue.sourceText,
        translatedText: translation.translatedText,
        reviewStatus: translation.reviewStatus,
        boundaryRisk: cue.boundaryRisk,
      };
    }),
    notes: cleanModelOutput.notes,
    map: cleanModelOutput.map,
  };
}

export function codexArguments(resultPath) {
  return [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--ignore-user-config",
    "--ignore-rules",
    "--disable",
    "shell_tool",
    "--disable",
    "shell_snapshot",
    "--disable",
    "browser_use",
    "--disable",
    "browser_use_external",
    "--disable",
    "apps",
    "--disable",
    "computer_use",
    "--output-schema",
    SCHEMA_PATH,
    "--output-last-message",
    resultPath,
    "-",
  ];
}

async function runCodex(prompt, resultPath, isolatedWorkingDirectory) {
  const command = "codex";
  const args = codexArguments(resultPath);
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: isolatedWorkingDirectory,
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`codex exec exited with code ${code}: ${stderr.trim()}`));
    });
    child.stdin.on("error", rejectPromise);
    child.stdin.end(prompt, "utf8");
  });
}

async function assertOutputDoesNotExist(outputPath) {
  try {
    await access(outputPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  fail(`refusing to overwrite existing output: ${outputPath}`);
}

async function assertOutputParentDirectoryExists(outputPath) {
  const parentPath = dirname(outputPath);
  let parentInfo;
  try {
    parentInfo = await stat(parentPath);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`output parent directory does not exist: ${parentPath}`);
    throw error;
  }
  if (!parentInfo.isDirectory()) fail(`output parent is not a directory: ${parentPath}`);
}

async function hashRegularNonEmptyFile(filePath, context) {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${context} does not exist: ${filePath}`);
    throw error;
  }
  try {
    const fileInfo = await handle.stat();
    if (!fileInfo.isFile()) fail(`${context} must be a regular file: ${filePath}`);
    if (fileInfo.size <= 0) fail(`${context} must be non-empty: ${filePath}`);
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export async function publishAtomicNoOverwrite(outputPath, contents) {
  const temporaryOutput = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryOutput, contents, { encoding: "utf8", flag: "wx" });
    try {
      await link(temporaryOutput, outputPath);
    } catch (error) {
      if (error?.code === "EEXIST") fail(`refusing to overwrite existing output: ${outputPath}`);
      throw error;
    }
  } finally {
    await rm(temporaryOutput, { force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  await assertOutputParentDirectoryExists(options.output);
  await assertOutputDoesNotExist(options.output);

  const sourceSha256 = await hashRegularNonEmptyFile(options.sourceFile, "--source-file");
  if (
    options.expectedSourceSha256
    && options.expectedSourceSha256 !== sourceSha256
  ) {
    fail(
      `--expected-source-sha256 mismatch: expected ${options.expectedSourceSha256}, computed ${sourceSha256}`,
    );
  }

  const srtBytes = await readFile(options.srt);
  const cues = parseSrt(
    srtBytes.toString("utf8"),
    options.offsetSeconds,
    options.boundaryMode,
  );
  validateCueSegmentBounds(cues, options.offsetSeconds, options.segmentDuration);
  const transcriptSha256 = createHash("sha256").update(srtBytes).digest("hex");

  if (options.dryRun) {
    const dryRun = {
      dryRun: true,
      cueCount: cues.length,
      cueTimeRange: {
        start: cues[0].start,
        end: Math.max(...cues.map((cue) => cue.end)),
      },
      modelInputFields: ["cueId", "start", "end", "sourceText", "boundaryRisk"],
      sourceSha256,
      transcriptSha256,
      boundaryMode: options.boundaryMode,
      segmentStart: options.offsetSeconds,
      segmentDuration: options.segmentDuration,
      realInvocationRequires: "--trusted-transcript",
    };
    process.stdout.write(`${JSON.stringify(dryRun, null, 2)}\n`);
    return dryRun;
  }

  if (!options.trustedTranscript) {
    fail(
      "real model invocation requires --trusted-transcript: complete sourceText and absolute cue times will be sent to Codex; the video, local paths, and hashes are not included in the model prompt",
    );
  }

  const prompt = await buildModelPrompt(cues);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "study-bundle-"));
  const temporaryResult = join(temporaryDirectory, "model-result.json");
  try {
    await runCodex(prompt, temporaryResult, temporaryDirectory);
    const modelOutput = JSON.parse(await readFile(temporaryResult, "utf8"));
    const bundle = mergeBundle({
      title: options.title,
      sourceFile: options.sourceFile,
      sourceSha256,
      transcriptSha256,
      offsetSeconds: options.offsetSeconds,
      segmentDuration: options.segmentDuration,
      boundaryMode: options.boundaryMode,
      cues,
      modelOutput,
    });
    await publishAtomicNoOverwrite(options.output, `${JSON.stringify(bundle, null, 2)}\n`);
    process.stdout.write(`Wrote structurally validated AI draft: ${options.output}\n`);
    return bundle;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`generate-study-bundle: ${error.message}\n`);
    process.exitCode = 1;
  });
}
