import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PracticeStore } from '../lib/practice.mjs';
import { TopicTraining, summarizeTraining } from '../lib/topic-training.mjs';
import { derivePracticeEvidence } from '../lib/practice-evidence.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/yXcAAAAASUVORK5CYII=';
const topic = { id: 'math-test', title: '合成数学题型', unitId: 'math1-limits', training: { method: 'METHOD', source: '合成题源' } };
const grade = { verdict: 'correct', summary: '合成判定', recognizedWork: '1', steps: [{ page: 1, status: 'correct', comment: '合成步骤', topicIds: [topic.id], x: null, y: null }], errorTopicIds: [], uncertainties: [], hint: 'hint', solution: 'solution', verification: { status: 'verified', reason: '合成' } };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'math-training-test-')); await mkdir(join(root, 'practice'));
  const catalog = { schemaVersion: 1, sources: [{ id: 's', title: '合成题源', kind: 'local', status: 'available' }], topics: [topic], items: Array.from({ length: 11 }, (_, i) => ({ id: `q${i}`, title: `题 ${i}`, sourceId: 's', sourceRef: 'synthetic', prompt: '1=?', referenceAnswer: '1', topicIds: [topic.id], unitId: topic.unitId, track: 'math1', kind: 'supplement', sourceQuality: i === 10 ? 'disputed' : 'UNKNOWN', locator: { path: 'synthetic' }, trainingOrder: i })) };
  await writeFile(join(root, 'practice/catalog.json'), JSON.stringify(catalog));
  const practice = new PracticeStore({ courseRoot: root, grader: async () => ({ reports: [grade, grade] }) });
  const training = new TopicTraining(root, practice);
  return { root, practice, training, catalog };
}
function payload(s, index, id = `a${index}`) { return { id, lessonId: s.id, itemId: s.itemIds[index], pages: [{ objects: [], image: png }], conditions: { closedBook: true, firstSeen: true, guessed: false } }; }

test('training persists 5–10 real questions without requiring a course; shortages and disputed sources cannot be padded', async () => {
  const { training, root, practice } = await fixture();
  assert.equal((await training.options())[0].unseen, 10);
  await assert.rejects(training.create({ topicId: topic.id, count: 4, mode: 'guided' }), /5–10/);
  const s = await training.create({ topicId: topic.id, count: 10, mode: 'guided' });
  assert.equal(s.itemIds.length, 10); assert.ok(!s.itemIds.includes('q10')); assert.equal(s.method, undefined);
  const reload = new TopicTraining(root, practice); assert.equal((await reload.list())[0].id, s.id);
  await assert.rejects(training.submit({ ...payload(s, 0), itemId: 'q10' }), /不属于/);
  const report = await training.report(s.id); assert.equal(report.accuracy.value, null); assert.equal(report.unsubmitted, 10);
});

test('guided and method-revealed detection cannot inflate independent evidence; corrections cannot erase first attempts', async () => {
  const { training, practice, catalog, root } = await fixture();
  const s = await training.create({ topicId: topic.id, count: 5, mode: 'guided' });
  await training.submit(payload(s, 0)); await practice.waitForIdle();
  assert.equal((await training.report(s.id)).independentAccuracy.value, null);
  assert.equal(derivePracticeEvidence(catalog, await practice.list()).topics[0].independentItems, 0);
  const path = join(root, 'practice/attempts/a0/submission.json'); const original = await readFile(path, 'utf8');
  await training.submit({ ...payload(s, 0, 'correction'), parentAttemptId: 'a0', conditions: { closedBook: true, firstSeen: false, guessed: false } }); await practice.waitForIdle();
  const report = await training.report(s.id); assert.equal(report.accuracy.total, 1); assert.equal(report.rows[0].corrections, 1);
  assert.equal(await readFile(path, 'utf8'), original);
  const independent = await training.create({ topicId: topic.id, count: 5, mode: 'independent' });
  await training.submit(payload(independent, 0, 'before-method')); await practice.waitForIdle();
  assert.equal((await training.report(independent.id)).independentAccuracy.correct, 1);
  assert.equal((await training.method(independent.id)).method, 'METHOD');
  await training.submit(payload(independent, 1, 'after-method')); await practice.waitForIdle();
  const updated = await training.report(independent.id);
  assert.equal(updated.accuracy.correct, 2); assert.equal(updated.independentAccuracy.correct, 1);
  assert.equal(updated.assisted, 1);
});

test('round statistics separate UNKNOWN, failures, unanswered, guesses and first attempts from retries', () => {
  const session = { id: 's', mode: 'independent', itemIds: ['a','b','c','d','e','f'] };
  const a = (id, verdict, extra = {}) => ({ id: `try-${id}`, lessonId: 's', itemId: id, submittedAt: '2026-09-20T08:00:00Z', state: 'done', item: { sourceQuality: 'UNKNOWN' }, conditions: { closedBook: true, firstSeen: true, guessed: false }, grade: { ...grade, verdict }, ...extra });
  const rows = [a('a', 'wrong'), a('b', 'correct', { conditions: { closedBook: null, firstSeen: true, guessed: false } }), a('c', 'correct', { state: 'failed' }), a('d', 'unanswered'), a('e', 'correct', { conditions: { closedBook: true, firstSeen: true, guessed: true } }), a('a', 'correct', { id: 'correction', parentAttemptId: 'try-a', submittedAt: '2026-09-20T09:00:00Z' })];
  const report = summarizeTraining(session, rows);
  assert.deepEqual(report.accuracy, { correct: 2, total: 4, value: .5 });
  assert.deepEqual(report.independentAccuracy, { correct: 0, total: 2, value: 0 });
  assert.equal(report.pending, 1); assert.equal(report.unsubmitted, 1); assert.equal(report.guessed, 1); assert.equal(report.rows[0].corrected, true);
});

test('error distribution counts only the first evidenced mistake, never guesses categories from a result', () => {
  const session = { id: 's', mode: 'guided', itemIds: ['q1','q2'] };
  const attempt = (itemId, comments) => ({ id: itemId, itemId, lessonId: 's', submittedAt: '2026-09-20T08:00:00Z', state: 'done', item: { sourceQuality: 'UNKNOWN' },
    grade: { ...grade, verdict: 'wrong', steps: comments.map(comment => ({ page: 1, status: 'wrong', comment, topicIds: [topic.id] })) } });
  const report = summarizeTraining(session, [attempt('q1',['【概念】首个错误','【运算】连带错误']),attempt('q2',['缺乏明确归类依据'])]);
  assert.deepEqual(report.errorGroups.map(g => [g.category,g.count]), [['概念',1],['待定位',1]]);
  assert.equal(report.gaps[0].count,2);
});

test('independent selection excludes already submitted questions and refuses fake new-item counts', async () => {
  const { training, practice } = await fixture(); const s = await training.create({ topicId: topic.id, count: 10, mode: 'guided' });
  for (let i=0;i<6;i++) await training.submit(payload(s,i)); await practice.waitForIdle();
  await assert.rejects(training.create({ topicId: topic.id, count: 5, mode: 'independent' }), /只有 4/);
  await assert.rejects(training.create({ topicId: topic.id, count: 5, mode: 'independent', includeSeen: true }), /只选/);
  const review = await training.create({ topicId: topic.id, count: 5, mode: 'guided', includeSeen: true });
  assert.equal(review.itemIds.length, 5);
});

test('page topics open small composite groups without becoming independent-question evidence', async () => {
  const { training, practice, catalog, root } = await fixture();
  const pageTopic = { ...topic, id: 'page-topic', training: { ...topic.training, itemMode: 'pages', chapterTitle: '一元积分' } };
  catalog.topics.push(pageTopic);
  catalog.items.push({ ...catalog.items[0], id: 'page-1', topicIds: [pageTopic.id], composite: true, measurementEligible: false });
  catalog.items.push({ ...catalog.items[0], id: 'unsafe-page', topicIds: [pageTopic.id], composite: true });
  await writeFile(join(root, 'practice/catalog.json'), JSON.stringify(catalog));
  const option = (await training.options()).find(t => t.id === pageTopic.id);
  assert.equal(option.total, 1); assert.equal(option.itemMode, 'pages');
  await assert.rejects(training.create({ topicId: pageTopic.id, count: 1, mode: 'independent' }), /不能用于独立检测/);
  const s = await training.create({ topicId: pageTopic.id, count: 1, mode: 'guided' });
  assert.deepEqual(s.itemIds, ['page-1']); assert.equal(s.itemMode, 'pages');
  await training.submit(payload(s, 0)); await practice.waitForIdle();
  assert.equal((await training.report(s.id)).independentAccuracy.value, null);
  assert.equal((await training.options()).find(t => t.id === pageTopic.id).unseen, 0);
  assert.equal(derivePracticeEvidence(catalog, await practice.list()).topics.find(t => t.id === pageTopic.id).independentItems, 0);
});
