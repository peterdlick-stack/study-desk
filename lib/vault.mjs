import { readFile, mkdir, readdir, writeFile, appendFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { boundedPath, sha } from './store.mjs';
import { requireId, validateSnapshot } from '../js/library.js';
import { canvasSvg } from './canvas-svg.mjs';

export const eventHeader = 'event_id,recorded_at,kind,supersedes_id,payload_json';
export function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(field); field = ''; }
    else if (c === '\n' && !quoted) { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const headers = (rows.shift() || []).map(s => s.replace(/^\uFEFF/, ''));
  return rows.filter(r => r.some(Boolean)).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}
const csvField = s => `"${String(s).replaceAll('"', '""')}"`;
const md = s => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const dateLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export class VaultBridge {
  constructor(root, baseUrl = 'http://127.0.0.1:4173') { this.root = root; this.baseUrl = baseUrl; this.previews = new Map(); }
  async csv(name) {
    try { return parseCsv(await readFile(await boundedPath(this.root, '考研', '数据', name), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  async configuration() {
    return { vaultRoot: this.root, entryDirectory: '学习/课程知识', subjects: await this.csv('subjects.csv'), units: await this.csv('units.csv') };
  }
  async previewArchive(snapshot, entryId) {
    const state = validateSnapshot(snapshot), entry = state.entries.find(e => e.id === entryId);
    if (!entry || entry.status !== 'ready') throw new Error('请先将条目整理为“可入库”');
    if (!entry.title.trim() || !entry.personalText.trim()) throw new Error('正式条目需要标题和个人理解');
    if (state.course.demo) throw new Error('演示内容不能作为正式学习记录入库');
    if (entry.relatedPath) await this.readEntry(entry.relatedPath);
    const source = state.studyBundle?.source || { transcriptName: state.course.transcriptName };
    const selected = state.canvasObjects.filter(o => entry.attachmentIds.includes(o.id));
    const payload = { formatVersion: 1, baseUrl: this.baseUrl, entry, lessonId: state.lessonId, title: state.course.title, source, selected };
    const revision = sha(JSON.stringify(payload));
    const directory = `学习/课程知识/${requireId(entry.id)}`;
    const titleName = entry.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '').slice(0, 40) || '知识条目';
    const path = `${directory}/${titleName}--${revision}.md`;
    const files = [];
    const attachments = [];
    for (const object of selected) {
      if (object.image) {
        const match = /^data:image\/(jpeg|png);base64,(.+)$/.exec(object.image);
        const bytes = Buffer.from(match[2], 'base64');
        const name = `${sha(bytes)}.${match[1] === 'jpeg' ? 'jpg' : 'png'}`;
        files.push({ path: `${directory}/${name}`, bytes });
        attachments.push(`![课程截图 ${object.time ?? entry.time} 秒](./${name})`);
      } else attachments.push(`- 画布 ${md(object.type)}，时间 ${object.time ?? entry.time} 秒；完整笔迹见画布附件。`);
    }
    if (selected.length) {
      const name = `${revision}.canvas.json`;
      files.push({ path: `${directory}/${name}`, bytes: Buffer.from(JSON.stringify(selected, null, 2)) });
      attachments.push(`[完整画布对象](./${name})`);
      const svgName = `${revision}.canvas.svg`;
      files.push({ path: `${directory}/${svgName}`, bytes: Buffer.from(canvasSvg(selected)) });
      attachments.push(`![个人画布](./${svgName})`);
    }
    const link = `${this.baseUrl}/?lesson=${encodeURIComponent(state.lessonId)}&entry=${encodeURIComponent(entry.id)}&time=${entry.time}`;
    const text = `---\ntype: knowledge\ndomain: study\nsource_kind: study-desk\nrelations_reviewed: false\nstudy_entry_id: ${entry.id}\nstudy_lesson_id: ${state.lessonId}\nsource_item_id: ${JSON.stringify(entry.sourceItemId)}\nstudy_time: ${entry.time}\nrevision: ${revision}\nstatus: ready\nevidence_state: ${entry.reviewStatus}\nmastery_state: UNKNOWN\ncreated: ${entry.createdAt.slice(0, 10)}\nsource_ref: ${JSON.stringify(link)}\naliases: ${JSON.stringify(entry.aliases.split(/[，,]/).map(x => x.trim()).filter(Boolean))}\n---\n\n# ${md(entry.title)}\n\n## 来源\n\n${md(state.course.title)} · ${entry.time} 秒 · [回到学习台](${link})\n\n来源标识：\n\n\`\`\`json\n${JSON.stringify(source, null, 2)}\n\`\`\`\n\n## 课程草稿（保留原文）\n\n${md(entry.originalText) || '此条目来自个人随手记录。'}\n\n## 我的理解\n\n${md(entry.personalText)}\n\n## 内容复核\n\n状态：${entry.reviewStatus}\n\n依据：${md(entry.reviewBasis) || '未提供'}\n\n内容核验不代表掌握；独立练习与复测另记。\n\n## 关系\n\n${entry.relatedPath ? `关联已有条目：[打开](${encodeURI('../../../' + entry.relatedPath)})；本文件作为补充草稿，未覆盖原笔记。` : '待后续使用时补充。'}\n\n## 附件\n\n${attachments.join('\n\n') || '无'}\n\n## 修订记录\n\n\`\`\`json\n${JSON.stringify(entry.history, null, 2)}\n\`\`\`\n`;
    files.push({ path, bytes: Buffer.from(text) });
    const existing = [];
    for (const file of files) {
      try {
        const bytes = await readFile(await boundedPath(this.root, file.path));
        if (!bytes.equals(file.bytes)) throw new Error('目标文件已有不同内容，已停止；请检查人工修改');
        existing.push(file.path);
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const token = sha(JSON.stringify(files.map(f => [f.path, sha(f.bytes)])));
    this.previews.set(token, { files, path });
    if (this.previews.size > 100) this.previews.delete(this.previews.keys().next().value);
    return { token, path, text, files: files.map(f => f.path), unchanged: existing.length === files.length,
      note: '确认后保存此修订；已有笔记和先前修订均保留。相同内容重复确认不会新增文件。' };
  }
  async commitArchive(token) {
    const plan = this.previews.get(token);
    if (!plan) throw new Error('预览已失效，请重新预览');
    // Preflight all destinations again. Markdown is written last, so partial attachment writes are retryable.
    for (const file of plan.files) {
      const dest = await boundedPath(this.root, file.path);
      try { if (!(await readFile(dest)).equals(file.bytes)) throw new Error('预览后目标内容发生变化，停止写入'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    for (const file of plan.files) {
      const dest = await boundedPath(this.root, file.path);
      await mkdir(join(dest, '..'), { recursive: true });
      try { await writeFile(dest, file.bytes, { flag: 'wx' }); }
      catch (e) { if (e.code !== 'EEXIST' || !(await readFile(dest)).equals(file.bytes)) throw e; }
    }
    return { path: plan.path, files: plan.files.map(f => f.path) };
  }
  async search(query) {
    const hits = [];
    const walk = async rel => {
      const path = await boundedPath(this.root, rel);
      let children;
      try { children = await readdir(path, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
      for (const child of children) {
        if (child.isSymbolicLink()) continue;
        const next = `${rel}/${child.name}`;
        if (child.isDirectory()) await walk(next);
        else if (child.name.endsWith('.md')) {
          const text = await readFile(await boundedPath(this.root, next), 'utf8');
          if (query && !text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
          const entryId = /^study_entry_id: (.+)$/m.exec(text)?.[1];
          const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
          const personal = /## 我的理解\s*\n([\s\S]*?)(?:\n## |$)/.exec(body)?.[1];
          const excerptStart = Math.max(0, body.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) - 40);
          hits.push({ path: next, title: /^# (.+)$/m.exec(text)?.[1] || child.name,
            entryId, lessonId: /^study_lesson_id: (.+)$/m.exec(text)?.[1],
            time: Number(/^study_time: (.+)$/m.exec(text)?.[1] || 0),
            excerpt: (personal || body.slice(excerptStart, excerptStart + 220)).trim().slice(0, 220) });
        }
      }
    };
    // Deliberately excludes exam papers, external media and unrelated vault domains.
    await walk('学习/课程知识');
    await walk('学习/考研学习');
    return hits.slice(0, 100);
  }
  async readEntry(path) {
    const match = /^学习\/(课程知识|考研学习)\/(.+\.md)$/.exec(path);
    if (!match) throw new Error('只允许打开已登记的学习笔记');
    const allowedRoot = await boundedPath(this.root, '学习', match[1]);
    return { path, text: await readFile(await boundedPath(allowedRoot, match[2]), 'utf8') };
  }
  async records() {
    const effective = new Map();
    for (const [kind, file] of [['attempt', 'attempts.csv'], ['session', 'study_sessions.csv']]) {
      (await this.csv(file)).forEach((payload, index) => effective.set(`legacy-${kind}-${index + 1}`, { id: `legacy-${kind}-${index + 1}`, kind, payload }));
    }
    const events = await this.csv('study_desk_events.csv');
    const ids = new Set();
    for (const event of events) {
      if (ids.has(event.event_id)) throw new Error('学习事件标识重复');
      ids.add(event.event_id);
      if (event.supersedes_id) {
        const target = effective.get(event.supersedes_id);
        if (!target || target.kind !== event.kind) throw new Error('更正引用了缺失、已更正或不同类型的记录');
        effective.delete(event.supersedes_id);
      }
      effective.set(event.event_id, { id: event.event_id, kind: event.kind, payload: JSON.parse(event.payload_json) });
    }
    return [...effective.values()];
  }
  async validateRecord(event) {
    requireId(event.id);
    if (!['session', 'attempt'].includes(event.kind)) throw new Error('记录类型无效');
    const p = event.payload;
    if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(p.date) || !Number.isFinite(Date.parse(p.date)) || new Date(p.date).toISOString().slice(0, 10) !== p.date || p.date > dateLocal()) throw new Error('请填写有效的实际发生日期');
    const units = await this.csv('units.csv');
    if (!units.some(u => u.unit_id === p.unit_id && u.subject_id === p.subject_id)) throw new Error('请选择已登记且科目匹配的知识单元');
    if (event.kind === 'session') {
      if (p.effective_minutes !== '' && (!Number.isFinite(Number(p.effective_minutes)) || Number(p.effective_minutes) < 0 || Number(p.effective_minutes) > 1440)) throw new Error('有效分钟数无效，未知请留空');
      if (!p.output?.trim()) throw new Error('请记录实际产物');
    } else {
      for (const key of ['first_seen', 'closed_book', 'timed', 'guessed']) if (!['true', 'false'].includes(p[key])) throw new Error(`请明确选择 ${key}`);
      if (!p.item_id?.trim() || !p.source?.trim()) throw new Error('练习需要题目标识和来源');
      if (!['independent', 'timed_mixed', 'delayed_retest'].includes(p.evidence_kind)) throw new Error('日常入口不登记隔离卷或节点测试');
      if (!['correct', 'wrong', 'timeout', 'source_issue'].includes(p.result)) throw new Error('请选择实际结果');
      if (!['UNKNOWN', 'verified', 'disputed'].includes(p.source_quality)) throw new Error('题源状态无效');
      if (p.isolated_test !== 'false') throw new Error('此入口不接受隔离卷记录');
      if (p.purpose === 'correction') throw new Error('更正请使用“更正已有记录”入口');
      if (p.duration_min !== '' && (!Number.isFinite(Number(p.duration_min)) || Number(p.duration_min) < 0)) throw new Error('耗时无效');
    }
    const effective = await this.records();
    if (event.supersedesId && !effective.some(r => r.id === event.supersedesId && r.kind === event.kind)) throw new Error('被更正记录已变化，请重新选择');
    if (event.kind === 'attempt' && p.first_seen === 'true' && effective.some(r => r.kind === 'attempt' && r.id !== event.supersedesId && r.payload.item_id === p.item_id && r.payload.first_seen === 'true')) throw new Error('同一题已经记录为首次见，请保持原题目标识并标记重复练习');
  }
  async appendRecord(event) {
    const existing = (await this.csv('study_desk_events.csv')).find(e => e.event_id === event.id);
    if (existing) {
      if (existing.kind !== event.kind || existing.supersedes_id !== (event.supersedesId || '') || existing.payload_json !== JSON.stringify(event.payload)) throw new Error('同一事件标识具有不同内容');
      return { id: event.id, unchanged: true };
    }
    await this.validateRecord(event);
    const path = await boundedPath(this.root, '考研', '数据', 'study_desk_events.csv');
    await mkdir(join(path, '..'), { recursive: true });
    try { await writeFile(path, eventHeader + '\n', { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const line = [event.id, new Date().toISOString(), event.kind, event.supersedesId || '', JSON.stringify(event.payload)].map(csvField).join(',') + '\n';
    await appendFile(path, line, 'utf8');
    return { id: event.id, unchanged: false };
  }
}
