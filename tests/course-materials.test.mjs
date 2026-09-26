import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { CourseMaterials } from '../lib/course-materials.mjs';
import { createDefaultState } from '../js/core.js';
import { validateSnapshot, newEntry } from '../js/library.js';
const hash = s => createHash('sha256').update(s).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'materials-test-'));
  await mkdir(join(root, 'materials/files'), { recursive: true });
  const file = join(root, 'test.mp4'); await writeFile(file, 'original-media');
  await writeFile(join(root, 'materials/files/note.md'), '# 原始笔记');
  const index = { assets: { note: { title: '笔记', filename: 'note.md', sha256: hash('# 原始笔记') } }, courses: [{ lessonId: 'lesson-test', title: 'Test', number: 1, assetIds: ['note'], timeline: [], psets: [], video: { path: file, name: 'test.mp4', bytes: 14, sha256: hash('original-media'), duration: 12 } }] };
  const save = () => writeFile(join(root, 'materials/index.json'), JSON.stringify(index)); await save();
  return { root, file, index, save, materials: new CourseMaterials(root) };
}
test('untimed study notes stay untimed and cannot promote themselves to verified', () => {
  const s = createDefaultState(); s.lessonId = 'lesson-test'; s.entries = []; s.player.currentTime = 42;
  s.notes = [{ id: 'review', summary: '复习补充', start: 0, end: 0, timingStatus: 'untimed', reviewStatus: 'verified' }];
  const clean = validateSnapshot(s);
  assert.equal(clean.notes[0].timingStatus, 'untimed'); assert.equal(clean.notes[0].reviewStatus, 'needs-review');
  assert.equal(newEntry(clean, clean.notes[0]).time, 42, 'personal note records the actual viewing position, not a fabricated source time');
});
test('normal course notes remain backward compatible', () => {
  const s = createDefaultState(); s.lessonId = 'lesson-test'; s.entries = [];
  assert.equal(validateSnapshot(s).notes[0].timingStatus, undefined);
});
test('materials metadata excludes disk paths and video URLs before verification', async () => {
  const f = await fixture(); const c = await f.materials.course('lesson-test');
  assert.equal(c.assets.length, 1); assert.match(c.assets[0].url, /^\/materials\/file\/[a-f\d-]+$/);
  assert.ok(!JSON.stringify(c).includes(f.root)); assert.equal(c.video, undefined);
  assert.equal(await f.materials.course('unknown'), null);
});
test('unknown assets and traversal cannot read local files', async () => {
  const f = await fixture(); await assert.rejects(f.materials.text('../../test.mp4'));
  f.index.assets.note.filename = '../../test.mp4'; await f.save();
  await assert.rejects(f.materials.text('note'), /路径超出/);
});
test('changed documents are rejected rather than silently served', async () => {
  const f = await fixture(); await writeFile(join(f.root, 'materials/files/note.md'), 'changed');
  await assert.rejects(f.materials.text('note'), /已变化/);
});
test('video must match the registered SHA even when byte length matches', async () => {
  const f = await fixture(); await writeFile(f.file, 'different-data');
  await assert.rejects(f.materials.video('lesson-test'), /不一致/);
});
test('verified media rejects subsequent file changes', async () => {
  const f = await fixture(); const video = await f.materials.video('lesson-test'); assert.equal(video.sha256, hash('original-media'));
  await writeFile(f.file, 'different-data'); await utimes(f.file, new Date(), new Date(Date.now() + 5000));
  await assert.rejects(f.materials.video('lesson-test'), /不一致/);
});
