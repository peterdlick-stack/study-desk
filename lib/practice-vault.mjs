import { readFile, mkdir, writeFile, appendFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { boundedPath, sha, readJson, atomicJson } from './store.mjs';
import { parseCsv } from './vault.mjs';
import { requireId } from '../js/library.js';
import { derivePracticeEvidence, summarizeAttempt } from './practice-evidence.mjs';

const header = 'event_id,recorded_at,kind,attempt_id,payload_json';
const csv = s => `"${String(s).replaceAll('"', '""')}"`;
const cell = s => String(s ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
const safeText = s => String(s ?? '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const labels = { correct: '正确', wrong: '错误', unanswered: '未完成', 'needs-review': '待核验', 'source-issue': '题源问题', queued: '排队中', running: '批改中', failed: '批改失败', done: '已批改' };
const gaps = { unknown: '未确认缺口', candidate: '候选薄弱点', confirmed: '跨日期证据支持的薄弱点', resolved: '已通过后续复测' };

async function writeOnce(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, bytes, { flag: 'wx' }); }
  catch (e) { if (e.code !== 'EEXIST' || !(await readFile(path)).equals(Buffer.from(bytes))) throw new Error(`归档目标已被修改，保留原文件：${path}`); }
}

export class PracticeVault {
  constructor({ vaultRoot, courseRoot, baseUrl }) { this.vaultRoot = vaultRoot; this.courseRoot = courseRoot; this.baseUrl = baseUrl; this.queue = Promise.resolve(); }
  async events() {
    try { return parseCsv(await readFile(await boundedPath(this.vaultRoot, '考研/数据/practice_events.csv'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  record(event) {
    const task = this.queue.then(() => this.writeEvent(event));
    this.queue = task.catch(() => {});
    return task;
  }
  async writeEvent({ type, attempt }) {
    const a = summarizeAttempt(attempt), id = requireId(a.id);
    const dir = `学习/错题本/作答/${id}`;
    const attachments = [];
    for (let i = 0; i < (attempt.pages || []).length; i++) {
      const page = attempt.pages[i], drawing = Buffer.from(JSON.stringify(page.objects || [], null, 2));
      const drawingName = `第${i + 1}页-${sha(drawing)}.json`;
      await writeOnce(await boundedPath(this.vaultRoot, dir, drawingName), drawing);
      if (typeof page.image === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(page.image)) {
        const bytes = Buffer.from(page.image.split(',')[1], 'base64'), filename = `第${i + 1}页-${sha(bytes)}.png`;
        await writeOnce(await boundedPath(this.vaultRoot, dir, filename), bytes);
        attachments.push({ page: i + 1, image: `${dir}/${filename}`, objects: `${dir}/${drawingName}` });
      }
    }
    // The Vault stores the student's work and a source index, never the book question/answer corpus.
    const payload = { ...a, attachments };
    if (payload.grade) { payload.grade = { ...payload.grade }; delete payload.grade.solution; delete payload.grade.hint; }
    const raw = JSON.stringify(payload), eventId = `practice-${sha(type + raw)}`;
    const previous = await this.events();
    if (!previous.some(e => e.event_id === eventId)) {
      const path = await boundedPath(this.vaultRoot, '考研/数据/practice_events.csv');
      await mkdir(dirname(path), { recursive: true });
      try { await writeFile(path, header + '\n', { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      await appendFile(path, [eventId, new Date().toISOString(), type, id, raw].map(csv).join(',') + '\n');
    }
    if (['graded', 'failed', 'corrected'].includes(type)) {
      const link = this.link(a), grade = a.grade;
      const lines = ['---', 'type: exercise-attempt', 'domain: study', 'source_kind: study-desk', `status: ${a.state}`,
        `study_attempt_id: ${id}`, `source_ref: ${JSON.stringify(link)}`, `evidence_state: ${a.state === 'done' ? 'AI_REVIEWED' : 'PENDING'}`, 'relations_reviewed: false', '---', '',
        `# ${safeText(a.item.title)} · 作答记录`, '', `提交时间：${a.submittedAt}`, '',
        `题目出处：${safeText(a.item.sourceRef || a.item.locator?.path || '待补')}`, '',
        `[回到学习台查看题目和完整批改](${link})`, '',
        `批改状态：${labels[grade?.verdict] || labels[a.state] || a.state}`, '',
        safeText(grade?.summary || a.lastError || '等待批改'), '', '## 作答与批改依据', '',
        safeText(grade?.recognizedWork || '没有可确认的转写'), '',
        ...(grade?.steps || []).map(s => `- 第 ${s.page} 页：${safeText(s.comment)}`), '',
        ...(grade?.uncertainties || []).map(s => `- 待核验：${safeText(s)}`), '',
        '## 关联知识点', '',
        ...a.item.topicIds.map(t => `- [[../../知识点/${requireId(t)}.generated|${t}]]`), '',
        '题目涉及知识点只表示关联；实际错误归因与掌握证据分别计算。', '',
        '## 原始手写', '', ...attachments.map(p => `![第 ${p.page} 页](./${p.image.split('/').at(-1)})`), '',
        '原始作答与每次批改保留。事实更正和订正使用新的事件，不覆盖本记录。', ''];
      await writeOnce(await boundedPath(this.vaultRoot, dir, `批改-${sha(raw)}.md`), Buffer.from(lines.join('\n')));
    }
    const catalog = await readJson(await boundedPath(this.courseRoot, 'practice/catalog.json'), { topics: [], items: [], sources: [] });
    await this.regenerate(catalog);
    return { eventId, directory: dir };
  }
  link(a) { return `${this.baseUrl}/?${a.lessonId?.startsWith('training-') ? 'training' : 'lesson'}=${encodeURIComponent(a.lessonId)}&practice=${encodeURIComponent(a.itemId)}&attempt=${encodeURIComponent(a.id)}`; }
  async effective() {
    const latest = new Map();
    for (const event of await this.events()) {
      const value = JSON.parse(event.payload_json);
      if (value.id !== event.attempt_id) throw new Error('作答归档事件标识不一致');
      latest.set(value.id, value);
    }
    return [...latest.values()];
  }
  async regenerate(catalog) {
    const ledger = await boundedPath(this.vaultRoot, '考研/数据/practice_events.csv');
    await mkdir(dirname(ledger), { recursive: true });
    try { await writeFile(ledger, header + '\n', { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const result = derivePracticeEvidence(catalog, await this.effective());
    const generated = new Map();
    const all = result.attempts, wrong = all.filter(a => a.state === 'done' && a.grade?.verdict === 'wrong');
    const pending = all.filter(a => a.state !== 'done' || ['needs-review', 'source-issue'].includes(a.grade?.verdict));
    const table = entries => ['| 提交时间 | 题目 | 状态 | 原始记录 |', '|---|---|---|---|',
      ...entries.map(a => `| ${cell(a.submittedAt)} | ${cell(a.item.title)} | ${labels[a.grade?.verdict] || labels[a.state] || a.state} | [查看](${this.link(a)}) |`),
      ...(entries.length ? [] : ['| — | 暂无记录 | UNKNOWN | — |'])];
    generated.set('学习/错题本/00-错题本.generated.md', [
      '---', 'type: generated-index', 'domain: study', `status: ${all.length ? 'EVIDENCE_AVAILABLE' : 'UNKNOWN'}`, 'source_kind: practice-events', 'source_ref: "考研/数据/practice_events.csv"', 'evidence_state: derived', 'relations_reviewed: true', '---', '',
      '# 错题与作答证据', '', '由 `00-System/tools/Refresh-Practice.ps1` 及同一生成器重建。原始事件在 [[../../考研/数据/practice_events.csv]]。', '',
      result.note, '', `已保存 ${all.length} 次作答；已判定错误 ${wrong.length} 次；待处理 ${pending.length} 次。`, '',
      '## 错题', '', ...table(wrong), '', '## 待批改与待核验', '', ...table(pending), '',
      '## 知识点', '', '| 知识点 | 独立正确题 / 日期 | 证据阶梯 | 缺口 |', '|---|---|---|---|',
      ...result.topics.map(t => `| [[知识点/${t.id}.generated|${cell(t.title)}]] | ${t.independentItems} / ${t.independentDates} | ${t.mastery === null ? 'UNKNOWN' : t.mastery + '（阶梯值）'} | ${gaps[t.gap]} |`), '',
      '## 全部作答', '', ...table(all), ''].join('\n'));
    // Match existing note titles for navigation only. Linking is not evidence of mastery.
    const noteIndex = [];
    const scan = async rel => {
      let files; try { files = await readdir(await boundedPath(this.vaultRoot, rel), { withFileTypes: true }); }
      catch (e) { if (e.code === 'ENOENT') return; throw e; }
      for (const f of files) {
        if (f.isSymbolicLink()) continue;
        const next = `${rel}/${f.name}`;
        if (f.isDirectory()) await scan(next);
        else if (f.name.endsWith('.md')) {
          const text = await readFile(await boundedPath(this.vaultRoot, next), 'utf8');
          noteIndex.push({ path: next, title: /^# (.+)$/m.exec(text)?.[1] || f.name.slice(0, -3) });
        }
      }
    };
    await scan('学习/课程知识');
    for (const t of result.topics) {
      const relatedNotes = noteIndex.filter(n => n.title === t.title || (t.title.length >= 4 && n.title.includes(t.title))).slice(0, 8);
      const relevant = all.filter(a => a.item.topicIds.includes(t.id));
      generated.set(`学习/错题本/知识点/${requireId(t.id)}.generated.md`, [
        '---', 'type: knowledge-evidence-index', 'domain: study', `status: ${t.attempts ? 'EVIDENCE_AVAILABLE' : 'UNKNOWN'}`, 'source_kind: practice-events', 'source_ref: "考研/数据/practice_events.csv"', 'evidence_state: derived',
        'relations_reviewed: false', `unit_id: ${t.unitId || 'UNKNOWN'}`, 'syllabus_status: pending', '---', '',
        `# ${t.title}`, '', `证据阶梯：${t.mastery === null ? 'UNKNOWN' : t.mastery}；${gaps[t.gap]}。`, '',
        `独立正确题 ${t.independentItems} 道，跨 ${t.independentDates} 个日期；累计作答 ${t.attempts} 次，待处理 ${t.pending} 次。`, '',
        `最近作答：${t.lastAttemptAt || '尚未测量'}。`, '',
        '统计关联到这一个主题的证据，不代表所属整章已掌握，也不代表完整考纲覆盖。', '',
        '## 课程知识与相关主题', '',
        ...relatedNotes.map(n => `- related → [[${n.path.slice(0, -3)}|${n.title}]]（标题匹配的关联候选）`),
        ...t.relatedTopicIds.map(id => `- related → [[${requireId(id)}.generated]]`),
        ...(relatedNotes.length || t.relatedTopicIds.length ? [] : ['暂无已经对应的课程条目，后续课程入库后重新匹配。']), '',
        '## 作答证据', '', ...table(relevant), '', '[[../00-错题本.generated|返回错题本]]', ''].join('\n'));
    }
    for (const [rel, content] of generated) {
      const path = await boundedPath(this.vaultRoot, rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    }
    return result;
  }
}
