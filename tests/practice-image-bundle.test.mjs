import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PracticeStore } from '../lib/practice.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/yXcAAAAASUVORK5CYII=';
async function setup(track = '836-thermal') {
  const root = await mkdtemp(join(tmpdir(), 'practice-image-bundle-'));
  const rel = 'sources/test/images/q1.json', path = join(root, 'practice', rel);
  await mkdir(join(root, 'practice/sources/test/images'), { recursive: true });
  const bytes = JSON.stringify({ questionImages: [{ name: 'question', dataUrl: png }], referenceImages: [{ name: 'PRIVATE_REFERENCE', dataUrl: png }] });
  await writeFile(path, bytes);
  const item = { id: 'q1', title: '原图题', sourceId: 's', sourceRef: 'synthetic', prompt: '原图', referenceAnswer: 'PRIVATE_ANSWER', topicIds: [], unitId: 'u', track, kind: 'supplement', sourceQuality: 'UNKNOWN', locator: { path: 'synthetic' }, imageBundle: { path: rel, sha256: createHash('sha256').update(bytes).digest('hex') } };
  const catalog = { schemaVersion: 1, sources: [{ id: 's', title: 'synthetic', status: 'available', kind: 'local' }], topics: [], items: [item] };
  await writeFile(join(root, 'practice/catalog.json'), JSON.stringify(catalog));
  // No external grader: a failed synthetic grade still preserves the submitted original.
  const store = new PracticeStore({ courseRoot: root, grader: async () => { throw new Error('synthetic-no-grader'); } });
  return { root, path, catalog, store };
}
test('lazy images preserve answer privacy, reveal audit, and self-contained submission snapshots', async () => {
  const { root, store, path } = await setup();
  const list = await store.catalog();
  assert.equal(list.items[0].hasImageBundle, true);
  assert.equal(list.items[0].questionImages, undefined);
  assert.ok(!JSON.stringify(list).includes('PRIVATE'));
  const detail = await store.item('q1');
  assert.equal(detail.questionImages.length, 1);
  assert.ok(!JSON.stringify(detail).includes('PRIVATE'));
  assert.equal((await store.list()).length, 0);
  const answer = await store.reveal('q1', { kind: 'solution' });
  assert.equal(answer.images[0].name, 'PRIVATE_REFERENCE');
  await store.submit({ id: 'attempt-test', itemId: 'q1', lessonId: 'lesson-test', pages: [{ objects: [], image: png }], conditions: { firstSeen: true, closedBook: true, guessed: false } });
  await store.waitForIdle();
  const saved = JSON.parse(await readFile(join(root, 'practice/attempts/attempt-test/submission.json'), 'utf8'));
  assert.equal(saved.item.questionImages.length, 1);
  assert.equal(saved.item.referenceImages.length, 1);
  assert.equal(saved.helpHistory.length, 1);
  await writeFile(path, '{}');
  await assert.rejects(store.item('q1'), /已变化/);
  assert.equal((await store.reveal('q1', { kind: 'solution', attemptId: 'attempt-test' })).images.length, 1);
});
test('modern physics is accepted and unsafe bundle paths are rejected', async () => {
  const { root, catalog, store } = await setup('836-modern');
  assert.equal((await store.item('q1')).track, '836-modern');
  catalog.items[0].imageBundle.path = '../private.json';
  await writeFile(join(root, 'practice/catalog.json'), JSON.stringify(catalog));
  await assert.rejects(store.catalog(), /路径或哈希/);
});
