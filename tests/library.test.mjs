import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDefaultState } from '../js/core.js';
import { validateSnapshot, makeBackup, readBackup, newEntry, reviseEntry } from '../js/library.js';
import { CourseStore } from '../lib/store.mjs';
import { VaultBridge } from '../lib/vault.mjs';

function snapshot(id = 'lesson-a') {
  return { ...createDefaultState(), lessonId: id, entries: [], course: { title: id, demo: false, transcriptName: 'synthetic.srt' } };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'study-desk-library-'));
  const vaultRoot = join(root, 'vault');
  await mkdir(join(vaultRoot, '考研', '数据'), { recursive: true });
  await writeFile(join(vaultRoot, '考研', '数据', 'subjects.csv'), 'subject_id,title\nmath,数学\n');
  await writeFile(join(vaultRoot, '考研', '数据', 'units.csv'), 'unit_id,subject_id,title\nu,math,测试单元\n');
  return { root, vaultRoot, store: new CourseStore(join(root, 'courses')), vault: new VaultBridge(vaultRoot) };
}
test('A/B courses isolate canvas and roundtrip full backup with history', async () => {
  const { store } = await setup(); const a = snapshot(), b = snapshot('lesson-b');
  a.canvasObjects = [{ id: 'anchor-a', type: 'anchor', time: 12, x: 10, y: 10 }];
  a.entries = [reviseEntry(newEntry(a), { personalText: '个人理解', reviewStatus: 'verified', reviewBasis: '对照合成板书' })];
  a.player.currentTime = 12;
  await store.save(a, null); await store.save(b, null);
  assert.equal((await store.get('lesson-b')).snapshot.canvasObjects.length, 0);
  const recovered = readBackup(JSON.parse(JSON.stringify(makeBackup((await store.get('lesson-a')).snapshot))));
  assert.equal(recovered.entries[0].history.length, 1);
  assert.equal(recovered.player.currentTime, 12);
  assert.equal(recovered.canvasObjects[0].id, 'anchor-a');
  assert.equal((await store.search('个人理解')).length, 1);
});
test('invalid backup, unsafe image and concurrent stale saves cannot replace saved data', async () => {
  const { store } = await setup(); const a = snapshot(); const first = await store.save(a, null);
  await assert.rejects(store.save({ ...a, course: { title: '改动' } }, null), /另一个页面/);
  const bad = makeBackup(a); bad.snapshot.canvasObjects = [{ id: 'bad', type: 'screenshot', image: 'https://example.com/tracker' }];
  assert.throws(() => readBackup(bad), /截图格式/);
  assert.throws(() => validateSnapshot({ ...a, lessonId: '../outside' }), /标识/);
  assert.equal((await store.get(a.lessonId)).revision, first.revision);
  assert.throws(() => reviseEntry(newEntry(a), { reviewStatus: 'verified', reviewBasis: '' }), /依据/);
});
test('archive is previewed, repeatable and preserves external edits and revisions', async () => {
  const { vault, vaultRoot } = await setup(); const a = snapshot();
  const e = newEntry(a, a.notes[0]); a.entries = [reviseEntry(e, { title: '合成条目', personalText: '这是我的解释', status: 'ready' })];
  const p = await vault.previewArchive(a, e.id);
  await assert.rejects(readFile(join(vaultRoot, p.path)), { code: 'ENOENT' });
  await vault.commitArchive(p.token); await vault.commitArchive(p.token);
  const same = await vault.previewArchive(a, e.id); assert.equal(same.unchanged, true);
  assert.match(await readFile(join(vaultRoot, p.path), 'utf8'), /mastery_state: UNKNOWN/);
  a.entries[0] = reviseEntry(a.entries[0], { personalText: '修订后的解释' });
  const second = await vault.previewArchive(a, e.id); assert.notEqual(second.path, p.path);
  await vault.commitArchive(second.token);
  await writeFile(join(vaultRoot, second.path), '手工修改');
  await assert.rejects(vault.commitArchive(second.token), /发生变化/);
  assert.equal(await readFile(join(vaultRoot, second.path), 'utf8'), '手工修改');
  assert.equal((await vault.search('这是我的解释')).length, 1);
  await assert.rejects(vault.readEntry('考研/测评/secret.md'), /只允许/);
  await assert.rejects(vault.readEntry('学习/课程知识/../../../secret.md'), /超出/);
  await assert.rejects(vault.readEntry('学习/课程知识/../../考研/测评/secret.md'), /超出/);
});
test('append-only correction replaces effective record and retries do not duplicate events', async () => {
  const { vault, vaultRoot } = await setup();
  const payload = { date: '2026-01-01', subject_id: 'math', unit_id: 'u', effective_minutes: '', output: '合成测试产物', notes: '' };
  await vault.appendRecord({ id: 'event-one', kind: 'session', payload });
  await vault.appendRecord({ id: 'event-one', kind: 'session', payload });
  const correction = { id: 'event-two', kind: 'session', supersedesId: 'event-one', payload: { ...payload, effective_minutes: '20' } };
  await vault.appendRecord(correction); await vault.appendRecord(correction);
  const rows = await vault.records(); assert.equal(rows.length, 1); assert.equal(rows[0].payload.effective_minutes, '20');
  assert.equal((await vault.csv('study_desk_events.csv')).length, 2);
  await assert.rejects(vault.appendRecord({ ...correction, id: 'event-three' }), /已变化/);
  await assert.rejects(vault.appendRecord({ id: 'event-four', kind: 'session', payload: { ...payload, date: '2026-02-31' } }), /有效/);

});
test('first-seen duplicates, guessed results and correction of legacy rows retain evidence meaning', async () => {
  const { vault, vaultRoot } = await setup();
  const payload = { date: '2026-01-01', subject_id: 'math', unit_id: 'u', item_id: 'book-1', source: '合成题', purpose: 'practice', evidence_kind: 'independent', result: 'correct', first_seen: 'true', closed_book: 'true', timed: 'false', guessed: 'true', source_quality: 'UNKNOWN', isolated_test: 'false', duration_min: '', notes: '' };
  await vault.appendRecord({ id: 'attempt-one', kind: 'attempt', payload });
  await assert.rejects(vault.appendRecord({ id: 'attempt-two', kind: 'attempt', payload }), /首次见/);
  assert.equal((await vault.records())[0].payload.guessed, 'true');
  await writeFile(join(vaultRoot, '考研', '数据', 'study_sessions.csv'), 'date,subject_id,unit_id,effective_minutes,output\n2026-01-01,math,u,5,旧记录\n');
  await vault.appendRecord({ id: 'session-fix', kind: 'session', supersedesId: 'legacy-session-1', payload: { date: '2026-01-01', subject_id: 'math', unit_id: 'u', effective_minutes: '7', output: '更正旧记录' } });
  assert.match(await readFile(join(vaultRoot, '考研', '数据', 'study_sessions.csv'), 'utf8'), /,5,旧记录/);
  assert.equal((await vault.records()).filter(r => r.kind === 'session')[0].payload.effective_minutes, '7');
});
