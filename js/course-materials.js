const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
const math = node => window.renderMathInElement?.(node, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }], throwOnError: false, trust: false });
export function renderMaterialText(target, text) {
  target.replaceChildren();
  const lines = text.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  let paragraph = [], table = null;
  const plain = s => s.replace(/\[([^\]]+)\]\((?:<[^>]*>|[^)]*)\)/g, '$1').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a);
  const flush = () => { if (paragraph.length) target.append(el('p', plain(paragraph.join(' ')))); paragraph = []; };
  for (const line of lines) {
    if (line.startsWith('|')) {
      flush(); if (/^\|[\s:|\-]+\|$/.test(line)) continue;
      if (!table) { const wrap = el('div', undefined, 'material-table'); table = el('table'); wrap.append(table); target.append(wrap); }
      const tr = el('tr'); for (const value of line.split('|').slice(1, -1)) tr.append(el('td', plain(value.trim()))); table.append(tr); continue;
    }
    table = null;
    if (!line.trim()) { flush(); continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) { flush(); target.append(el(heading[1].length === 1 ? 'h2' : 'h3', heading[2])); }
    else if (/^[-*]\s|^\d+\.\s/.test(line)) { flush(); target.append(el('p', plain(line))); }
    else paragraph.push(line);
  }
  flush(); math(target);
}
export function mountCourseMaterials({ getState, api, toast, openCourse, openItem, loadVideo }) {
  const nav = el('div', undefined, 'course-materials-nav'); nav.id = 'course-materials-nav'; nav.hidden = true;
  const select = el('select'); select.id = 'materials-course'; select.setAttribute('aria-label', '经典力学课程');
  const label = el('label', '课程视频'); label.htmlFor = select.id;
  const load = el('button', '重新载入视频'); load.id = 'materials-video'; load.type = 'button'; load.hidden = true;
  const message = el('p'); message.id = 'materials-status'; message.setAttribute('role', 'status');
  nav.append(label, select, load, message);
  const manual = document.querySelector('label[for="video-input"]'); manual.before(nav);
  const panel = el('section', undefined, 'course-materials-panel'); panel.id = 'course-materials-panel'; panel.hidden = true;
  document.querySelector('#course-map .shortcut-reference').before(panel);
  const dialog = el('dialog', undefined, 'materials-reader'); dialog.id = 'materials-reader';
  const head = el('header'), title = el('h2'), close = el('button', '返回课程'); close.type = 'button';
  const body = el('article'); body.id = 'materials-reader-body'; head.append(title, close); dialog.append(head, body); document.body.append(dialog);
  close.addEventListener('click', () => dialog.close());
  let epoch = 0, list = [];
  const action = fn => async () => { try { await fn(); } catch (e) { message.textContent = e.message; toast(e.message, 'error'); } };
  const button = (text, fn) => { const b = el('button', text); b.type = 'button'; b.addEventListener('click', action(fn)); return b; };
  async function read(asset) {
    const record = await api(`materials/text?id=${encodeURIComponent(asset.id)}`);
    title.textContent = record.title;
    if (asset.type === '.srt' || asset.type === '.txt') { body.replaceChildren(el('pre', record.text)); }
    else renderMaterialText(body, record.text);
    dialog.showModal();
  }
  select.addEventListener('change', action(async () => {
    if (!select.value) return;
    select.disabled = true;
    try { await openCourse(select.value); }
    finally { select.disabled = false; select.value = list.some(c => c.lessonId === getState().lessonId) ? getState().lessonId : ''; }
  }));
  async function prepareVideo(id, turn) {
    load.hidden = true; message.textContent = '笔记已打开，正在载入视频…';
    try {
      const video = await api('materials/video', { lessonId: id });
      if (turn !== epoch || id !== getState().lessonId) return;
      await loadVideo(video); message.textContent = '视频已就绪';
    } catch (e) {
      if (turn !== epoch || id !== getState().lessonId) return;
      load.hidden = false; message.textContent = `视频未载入：${e.message}`;
    }
  }
  load.addEventListener('click', action(() => prepareVideo(getState().lessonId, epoch)));
  async function refresh() {
    const turn = ++epoch, id = getState().lessonId;
    panel.hidden = true; panel.dataset.lessonId = '';
    try {
      if (!list.length) list = await api('materials');
      if (turn !== epoch || id !== getState().lessonId) return;
      nav.hidden = list.length === 0;
      if (list.length) {
        manual.textContent = '其他本地视频';
        select.replaceChildren(...list.map(c => new Option(`${String(c.number).padStart(2, '0')} · ${c.title}`, c.lessonId)));
        if (!list.some(c => c.lessonId === id)) select.prepend(new Option('选择 MIT 8.01 课程', ''));
        select.value = list.some(c => c.lessonId === id) ? id : '';
      }
      load.hidden = true;
      const record = await api(`materials/course?lessonId=${encodeURIComponent(id)}`);
      if (turn !== epoch || id !== getState().lessonId) return;
      panel.hidden = !record;
      if (!record) { message.textContent = '选择讲次，笔记与视频一起切换'; return; }
      panel.dataset.lessonId = id;
      panel.replaceChildren(el('h3', '本讲资料'));
      const documents = el('div', undefined, 'material-actions');
      for (const asset of record.assets) {
        if (asset.type === '.pdf') { const a = el('a', asset.title); a.href = asset.url; a.target = '_blank'; a.rel = 'noopener'; documents.append(a); }
        else documents.append(button(asset.title, () => read(asset)));
      }
      panel.append(documents);
      const work = el('details'), ws = el('summary', '配套作业'); work.append(ws);
      work.append(el('p', '按原作业首页的授课安排关联；题目可能回练前面内容。只引用教材题号的条目仍待补题面。'));
      for (const pset of record.psets) work.append(button(`PSET ${pset.number} · 打开手写作业`, () => openItem(pset.id)));
      work.append(button('作业目录（从 PSET 1 打开）', () => openItem('mit-801-fall1999-pset-01-sheet')));
      const timeline = el('details'); timeline.append(el('summary', '原版视频主题目录（时间待对齐）'));
      const entries = el('ol');
      for (const t of record.timeline) entries.append(el('li', `${Math.floor(t.seconds / 60).toString().padStart(2, '0')}:${(t.seconds % 60).toString().padStart(2, '0')}　${t.zh}`));
      timeline.append(entries); panel.append(work, timeline);
      await prepareVideo(id, turn);
    } catch (e) { if (turn === epoch) { nav.hidden = false; message.textContent = `课程资料读取失败：${e.message}`; } }
  }
  return { refresh };
}
