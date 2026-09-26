import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PracticeStore } from '../lib/practice.mjs';
import { PracticeDrafts } from '../lib/practice-drafts.mjs';
import { PracticeVault } from '../lib/practice-vault.mjs';
import { derivePracticeEvidence } from '../lib/practice-evidence.mjs';
import { parseCodexUsage, reconcilePracticeGrades, practiceCodexArguments, summarizeCodexUsage } from '../lib/practice-grader.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/yXcAAAAASUVORK5CYII=';
const topic = { id: 'test-topic', title: '合成知识点', unitId: 'physics836-mechanics' };
export const catalogFixture = { schemaVersion: 1, sources: [{ id: 's', title: '合成题源', kind: 'local', status: 'available' }], topics: [topic],
  items: [{ id: 'q1', sourceId: 's', sourceRef: '仅用于测试', title: '合成题目', prompt: '$1+1=?$', referenceAnswer: 'SECRET_REFERENCE', topicIds: [topic.id], unitId: topic.unitId,
    kind: 'supplement', track: '8.01', sourceQuality: 'UNKNOWN', locator: { path: 'synthetic.txt' } }] };
const payload = (id = 'a1', itemId = 'q1') => ({ id, itemId, lessonId: 'lesson-test', pages: [{ objects: [], image: png }], conditions: { closedBook: true, guessed: false, firstSeen: true } });
const grade = (verdict = 'correct') => ({ verdict, summary: '合成批改', recognizedWork: '2', steps: [{ page: 1, status: verdict === 'wrong' ? 'wrong' : 'correct', comment: '合成依据', topicIds: [topic.id], x: 0.1, y: 0.2 }],
  errorTopicIds: verdict === 'wrong' ? [topic.id] : [], uncertainties: [], hint: 'SECRET_HINT', solution: 'SECRET_SOLUTION', verification: { status: 'verified', reason: '合成复核' } });
const pair = (verdict = 'correct') => ({ reports: [grade(verdict), grade(verdict)] });
async function fixture(grader = async () => pair(), onChange) {
  const root = await mkdtemp(join(tmpdir(), 'practice-test-'));
  await mkdir(join(root, 'practice'));
  await writeFile(join(root, 'practice/catalog.json'), JSON.stringify(catalogFixture));
  const store = new PracticeStore({ courseRoot: root, grader, onChange });
  await store.init();
  return { root, store };
}

test('practice stores immutable originals, returns promptly, and deduplicates repeated submissions', async () => {
  let release, runs = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { root, store } = await fixture(async () => { runs++; await gate; return pair(); });
  const first = await store.submit(payload());
  assert.equal(first.state, 'queued');
  const path = join(root, 'practice/attempts/a1/submission.json'), before = await readFile(path, 'utf8');
  await store.submit(payload());
  await assert.rejects(store.submit({ ...payload(), note: 'different' }), /不可覆盖/);
  release(); await store.waitForIdle();
  assert.equal(runs, 1); assert.equal((await store.get('a1')).state, 'done');
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal((await store.list()).length, 1);
  assert.ok(!JSON.stringify(await store.catalog()).includes('SECRET_REFERENCE'));
  assert.ok(!JSON.stringify(await store.get('a1')).includes('SECRET_HINT'));
  assert.ok(!JSON.stringify(await store.list()).includes('SECRET_SOLUTION'));
});

test('unclear writing, source disputes and inconsistent graders never produce positive evidence', async () => {
  const unclear = grade(); unclear.steps[0].status = 'unclear';
  assert.equal(reconcilePracticeGrades(grade(), unclear).grade.verdict, 'needs-review');
  assert.equal(reconcilePracticeGrades(grade(), grade('wrong')).grade.verdict, 'needs-review');
  assert.equal(reconcilePracticeGrades(grade(), grade(), { sourceQuality: 'disputed' }).grade.verdict, 'source-issue');
  const { store } = await fixture(async () => ({ reports: [grade(), unclear] }));
  await store.submit(payload()); await store.waitForIdle();
  assert.equal((await store.get('a1')).state, 'needs-review');
  const result = derivePracticeEvidence(catalogFixture, await store.list());
  assert.equal(result.topics[0].mastery, null); assert.equal(result.topics[0].gap, 'unknown');
});

test('failed CLI and malformed reports retain original work and retry only the existing attempt', async () => {
  let runs = 0;
  const { root, store } = await fixture(async () => { if (++runs === 1) throw new Error('synthetic unavailable CLI'); return pair(); });
  await store.submit(payload()); await store.waitForIdle();
  const original = await readFile(join(root, 'practice/attempts/a1/submission.json'), 'utf8');
  assert.equal((await store.get('a1')).state, 'failed');
  await store.retry('a1'); await store.waitForIdle();
  assert.equal((await store.get('a1')).state, 'done'); assert.equal((await store.list()).length, 1);
  assert.equal(await readFile(join(root, 'practice/attempts/a1/submission.json'), 'utf8'), original);
  assert.equal((await readdir(join(root, 'practice/attempts/a1/runs'))).length, 2);
});

test('solution exposure and factual corrections are auditable and cannot directly set grades', async () => {
  const { store, root } = await fixture();
  const shown = await store.reveal('q1', { kind: 'solution' }); assert.equal(shown.text, 'SECRET_REFERENCE');
  await store.submit(payload()); await store.waitForIdle();
  assert.equal((await store.get('a1')).helpHistory.length, 1);
  assert.equal(derivePracticeEvidence(catalogFixture, await store.list()).topics[0].independentItems, 0);
  const before = await readFile(join(root, 'practice/attempts/a1/submission.json'), 'utf8');
  await assert.rejects(store.correct('a1', { reason: '直接改分', verdict: 'correct' }), /不允许/);
  await store.correct('a1', { reason: '实际看过资料', conditions: { closedBook: false } });
  await store.waitForIdle();
  const after = await store.get('a1');
  assert.equal(after.conditions.closedBook, false); assert.equal(after.corrections.length, 1);
  assert.equal(await readFile(join(root, 'practice/attempts/a1/submission.json'), 'utf8'), before);
});

test('restart recovers incomplete jobs as retryable uncertainty without invoking a model', async () => {
  const { root, store } = await fixture(); await store.submit(payload()); await store.waitForIdle();
  const path = join(root, 'practice/attempts/a1/state.json');
  const state = JSON.parse(await readFile(path, 'utf8')); state.state = 'running'; await writeFile(path, JSON.stringify(state));
  let calls = 0;
  const recovered = new PracticeStore({ courseRoot: root, grader: async () => { calls++; return pair(); } });
  await recovered.init(); assert.equal((await recovered.get('a1')).state, 'needs-review'); assert.equal(calls, 0);
});

test('drafts isolate lesson/item/page and reject stale overwrites', async () => {
  const root = await mkdtemp(join(tmpdir(), 'practice-drafts-test-')), drafts = new PracticeDrafts(root);
  const snapshot = { pages: [{ objects: [] }, { objects: [{ id: 'line1', type: 'line', themeId: 'unclassified', start: { x: 1, y: 1 }, end: { x: 5, y: 8 } }] }], activePage: 1, attemptId: 'draft-a' };
  const saved = await drafts.save({ lessonId: 'lesson-a', itemId: 'q1', snapshot });
  assert.equal((await drafts.get('lesson-a', 'q1')).snapshot.pages[1].objects.length, 1);
  assert.equal(await drafts.get('lesson-b', 'q1'), null);
  await assert.rejects(drafts.save({ lessonId: 'lesson-a', itemId: 'q1', snapshot }), /另一个页面/);
  assert.equal((await drafts.save({ lessonId: 'lesson-a', itemId: 'q1', snapshot, expectedRevision: saved.revision })).revision, saved.revision);
});

test('mastery uses unique dated independent work; repeated, guessed, prompted and unrelated concepts do not inflate it', () => {
  const attempt = (id, day, overrides = {}) => ({ id, itemId: id, lessonId: 'l', submittedAt: `2026-09-${day}T01:00:00.000Z`, state: 'done',
    conditions: { closedBook: true, guessed: false, firstSeen: true }, grade: grade(), item: catalogFixture.items[0], ...overrides });
  const three = [attempt('p1', '01'), attempt('p2', '01'), attempt('p3', '02')];
  assert.equal(derivePracticeEvidence(catalogFixture, three).topics[0].mastery, 0.5);
  assert.equal(derivePracticeEvidence(catalogFixture, three.map(a => ({ ...a, itemId: 'same' }))).topics[0].mastery, null);
  assert.equal(derivePracticeEvidence(catalogFixture, three.map(a => ({ ...a, conditions: { ...a.conditions, guessed: true } }))).topics[0].mastery, null);
  for (const itemFields of [{ composite: true }, { measurementEligible: false }]) {
    assert.equal(derivePracticeEvidence(catalogFixture, three.map(a => ({ ...a, item: { ...a.item, ...itemFields } }))).topics[0].mastery, null);
  }
  const secondTopic = { ...topic, id: 'unrelated' };
  const extra = { ...catalogFixture, topics: [topic, secondTopic] };
  const result = derivePracticeEvidence(extra, three.map(a => ({ ...a, item: { ...a.item, topicIds: [topic.id, secondTopic.id] } })));
  assert.equal(result.topics[1].mastery, null);
  assert.equal(derivePracticeEvidence(extra, three.map(a => ({ ...a, item: { ...a.item, topicIds: [topic.id, secondTopic.id] }, conditions: { ...a.conditions, guessed: true } }))).topics[1].gap, 'unknown');
  const negatives = [attempt('n1', '01', { grade: grade('wrong') }), attempt('n2', '02', { grade: grade('wrong') })];
  assert.equal(derivePracticeEvidence(catalogFixture, negatives.slice(0, 1)).topics[0].gap, 'candidate');
  assert.equal(derivePracticeEvidence(catalogFixture, negatives).topics[0].gap, 'confirmed');
});

test('automatic Vault archiving is idempotent, keeps original drawings and retains corrected reports', async () => {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'practice-vault-test-'));
  const { root, store } = await fixture();
  const bridge = new PracticeVault({ vaultRoot, courseRoot: root, baseUrl: 'http://127.0.0.1:4173' });
  store.onChange = event => bridge.record(event);
  await store.submit(payload()); await store.waitForIdle();
  const before = (await bridge.events()).length;
  await bridge.record({ type: 'graded', attempt: await store.getInternal('a1') });
  assert.equal((await bridge.events()).length, before);
  assert.ok((await readdir(join(vaultRoot, '学习/错题本/作答/a1'))).some(n => n.endsWith('.png')));
  const report = await readFile(join(vaultRoot, '学习/错题本/00-错题本.generated.md'), 'utf8');
  assert.match(report, /UNKNOWN/); assert.ok(!report.includes('SECRET_REFERENCE'));
  await store.correct('a1', { reason: '闭卷条件更正', conditions: { closedBook: false } }); await store.waitForIdle();
  assert.ok((await readdir(join(vaultRoot, '学习/错题本/作答/a1'))).filter(n => n.endsWith('.md')).length >= 2);
  assert.equal((await bridge.effective()).length, 1);
});

test('grading arguments disable execution tools and carry image/schema arguments without shell strings', () => {
  const args = practiceCodexArguments('result.json', ['a b.png']);
  assert.ok(args.includes('--json')); assert.ok(args.includes('--ignore-user-config')); assert.ok(args.includes('--output-schema'));
  assert.equal(args[args.indexOf('--image') + 1], 'a b.png');
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('Codex JSONL usage is validated and summed without double-counting cached or reasoning tokens', () => {
  const first = parseCodexUsage('{"type":"turn.started"}\n{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":20,"reasoning_output_tokens":5}}\n');
  const second = parseCodexUsage('not-json\n{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":50,"output_tokens":25,"reasoning_output_tokens":6}}\n');
  assert.deepEqual(first, { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5 });
  assert.deepEqual(summarizeCodexUsage([{ role: 'first', usage: first }, { role: 'second', usage: second }]), {
    status: 'complete', calls: [{ role: 'first', usage: first }, { role: 'second', usage: second }],
    totals: { input_tokens: 220, cached_input_tokens: 90, output_tokens: 45, reasoning_output_tokens: 11, total_tokens: 265 },
  });
  assert.equal(parseCodexUsage('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":11,"output_tokens":2,"reasoning_output_tokens":0}}'), null);
});
