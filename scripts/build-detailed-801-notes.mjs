// Build reviewable candidates only. Live deployment is a separate revision-checked step.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { normaliseStudyBundle } from '../js/core.js';

const digest = text => createHash('sha256').update(text).digest('hex');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const stamp = seconds => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

export function compileLecture(manifest, source, draft, alignment) {
  if (draft.lecture !== manifest.lecture || alignment.lecture !== manifest.lecture) throw new Error('Lecture mismatch');
  let nextCue = 1;
  const cues = [], notes = [], sourceOnlyNotes = [], segments = [], topics = new Map();
  for (const [i, note] of draft.notes.entries()) {
    if (note.firstCue !== nextCue || !Number.isInteger(note.lastCue) || note.lastCue < nextCue || note.lastCue > source.cues.length) throw new Error(`Invalid source coverage at note ${i + 1}`);
    nextCue = note.lastCue + 1;
    if (![note.title, note.summary, note.topic].every(v => typeof v === 'string' && v.trim())) throw new Error('Empty note');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(note.summary) || /\\\\[a-zA-Z]/.test(note.summary)) throw new Error(`Broken formula escaping at note ${i + 1}`);
    const raw = source.cues.slice(note.firstCue - 1, note.lastCue);
    const rows = alignment.cues.slice(note.firstCue - 1, note.lastCue);
    const matched = rows.filter(row => row.matchedWords && Number.isFinite(row.localStart));
    const words = rows.reduce((n, row) => n + row.sourceWords, 0);
    const hits = rows.reduce((n, row) => n + row.matchedWords, 0);
    // A handful of coincidental words cannot establish a local lecture passage.
    const timed = hits >= 12 && hits / Math.max(1, words) >= .45;
    const start = timed ? matched[0].localStart : null;
    const end = timed ? Math.max(...matched.map(row => row.localEnd)) : null;
    if (timed && (start < 0 || end <= start || end > manifest.duration + .01)) throw new Error(`Invalid audio bounds at note ${i + 1}`);
    const noteId = `l${String(manifest.lecture).padStart(2, '0')}-detail-${String(i + 1).padStart(3, '0')}`;
    const cueId = `cue-${String(i + 1).padStart(6, '0')}`;
    const sourceText = raw.map(cue => cue.text).filter(Boolean).join(' ');
    const segment = { noteId, cueId, firstCue: note.firstCue, lastCue: note.lastCue, sourceStart: raw[0].start, sourceEnd: raw.at(-1).end,
      localStart: start, localEnd: end, sourceWords: words, matchedWords: hits, matchRatio: Math.round(hits / Math.max(1, words) * 10000) / 10000 };
    segments.push(segment);
    if (!timed) {
      sourceOnlyNotes.push({ id: noteId, title: note.title, summary: note.summary, sourceText,
        timingStatus: 'untimed', sourceStart: raw[0].start, sourceEnd: raw.at(-1).end, reviewStatus: 'needs-review' });
      continue;
    }
    if (!topics.has(note.topic)) topics.set(note.topic, { id: `l${manifest.lecture}-topic-${topics.size + 1}`, label: note.topic, kind: 'topic', parentId: `l${manifest.lecture}-course`, start, evidenceCueIds: [], reviewStatus: 'needs-review' });
    const theme = topics.get(note.topic); theme.evidenceCueIds.push(cueId);
    cues.push({ id: cueId, start, end, sourceText, translatedText: note.summary, reviewStatus: 'needs-review', boundaryRisk: 'none' });
    notes.push({ id: noteId, start, end, title: note.title, summary: note.summary, themeId: theme.id, themeTitle: theme.label, evidenceCueIds: [cueId], reviewStatus: 'needs-review' });
  }
  if (nextCue !== source.cues.length + 1) throw new Error('Incomplete source coverage');
  if (!notes.length) throw new Error('No timed notes');
  if (cues.some((cue, i) => i && cue.start < cues[i - 1].start)) throw new Error('Audio alignment is not monotone');
  const bundle = normaliseStudyBundle({ schemaVersion: 1, title: `MIT 8.01 · ${manifest.lecture} ${manifest.title}`,
    source: { fileName: manifest.video.name, fileSha256: manifest.video.sha256, transcriptSha256: source.subtitleSha256,
      sourceLanguage: 'en', outputLanguage: 'zh-CN', segmentStart: 0, duration: manifest.duration, boundaryMode: 'natural' },
    cues, notes, map: { nodes: [{ id: `l${manifest.lecture}-course`, label: manifest.title, kind: 'course', parentId: null,
      start: cues[0].start, evidenceCueIds: cues.map(cue => cue.id), reviewStatus: 'needs-review' }, ...topics.values()], edges: [] } });
  const audit = { method: alignment.method, wordMatchRatio: alignment.wordMatchRatio, sourceCueCount: source.cues.length,
    noteCount: draft.notes.length, timedNoteCount: notes.length, sourceOnlyCount: sourceOnlyNotes.length,
    contentCharacters: draft.notes.reduce((sum, note) => sum + note.summary.length, 0), segments,
    uncertainties: draft.review?.uncertainties || [], coverageNotes: draft.review?.coverageNotes || '' };
  const markdown = [`# ${bundle.title} · 详细课堂笔记`, '',
    '时间为本地视频音频与原版字幕逐段匹配得到的近似定位，可用于回看；不是逐帧人工标注。中文为按课堂顺序整理的讲解，原文对照保留完整对应字幕。', '',
    ...draft.notes.flatMap((note, i) => [`## ${segments[i].localStart === null ? '原版补充 · 本地未定位' : stamp(segments[i].localStart)} ${note.title}`, '', note.summary, '']),
    '## 核对说明', '', ...audit.uncertainties.map(text => `- ${text}`), '', audit.coverageNotes, ''].join('\n');
  return { lessonId: manifest.lessonId, bundle, sourceOnlyNotes, audit, markdown, markdownSha256: digest(markdown) };
}

export function mergeDetailedNotes(snapshot, candidate) {
  if (snapshot.lessonId !== candidate.lessonId) throw new Error('Refusing to update a different course');
  const merged = structuredClone(snapshot);
  const { bundle, audit, sourceOnlyNotes } = candidate;
  merged.notes = bundle.notes; merged.map = bundle.map;
  merged.studyBundle = { schemaVersion: 1, source: bundle.source, cues: bundle.cues };
  merged.course = { ...merged.course, transcriptFormat: 'aligned-detailed-notes', transcriptName: '详细课堂笔记（本地音频校准）',
    detailedNotesRevision: digest(JSON.stringify({ bundle, sourceOnlyNotes, audit })), noteTimingAudit: audit, sourceOnlyNotes };
  const existingIds = new Set(merged.themes.map(theme => theme.id));
  for (const node of bundle.map.nodes.filter(node => node.kind === 'topic')) {
    if (!existingIds.has(node.id)) merged.themes.push({ id: node.id, title: node.label, start: node.start, status: 'confirmed' });
  }
  return merged;
}

async function main() {
  const work = resolve(process.argv[2]);
  const selected = process.argv.slice(3).map(Number);
  const manifest = await read(join(work, 'manifest.json'));
  await mkdir(join(work, 'candidates'), { recursive: true });
  for (const lecture of manifest.filter(row => !selected.length || selected.includes(row.lecture))) {
    const name = `L${String(lecture.lecture).padStart(2, '0')}`;
    const candidate = compileLecture(lecture, await read(join(work, 'inputs', `${name}.json`)), await read(join(work, 'drafts', `${name}.json`)), await read(join(work, 'alignment', `${name}.json`)));
    await writeFile(join(work, 'candidates', `${name}.json`), JSON.stringify(candidate, null, 2));
    await writeFile(join(work, 'candidates', `${name}.md`), candidate.markdown);
    console.log(JSON.stringify({ lecture: lecture.lecture, notes: candidate.audit.noteCount, timed: candidate.audit.timedNoteCount, sourceOnly: candidate.audit.sourceOnlyCount, characters: candidate.audit.contentCharacters }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
