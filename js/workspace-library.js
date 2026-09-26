import { createDefaultState, formatTime } from './core.js';
import { validateSnapshot, makeBackup, readBackup, newEntry, reviseEntry } from './library.js';

export async function api(path, payload) {
  const response = await fetch(`/api/${path}`, { method: payload === undefined ? 'GET' : 'POST',
    headers: { 'X-Study-Desk': '1', ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '本地服务无法完成请求');
  return result;
}
function download(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const localDate = () => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export function mountLibrary({ getState, setState, seek, toast }) {
  const subject = document.body.dataset.subject || 'physics';
  const lastLessonKey = `study-desk-last-lesson-${subject}`;
  const inSubject = course => subject === 'math' ? course.id === 'math-workspace' : course.id !== 'math-workspace';
  const dialog = document.createElement('dialog');
  dialog.id = 'library-dialog';
  dialog.innerHTML = `
    <header class="library-heading"><div><h2>课程与知识库</h2><p id="library-location">正在连接本地资料库</p></div><button id="export-course" type="button">导出当前完整备份</button><button id="library-close" type="button">返回学习</button></header>
    <nav class="library-tabs" aria-label="知识库功能">
      <button data-library-tab="courses" type="button">课程与备份</button><button data-library-tab="entries" type="button">整理记录</button>
      <button data-library-tab="search" type="button">检索与回源</button><button data-library-tab="records" type="button">学习与练习</button>
    </nav>
    <section data-library-pane="courses"><h3>已保存课程</h3><div id="course-list" class="library-list"></div>
      <div class="library-row"><input id="new-course-title" aria-label="新课程名称" placeholder="新课程名称"><button id="new-course" type="button">新建空白课程</button></div>
      <div class="library-row"><label class="file-button" for="restore-course">导入备份为独立副本</label><input id="restore-course" type="file" accept=".json" hidden></div>
      <p>备份包括笔记、批注、截图、整理记录及修订历史。原视频单独保管，重新打开时需再次选择。旧浏览器记录只迁移一次，原缓存保留。</p>
    </section>
    <section data-library-pane="entries" hidden><div class="library-row"><select id="entry-source" aria-label="记录来源"></select><button id="create-entry" type="button">加入待整理</button></div>
      <div class="library-columns"><div id="entry-list" class="library-list"></div><form id="entry-form" hidden>
        <label>标题<input id="entry-title" required></label><label>课程原文或 AI 草稿<textarea id="entry-original" readonly rows="3"></textarea></label>
        <label>我的理解、疑问或修订<textarea id="entry-personal" rows="5"></textarea></label>
        <div class="library-row"><label>整理状态<select id="entry-status"><option value="inbox">待整理</option><option value="pending">暂存待定</option><option value="ready">可入库</option></select></label>
        <label>内容复核<select id="entry-review"><option value="UNKNOWN">无法确定</option><option value="needs-review">待复核</option><option value="verified">核验通过</option></select></label></div>
        <label>核验依据<textarea id="entry-basis" rows="2" placeholder="对照了哪段视频、板书或推导；核验通过时必填"></textarea></label>
        <label>检索别名（逗号分隔）<input id="entry-aliases"></label><label>关联已有笔记<input id="entry-related" placeholder="可在检索结果中选择关联"></label>
        <fieldset><legend>附带画布记录</legend><div id="entry-attachments"></div></fieldset>
        <p id="entry-history"></p><div class="library-row"><button type="submit">保存整理</button><button id="entry-seek" type="button">回到课程位置</button><button id="archive-preview" type="button">预览入库</button><button id="entry-practice" type="button">关联练习 / 复测</button></div>
      </form></div>
      <p>内容核验与个人掌握分开记录。课程草稿保留原文，个人修改保留历史。</p>
    </section>
    <section data-library-pane="search" hidden><form id="search-form" class="library-row"><input id="library-query" aria-label="检索关键词" placeholder="标题、别名、正文或疑问" required><button type="submit">检索</button></form><div id="search-results" class="library-list"></div><pre id="entry-reader" hidden></pre></section>
    <section data-library-pane="records" hidden>
      <p>这里记录实际学习投入；练习通过“作业与错题”提交后自动批改归档。旧练习记录保留只读。有效时长未知可留空。</p>
      <div class="library-row"><select id="record-existing" aria-label="更正已有记录"><option value="">新增记录</option></select><button id="record-load" type="button">载入更正</button></div>
      <form id="record-form"><div class="library-row"><label>类型<select id="record-kind"><option value="session">学习记录</option></select></label><label>日期<input id="record-date" type="date" required></label><label>知识单元<select id="record-unit" required></select></label></div>
        <label>关联条目<input id="record-entry" readonly></label>
        <div id="session-fields"><label>有效分钟<input id="record-minutes" type="number" min="0" max="1440" placeholder="未知留空"></label><label>实际产物<textarea id="record-output" rows="2"></textarea></label></div>
        <div id="attempt-fields" hidden><div class="library-row"><label>题目标识<input id="record-item" placeholder="相同题目始终使用相同标识"></label><label>题目来源<input id="record-source" placeholder="书名、页码、题号或已授权题目路径"></label></div>
          <div class="library-row"><label>证据类型<select id="record-evidence"><option value="independent">独立练习</option><option value="timed_mixed">限时混合题</option><option value="delayed_retest">延迟复测</option></select></label><label>实际结果<select id="record-result"><option value="">请选择</option><option value="correct">正确</option><option value="wrong">错误</option><option value="timeout">超时</option><option value="source_issue">题源问题</option></select></label><label>题源核验<select id="record-quality"><option value="UNKNOWN">未知</option><option value="verified">已核验</option><option value="disputed">有争议</option></select></label></div>
          <div id="record-flags" class="library-row"></div><label>用时（分钟，未知留空）<input id="record-duration" type="number" min="0"></label><label>错因<input id="record-error"></label>
        </div><label>补充说明<textarea id="record-notes" rows="2"></textarea></label><button type="submit">预览记录</button>
      </form><h3>当前课程关联记录</h3><div id="linked-records" class="library-list"></div>
    </section>
    <section id="commit-panel" hidden><h3>确认写入内容</h3><p id="commit-description"></p><pre id="commit-preview"></pre><button id="commit-write" type="button">确认写入</button><button id="commit-cancel" type="button">取消预览</button></section>
    <p id="library-message" role="status"></p>`;
  document.body.append(dialog);
  const $ = id => dialog.querySelector(`#${id}`);
  const status = document.querySelector('#save-status');
  let revision = null, ready = false, dirty = false, saving = Promise.resolve(), editedId = '', formDirty = false;
  let preview = null, config, records = [], correcting = '', recordId = '', sources = [], epoch = 0;
  const fail = error => { $('library-message').textContent = error.message; toast(error.message, 'error'); };
  const action = fn => async event => { event?.preventDefault(); try { await fn(event); } catch (e) { fail(e); } };
  const sourceItems = () => {
    const s = getState();
    return [...s.notes, ...(s.studyBundle?.cues || []), ...(s.map?.nodes || []).map(n => ({ ...n, title: n.label, summary: n.label })),
      ...(s.map?.edges || []).map(e => ({ ...e, title: `${e.from} ${e.relation} ${e.to}`, summary: `${e.from} ${e.relation} ${e.to}`, start: s.map.nodes.find(n => n.id === e.from)?.start || 0 }))];
  };
  function message(text) { $('library-message').textContent = text; }
  function markDirty() { dirty = true; status.textContent = '未保存'; status.dataset.state = 'pending'; }
  async function save() {
    if (!ready) throw new Error('课程库尚未连接，当前内容可先导出备份');
    const snapshot = structuredClone(getState());
    const task = async () => {
      try {
        status.textContent = '正在保存';
        const result = await api('courses', { snapshot, expectedRevision: revision });
        revision = result.revision;
        dirty = JSON.stringify(getState()) !== JSON.stringify(snapshot);
        status.textContent = dirty ? '有未保存修改' : '已保存到本地';
        status.dataset.state = dirty ? 'pending' : 'saved';
        return result;
      } catch (e) { dirty = true; status.textContent = `保存失败：${e.message}（可导出备份）`; status.dataset.state = 'error'; throw e; }
    };
    saving = saving.catch(() => {}).then(task);
    return saving;
  }
  async function saveEditor() {
    if (!editedId || !formDirty) return;
    const s = getState(), entry = s.entries.find(e => e.id === editedId);
    const fields = { title: $('entry-title').value, personalText: $('entry-personal').value, status: $('entry-status').value,
      reviewStatus: $('entry-review').value, reviewBasis: $('entry-basis').value, aliases: $('entry-aliases').value,
      relatedPath: $('entry-related').value.trim(), attachmentIds: [...dialog.querySelectorAll('[data-attachment]:checked')].map(e => e.dataset.attachment) };
    s.entries = s.entries.map(e => e.id === entry.id ? reviseEntry(entry, fields) : e);
    if (s.editorDraft?.entryId === editedId) delete s.editorDraft;
    formDirty = false; markDirty(); await save(); renderEntryList();
    $('entry-history').textContent = `来源位置 ${formatTime(entry.time)} · ${getState().entries.find(e => e.id === editedId).history.length} 次修订 · 掌握状态另记`;
    message('整理已保存。课程原文保留，修订已加入历史。');
  }
  async function activate(record) {
    epoch++; revision = record.revision; editedId = ''; formDirty = false;
    setState(validateSnapshot(record.snapshot)); dirty = false; status.textContent = '已保存到本地'; status.dataset.state = 'saved';
    try { localStorage.setItem(lastLessonKey, record.snapshot.lessonId); } catch { /* Disk storage remains authoritative. */ }
    if (config) resetRecord();
    renderEntries(); await renderCourses();
  }
  async function openCourse(id) {
    await saveEditor(); await save(); await activate(await api(`courses/${encodeURIComponent(id)}`));
    const url = new URL(location.href); url.searchParams.set('lesson', id);
    for (const key of ['entry', 'time', 'training', 'item', 'attempt']) url.searchParams.delete(key);
    history.replaceState(null, '', url);
  }
  async function importSnapshot(snapshot, { copy = false } = {}) {
    let valid = validateSnapshot(snapshot);
    await saveEditor(); await save();
    if (copy && (await api('courses')).some(c => c.id === valid.lessonId)) {
      const ids = new Map(valid.entries.map(e => [e.id, `entry-${crypto.randomUUID()}`]));
      valid = { ...valid, lessonId: `lesson-${crypto.randomUUID()}`, course: { ...valid.course, title: `${valid.course.title}（恢复副本）` }, entries: valid.entries.map(e => ({ ...e, id: ids.get(e.id) })) };
      if (valid.editorDraft) valid.editorDraft.entryId = ids.get(valid.editorDraft.entryId);
    }
    else {
      const existing = (await api('courses')).find(c => c.id === valid.lessonId);
      if (existing) { await activate(await api(`courses/${valid.lessonId}`)); toast('已打开保存过的课程，个人记录保留'); return; }
    }
    const record = await api('courses', { snapshot: valid, expectedRevision: null });
    await activate(record);
  }
  async function renderCourses() {
    const courses = await api('courses'); $('course-list').replaceChildren();
    for (const course of courses.filter(inSubject)) {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = `${course.title}${course.id === getState().lessonId ? ' · 当前' : ''} · ${course.entries} 条整理记录`;
      if (course.error) { button.disabled = true; button.textContent += '；原文件保留，请导入完整备份'; }
      button.addEventListener('click', action(() => openCourse(course.id))); $('course-list').append(button);
    }
  }
  function renderEntryList() {
    $('entry-list').replaceChildren();
    for (const entry of getState().entries || []) {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = `${entry.title} · ${{ inbox: '待整理', ready: '可入库', pending: '暂存待定' }[entry.status]} · ${formatTime(entry.time)}`;
      button.addEventListener('click', action(async () => { await saveEditor(); editEntry(entry.id); })); $('entry-list').append(button);
    }
  }
  function renderEntries() {
    sources = sourceItems(); $('entry-source').replaceChildren(new Option('个人随手记录（当前时间）', ''));
    for (const [i, source] of sources.entries()) $('entry-source').add(new Option(`${source.title || source.translatedText || '课程内容'}`.slice(0, 70), String(i)));
    renderEntryList(); $('entry-form').hidden = !editedId;
  }
  function editEntry(id) {
    const entry = getState().entries.find(e => e.id === id); if (!entry) return;
    editedId = id; formDirty = false; $('entry-form').hidden = false;
    for (const [field, key] of Object.entries({ title: 'title', original: 'originalText', personal: 'personalText', status: 'status', review: 'reviewStatus', basis: 'reviewBasis', aliases: 'aliases', related: 'relatedPath' })) $('entry-' + field).value = entry[key] || '';
    const draft = getState().editorDraft;
    if (draft?.entryId === id) {
      for (const [field, key] of Object.entries({ title: 'title', personal: 'personalText', status: 'status', review: 'reviewStatus', basis: 'reviewBasis', aliases: 'aliases', related: 'relatedPath' })) $('entry-' + field).value = draft[key] || '';
      formDirty = true; message('已恢复尚未提交的编辑草稿，请核对后保存。');
    }
    $('entry-history').textContent = `来源位置 ${formatTime(entry.time)} · ${entry.history.length} 次修订 · 掌握状态另记`;
    $('entry-attachments').replaceChildren();
    for (const object of getState().canvasObjects) {
      const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.dataset.attachment = object.id; input.checked = entry.attachmentIds.includes(object.id);
      label.append(input, document.createTextNode(`${object.type} · ${formatTime(object.time || 0)}`)); $('entry-attachments').append(label);
    }
  }
  async function showTab(name) {
    await saveEditor(); clearPreview();
    dialog.querySelectorAll('[data-library-pane]').forEach(p => { p.hidden = p.dataset.libraryPane !== name; });
    dialog.querySelectorAll('[data-library-tab]').forEach(p => p.setAttribute('aria-pressed', String(p.dataset.libraryTab === name)));
    if (name === 'courses') await renderCourses();
    if (name === 'entries') renderEntries();
    if (name === 'records') { if (!correcting) $('record-entry').value = editedId; await loadRecords(); }
  }
  function clearPreview() { preview = null; $('commit-panel').hidden = true; }
  function showPreview(kind, result) {
    preview = { kind, result }; $('commit-panel').hidden = false; $('commit-description').textContent = `${result.path}\n${result.note || ''}`;
    if (result.text) $('commit-preview').textContent = result.text;
    else {
      const p = result.event.payload;
      const labels = { date: '日期', subject_id: '科目', unit_id: '单元', effective_minutes: '有效分钟', output: '实际产物', item_id: '题目标识', source: '题目来源', evidence_kind: '证据类型', result: '实际结果', first_seen: '首次见题', closed_book: '闭卷独立', timed: '限时', guessed: '蒙对', duration_min: '用时分钟', error_type: '错因', source_quality: '题源状态', notes: '补充说明' };
      const values = { true: '是', false: '否', correct: '正确', wrong: '错误', timeout: '超时', source_issue: '题源问题', independent: '独立练习', timed_mixed: '限时混合题', delayed_retest: '延迟复测', UNKNOWN: '未知', verified: '已核验', disputed: '有争议' };
      $('commit-preview').textContent = `${result.event.supersedesId ? '更正已有记录（原记录保留）' : '新增实际记录'}\n\n` + Object.entries(labels).filter(([k]) => Object.hasOwn(p, k)).map(([k, label]) => `${label}：${p[k] === '' ? '未知 / 未填写' : values[p[k]] || p[k]}`).join('\n');
    }
  }
  async function search() {
    await saveEditor(); await save();
    const q = $('library-query').value.trim(); if (!q) return;
    const result = await api(`search?q=${encodeURIComponent(q)}`); $('search-results').replaceChildren(); $('entry-reader').hidden = true;
    for (const hit of result.courses) {
      const row = document.createElement('div'), button = document.createElement('button');
      button.textContent = `${hit.courseTitle} · ${hit.title} · ${formatTime(hit.time)}`;
      button.addEventListener('click', action(async () => {
        await openCourse(hit.lessonId);
        if (hit.kind === 'entry') { await showTab('entries'); editEntry(hit.id); }
        else { dialog.close(); seek(hit.time); }
      })); row.append(button); $('search-results').append(row);
    }
    for (const hit of result.vault) {
      const row = document.createElement('div'), open = document.createElement('button'); open.textContent = `知识库 · ${hit.title}`;
      open.addEventListener('click', action(async () => { $('entry-reader').textContent = (await api(`entry?path=${encodeURIComponent(hit.path)}`)).text; $('entry-reader').hidden = false; })); row.append(open);
      if (hit.lessonId) { const back = document.createElement('button'); back.textContent = '回源'; back.addEventListener('click', action(async () => { await openCourse(hit.lessonId); dialog.close(); seek(hit.time); })); row.append(back); }
      if (editedId) { const link = document.createElement('button'); link.textContent = '关联到当前整理条目'; link.addEventListener('click', action(async () => { $('entry-related').value = hit.path; formDirty = true; await saveEditor(); await showTab('entries'); editEntry(editedId); })); row.append(link); }
      const excerpt = document.createElement('p'); excerpt.textContent = hit.excerpt; row.append(excerpt); $('search-results').append(row);
    }
    if (!result.courses.length && !result.vault.length) $('search-results').textContent = '没有找到相关记录。';
  }
  function recordKind() { const attempt = $('record-kind').value === 'attempt'; $('session-fields').hidden = attempt; $('attempt-fields').hidden = !attempt; }
  async function loadRecords() {
    records = await api('records'); $('record-existing').replaceChildren(new Option('新增记录', ''));
    for (const r of records.filter(r => r.kind === 'session')) $('record-existing').add(new Option(`${r.payload.date} · ${r.payload.output} · ${r.id}`, r.id));
    $('linked-records').replaceChildren();
    for (const r of records.filter(r => r.payload.lesson_id === getState().lessonId || r.payload.notes?.includes(getState().lessonId))) {
      const p = document.createElement('p'); p.textContent = `${r.payload.date} · ${r.payload.item_id || r.payload.output} · ${r.payload.result || '已记录投入'} · ${r.payload.evidence_kind || '掌握另测'}`; $('linked-records').append(p);
    }
  }
  function resetRecord() { correcting = ''; recordId = `event-${crypto.randomUUID()}`; $('record-form').reset(); $('record-date').value = localDate(); $('record-entry').value = editedId; recordKind(); }
  async function previewRecord() {
    const unit = config.units.find(u => u.unit_id === $('record-unit').value);
    if (!unit) throw new Error('请选择知识单元');
    const previous = records.find(r => r.id === correcting)?.payload;
    const p = { ...(previous || {}), date: $('record-date').value, subject_id: unit.subject_id, unit_id: unit.unit_id,
      notes: $('record-notes').value, lesson_id: previous?.lesson_id || getState().lessonId, entry_id: $('record-entry').value };
    if ($('record-kind').value === 'session') Object.assign(p, { start_time: previous?.start_time || '', effective_minutes: $('record-minutes').value, output: $('record-output').value, interruption_reason: previous?.interruption_reason || '' });
    else {
      Object.assign(p, { item_id: $('record-item').value.trim(), source: $('record-source').value.trim(), purpose: previous?.purpose || 'practice', evidence_kind: $('record-evidence').value,
        result: $('record-result').value, source_quality: $('record-quality').value, isolated_test: 'false', duration_min: $('record-duration').value, error_type: $('record-error').value, confidence_before_check: previous?.confidence_before_check || '' });
      for (const flag of ['first_seen', 'closed_book', 'timed', 'guessed']) p[flag] = $('record-' + flag).value;
    }
    if (getState().course.demo) throw new Error('请先新建或导入实际课程，演示课不登记学习证据');
    showPreview('records', await api('records/preview', { id: recordId, kind: $('record-kind').value, supersedesId: correcting, payload: p }));
  }
  for (const [flag, title] of [['first_seen', '首次见题'], ['closed_book', '闭卷独立'], ['timed', '限时'], ['guessed', '是否蒙对']]) {
    const label = document.createElement('label'); label.textContent = title; const select = document.createElement('select'); select.id = 'record-' + flag;
    select.add(new Option('请选择', '')); select.add(new Option('是', 'true')); select.add(new Option('否', 'false')); label.append(select); $('record-flags').append(label);
  }
  dialog.querySelectorAll('[data-library-tab]').forEach(b => b.addEventListener('click', action(() => showTab(b.dataset.libraryTab))));
  $('library-close').addEventListener('click', action(async () => { await saveEditor(); dialog.close(); }));
  dialog.addEventListener('cancel', action(async () => { await saveEditor(); dialog.close(); }));
  $('new-course').addEventListener('click', action(async () => { const title = $('new-course-title').value.trim(); if (!title) throw new Error('请输入课程名称'); const s = createDefaultState(); s.lessonId = `lesson-${crypto.randomUUID()}`; s.course = { ...s.course, title, demo: false, transcriptName: '', transcriptFormat: '' }; s.notes = []; s.themes = [{ id: 'unclassified', title: '未归类', start: 0, status: 'confirmed' }]; s.activeThemeId = 'unclassified'; s.canvasObjects = []; s.entries = []; await importSnapshot(s); }));
  $('export-course').addEventListener('click', action(async () => {
    const snapshot = structuredClone(getState());
    if (editedId && formDirty) snapshot.editorDraft = { entryId: editedId, title: $('entry-title').value, personalText: $('entry-personal').value, reviewStatus: $('entry-review').value, reviewBasis: $('entry-basis').value, aliases: $('entry-aliases').value, relatedPath: $('entry-related').value, status: $('entry-status').value };
    const backup = makeBackup(snapshot);
    try { const result = await api('backup', backup); message(`完整备份已保存：${result.path}`); }
    catch (error) {
      download(`${snapshot.lessonId}.study-backup.json`, backup);
      $('entry-reader').textContent = JSON.stringify(backup, null, 2); $('entry-reader').hidden = false;
      message(`本地导出服务不可用：${error.message}。已尝试浏览器下载；也可在“检索与回源”面板复制完整备份文本。`);
    }
  }));
  $('restore-course').addEventListener('change', action(async () => { const file = $('restore-course').files?.[0]; if (file) { await importSnapshot(readBackup(JSON.parse(await file.text())), { copy: true }); message('备份已恢复为独立副本，原课程保留。'); } $('restore-course').value = ''; }));
  $('create-entry').addEventListener('click', action(async () => { await saveEditor(); const choice = $('entry-source').value; const entry = newEntry(getState(), choice === '' ? null : sources[Number(choice)]); getState().entries.push(entry); markDirty(); await save(); renderEntryList(); editEntry(entry.id); }));
  $('entry-form').addEventListener('input', () => { formDirty = true; clearPreview(); });
  $('entry-form').addEventListener('submit', action(saveEditor));
  $('entry-seek').addEventListener('click', action(async () => { await saveEditor(); const entry = getState().entries.find(e => e.id === editedId); dialog.close(); seek(entry.time); }));
  $('archive-preview').addEventListener('click', action(async () => { await saveEditor(); showPreview('archive', await api('archive/preview', { snapshot: getState(), entryId: editedId })); }));
  $('search-form').addEventListener('submit', action(search));
  $('entry-practice').textContent = '打开作业与错题';
  $('entry-practice').addEventListener('click', action(async () => { await saveEditor(); dialog.close(); document.querySelector('#show-practice-workspace')?.click(); }));
  $('record-kind').addEventListener('change', recordKind);
  $('record-form').addEventListener('input', () => { clearPreview(); recordId = `event-${crypto.randomUUID()}`; });
  $('record-form').addEventListener('submit', action(previewRecord));
  $('record-load').addEventListener('click', action(async () => {
    resetRecord(); const r = records.find(r => r.id === $('record-existing').value); if (!r) return;
    correcting = r.id; $('record-kind').value = r.kind;
    const map = { date: 'date', unit: 'unit_id', minutes: 'effective_minutes', output: 'output', item: 'item_id', source: 'source', evidence: 'evidence_kind', result: 'result', quality: 'source_quality', duration: 'duration_min', error: 'error_type', notes: 'notes' };
    for (const [field, key] of Object.entries(map)) $('record-' + field).value = r.payload[key] || '';
    for (const key of ['first_seen', 'closed_book', 'timed', 'guessed']) $('record-' + key).value = r.payload[key] || '';
    $('record-entry').value = r.payload.entry_id || '';
    recordKind(); message('正在更正 ' + r.id + '，原记录将保留。');
  }));
  $('commit-cancel').addEventListener('click', clearPreview);
  $('commit-write').addEventListener('click', action(async () => {
    if (!preview) return; const plan = preview; $('commit-write').disabled = true;
    try { const result = await api(`${plan.kind}/commit`, { token: plan.result.token }); clearPreview(); message(`已写入：${result.path || result.id}`); if (plan.kind === 'records') { resetRecord(); await loadRecords(); } }
    finally { $('commit-write').disabled = false; }
  }));
  async function bootstrap() {
    try {
      config = await api('config'); $('library-location').textContent = `课程：${config.courseRoot}　知识库：${config.vaultRoot}`;
      for (const unit of config.units) $('record-unit').add(new Option(unit.title, unit.unit_id));
      resetRecord();
      const allCourses = await api('courses'), courses = allCourses.filter(c => !c.error && inSubject(c)), requested = new URL(location.href).searchParams.get('lesson');
      const preferred = requested || localStorage.getItem(lastLessonKey) || (subject === 'physics' ? localStorage.getItem('study-desk-last-lesson') : null);
      ready = true;
      if (courses.length) {
        const registered = subject === 'physics' ? await api('materials').catch(() => []) : [];
        let chosen = courses.find(c => c.id === preferred) || courses.find(c => c.id === registered[0]?.lessonId) || courses[0];
        let record = await api(`courses/${chosen.id}`);
        if (!requested && record.snapshot.course.transcriptFormat === 'demo' && registered.length) {
          const linked = registered.find(c => c.videoSha256 && c.videoSha256 === record.snapshot.course.videoSha256) || registered[0];
          const replacement = courses.find(c => c.id === linked.lessonId);
          if (replacement) { chosen = replacement; record = await api(`courses/${chosen.id}`); toast('已打开接入笔记的课程；旧演示课与手写保留在课程与知识库。'); }
        }
        await activate(record);
        if (requested && chosen.id !== requested) message('链接对应的课程未在本机找到，请导入课程备份。');
      } else if (subject === 'math') { status.textContent = '本地题型训练'; } else { if (allCourses.some(c => c.id === getState().lessonId)) getState().lessonId = `recovery-${crypto.randomUUID()}`; markDirty(); await save(); }
      if (allCourses.some(c => c.error)) message('部分课程文件无法读取，原文件保留；可以导入完整备份恢复为副本。');
      const entry = new URL(location.href).searchParams.get('entry');
      if (entry && getState().entries.some(e => e.id === entry)) { dialog.showModal(); await showTab('entries'); editEntry(entry); }
      const time = new URL(location.href).searchParams.get('time');
      if (time && Number.isFinite(Number(time))) { getState().player.currentTime = Math.max(0, Number(time)); toast('已定位课程时间；选择原视频后可继续播放'); }
    } catch (e) { ready = false; status.textContent = `课程库未连接：${e.message}；当前内容尚未持久保存`; status.dataset.state = 'error'; fail(e); }
  }
  document.querySelector('#open-library').addEventListener('click', action(async () => { dialog.showModal(); if (ready) { await save(); await showTab('courses'); } }));
  window.addEventListener('beforeunload', event => { if (dirty || formDirty) { event.preventDefault(); event.returnValue = ''; } });
  return { bootstrap, save, async flush() { await saveEditor(); if (dirty) await save(); await saving; }, markDirty, importSnapshot, openCourse, isReady: () => ready, isDirty: () => dirty,
    get epoch() { return epoch; },
    async quickEntry() { dialog.showModal(); await showTab('entries'); $('entry-source').value = ''; $('create-entry').click(); } };
}
