// The training panel reuses the existing per-question handwriting workspace.
import { mountMathMaterials } from './math-materials.js';
export function mountTopicTraining({ host, api, onOpen, onSelect, getTopics, math, fail, launchScreen, onMethod = () => {}, onStart = () => {} }) {
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  const run = fn => async e => { e?.preventDefault(); try { await fn(); } catch (err) { fail(err); } };
  const panel = el('section', undefined, 'training-panel'); panel.id = 'training-panel'; panel.hidden = true;
  panel.innerHTML = `<h1>按题型开始</h1><p>不用先导入课程。先看方法，逐题手写，批改后看整组错因。</p><form id="training-form"><label>章节<select id="training-chapter"><option value="">全部章节</option></select></label><label>题型<select id="training-topic"></select></label><p id="training-coverage" class="practice-muted"></p><div class="practice-condition-grid"><label><span id="training-count-label">本组题数</span><select id="training-count">${[5,6,7,8,9,10].map(n => `<option value="${n}">${n} 道</option>`).join('')}</select></label><label>练习方式<select id="training-mode"><option value="guided">方法练习</option><option value="independent">独立检测</option></select></label></div><label class="training-check"><input type="checkbox" id="training-seen">方法练习允许复习已提交题（另记重复）</label><button id="training-create" type="submit" class="primary-button">开始这一组</button><p id="training-status" role="status"></p></form><details><summary>继续以前的训练</summary><div id="training-history"></div></details><section id="training-method"></section><div id="training-progress" aria-live="polite"></div>`;
  host.prepend(panel);
  const $ = id => panel.querySelector(`#${id}`);
  let options = [], current = null, active = false, working = false;
  const materialHost = el('div'); $('training-form').after(materialHost);
  const materials = mountMathMaterials({ host: materialHost, api, math, fail,
    session: () => current, selectedTopic: () => current?.topicId || $('training-topic').value });
  const sessionKey = 'study-desk-last-training';
  const label = value => value === 'independent' ? '独立检测' : '方法练习';
  const button = (text, fn) => { const b = el('button', text); b.type = 'button'; b.addEventListener('click', run(fn)); return b; };
  const pageMode = () => options.find(o => o.id === $('training-topic').value)?.itemMode === 'pages';
  const sessionUnit = s => s?.itemMode === 'pages' ? '页' : '题';
  function coverage() {
    const t = options.find(o => o.id === $('training-topic').value), pages = pageMode();
    const independent = $('training-mode').querySelector('option[value="independent"]');
    independent.disabled = pages;
    if (pages) $('training-mode').value = 'guided';
    const mode = $('training-mode').value;
    $('training-seen').disabled = mode === 'independent'; if (mode === 'independent') $('training-seen').checked = false;
    const n = t ? ($('training-seen').checked ? t.total : t.unseen) : 0, min = pages ? 1 : 5;
    const previous = Number($('training-count').value);
    $('training-count').replaceChildren();
    for (let i=min; i<=10; i++) { const o = new Option(`${i} ${pages ? '页' : '道'}`, String(i)); o.disabled = i>n; $('training-count').add(o); }
    $('training-count').value = String(previous>=min && previous<=n ? previous : min);
    $('training-count-label').textContent = pages ? '本组讲义页数' : '本组题数';
    $('training-create').disabled = working || n < min;
    $('training-create').textContent = pages ? '开始按页练习' : '开始这一组';
    $('training-coverage').textContent = !t ? '当前章节暂无题型。' : pages
      ? `${t.total} 页原讲义，${t.unseen} 页尚未提交。${t.source}。请在作答中标明页内所做题目；整页练习不计独立题掌握。`
      : `${t.total} 道已收录，${t.unseen} 道尚未提交。${t.source}。`;
    if (t && n < min) $('training-coverage').textContent += ` 当前可用不足 ${min} ${pages ? '页' : '道题'}，可在方法练习中明确选择复习旧题。`;
  }
  function renderTypes(previous = $('training-topic').value) {
    const chapter = $('training-chapter').value, picker = $('training-topic'); picker.replaceChildren();
    const groups = new Map();
    for (const t of options.filter(t => !chapter || (t.chapterTitle || '已拆分单题') === chapter)) {
      const title = t.chapterTitle || '已拆分单题';
      if (!groups.has(title)) { const group = el('optgroup'); group.label = title; groups.set(title,group); picker.append(group); }
      groups.get(title).append(new Option(t.title + (t.itemMode === 'pages' ? '〔按页〕' : ''), t.id));
    }
    if ([...picker.options].some(o => o.value === previous)) picker.value = previous;
    coverage();
  }
  async function load() {
    const [types, sessions] = await Promise.all([api('training/options'), api('training/sessions')]); options = types;
    const chapter = $('training-chapter').value, chapterPicker = $('training-chapter');
    chapterPicker.replaceChildren(new Option('全部章节',''));
    for (const title of new Set(options.map(t => t.chapterTitle || '已拆分单题'))) chapterPicker.add(new Option(title,title));
    if ([...chapterPicker.options].some(o=>o.value===chapter)) chapterPicker.value=chapter;
    renderTypes(); const h = $('training-history'); h.replaceChildren();
    for (const s of sessions) h.append(button(`${s.title} · ${s.itemIds.length} ${sessionUnit(s)} · ${label(s.mode)} · ${new Date(s.createdAt).toLocaleDateString()}`, () => { launchScreen?.(); return open(s); }));
    if (!sessions.length) h.textContent = '尚未创建训练组。';
    return sessions;
  }
  async function revealMethod() {
    if (!current) return;
    const id = current.id;
    const method = await api('training/method', { id });
    if (current.id !== id) return;
    const box = $('training-method'); box.replaceChildren(el('h2', '这类题怎么做'));
    box.append(el('p', `先备知识：${method.prerequisites || '见下方方法说明'}`, 'practice-muted'));
    const details = el('details'); details.open = true; details.append(el('summary', '方法卡（可收起后作答）'));
    const text = el('div', method.method, 'training-method-text'); details.append(text); math(text);
    if (method.example) { const example = el('div', method.example, 'training-example'); details.append(example); math(example); }
    details.append(el('p', method.source || '', 'practice-source-ref')); box.append(details);
    box.append(button('收起方法，开始做题', async () => { details.open = false; onStart(); }));
    box.append(el('p', '已记录方法查看。本组后续首答属于有帮助的练习，不会伪装为独立检测。', 'practice-muted'));
    onMethod({ prerequisites: method.prerequisites, method: method.method, example: method.example, source: method.source }, id);
  }
  async function open(s, itemId, attemptId) {
    materials.close();
    await onOpen(s, itemId, attemptId); current = s;
    const selected = options.find(t=>t.id===s.topicId);
    if (selected) { $('training-chapter').value=selected.chapterTitle || '已拆分单题'; renderTypes(s.topicId); }
    $('training-mode').value=s.mode; $('training-seen').checked=s.includeSeen; coverage();
    try { localStorage.setItem(sessionKey, s.id); } catch {}
    const box = $('training-method'); box.replaceChildren();
    if (s.mode === 'guided') await revealMethod();
    else box.append(el('p', '独立检测：方法和例题默认隐藏。卡住时可以打开，但后续作答会记录帮助。'), button('查看方法并记为有帮助', revealMethod));
    await refresh();
  }
  async function activate(id, itemId, attemptId) {
    active = true; panel.hidden = false;
    const sessions = await load();
    if (!id && !current) { try { id = localStorage.getItem(sessionKey); } catch {} }
    const s = sessions.find(s => s.id === id) || (!id ? current : null);
    if (id && !s) throw new Error('指定的训练组不存在');
    if (s) await open(s, itemId, attemptId);
  }
  async function refresh() {
    if (!current || !active) return;
    const report = await api(`training/report?id=${encodeURIComponent(current.id)}`);
    $('training-progress').textContent = `${current.title} · ${label(current.mode)} · 已提交 ${report.submitted}/${report.total} · 待处理 ${report.pending}${current.itemMode === 'pages' ? ' · 按讲义页练习' : ''}`;
    return report;
  }
  async function renderReport(target) {
    target.replaceChildren(el('h2', '本组复盘'));
    if (!current) { target.append(el('p', '从左侧选择题型，开始单题训练或按讲义页练习。')); return; }
    target.append(el('p', '正在读取本组首答…'));
    try {
      const report = await refresh(); if (!report || !target.isConnected) return;
      target.replaceChildren(el('h2', `${current.title} · 本组复盘`));
      const fmt = r => r.value == null ? 'UNKNOWN（暂无可判定样本）' : `${r.correct}/${r.total} = ${Math.round(r.value * 100)}%`;
      target.append(el('p', `${current.itemMode === 'pages' ? '页练习首答正确率' : '首答正确率'}　${fmt(report.accuracy)}`, 'training-stat'), el('p', `独立首答正确率　${fmt(report.independentAccuracy)}`, 'training-stat'));
      target.append(el('p', `未提交 ${report.unsubmitted} · 待处理 ${report.pending} · 错误 ${report.wrong} · 未作答 ${report.unanswered} · 有帮助 ${report.assisted} · 含猜测 ${report.guessed}`, 'practice-muted'));
      target.append(el('p', report.note, 'practice-muted'), el('h3', '下一步'), el('p', report.nextStep));
      if (report.errorGroups.length) {
        target.append(el('h3', '错因分布'));
        for (const group of report.errorGroups) target.append(el('p', `${group.category} · ${group.count} 题。${group.repair}`));
        target.append(el('p', '按每题首个错误步骤的批改标签归类；未明确标注时保留待定位。', 'practice-muted'));
      }
      const topics = getTopics();
      if (report.gaps.length) target.append(el('p', '本组候选薄弱点：' + report.gaps.map(g => `${topics.find(t => t.id === g.topicId)?.title || g.topicId}（${g.count} 题）`).join('、') + '。不凭单组训练判整章不会。'));
      target.append(el('h3', current.itemMode === 'pages' ? '逐页定位' : '逐题定位'));
      const states = { correct: '正确', wrong: '错误', unanswered: '未作答', pending: '待处理', unsubmitted: '未提交' };
      report.rows.forEach((r, i) => {
        const card = el('article', undefined, 'training-result');
        card.append(button(`第 ${i + 1} ${sessionUnit(current)} · ${states[r.state]}`, () => onSelect(r.itemId, r.attemptId)));
        if (r.summary) card.append(el('p', r.summary));
        for (const error of r.errors) card.append(el('p', `作答第 ${error.page} 页：${error.comment}`));
        if (r.corrections) card.append(el('p', `订正 / 重做 ${r.corrections} 次${r.corrected ? '，已有正确订正' : ''}；首答保留。`, 'practice-muted'));
        target.append(card);
      }); math(target);
    } catch (error) { target.append(el('p', `复盘读取失败：${error.message}`)); }
  }
  $('training-form').addEventListener('submit', run(async () => {
    if (working) return; working = true; coverage(); $('training-status').textContent = '正在创建并保存训练组…';
    launchScreen?.();
    try { const s = await api('training/create', { topicId: $('training-topic').value, count: Number($('training-count').value), mode: $('training-mode').value, includeSeen: $('training-seen').checked }); await open(s); await load(); $('training-status').textContent = s.itemMode === 'pages' ? '讲义页已打开。标明页内所做题目，手写后提交批改。' : '训练组已保存，可逐题提交批改，右侧查看本组复盘。'; }
    catch (error) { $('training-status').textContent = error.message; throw error; }
    finally { working = false; coverage(); }
  }));
  $('training-chapter').addEventListener('change', () => { $('training-count').value='1'; renderTypes(''); });
  for (const id of ['training-topic', 'training-mode', 'training-seen']) $(id).addEventListener('change', coverage);
  return { activate, refresh, renderReport, panel, isActive: () => active, session: () => current,
    hide: () => { materials.close(); active = false; panel.hidden = true; }, revealMethod };
}
