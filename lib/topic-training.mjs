import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { boundedPath, readJson } from './store.mjs';
import { requireId } from '../js/library.js';

const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const reviewed = a => a?.state === 'done' && a.grade?.verification?.status === 'verified' &&
  !a.grade.uncertainties?.length && ['correct', 'wrong', 'unanswered'].includes(a.grade.verdict) && a.item?.sourceQuality !== 'disputed';
const ordered = rows => [...rows].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id));
const helped = a => (a.helpHistory || []).some(h => h.at <= a.submittedAt);
const fraction = (correct, total) => ({ correct, total, value: total ? correct / total : null });

// This is a round report, not a new mastery threshold or an exam decision gate.
export function summarizeTraining(session, allAttempts) {
  const firstGlobal = new Map();
  for (const a of ordered(allAttempts)) if (!firstGlobal.has(a.itemId)) firstGlobal.set(a.itemId, a.id);
  const rows = session.itemIds.map(itemId => {
    const tries = ordered(allAttempts.filter(a => a.lessonId === session.id && a.itemId === itemId));
    const first = tries.find(a => !a.parentAttemptId);
    const valid = reviewed(first);
    const independent = valid && session.mode === 'independent' && firstGlobal.get(itemId) === first.id &&
      !first.parentAttemptId && first.conditions?.closedBook === true && first.conditions?.firstSeen === true &&
      first.conditions?.guessed === false && !helped(first) && first.item?.measurementEligible !== false;
    return { itemId, attemptId: first?.id || null, state: !first ? 'unsubmitted' : valid ? first.grade.verdict : 'pending',
      independent, assisted: Boolean(first && (session.mode === 'guided' || helped(first) || first.conditions?.closedBook === false)),
      guessed: first?.conditions?.guessed === true, summary: valid ? first.grade.summary : first?.lastError || '',
      errors: valid && first.grade.verdict === 'wrong' ? first.grade.steps.filter(s => s.status === 'wrong').map(s => ({ page: s.page, comment: s.comment, topicIds: s.topicIds })) : [],
      corrections: tries.filter(a => a.parentAttemptId).length,
      corrected: tries.some(a => a.parentAttemptId && reviewed(a) && a.grade.verdict === 'correct') };
  });
  const valid = rows.filter(r => ['correct', 'wrong', 'unanswered'].includes(r.state));
  const independent = valid.filter(r => r.independent);
  const wrong = rows.filter(r => r.state === 'wrong');
  const pending = rows.filter(r => r.state === 'pending').length;
  const unsubmitted = rows.filter(r => r.state === 'unsubmitted').length;
  const gaps = new Map();
  for (const row of wrong) for (const id of new Set(row.errors.flatMap(e => e.topicIds))) gaps.set(id, (gaps.get(id) || 0) + 1);
  const errorGroups = new Map();
  const repairs = { '概念': '补清定义，解释每个符号，再做一道只用这个定义的题。', '方法选择': '回到方法卡的识别条件，先只写第一步变形，再完成推导。', '适用条件': '逐项写出定义域、极限趋向和替换条件，再重做原步骤。', '运算': '只重算首个错误处，检查符号、系数和阶数，再代回后续推导。', '表达或未完成': '补齐缺失的理由或最后还原步骤，再提交订正。', '待定位': '打开逐题批改核对首个错误；证据不足时提交事实复核。' };
  for (const row of wrong) {
    const explicit = /^【(概念|方法选择|适用条件|运算|表达或未完成|待定位)】/.exec(row.errors[0]?.comment || '')?.[1] || '待定位';
    if (!errorGroups.has(explicit)) errorGroups.set(explicit, { category: explicit, count: 0, itemIds: [], repair: repairs[explicit] });
    const group = errorGroups.get(explicit); group.count++; group.itemIds.push(row.itemId);
  }
  let nextStep;
  if (pending) nextStep = '先处理待批改、批改失败或字迹疑点；这些题暂不进入正确率分母。可以继续未提交题。';
  else if (wrong.length || rows.some(r => r.state === 'unanswered')) nextStep = '先回看下方首个错误步骤，只补对应概念、条件或运算，再在副本上订正；订正不覆盖首答正确率。之后用未见过的同类题检查。';
  else if (unsubmitted) nextStep = '继续本组未提交题。当前样本只反映已核验的首答。';
  else if (session.itemMode === 'pages') nextStep = '本组按页练习已完成。可继续其他讲义页，或订正本页作答；独立检测需要已逐题拆分的题源。';
  else if (session.mode === 'guided' || independent.length < rows.length) nextStep = '本组练习已完成。下一组选择独立检测，用未见过的题、闭卷且不看提示检查；题源不足时先补题源。';
  else nextStep = '本组独立首答已完成。改日用未见过的题复测，之后再做混合题；本次结果不能单独证明长期掌握。';
  return { session, rows, submitted: rows.length - unsubmitted, total: rows.length, pending, unsubmitted,
    accuracy: fraction(valid.filter(r => r.state === 'correct').length, valid.length),
    independentAccuracy: fraction(independent.filter(r => r.state === 'correct').length, independent.length),
    assisted: valid.filter(r => r.assisted).length, guessed: valid.filter(r => r.guessed).length,
    wrong: wrong.length, unanswered: rows.filter(r => r.state === 'unanswered').length,
    gaps: [...gaps].map(([topicId, count]) => ({ topicId, count })), errorGroups: [...errorGroups.values()].sort((a,b) => b.count-a.count), nextStep,
    note: session.itemMode === 'pages' ? '按讲义页记录首次提交和订正，只批改明确选定的作答。页练习正确率不是逐题正确率，不计独立题掌握；空样本为 UNKNOWN。' : '一题只计本组第一次提交；订正另记。待核验不入分母，未作答判定计入分母。独立首答另要求全局首次提交、首次见、闭卷、无帮助且非猜测；空样本为 UNKNOWN。' };
}

export class TopicTraining {
  constructor(courseRoot, practice) { this.root = join(courseRoot, 'practice', 'training'); this.courseRoot = courseRoot; this.practice = practice; }
  async directory() { await boundedPath(this.courseRoot, 'practice', 'training'); await mkdir(this.root, { recursive: true }); }
  async get(id) { requireId(id); return readJson(await boundedPath(this.root, `${id}.json`)); }
  async list() {
    await this.directory();
    const rows = [];
    for (const name of await readdir(this.root)) if (name.endsWith('.json')) rows.push(await readJson(await boundedPath(this.root, name)));
    return rows.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async options() {
    const catalog = await this.practice.catalog(), attempts = await this.practice.list();
    const tried = new Set(attempts.map(a => a.itemId));
    return catalog.topics.filter(t => t.training?.method).map(t => {
      const pages = t.training.itemMode === 'pages';
      const items = catalog.items.filter(i => i.track === 'math1' && i.topicIds.includes(t.id) && i.sourceQuality !== 'disputed' &&
        (pages ? i.composite === true && i.measurementEligible === false : !i.composite) && catalog.sources.some(s => s.id === i.sourceId && s.status === 'available'));
      return { id: t.id, title: t.title, total: items.length, unseen: items.filter(i => !tried.has(i.id)).length, source: t.training.source, prerequisites: t.training.prerequisites,
        itemMode: pages ? 'pages' : 'questions', chapterTitle: t.training.chapterTitle || '已拆分单题' };
    });
  }
  async create({ topicId, count, mode, includeSeen = false } = {}) {
    if (!['guided', 'independent'].includes(mode) || typeof includeSeen !== 'boolean') fail('训练方式无效');
    if (mode === 'independent' && includeSeen) fail('独立检测只选尚未提交的新题；复习请使用方法练习');
    const catalog = await this.practice.catalog(), topic = catalog.topics.find(t => t.id === topicId && t.training?.method);
    if (!topic) fail('题型尚未准备好');
    const pages = topic.training.itemMode === 'pages', unit = pages ? '页' : '道题';
    if (!Number.isInteger(count) || count < (pages ? 1 : 5) || count > 10) fail(pages ? '每组请选择 1–10 页' : '每组请选择 5–10 道题');
    if (pages && mode !== 'guided') fail('原讲义页尚未逐题拆分，只能用于方法练习，不能用于独立检测');
    const tried = new Set((await this.practice.list()).map(a => a.itemId));
    const candidates = catalog.items.filter(i => i.track === 'math1' && i.topicIds.includes(topicId) && i.sourceQuality !== 'disputed' &&
      (pages ? i.composite === true && i.measurementEligible === false : !i.composite) &&
      catalog.sources.some(s => s.id === i.sourceId && s.status === 'available') && (includeSeen || !tried.has(i.id)))
      .sort((a, b) => Number(tried.has(a.id)) - Number(tried.has(b.id)) || (a.trainingOrder || 0) - (b.trainingOrder || 0) || a.id.localeCompare(b.id));
    if (candidates.length < count) fail(`当前范围只有 ${candidates.length} ${unit}可用，不足 ${count} ${unit}。请减少数量，或在方法练习中明确选择允许复习旧题。`);
    const session = { schemaVersion: 1, id: `training-${randomUUID()}`, createdAt: new Date().toISOString(),
      topicId, title: topic.title, mode, includeSeen, itemIds: candidates.slice(0, count).map(i => i.id),
      itemMode: pages ? 'pages' : 'questions',
      method: structuredClone(topic.training) };
    await this.directory();
    await writeFile(await boundedPath(this.root, `${session.id}.json`), JSON.stringify(session, null, 2), { flag: 'wx' });
    return this.publicSession(session);
  }
  publicSession(session) { if (!session) return null; const copy = { ...session }; delete copy.method; return copy; }
  async report(id) { const session = await this.get(id); if (!session) fail('训练组不存在'); return summarizeTraining(this.publicSession(session), await this.practice.list()); }
  async method(id) {
    const session = await this.get(id); if (!session) fail('训练组不存在');
    // Exposures precede content delivery. Subsequent submissions cannot claim no help.
    await this.practice.recordMethodExposure(session.itemIds, session.id);
    return session.method;
  }
  async submit(payload) {
    const session = await this.get(payload.lessonId);
    if (!session || !session.itemIds.includes(payload.itemId)) fail('题目不属于这个训练组');
    return this.practice.submit(payload, { trainingMode: session.mode });
  }
}
