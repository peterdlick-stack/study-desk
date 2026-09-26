import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { EnglishStore } from '../lib/english.mjs';
import { emptyEnglishState, applyEnglishEvent } from '../js/english-state.js';
import { subjectFromUrl } from '../js/subject.js';

const course = { lessonId: 'free-english-00', title: 'Synthetic reading', number: 0, blocks: [{ id: 'p1-b1', page: 1, text: 'Source evidence.' }], assetIds: [], video: null };
const reduce = (state, type, payload) => applyEnglishEvent(state, { id: 'event-12345678', type, payload, at: '2026-09-20T00:00:00Z' }, course);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'english-test-')); await mkdir(join(root, 'english/materials'), { recursive: true });
  await writeFile(join(root, 'english/materials/index.json'), JSON.stringify({ assets: {}, courses: [course, { ...course, lessonId: 'free-english-01' }] }));
  return { root, store: new EnglishStore(root) };
}
test('English bookmarks route independently of physics; existing bookmarks stay compatible', () => {
  assert.equal(subjectFromUrl('http://local/?lesson=free-english-00'), 'english');
  assert.equal(subjectFromUrl('http://local/?lesson=mit-801-01'), 'physics');
  assert.equal(subjectFromUrl('http://local/?subject=math'), 'math');
});
test('completion, help and duration never produce ability claims', async () => {
  const { store } = await fixture();
  let s = reduce(emptyEnglishState(), 'complete', { value: true });
  s = reduce(s, 'time', { phase: 'independent', seconds: 30 });
  s = reduce(s, 'help', { kind: 'translation' });
  assert.equal(s.seconds.independent, 30); assert.equal(s.samples.length, 0);
  assert.equal((await store.list()).mastery, 'UNKNOWN');
  assert.throws(() => reduce(s, 'mastery', { value: 100 }), /未知/);
});
test('new-text response preserves uncertainty and remains pending even with self-reported conditions', () => {
  const sample = { title: 'New article', article: 'Original text', mainIdea: '主旨', structure: '结构', evidence: '原文依据', unseen: 'yes', comparable: 'yes' };
  const s = reduce(emptyEnglishState(), 'sample-submit', sample);
  assert.equal(s.samples[0].minutes, null); assert.equal(s.samples[0].help, ''); assert.equal(s.samples[0].reviewStatus, 'pending');
  assert.throws(() => reduce(s, 'sample-submit', { ...sample, evidence: '' }), /依据/);
  assert.throws(() => reduce(s, 'sample-submit', { ...sample, minutes: '-1' }), /用时/);
});
test('GPT reading diagnosis is stored as an observation and its probe can be confirmed', () => {
  const diagnosis = { summary: '观察', genre: 'argumentative', questionType: 'detail', languageBarrier: 'absent', expectedAction: '找观点', articleEvidence: '证据', chosenAnswerProblem: '只复述例子', correctAnswerReason: '概括观点', causeCode: 'EXAMPLE_AS_CLAIM', causeLabel: '例子当观点', certainty: 'medium', reason: '仍需确认', probe: { question: '当时怎么想？', choices: [{ id: 'surface', label: '停在例子表面' }] }, nextAction: '再练一题', sourceIds: ['source-1'] };
  const task = { article: '', question: 'Why?', options: 'A / B', selectedAnswer: 'A', correctAnswer: 'B', markedText: '', languageSignal: 'none', genreHint: 'argumentative' };
  let s = reduce(emptyEnglishState(), 'diagnosis-add', { task, diagnosis, sources: [{ id: 'source-1', category: '议论文', part: 'Opinion 1', source: 'https://example.test', start: '00:01:00', end: '00:02:00' }], usage: null });
  assert.equal(s.diagnoses.length, 1); assert.equal(s.diagnoses[0].confirmation, null);
  s = reduce(s, 'diagnosis-confirm', { id: 'event-12345678', choiceId: 'surface' });
  assert.equal(s.diagnoses[0].confirmation.label, '停在例子表面');
  assert.equal(s.samples.length, 0);
});
test('invalid anchors, help categories and timer inflation are rejected', () => {
  assert.throws(() => reduce(emptyEnglishState(), 'position', { blockId: 'made-up' }), /位置/);
  assert.throws(() => reduce(emptyEnglishState(), 'time', { phase: 'independent', seconds: 9999 }), /数值/);
  assert.throws(() => reduce(emptyEnglishState(), 'help', { kind: 'mastered' }), /帮助/);
});
test('append-only events survive restart, isolate courses, reject stale updates and deduplicate retries', async () => {
  const { root, store } = await fixture();
  const first = { lessonId: course.lessonId, expectedRevision: null, event: { id: 'event-12345678', type: 'blocker-add', payload: { blockId: 'p1-b1' } } };
  const a = await store.append(first); assert.ok(a.revision);
  assert.deepEqual(await store.append(first), a);
  await assert.rejects(store.append({ ...first, event: { ...first.event, payload: { blockId: 'p2-b2' } } }), /ID/);
  await assert.rejects(store.append({ ...first, event: { ...first.event, id: 'event-12345679' } }), /另一个页面/);
  await store.append({ lessonId: course.lessonId, expectedRevision: a.revision, event: { id: 'event-12345680', type: 'blocker-update', payload: { id: first.event.id, resolved: true, resolution: '回读后理解了' } } });
  const reloaded = new EnglishStore(root), record = await reloaded.record(course.lessonId);
  assert.equal(record.events.length, 2); assert.equal(record.state.blockers[0].resolved, true);
  assert.equal((await reloaded.record('free-english-01')).events.length, 0);
  const files = await readdir(join(root, 'english/events', course.lessonId));
  assert.equal(JSON.parse(await readFile(join(root, 'english/events', course.lessonId, files[0]), 'utf8')).type, 'blocker-add');
});
test('record tampering fails visibly rather than producing an empty successful state', async () => {
  const { root, store } = await fixture();
  await store.append({ lessonId: course.lessonId, expectedRevision: null, event: { id: 'event-12345678', type: 'complete', payload: { value: true } } });
  const dir = join(root, 'english/events', course.lessonId), file = join(dir, (await readdir(dir))[0]);
  const content = JSON.parse(await readFile(file)); content.payload.value = false; await writeFile(file, JSON.stringify(content));
  await assert.rejects(store.record(course.lessonId), /校验/);
  await assert.rejects(store.record('../../outside'), /不存在/);
});
test('missing video and mismatched assets remain unavailable', async () => {
  const { store } = await fixture();
  const c = await store.course(course.lessonId); assert.equal(c.hasVideo, false);
  await assert.rejects(store.video(course.lessonId), /尚未提供/);
  await assert.rejects(store.openAsset(course.lessonId, 'unrelated'), /不属于/);
});
test('timed notes remain unverified and the matching VTT track is hash-bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'english-media-test-'));
  const materials = join(root, 'english/materials'), files = join(materials, 'files');
  await mkdir(files, { recursive: true });
  const videoPath = join(root, 'lesson.mp4'), video = Buffer.from('synthetic-video');
  const note = Buffer.from('# 自动摘录\n\n- **[00:00:05]** 示例笔记\n'), captions = Buffer.from('WEBVTT\n\n1\n00:00:05.000 --> 00:00:07.000\n示例字幕\n');
  const hash = data => createHash('sha256').update(data).digest('hex');
  await writeFile(videoPath, video); await writeFile(join(files, 'free-english-00-linear-notes.md'), note); await writeFile(join(files, 'free-english-00-subtitles.vtt'), captions);
  const mediaCourse = { ...course, assetIds: ['free-english-00-linear-notes'], timedNotes: [{ time: '00:00:05', seconds: 5, text: '示例笔记' }],
    timedNotesStatus: 'AUTO_EXTRACTIVE_NOTES_UNVERIFIED', subtitleAssetId: 'free-english-00-subtitles', subtitleStatus: 'AUTO_TRANSCRIBED_UNVERIFIED',
    video: { path: videoPath, name: 'lesson.mp4', bytes: video.length, sha256: hash(video), duration: 30 } };
  const assets = {
    'free-english-00-linear-notes': { filename: 'free-english-00-linear-notes.md', title: '讲解线性笔记（自动摘录）', kind: 'notes', sha256: hash(note) },
    'free-english-00-subtitles': { filename: 'free-english-00-subtitles.vtt', title: '自动转写字幕', kind: 'subtitles', sha256: hash(captions) },
  };
  await writeFile(join(materials, 'index.json'), JSON.stringify({ assets, courses: [mediaCourse] }));
  const store = new EnglishStore(root), loadedCourse = await store.course(course.lessonId);
  assert.equal(loadedCourse.timedNotes[0].seconds, 5); assert.equal(loadedCourse.timedNotesStatus, 'AUTO_EXTRACTIVE_NOTES_UNVERIFIED');
  const loadedVideo = await store.video(course.lessonId); assert.match(loadedVideo.captions.url, /^\/english\/file\//); assert.equal(loadedVideo.captions.status, 'AUTO_TRANSCRIBED_UNVERIFIED');
  const openedNote = await store.openAsset(course.lessonId, 'free-english-00-linear-notes'); assert.match(openedNote.url, /^\/english\/file\//);
  assert.equal([...store.tokens.values()].at(-1).type, '.md');
});
