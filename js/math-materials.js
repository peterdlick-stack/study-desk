// A local reader for the existing authored notes. Dynamic content is always text, never HTML.
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
function inline(node, text) {
  const chunks = text.split(/(\*\*[^*]+\*\*)/g);
  for (const s of chunks) node.append(s.startsWith('**') && s.endsWith('**') ? el('strong', s.slice(2, -2)) : document.createTextNode(s));
}
export function renderMaterialMarkdown(target, markdown, math) {
  const lines = markdown.replace(/\r/g, '').split('\n');
  target.replaceChildren();
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^> \[!example\]-/.test(line)) {
      const details = el('details', undefined, 'math-materials-example');
      details.append(el('summary', line.replace(/^> \[!example\]-\s*/, '')));
      const body = el('div'); details.append(body); const quoted = []; i++;
      while (i < lines.length && /^>/.test(lines[i])) quoted.push(lines[i++].replace(/^> ?/, ''));
      renderMaterialMarkdown(body, quoted.join('\n'), math); target.append(details); continue;
    }
    if (/^#{1,3} /.test(line)) { const m = /^(#{1,3}) (.*)/.exec(line); const h = el(`h${Math.min(4, m[1].length + 1)}`); inline(h, m[2]); target.append(h); i++; continue; }
    if (line.startsWith('|')) {
      const wrap = el('div', undefined, 'math-materials-table-wrap'), table = el('table'); wrap.append(table);
      let first = true;
      while (i < lines.length && lines[i].startsWith('|')) {
        const row = lines[i++]; if (/^\|[\s:|-]+\|$/.test(row)) continue;
        const tr = el('tr'); for (const cell of row.slice(1, -1).split('|')) { const td = el(first ? 'th' : 'td'); inline(td, cell.trim()); tr.append(td); }
        table.append(tr); first = false;
      }
      target.append(wrap); continue;
    }
    if (line.startsWith('- ')) {
      const ul = el('ul'); while (i < lines.length && lines[i].startsWith('- ')) { const li = el('li'); inline(li, lines[i++].slice(2)); ul.append(li); } target.append(ul); continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3} |\||- |> \[!example\]-)/.test(lines[i])) paragraph.push(lines[i++]);
    const p = el('p'); inline(p, paragraph.join('\n')); target.append(p);
  }
  math(target);
}

export function mountMathMaterials({ host, api, math, fail, session, selectedTopic }) {
  const launch = el('button', '数学物料 · 方法笔记与原题定位', 'math-materials-launch'); launch.type = 'button'; launch.id = 'math-materials-open'; host.append(launch);
  const dialog = el('dialog', undefined, 'math-materials-dialog'); dialog.id = 'math-materials-dialog';
  dialog.setAttribute('aria-labelledby', 'math-materials-title');
  dialog.innerHTML = `<header class="math-materials-header"><div><h2 id="math-materials-title">数学物料</h2><p>按题查方法，按页找原题</p></div><button type="button" id="math-materials-close">返回练习</button></header><p id="math-materials-context" class="practice-muted"></p><div class="math-materials-layout"><aside><label for="math-materials-search">查找专题或题型</label><input id="math-materials-search" type="search" placeholder="例如：泰勒、格林、换元"><div id="math-materials-list"></div></aside><section class="math-materials-reader" id="math-materials-reader" aria-label="数学材料阅读区"><p>选择专题后打开方法笔记，或定位原讲义。</p></section></div><p id="math-materials-status" role="status"></p>`;
  document.body.append(dialog);
  const $ = id => dialog.querySelector(`#${id}`);
  let index = null, epoch = 0, pdfUrl = null, opener;
  const button = (text, fn) => { const b = el('button', text); b.type = 'button'; b.addEventListener('click', async () => { b.disabled = true; try { await fn(); } catch (e) { $('math-materials-status').textContent = e.message; fail(e); } finally { b.disabled = false; } }); return b; };
  const context = () => session();
  function clearReader() { epoch++; $('math-materials-reader').replaceChildren(); if (pdfUrl) { URL.revokeObjectURL(pdfUrl); pdfUrl = null; } }
  function close() { if (dialog.open) dialog.close(); }
  dialog.addEventListener('close', () => { clearReader(); opener?.focus(); });
  $('math-materials-close').addEventListener('click', close);
  function payload(extra) { return { ...extra, ...(context()?.id ? { sessionId: context().id } : {}) }; }
  function permissionLabel(kind) { return context()?.mode === 'independent' ? `查看${kind}并记为有帮助` : `查看${kind}`; }
  async function showNote(id) {
    clearReader(); const request = epoch;
    $('math-materials-status').textContent = '正在打开笔记…';
    const note = await api('math-materials/note', payload({ id }));
    if (request !== epoch || !dialog.open) return;
    renderMaterialMarkdown($('math-materials-reader'), note.markdown, math);
    $('math-materials-reader').scrollTop = 0;
    $('math-materials-status').textContent = '方法草稿 · 已记录相关练习的帮助查看；新编示例可按需展开。';
  }
  async function showPdf(page) {
    clearReader(); const request = epoch;
    $('math-materials-status').textContent = '正在打开本地讲义…';
    const response = await fetch('/api/math-materials/pdf', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Study-Desk': '1' }, body: JSON.stringify(payload({ page })) });
    if (!response.ok) { const error = await response.json(); throw new Error(error.error || '讲义打开失败'); }
    const blob = await response.blob(); if (request !== epoch || !dialog.open) return;
    pdfUrl = URL.createObjectURL(blob);
    const link = el('a', `在新标签打开原讲义（PDF 第 ${page} 页）`); link.href = `${pdfUrl}#page=${page}`; link.target = '_blank'; link.rel = 'noopener';
    const iframe = el('iframe'); iframe.title = `夜雨讲义 PDF 第 ${page} 页`; iframe.src = `${pdfUrl}#page=${page}&view=FitH`; iframe.className = 'math-materials-pdf';
    $('math-materials-reader').append(link, iframe);
    $('math-materials-status').textContent = `原讲义 · PDF 第 ${page} 页${page > 10 ? `，印刷第 ${page - 10} 页` : ''}。若阅读器未跳页，输入该 PDF 页码。`;
  }
  function renderList() {
    if (!index) return;
    const q = $('math-materials-search').value.trim().toLowerCase(), list = $('math-materials-list'); list.replaceChildren();
    const entries = [...index.chapters, index.repair];
    const topicId = selectedTopic();
    entries.sort((a,b) => Number(b.trainingTopicIds.includes(topicId)) - Number(a.trainingTopicIds.includes(topicId)));
    for (const chapter of entries) {
      const all = index.topics.filter(t => t.chapterId === chapter.id);
      const matched = all.filter(t => t.title.toLowerCase().includes(q));
      if (q && !chapter.title.toLowerCase().includes(q) && !matched.length) continue;
      const card = el('article', undefined, 'math-materials-chapter'); card.dataset.materialId = chapter.id;
      card.append(el('h3', chapter.title + (chapter.trainingTopicIds.includes(topicId) ? ' · 当前题型' : '')));
      if (chapter.pdfStart) card.append(el('p', `印刷 ${chapter.printedStart}–${chapter.printedEnd} 页 · PDF ${chapter.pdfStart}–${chapter.pdfEnd} 页`, 'practice-muted'));
      card.append(button(permissionLabel('笔记'), () => showNote(chapter.id)));
      if (chapter.pdfStart) card.append(button(permissionLabel('原讲义'), () => showPdf(chapter.pdfStart)));
      if (all.length) {
        const details = el('details'); details.open = Boolean(q);
        const shown = q && !chapter.title.toLowerCase().includes(q) ? matched : all;
        details.append(el('summary', `题型定位 · ${shown.length}`));
        for (const t of shown) { const b = button(`${t.title} · 印刷 ${t.printedPage} 页`, () => showPdf(t.pdfPage)); b.dataset.locatorId = t.id; details.append(b); }
        card.append(details);
      }
      list.append(card);
    }
    if (!list.children.length) list.append(el('p', '没有匹配的题型，试试“极限”“积分”或“级数”。'));
  }
  launch.addEventListener('click', async () => {
    opener = document.activeElement; clearReader(); $('math-materials-search').value = ''; $('math-materials-list').replaceChildren();
    $('math-materials-reader').append(el('p', '先选专题，再按需要查看笔记或原题。示例保持折叠。'));
    $('math-materials-context').textContent = context()?.mode === 'independent' ? '当前为独立检测。目录可查；打开笔记或讲义会记录帮助，本组后续作答不再计为无帮助的独立首答。' : '专题笔记与原题在此查阅，关闭后继续当前作答。打开资料会记录相关练习的帮助查看。';
    $('math-materials-status').textContent = '正在读取目录…'; dialog.showModal();
    const request = epoch;
    try { index = await api('math-materials'); if (request !== epoch || !dialog.open) return; renderList(); $('math-materials-status').textContent = `${index.chapters.length} 个专题 · ${index.topics.length} 个题型定位 · 1 份错因修补表`; }
    catch (e) { $('math-materials-status').textContent = `材料目录读取失败：${e.message}`; }
  });
  $('math-materials-search').addEventListener('input', renderList);
  return { close };
}
