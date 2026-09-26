import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { prepareDemo } from '../scripts/prepare-demo.mjs';
import { EnglishStore } from '../lib/english.mjs';

test('public demo seeds synthetic records once and preserves visitor confirmation on restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'study-desk-public-'));
  assert.equal((await prepareDemo(root)).created, true);
  const index = await readFile(join(root, 'english/materials/index.json'), 'utf8');
  const store = new EnglishStore(root), first = await store.record('free-english-00');
  assert.equal(first.events.length, 1);
  assert.match(first.state.diagnoses[0].diagnosis.summary, /预置示例，非实时模型输出/);
  assert.equal(first.state.diagnoses[0].usage, null);
  await store.append({ lessonId: 'free-english-00', expectedRevision: first.revision,
    event: { id: 'visitor-confirm-0001', type: 'diagnosis-confirm', payload: { id: 'demo-diagnosis-0001', choiceId: 'scope' } } });
  assert.equal((await prepareDemo(root)).created, false);
  assert.equal(await readFile(join(root, 'english/materials/index.json'), 'utf8'), index);
  assert.equal((await new EnglishStore(root).record('free-english-00')).state.diagnoses[0].confirmation.choiceId, 'scope');
});

test('public entry point blocks online AI even when inherited environment enables it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-desk-public-http-'));
  const port = 41000 + Math.floor(Math.random() * 5000);
  const child = spawn(process.execPath, ['scripts/start-demo.mjs'], { cwd: new URL('..', import.meta.url),
    env: { ...process.env, STUDY_DESK_PORT: String(port), STUDY_DESK_DATA: root, STUDY_DESK_VAULT: join(root, 'vault'), STUDY_DESK_ENABLE_AI: '1' }, windowsHide: true });
  t.after(() => child.kill());
  let errors = ''; child.stderr.on('data', x => { errors += x; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errors || 'startup timeout')), 10000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(errors || 'early exit')); });
  });
  const base = `http://127.0.0.1:${port}`;
  const list = await fetch(base + '/api/english', { headers: { 'X-Study-Desk': '1' } });
  assert.equal(list.status, 200); assert.equal((await list.json()).courses.length, 2);
  for (const path of ['/api/english/diagnose', '/api/practice/submit', '/api/practice/retry']) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Study-Desk': '1' }, body: '{}' });
    assert.equal(response.status, 503); assert.match((await response.json()).error, /默认不调用模型/);
  }
  assert.equal((await fetch(base + '/.git/config')).status, 404);
  assert.equal((await fetch(base + '/.local/study-library/english/materials/index.json')).status, 404);
});
