import test from 'node:test';
import assert from 'node:assert/strict';
import { compileLecture, mergeDetailedNotes } from '../scripts/build-detailed-801-notes.mjs';
import { detailedLearningItems, isTimedLearningItem } from '../js/detailed-notes.js';
import { createDefaultState } from '../js/core.js';
import { validateSnapshot } from '../js/library.js';

function fixture() {
  const manifest = { lecture: 1, title: '合成课程', lessonId: 'synthetic', duration: 40, video: { name: 'sample.mp4', sha256: 'a'.repeat(64) } };
  const source = { subtitleSha256: 'b'.repeat(64), cues: [1, 2, 3].map(n => ({ cue: n, start: n * 100, end: n * 100 + 10, text: `Original evidence ${n}` })) };
  const draft = { lecture: 1, notes: [1, 2, 3].map(n => ({ firstCue: n, lastCue: n, topic: '主题', title: `笔记${n}`, summary: `说明${n}，公式 $F=ma$。` })), review: {} };
  const alignment = { lecture: 1, method: 'synthetic evidence', wordMatchRatio: .6667,
    cues: [{ sourceWords: 20, matchedWords: 20, localStart: 2, localEnd: 10 }, { sourceWords: 20, matchedWords: 0, localStart: null, localEnd: null }, { sourceWords: 20, matchedWords: 20, localStart: 25, localEnd: 35 }] };
  return { manifest, source, draft, alignment };
}
const build = ({ manifest, source, draft, alignment }) => compileLecture(manifest, source, draft, alignment);

test('local audio determines seek positions; unmatched original passages remain complete and unseekable', () => {
  const candidate = build(fixture());
  assert.deepEqual(candidate.bundle.notes.map(note => note.start), [2, 25]);
  assert.equal(candidate.sourceOnlyNotes.length, 1);
  const snapshot = createDefaultState(); snapshot.lessonId = 'synthetic';
  const updated = validateSnapshot(mergeDetailedNotes(snapshot, candidate));
  const notes = detailedLearningItems(updated);
  assert.deepEqual(notes.map(note => note.title), ['笔记1', '笔记2', '笔记3']);
  assert.deepEqual(notes.map(isTimedLearningItem), [true, false, true]);
  assert.equal(notes[1].start, undefined);
  assert.deepEqual(detailedLearningItems(updated, true).map(cue => cue.sourceText), ['Original evidence 1', 'Original evidence 2', 'Original evidence 3']);
});
test('missing or duplicate source ranges and implausible local timestamps stop compilation', () => {
  for (const mutate of [f => f.draft.notes.splice(1, 1), f => f.draft.notes[1].firstCue = 1,
    f => f.alignment.cues[2].localEnd = 41, f => f.alignment.cues[2].localStart = 1]) {
    const f = fixture(); mutate(f); assert.throws(() => build(f));
  }
});
test('replacing generated note layers retains handwritten work, records, progress and existing theme references', () => {
  const before = createDefaultState(); before.lessonId = 'synthetic';
  before.canvasObjects = [{ id: 'own-line', type: 'line', start: { x: 1, y: 2 }, end: { x: 4, y: 8 }, themeId: 'old-theme' }];
  before.entries = [{ id: 'entry-old', title: '手写整理', personalText: '我的推导', time: 12, history: [], attachmentIds: ['own-line'], status: 'inbox', reviewStatus: 'UNKNOWN' }];
  before.themes.push({ id: 'old-theme', title: '旧主题', start: 2, status: 'confirmed' });
  before.activeThemeId = 'old-theme'; before.player.currentTime = 17;
  before.editorDraft = { entryId: 'entry-old', text: '未完成编辑' };
  const copy = structuredClone(before), after = validateSnapshot(mergeDetailedNotes(before, build(fixture())));
  for (const key of ['canvasObjects', 'entries', 'player', 'layout', 'activeThemeId', 'editorDraft']) assert.deepEqual(after[key], before[key], key);
  assert.ok(after.themes.some(theme => theme.id === 'old-theme'));
  assert.deepEqual(before, copy);
  assert.throws(() => mergeDetailedNotes({ ...before, lessonId: 'other' }, build(fixture())));
});
