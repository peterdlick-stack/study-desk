import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha } from '../lib/store.mjs';
import { MathMaterials } from '../lib/math-materials.mjs';
import { PracticeStore } from '../lib/practice.mjs';
import { TopicTraining } from '../lib/topic-training.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/yXcAAAAASUVORK5CYII=';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'math-materials-')), vault = join(root, 'vault');
  await mkdir(join(root, 'practice')); await mkdir(join(vault, 'notes'), { recursive: true });
  const topic = { id: 'limits', title: '极限', unitId: 'math1-limits', training: { method: 'METHOD' } };
  const catalog = { schemaVersion: 1, sources: [{ id: 's', title: 'synthetic', kind: 'local', status: 'available' }], topics: [topic],
    items: Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, title: `Q${i}`, sourceId: 's', sourceRef: 'synthetic', prompt: '1=?', referenceAnswer: '1', topicIds: ['limits'], unitId: 'math1-limits', track: 'math1', kind: 'supplement', sourceQuality: 'UNKNOWN', locator: { path: 'synthetic' } })) };
  await writeFile(join(root, 'practice/catalog.json'), JSON.stringify(catalog));
  const grade = { verdict: 'correct', summary: 'synthetic', recognizedWork: '1', steps: [{ page: 1, status: 'correct', comment: 'OK', topicIds: ['limits'], x: null, y: null }], errorTopicIds: [], uncertainties: [], hint: 'hint', solution: 'solution', verification: { status: 'verified', reason: 'synthetic' } };
  const practice = new PracticeStore({ courseRoot: root, grader: async () => ({ reports: [grade, grade] }) });
  const training = new TopicTraining(root, practice); await practice.init();
  const sourcePath = join(root, 'source.pdf'); await writeFile(sourcePath, '%PDF-1.7\nsynthetic');
  await writeFile(join(vault, 'notes/limits.md'), '---\nstatus: DRAFT\n---\n# 极限\nSECRET_METHOD');
  const manifest = { notesDirectory: 'notes', source: { path: sourcePath, title: 'synthetic', sha256: sha(await readFile(sourcePath)), pages: 2 }, chapters: [{ id: 'chapter-01', title: '极限', noteFile: 'limits.md', trainingTopicIds: ['limits'] }], repair: { id: 'repair', title: '自查', noteFile: 'repair.md', trainingTopicIds: [] }, topics: [] };
  const materials = new MathMaterials({ vaultRoot: vault, manifest, practice, training });
  const submit = (session, n) => training.submit({ id: `answer-${n}`, lessonId: session.id, itemId: `q${n}`, pages: [{ objects: [], image: png }], conditions: { closedBook: true, firstSeen: true, guessed: false } });
  return { root, vault, practice, training, materials, manifest, submit };
}

test('directory gives metadata only and makes no exposure or study records', async () => {
  const { materials, root } = await fixture();
  const data = JSON.stringify(materials.index());
  assert.ok(!data.includes('SECRET_METHOD') && !data.includes('noteFile') && !data.includes('source.pdf'));
  assert.deepEqual(await readdir(join(root, 'practice/events')), []);
});

test('reading notes records help before delivery, preserves past independent first answers, and survives reopening', async () => {
  const { materials, training, practice, root, submit } = await fixture();
  const s = await training.create({ topicId: 'limits', count: 5, mode: 'independent' });
  await submit(s, 0); await practice.waitForIdle();
  const original = await readFile(join(root, 'practice/attempts/answer-0/submission.json'), 'utf8');
  const note = await materials.note({ id: 'chapter-01', sessionId: s.id });
  assert.match(note.markdown, /SECRET_METHOD/); assert.ok(!note.markdown.includes('status:'));
  await submit(s, 1); await practice.waitForIdle();
  const report = await training.report(s.id);
  assert.equal(report.accuracy.correct, 2); assert.equal(report.independentAccuracy.correct, 1); assert.equal(report.assisted, 1);
  assert.equal(await readFile(join(root, 'practice/attempts/answer-0/submission.json'), 'utf8'), original);
  assert.equal((await new PracticeStore({ courseRoot: root }).get('answer-1')).helpHistory.length, 1);
});

test('pre-round notes cannot become help-free answers merely by opening a new round', async () => {
  const { materials, training, practice, submit } = await fixture();
  await materials.note({ id: 'chapter-01' });
  const s = await training.create({ topicId: 'limits', count: 5, mode: 'independent' });
  await submit(s, 0); await practice.waitForIdle();
  assert.equal((await training.report(s.id)).independentAccuracy.value, null);
});

test('missing notes, invalid IDs, and exposure failure do not deliver content', async () => {
  const { materials, practice, root } = await fixture();
  await assert.rejects(materials.note({ id: '../../secret' }), /不存在/);
  await assert.rejects(materials.note({ id: 'repair' }), /暂时不可用/);
  await assert.rejects(materials.note({ id: 'chapter-01', sessionId: 'missing' }), /训练组不存在/);
  assert.deepEqual(await readdir(join(root, 'practice/events')), []);
  practice.recordMethodExposure = async () => { throw new Error('disk failure'); };
  await assert.rejects(materials.note({ id: 'chapter-01' }), /disk failure/);
});

test('PDF is restricted to the hash-bound source, valid pages, and a committed exposure', async () => {
  const { materials, manifest, root } = await fixture();
  await assert.rejects(materials.pdf({ page: 0 }), /页码/);
  await assert.rejects(materials.pdf({ page: 3 }), /页码/);
  const bytes = await materials.pdf({ page: 1, path: '../../unrelated' });
  assert.equal(sha(bytes), manifest.source.sha256);
  assert.ok((await readdir(join(root, 'practice/events'))).length);
  await writeFile(manifest.source.path, '%PDF-different');
  await assert.rejects(materials.pdf({ page: 1 }), /文件已变化/);
});
