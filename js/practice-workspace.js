import { catalogForSubject } from './subject.js';
// Practice drafts deliberately live outside the classroom snapshot.
import { mountTopicTraining } from './topic-training.js';
const VERDICTS = { correct: '正确', wrong: '错误', unanswered: '未作答', 'needs-review': '待核验', 'source-issue': '题源待核验' };
const STATES = { queued: '等待批改', running: '正在批改', failed: '批改失败', 'needs-review': '待核验', done: '批改完成' };
const tokenCount = value => Number.isSafeInteger(value) ? value.toLocaleString('zh-CN') : '未记录';
const KINDS = { classroom: '课堂练习', pset: 'PSET', supplement: '补充练习' };
const PHYSICS_KIND_ORDER = { pset: 0, supplement: 1, classroom: 2 };
const freshDraft = () => ({ pages: [{ objects: [] }], activePage: 0, conditions: { closedBook: null, guessed: null, firstSeen: null }, note: '', attemptId: `attempt-${crypto.randomUUID()}`, parentAttemptId: null, submittedId: null });
const stamp = a => a?.submittedAt || a?.createdAt || '';
const date = s => s ? new Date(s).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '暂无';
const clone = value => structuredClone(value);
function node(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
function button(text, handler, className) { const b = node('button', text, className); b.type = 'button'; b.addEventListener('click', handler); return b; }
function math(el) {
  if (!window.renderMathInElement) return;
  window.renderMathInElement(el, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '\\[', right: '\\]', display: true }, { left: '\\(', right: '\\)', display: false }, { left: '$', right: '$', display: false }], macros: { '\\dd': '\\,\\mathrm{d}', '\\answerblank': '\\underline{\\hspace{#1}}', '\\textasciitilde': '\\sim' }, throwOnError: false, trust: false, strict: 'ignore' });
}

export function mountPractice({ getState, api, toast, renderCanvas, setTool, exportPage, saveCourse, openQuestionScreen, onQuestionChange = () => {} }) {
  const subject = document.body.dataset.subject || 'physics';
  const $ = id => document.getElementById(id);
  const left = $('practice-left'); const right = $('practice-right');
  const strip = node('div', undefined, 'practice-strip'); strip.id = 'practice-strip'; strip.hidden = true;
  strip.innerHTML = `<div class="practice-answer-heading"><strong id="practice-answer-title">选择一道题开始</strong><span id="practice-save-status" role="status"></span></div><div class="practice-page-controls"><button id="practice-prev-page" type="button" aria-label="上一页">上一页</button><select id="practice-page" aria-label="作答页"></select><button id="practice-next-page" type="button" aria-label="下一页">下一页</button><button id="practice-add-page" type="button">加一页</button><span id="practice-readonly"></span></div>`;
  document.querySelector('.canvas-context').after(strip);
  const footer = node('form', undefined, 'practice-footer'); footer.id = 'practice-submit-form'; footer.hidden = true;
  footer.innerHTML = `<details id="practice-conditions"><summary>作答条件与补充说明 <span id="practice-conditions-summary">未确认</span></summary><div class="practice-condition-grid"><label>是否闭卷<select id="practice-closed-book"><option value="">未知</option><option value="true">全程闭卷</option><option value="false">看过资料或提示</option></select></label><label>是否首次见到此题<select id="practice-first-seen"><option value="">未知</option><option value="true">首次见到</option><option value="false">以前见过</option></select></label><label>答案是否含猜测<select id="practice-guessed"><option value="">未知</option><option value="false">不是蒙对</option><option value="true">有猜测</option></select></label></div><label>补充说明<textarea id="practice-note" rows="2" placeholder="可注明卡住的地方、使用过的帮助或字迹说明"></textarea></label></details><div class="practice-submit-actions"><span id="practice-submit-note">提交才批改；原作答和后续订正分别保存。</span><button id="practice-export-draft" type="button" hidden>导出未保存草稿</button><button id="practice-save-retry" type="button" hidden>重试保存</button><button id="practice-submit" type="submit" class="primary-button" disabled>提交批改</button></div>`;
  document.querySelector('.canvas-panel').append(footer);
  const annotations = node('div', undefined, 'practice-annotations'); annotations.id = 'practice-annotations'; $('canvas-stage').append(annotations);
  left.innerHTML = `<header class="practice-heading"><h1>本节作业</h1><p id="practice-lesson"></p></header><div class="practice-filters"><label>课程<select id="practice-track"><option value="8.01">MIT 8.01 · 力学</option><option value="836-thermal">热学</option><option value="8.02">MIT 8.02 · 电磁学</option><option value="8.03">MIT 8.03 · 振动、机械波与光学</option><option value="836-modern">近代物理</option></select></label><label>知识单元<select id="practice-unit"><option value="">全部单元</option></select></label><label>题目类型<select id="practice-kind"><option value="">全部类型</option><option value="classroom">课堂练习</option><option value="pset">PSET</option><option value="supplement">补充练习</option></select></label></div><details class="practice-sources"><summary>题源与待补材料</summary><div id="practice-source-list"></div></details><div id="practice-load-status" role="status">正在读取本地题源…</div><div id="practice-item-list" class="practice-item-list"></div><article id="practice-question" class="practice-question"><p>选择题目后，中间会打开这道题自己的手写页。</p></article>`;
  const suggestions = node('details', undefined, 'practice-sources');
  suggestions.innerHTML = '<summary>本节补充练习建议</summary><label>当前已学主题<select id="practice-topic"><option value="">从课程记录匹配</option></select></label><div id="practice-suggestions"></div>';
  left.querySelector('.practice-filters').after(suggestions);
  const directory = node('details', undefined, 'practice-sources'); directory.id = 'practice-directory'; directory.append(node('summary', '展开题目目录'));
  const itemList = $('practice-item-list'); itemList.before(directory); directory.append(itemList);
  const picker = node('div', undefined, 'practice-picker'); picker.innerHTML = '<label for="practice-current-item">当前题目</label><select id="practice-current-item"></select>';
  directory.before(picker);
  const pictureDialog = node('dialog', undefined, 'practice-image-dialog');
  const enlarged = node('img'); enlarged.alt = '题面原图';
  pictureDialog.append(button('关闭原图', () => pictureDialog.close()), enlarged); document.body.append(pictureDialog);
  function expandableImage(picture) { const img = node('img'); img.src = picture.dataUrl; img.alt = picture.name || '题目配图'; img.tabIndex = 0; img.title = '点击放大原图'; const open = () => { enlarged.src = picture.dataUrl; enlarged.alt = img.alt; pictureDialog.showModal(); }; img.addEventListener('click', open); img.addEventListener('keydown', e => { if (e.key === 'Enter') open(); }); return img; }
  right.innerHTML = `<nav class="practice-right-tabs" aria-label="作业信息"><button type="button" data-practice-tab="grade" aria-pressed="true">批改</button><button type="button" data-practice-tab="history" aria-pressed="false">作答档案 / 错题</button><button type="button" data-practice-tab="topics" aria-pressed="false">知识点</button></nav><div id="practice-right-body" class="practice-right-body"></div>`;
  let active = false, ready = false, loading = false, busy = false, selectedId = '', viewedAttempt = null, activePage = 0, tab = 'grade', historyFilter = 'all';
  let catalog = { sources: [], topics: [], items: [] }, attempts = [], evidence = { topics: [] }, refreshTimer, selectEpoch = 0;
  let lastLessonId = getState().lessonId, pinnedLessonId = '', bootError = '';
  const drafts = new Map();
  const loadedItems = new Map();
  const lessonId = () => pinnedLessonId || getState().lessonId;
  const key = (lesson, item) => `${lesson}\u0000${item}`;
  const recoveryKey = (lesson, item) => `study-desk-practice-recovery:${encodeURIComponent(lesson)}:${encodeURIComponent(item)}`;
  const selected = () => loadedItems.get(selectedId) || catalog.items.find(i => i.id === selectedId);
  const current = () => drafts.get(key(lessonId(), selectedId));
  const canEdit = () => active && Boolean(current()) && (!selected()?.hasImageBundle || Boolean(selected()?.questionImages?.length)) && !viewedAttempt && !current().snapshot.submittedId && !busy && !loading;
  const pages = () => viewedAttempt?.pages || current()?.snapshot.pages || [{ objects: [] }];
  const objects = () => pages()[activePage]?.objects || [];
  const fail = error => { toast(error.message || String(error), 'error'); };
  const action = fn => async e => { e?.preventDefault(); try { await fn(e); } catch (error) { fail(error); } };
  let trainingSession = null, presentationMethod = null, presentationPhase = 'loading', presentationRevision = 0, navigating = false;
  const training = mountTopicTraining({ host: left, api, math, fail, getTopics: () => catalog.topics,
    launchScreen: () => openQuestionScreen?.(),
    onMethod: (method, id) => { if (trainingSession?.id !== id) return; presentationMethod = method; presentationPhase = 'method'; ++presentationRevision; updateQuestionPlacement(); onQuestionChange(); },
    onStart: () => navigateTraining(),
    onSelect: async (id, attemptId) => { await selectItem(id, attemptId); tab = 'grade'; renderRight(); },
    onOpen: async (session, id, attemptId) => {
      if (busy) throw new Error('请等待当前提交完成');
      const previous = current(); if (previous?.dirty) await saveDraft(previous);
      trainingSession = session; pinnedLessonId = session.id; selectedId = ''; viewedAttempt = null;
      presentationMethod = null; presentationPhase = 'loading'; ++presentationRevision;
      $('practice-track').value = 'math1'; $('practice-unit').value = ''; $('practice-kind').value = '';
      renderUnits(); renderItems();
      await selectItem(id && session.itemIds.includes(id) ? id : session.itemIds[0], attemptId);
      presentationPhase = session.mode === 'guided' ? 'loading' : 'question'; ++presentationRevision; onQuestionChange();
      tab = 'grade'; renderRight();
    } });
  if (subject === 'math') $('practice-track').replaceChildren(new Option('数学一', 'math1'));
  const reviewTab = button('本组复盘', () => { tab = 'training'; renderRight(); }); reviewTab.dataset.practiceTab = 'training';
  right.querySelector('nav').append(reviewTab); reviewTab.hidden = true;
  const screenControls = node('div', undefined, 'practice-screen-controls'); screenControls.hidden = true;
  const screenButton = button('副屏看题', () => openQuestionScreen?.()); screenButton.id = 'practice-open-question-screen';
  const screenStatus = node('span'); screenStatus.id = 'practice-screen-status';
  const inlineLabel = node('label'); const inlineQuestion = node('input'); inlineQuestion.type = 'checkbox'; inlineQuestion.id = 'practice-inline-question';
  inlineLabel.append(inlineQuestion, document.createTextNode('主屏也显示题面'));
  screenControls.append(screenButton, screenStatus, inlineLabel); strip.append(screenControls);
  let screenConnected = false;
  function updateQuestionPlacement() {
    const enabled = active;
    screenControls.hidden = !enabled;
    const detached = enabled && screenConnected && !inlineQuestion.checked;
    $('practice-question').hidden = detached;
    $('training-method').hidden = detached && Boolean(presentationMethod);
    document.body.classList.toggle('question-on-secondary', detached);
    screenStatus.textContent = screenConnected ? (training.isActive() ? '讲解和题目已同步 · → / Enter 开始或下一题 · 切题不自动提交' : '题目已同步 · → / Enter 下一题 · 切题不自动提交') : '副屏未连接 · 题面保留在主屏';
  }
  inlineQuestion.addEventListener('change', updateQuestionPlacement);
  function getSecondaryQuestion() {
    const isTraining = training.isActive();
    const ids = isTraining ? trainingSession?.itemIds || [] : filteredItems().map(i => i.id);
    const item = active && ids.includes(selectedId) ? selected() : null;
    return { active, mode: isTraining ? 'training' : 'practice',
      trainingId: active ? (isTraining ? trainingSession?.id || '' : lessonId()) : '',
      groupTitle: active ? (isTraining ? trainingSession?.title || '题型训练' : `${getState().course.title} · 作业与错题`) : '',
      phase: loading || navigating ? 'loading' : isTraining ? presentationPhase : 'question', revision: presentationRevision,
      method: isTraining && presentationPhase === 'method' ? presentationMethod : null,
      position: item ? ids.indexOf(item.id) + 1 : 0, total: active ? ids.length : 0,
      itemMode: isTraining ? trainingSession?.itemMode || 'questions' : 'questions',
      // Only logged teaching content and the selected question; never reference answers or handwriting.
      item: item ? { id: item.id, title: item.title, prompt: item.prompt, sourceRef: item.sourceRef,
        questionImages: (item.questionImages || []).map(p => ({ name: p.name, dataUrl: p.dataUrl })) } : null };
  }
  async function navigateTraining(command) {
    const view = getSecondaryQuestion();
    if (!view.active || !view.item || busy || loading || navigating || view.phase === 'loading') return;
    if (command && (command.trainingId !== view.trainingId || command.revision !== view.revision)) return;
    navigating = true;
    try {
      const draft = current(); if (draft?.dirty || draft?.saving) await saveDraft(draft);
      const next = getSecondaryQuestion();
      if (!next.active || next.trainingId !== view.trainingId || next.revision !== view.revision) return;
      if (view.phase === 'method') { presentationPhase = 'question'; ++presentationRevision; }
      else {
        const items = filteredItems(), index = items.findIndex(i => i.id === selectedId);
        if (index >= 0 && index < items.length - 1) await selectItem(items[index + 1].id);
        else toast('已经是当前列表最后一题。请在主屏提交需要批改的作答。');
      }
    } catch (error) { fail(error); }
    finally { navigating = false; updateQuestionPlacement(); onQuestionChange(); }
  }
  function trainingLayout(enabled) {
    left.querySelector('.practice-heading').hidden = enabled;
    left.querySelector('.practice-filters').hidden = enabled;
    suggestions.hidden = enabled; reviewTab.hidden = !enabled;
    $('show-training-workspace').setAttribute('aria-pressed', String(enabled));
    $('show-practice-workspace').setAttribute('aria-pressed', String(active && !enabled));
  }
  async function enterTraining(id, itemId, attemptId) {
    show(true); trainingLayout(true);
    if (!ready) await bootstrap();
    await training.activate(id, itemId, attemptId);
    if (!trainingSession) { selectedId = ''; viewedAttempt = null; ++selectEpoch; renderItems(); renderQuestion(); renderAnswer(); renderRight(); renderCanvas(); }
    updateQuestionPlacement(); onQuestionChange();
  }
  function leaveTraining() {
    if (training.isActive()) {
      const d = current(); if (d?.dirty) saveDraft(d).catch(fail);
      training.hide(); trainingSession = null; pinnedLessonId = ''; selectedId = ''; viewedAttempt = null; ++selectEpoch;
      $('practice-track').value = subject === 'math' ? 'math1' : '8.01'; tab = 'grade'; renderUnits(); renderItems(); renderQuestion(); renderAnswer();
    }
    trainingLayout(false);
  }
  const backup = d => { try { localStorage.setItem(recoveryKey(d.lessonId, d.itemId), JSON.stringify({ revision: d.revision, snapshot: d.snapshot })); } catch { /* Keep the visible unsaved status when browser storage is unavailable. */ } };

  const classroomDialog = node('dialog', undefined, 'practice-classroom-dialog');
  classroomDialog.id = 'practice-classroom-dialog';
  classroomDialog.innerHTML = `<form id="practice-classroom-form"><header><h2>把课程截图作为课堂题</h2><button id="practice-classroom-close" type="button" aria-label="关闭课堂题选择">关闭</button></header><p>使用当前课程已经保存的画面。选择题面清楚的截图，原图会随题目保留。</p><p id="practice-classroom-message" role="status"></p><label>截图时间点<select id="practice-classroom-screenshot"></select></label><img id="practice-classroom-preview" alt="选中的课程截图" hidden><label>题目标题<input id="practice-classroom-title" required maxlength="180"></label><label>课程<select id="practice-classroom-track"><option value="8.01">MIT 8.01 · 力学</option><option value="8.02">MIT 8.02 · 电磁学</option><option value="8.03">MIT 8.03 · 振动、机械波与光学</option></select></label><p class="practice-muted">课堂题单独留档，不作为首次见到的独立新题证据。若已看过老师的讲解或答案，请在作答条件中如实记录。</p><button id="practice-classroom-create" type="submit" class="primary-button">加入本节作业</button></form>`;
  document.body.append(classroomDialog);
  const classroomButton = button('把课程截图作为课堂题', openClassroomDialog, 'quiet-button');
  classroomButton.id = 'practice-add-classroom';
  $('course-notes').querySelector('.notes-controls').append(classroomButton);
  let classroomLesson = '', classroomScreenshots = [], classroomCreating = false;
  const videoTime = seconds => { const total = Math.max(0, Math.floor(Number(seconds) || 0)); return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`; };
  function updateClassroomPreview() {
    const screenshot = classroomScreenshots.find(s => s.id === $('practice-classroom-screenshot').value);
    const preview = $('practice-classroom-preview'); preview.hidden = !screenshot;
    if (screenshot) { preview.src = screenshot.image; $('practice-classroom-title').value = `${getState().course.title} · ${videoTime(screenshot.time)} 课堂题`.slice(0, 180); }
    else { preview.removeAttribute('src'); $('practice-classroom-title').value = ''; }
  }
  function openClassroomDialog() {
    if (classroomCreating) return;
    classroomLesson = getState().lessonId;
    classroomScreenshots = getState().canvasObjects.filter(o => o.type === 'screenshot' && typeof o.image === 'string' && o.image.startsWith('data:image/'));
    const choices = $('practice-classroom-screenshot'); choices.replaceChildren();
    classroomScreenshots.forEach((s, i) => choices.add(new Option(`${videoTime(s.time)} · 截图 ${i + 1}`, s.id)));
    choices.value = classroomScreenshots.at(-1)?.id || '';
    $('practice-classroom-create').disabled = classroomScreenshots.length === 0;
    $('practice-classroom-title').disabled = classroomScreenshots.length === 0;
    choices.disabled = classroomScreenshots.length === 0;
    $('practice-classroom-message').textContent = classroomScreenshots.length ? '默认选中最近保存的一张截图。' : '当前课程还没有截图。打开副屏视频，在题目出现时按 Ctrl+2 保存画面，再回到这里选择。';
    const match = `${getState().course.title} ${getState().course.videoName}`.match(/8[._-]?0([123])/);
    $('practice-classroom-track').value = match ? `8.0${match[1]}` : $('practice-track').value;
    updateClassroomPreview(); classroomDialog.showModal();
  }
  $('practice-classroom-close').addEventListener('click', () => { if (!classroomCreating) classroomDialog.close(); });
  classroomDialog.addEventListener('cancel', event => { if (classroomCreating) event.preventDefault(); });
  $('practice-classroom-screenshot').addEventListener('change', updateClassroomPreview);
  $('practice-classroom-form').addEventListener('submit', async event => {
    event.preventDefault(); if (classroomCreating) return;
    const screenshotId = $('practice-classroom-screenshot').value;
    const title = $('practice-classroom-title').value.trim(), track = $('practice-classroom-track').value;
    if (!title || !classroomScreenshots.some(s => s.id === screenshotId)) return;
    classroomCreating = true; $('practice-classroom-create').disabled = true; $('practice-classroom-close').disabled = true;
    $('practice-classroom-message').textContent = '正在保存课程并加入课堂题…';
    try {
      if (getState().lessonId !== classroomLesson) throw new Error('课程已切换，请重新选择当前课程的截图');
      await saveCourse();
      if (getState().lessonId !== classroomLesson) throw new Error('保存期间课程已切换，请重新选择截图');
      const result = await api('practice/classroom', { lessonId: classroomLesson, screenshotId, title, track });
      const previous = current(); if (previous?.dirty) await saveDraft(previous);
      catalog = catalogForSubject(await api('practice/catalog'), subject); loadedItems.clear(); ready = true; bootError = '';
      if (!catalog.items.some(item => item.id === result.itemId)) throw new Error('课堂题已经保存，题源列表尚未返回该题，请稍后刷新作业');
      pinnedLessonId = ''; $('practice-track').value = track; $('practice-unit').value = ''; $('practice-kind').value = 'classroom';
      selectedId = result.itemId; renderSources(); renderUnits(); renderItems(); show(true);
      await selectItem(result.itemId); tab = 'grade'; renderRight();
      classroomDialog.close(); toast('课堂题已加入本节作业，原截图保留。');
    } catch (error) { $('practice-classroom-message').textContent = error.message; fail(error); }
    finally { classroomCreating = false; $('practice-classroom-create').disabled = classroomScreenshots.length === 0; $('practice-classroom-close').disabled = false; }
  });

  function status(d = current()) {
    if (!d) { $('practice-save-status').textContent = loading ? '正在读取草稿' : ''; return; }
    const s = d.error ? 'error' : d.dirty || d.saving ? 'pending' : 'saved';
    $('practice-save-status').dataset.state = s;
    $('practice-save-status').textContent = d.error ? `未保存：${d.error}` : s === 'pending' ? '正在保存到本机…' : '已保存到本机';
    $('practice-save-retry').hidden = !d.error;
    $('practice-export-draft').hidden = !d.error && !d.recoveryConflict;
  }
  async function saveDraft(d = current()) {
    if (!d) return;
    clearTimeout(d.timer);
    if (d.saving) { await d.saving; if (d.dirty) return saveDraft(d); return; }
    if (!d.dirty) return;
    const version = d.version, snapshot = clone(d.snapshot);
    d.error = ''; status();
    d.saving = (async () => {
      try {
        const result = await api('practice/draft', { lessonId: d.lessonId, itemId: d.itemId, expectedRevision: d.revision, snapshot });
        d.revision = result.revision;
        d.dirty = d.version !== version;
        if (!d.dirty) { try { localStorage.removeItem(recoveryKey(d.lessonId, d.itemId)); } catch {} }
      } catch (error) { d.error = error.message; backup(d); throw error; }
      finally { d.saving = null; status(); }
    })();
    await d.saving;
    if (d.dirty) await saveDraft(d);
  }
  function markDirty() {
    const d = current(); if (!d || viewedAttempt || busy) return;
    d.snapshot.activePage = activePage; d.version++; d.dirty = true; backup(d); status(d);
    clearTimeout(d.timer); d.timer = setTimeout(() => saveDraft(d).catch(() => {}), 700);
  }
  async function loadDraft(itemId) {
    const lesson = lessonId(), cacheKey = key(lesson, itemId);
    if (drafts.has(cacheKey)) return drafts.get(cacheKey);
    const result = await api(`practice/draft?lessonId=${encodeURIComponent(lesson)}&itemId=${encodeURIComponent(itemId)}`);
    const d = { lessonId: lesson, itemId, revision: result?.revision ?? null, snapshot: result?.snapshot || freshDraft(), version: 0, dirty: false, error: '', saving: null };
    try {
      const saved = JSON.parse(localStorage.getItem(recoveryKey(lesson, itemId)) || 'null');
      if (saved?.snapshot) {
        if (saved.revision === d.revision) { d.snapshot = saved.snapshot; d.dirty = true; d.version++; }
        else { d.recoveryConflict = saved; toast('发现另一份未保存草稿，可导出保留；当前显示本机服务中的版本。', 'error'); }
      }
    } catch {}
    d.snapshot.attemptId ||= `attempt-${crypto.randomUUID()}`;
    drafts.set(cacheKey, d);
    return d;
  }
  async function selectItem(id, attemptId) {
    if (!catalog.items.some(item => item.id === id) || busy) return;
    const previous = current(); if (previous?.dirty || previous?.saving) await saveDraft(previous);
    const chosen = catalog.items.find(i => i.id === id);
    if ($('practice-track').value !== chosen.track) { $('practice-track').value = chosen.track; renderUnits(); }
    const epoch = ++selectEpoch; selectedId = id; viewedAttempt = null; activePage = 0; loading = true;
    if (trainingSession) presentationPhase = 'question';
    ++presentationRevision;
    renderQuestion(); renderItems(); renderAnswer(); renderCanvas();
    try {
      if (chosen.hasImageBundle && !loadedItems.has(id)) {
        const detail = await api(`practice/item?id=${encodeURIComponent(id)}`);
        if (epoch !== selectEpoch) return;
        loadedItems.set(id, detail);
        if (loadedItems.size > 12) loadedItems.delete(loadedItems.keys().next().value);
        renderQuestion();
      }
      const d = await loadDraft(id); if (epoch !== selectEpoch) return;
      if (attemptId || d.snapshot.submittedId) viewedAttempt = await api(`practice/attempt?id=${encodeURIComponent(attemptId || d.snapshot.submittedId)}`);
      if (epoch !== selectEpoch) return;
      activePage = Math.min(d.snapshot.activePage || 0, pages().length - 1);
    } finally { if (epoch === selectEpoch) { loading = false; renderQuestion(); renderAnswer(); renderRight(); renderCanvas(); onQuestionChange(); } }
  }
  function show(activeValue) {
    active = activeValue; ++presentationRevision;
    document.body.classList.toggle('practice-active', active);
    $('course-notes').hidden = active; $('course-map').hidden = active;
    left.hidden = !active; right.hidden = !active; strip.hidden = !active; footer.hidden = !active;
    $('show-course-workspace').setAttribute('aria-pressed', String(!active)); $('show-practice-workspace').setAttribute('aria-pressed', String(active));
    if (!active) { for (const d of drafts.values()) if (d.dirty) saveDraft(d).catch(() => {}); }
    renderCanvas();
    if (active && ready && !selectedId) {
      const available = filteredItems(); if (available[0]) selectItem(available[0].id).catch(fail);
    }
    if (active) { renderAnswer(); renderRight(); }
    updateQuestionPlacement(); onQuestionChange();
  }
  function filteredItems() {
    if (training.isActive()) return (trainingSession?.itemIds || []).map(id => catalog.items.find(i => i.id === id)).filter(Boolean);
    const items = catalog.items.filter(item => item.track === $('practice-track').value && (!$('practice-unit').value || item.unitId === $('practice-unit').value) && (!$('practice-kind').value || item.kind === $('practice-kind').value));
    return subject === 'physics'
      ? items.map((item, index) => ({ item, index })).sort((a, b) => (PHYSICS_KIND_ORDER[a.item.kind] ?? 99) - (PHYSICS_KIND_ORDER[b.item.kind] ?? 99) || a.index - b.index).map(({ item }) => item)
      : items;
  }
  async function applyFilterChange(updateUnits = false) {
    if (updateUnits) renderUnits();
    renderItems();
    const items = filteredItems();
    ++presentationRevision;
    if (items.some(i => i.id === selectedId)) { renderQuestion(); return; }
    const previous = current(); if (previous?.dirty) await saveDraft(previous);
    if (items[0]) return selectItem(items[0].id);
    ++selectEpoch; selectedId = ''; viewedAttempt = null; activePage = 0; loading = false;
    renderQuestion(); renderAnswer(); renderRight(); renderCanvas();
  }
  function renderSources() {
    const list = $('practice-source-list'); list.replaceChildren();
    for (const source of catalog.sources) {
      const row = node('div', undefined, 'practice-source'); row.append(node('strong', `${source.title} · ${source.status === 'available' ? '已收录' : '待准备'}`));
      if (source.note) row.append(node('p', source.note)); list.append(row);
    }
  }
  function renderUnits() {
    const unit = $('practice-unit'), value = unit.value; unit.replaceChildren(new Option('全部单元', ''));
    const ids = [...new Set(catalog.items.filter(i => i.track === $('practice-track').value).map(i => i.unitId))];
    for (const id of ids) {
      const labels = catalog.topics.filter(t => t.unitId === id).map(t => t.title);
      unit.add(new Option(labels.slice(0, 2).join(' / ') || id, id));
    }
    if (ids.includes(value)) unit.value = value;
  }
  function renderItems() {
    $('practice-lesson').textContent = trainingSession ? `${trainingSession.title} · 本组独立保存` : `${getState().course.title} · 每道题按当前课程保存`;
    const list = $('practice-item-list'); list.replaceChildren();
    const items = filteredItems();
    const picker = $('practice-current-item'); picker.replaceChildren(new Option('选择题目', ''));
    for (const item of items) picker.add(new Option(`${KINDS[item.kind]} · ${item.title}`, item.id));
    if (items.some(i => i.id === selectedId)) picker.value = selectedId;
    $('practice-load-status').textContent = bootError || (items.length ? `${items.length} 道候选题 · 按知识单元筛选，题源位置见下方` : '这个范围暂未收录题目，待准备的题源不会伪装成作业。');
    if (training.isActive() && !bootError) $('practice-load-status').textContent = trainingSession ? `本组 ${items.length} 道题 · 逐题提交，右侧查看整组复盘` : '选择题型并开始这一组后，这里会显示本组题目。';
    if (bootError) list.append(button('重试读取题源', action(bootstrap)));
    for (const item of items) {
      const row = button('', action(() => selectItem(item.id)), 'practice-item'); row.dataset.itemId = item.id; row.setAttribute('aria-pressed', String(item.id === selectedId));
      row.append(node('span', KINDS[item.kind] || item.kind, 'practice-item-kind'), node('strong', item.title));
      const done = attempts.filter(a => a.itemId === item.id).sort((a, b) => stamp(b).localeCompare(stamp(a)))[0];
      row.append(node('small', done ? `${VERDICTS[done.grade?.verdict] || STATES[done.state] || '已提交'} · ${date(stamp(done))}` : item.sourceRef || '尚未作答'));
      list.append(row);
    }
  }
  function renderQuestion() {
    updateQuestionPlacement(); onQuestionChange();
    const target = $('practice-question'); target.replaceChildren(); const item = selected(); if (!item) return;
    const source = catalog.sources.find(s => s.id === item.sourceId);
    target.append(node('h2', item.title), node('p', `${source?.title || item.sourceId} · ${item.sourceRef || ''}`, 'practice-source-ref'));
    if (item.sourceQuality !== 'verified') target.append(node('p', item.sourceQualityNote || '题面或参考解答仍待核验；有疑义的批改不会计为有效掌握证据。', 'practice-caution'));
    const prompt = node('div', item.prompt, 'practice-prompt'); target.append(prompt); math(prompt);
    if (item.hasImageBundle && !item.questionImages?.length) {
      target.append(node('p', loading ? '正在读取题面原图…' : '题面原图未加载，请重试。', 'practice-caution'));
      if (!loading) target.append(button('重试题图', action(() => selectItem(item.id))));
    }
    for (const picture of item.questionImages || []) target.append(expandableImage(picture));
    if (item.composite) target.append(node('p', item.track === 'math1' ? '按原讲义页练习：请在手写第一行标明所做题目，点击原页可放大。只批改你选定的作答，整页不计为一道独立题的掌握证据。' : '整份 PSET 按原题号作答，可点击题面放大。整份提交会保存和批改，但不计为一道独立题的掌握证据。', 'practice-caution'));
    const location = item.locator || {}; const detail = node('details'); detail.append(node('summary', '原题位置与知识点'));
    detail.append(node('p', [location.path, location.page != null ? `第 ${location.page} 页` : '', location.exercise ? `题号 ${location.exercise}` : '', location.section].filter(Boolean).join(' · ')));
    detail.append(node('p', (item.topicIds || []).map(id => catalog.topics.find(t => t.id === id)?.title || id).join('、'))); target.append(detail);
  }
  function renderAnswer() {
    const d = current(), edit = canEdit(), item = selected();
    for (const control of left.querySelectorAll('.practice-filters select, #practice-current-item, #practice-topic')) control.disabled = busy;
    $('practice-answer-title').textContent = item ? `${item.title}${viewedAttempt ? ' · 原始提交' : d?.snapshot.parentAttemptId ? ' · 订正草稿' : ' · 作答草稿'}` : '选择一道题开始';
    const page = $('practice-page'); page.replaceChildren();
    pages().forEach((_, i) => page.add(new Option(`第 ${i + 1} 页 / 共 ${pages().length} 页`, String(i)))); page.value = String(activePage); page.disabled = loading || busy || !item;
    $('practice-prev-page').disabled = loading || busy || !activePage;
    $('practice-next-page').disabled = loading || busy || activePage >= pages().length - 1;
    $('practice-add-page').disabled = !edit || pages().length >= 12;
    $('practice-readonly').textContent = viewedAttempt ? '原提交只读 · 在右侧新建订正' : loading ? '正在读取…' : '';
    const conditions = viewedAttempt?.conditions || d?.snapshot.conditions || {};
    for (const [id, name] of [['practice-closed-book', 'closedBook'], ['practice-first-seen', 'firstSeen'], ['practice-guessed', 'guessed']]) { $(id).value = conditions[name] == null ? '' : String(conditions[name]); $(id).disabled = !edit; }
    $('practice-note').value = viewedAttempt?.note || d?.snapshot.note || ''; $('practice-note').disabled = !edit;
    $('practice-conditions-summary').textContent = Object.values(conditions).some(v => v == null) ? '含未知条件' : '已记录事实';
    $('practice-submit').disabled = !edit || !ready;
    $('practice-submit').textContent = busy ? '正在提交…' : '提交批改';
    $('practice-submit-note').textContent = viewedAttempt ? `提交于 ${date(stamp(viewedAttempt))} · 原作答保留` : '题面与作答图将交给 Codex 批改；档案保存在本机。';
    document.querySelector('.canvas-panel').classList.toggle('practice-readonly', active && !edit);
    status();
  }
  function setPage(index) {
    if (busy || loading) return;
    activePage = Math.max(0, Math.min(index, pages().length - 1));
    if (!viewedAttempt) markDirty(); renderAnswer(); renderCanvas();
    $('canvas-viewport').scrollTo({ left: 0, top: 0 });
  }
  function renderAnnotations() {
    annotations.replaceChildren(); if (!active || !viewedAttempt?.grade) return;
    for (const [i, step] of (viewedAttempt.grade.steps || []).entries()) {
      if (step.page !== activePage + 1 || !Number.isFinite(step.x) || !Number.isFinite(step.y)) continue;
      const marker = button(String(i + 1), () => { tab = 'grade'; renderRight(); $('practice-right-body').querySelector(`[data-step="${i}"]`)?.scrollIntoView({ block: 'center' }); }, `practice-marker ${step.status}`);
      marker.style.left = `${Math.max(0, Math.min(1, step.x)) * 2400}px`; marker.style.top = `${Math.max(0, Math.min(1, step.y)) * 1600}px`;
      marker.title = step.comment; marker.setAttribute('aria-label', `第 ${i + 1} 条批注：${step.comment}`); annotations.append(marker);
    }
  }
  async function refresh() {
    const [list, evidenceResult] = await Promise.all([api('practice/attempts'), api('practice/evidence')]);
    attempts = (Array.isArray(list) ? list : list.attempts || []).filter(a => catalog.items.some(i => i.id === a.itemId));
    evidence = { ...evidenceResult, topics: (evidenceResult.topics || []).filter(t => catalog.topics.some(c => c.id === t.id)) };
    if (viewedAttempt) { const id = viewedAttempt.id; const fresh = await api(`practice/attempt?id=${encodeURIComponent(id)}`); if (viewedAttempt?.id === id) viewedAttempt = fresh; }
    renderItems(); renderRight(); renderAnswer(); renderAnnotations();
    if (training.isActive()) await training.refresh();
    clearTimeout(refreshTimer);
    if (attempts.some(a => ['queued', 'running'].includes(a.state || a.status))) refreshTimer = setTimeout(() => refresh().catch(fail), 2200);
  }
  async function submit() {
    if (!canEdit()) return;
    const d = current(); busy = true; renderAnswer();
    try {
      d.dirty = true; d.version++; await saveDraft(d);
      const payload = { id: d.snapshot.attemptId, itemId: d.itemId, lessonId: d.lessonId, conditions: clone(d.snapshot.conditions), note: d.snapshot.note, parentAttemptId: d.snapshot.parentAttemptId || undefined, pages: [] };
      for (const page of d.snapshot.pages) payload.pages.push({ objects: clone(page.objects), image: await exportPage(page.objects) });
      const attempt = await api('practice/submit', payload);
      d.snapshot.submittedId = attempt.id; d.dirty = true; d.version++; backup(d);
      if (current() === d) { viewedAttempt = attempt; tab = 'grade'; }
      await saveDraft(d);
      toast('作答已提交并归档，批改完成后会显示在右侧。');
      await refresh();
    } finally { busy = false; renderAnswer(); renderRight(); renderCanvas(); }
  }
  async function newAttempt(copyPages) {
    if (busy || !viewedAttempt) return;
    const parent = viewedAttempt, d = current(); await saveDraft(d);
    const draft = freshDraft(); draft.parentAttemptId = parent.id; draft.conditions.firstSeen = false;
    if (copyPages) draft.pages = parent.pages.map(p => ({ objects: clone(p.objects || []) }));
    d.snapshot = draft; viewedAttempt = null; activePage = 0; markDirty(); await saveDraft(d);
    renderAnswer(); renderRight(); renderCanvas(); setTool('pen');
  }
  async function reveal(kind) {
    const result = await api('practice/reveal', { itemId: selectedId, kind, ...(viewedAttempt ? { attemptId: viewedAttempt.id } : {}) });
    const box = $(`practice-${kind}-content`); if (!box) return;
    box.replaceChildren(node('div', result.text || result.content || '当前没有可用内容。'));
    for (const picture of result.images || []) box.append(expandableImage(picture)); math(box);
    box.hidden = false; box.previousElementSibling.disabled = true;
    if (!viewedAttempt && current()) { current().snapshot.conditions.closedBook = false; markDirty(); renderAnswer(); }
  }
  function renderGrade(target) {
    const item = selected(); if (!item) { target.append(node('p', '先在左侧选择题目。')); return; }
    const attempt = viewedAttempt;
    if (!attempt) {
      target.append(node('h2', '先独立尝试'), node('p', '手动提交后，批改会指出成立的步骤、首个错误和需要澄清的字迹。停笔或切换课程不会自动交卷。'));
      target.append(node('p', '未做出来也可以提交，系统会保留未作答记录；不会要求你给自己打分。', 'practice-muted'));
    } else {
      const grade = attempt.grade;
      target.append(node('h2', VERDICTS[grade?.verdict] || STATES[attempt.state] || '已提交'));
      target.append(node('p', `提交 ${date(stamp(attempt))} · ${attempt.parentAttemptId ? '关联前次作答' : '首次档案'}`, 'practice-muted'));
      if (attempt.usage) {
        const usage = attempt.usage, totals = usage.totals;
        const detail = node('details');
        detail.append(node('summary', totals ? `Token 共 ${tokenCount(totals.total_tokens)}（输入 ${tokenCount(totals.input_tokens)}，输出 ${tokenCount(totals.output_tokens)}）` : 'Token 用量未返回'));
        if (totals) detail.append(node('p', `缓存输入 ${tokenCount(totals.cached_input_tokens)}；推理输出 ${tokenCount(totals.reasoning_output_tokens)}。缓存和推理均为对应总量的子集，不重复计入合计。`, 'practice-muted'));
        for (const call of usage.calls || []) {
          const u = call.usage, label = call.role === 'first' ? '第一次独立批改' : call.role === 'second' ? '第二次独立复核' : call.role;
          detail.append(node('p', u ? `${label}：输入 ${tokenCount(u.input_tokens)}（缓存 ${tokenCount(u.cached_input_tokens)}），输出 ${tokenCount(u.output_tokens)}（推理 ${tokenCount(u.reasoning_output_tokens)}）` : `${label}：未记录`, 'practice-muted'));
        }
        target.append(detail);
      } else if (!['queued', 'running'].includes(attempt.state)) target.append(node('p', 'Token 用量：未记录（旧作答或批改器未返回用量）。', 'practice-muted'));
      if (['queued', 'running'].includes(attempt.state)) target.append(node('p', '本机正在调用 Codex。你可以返回课程，作答已经留档。'));
      if (attempt.state === 'failed' || (attempt.state === 'needs-review' && !grade)) { target.append(node('p', attempt.lastError || '批改未完成，原作答已保存。', 'practice-caution')); target.append(button('重试批改', action(async () => { await api('practice/retry', { id: attempt.id }); await refresh(); }))); }
      if (attempt.archiveError) { target.append(node('p', attempt.archiveError, 'practice-caution'), button('重试知识库同步', action(async () => { await api('practice/sync', {}); await refresh(); toast('知识库索引已重新同步'); }))); }
      if (grade) {
        const summary = node('p', grade.summary || '当前结果需要复核。', 'practice-grade-summary'); target.append(summary); math(summary);
        if (grade.verification?.status !== 'verified') { const caution = node('p', grade.verification?.reason || '结论尚待核验，不据此提高掌握状态。', 'practice-caution'); target.append(caution); math(caution); }
        const steps = node('ol', undefined, 'practice-steps');
        (grade.steps || []).forEach((step, i) => {
          const entry = node('li'); entry.dataset.step = String(i); entry.dataset.status = step.status;
          const jump = button(`第 ${step.page} 页 · ${step.status === 'correct' ? '成立' : step.status === 'wrong' ? '错误' : '待澄清'}`, () => { setPage(step.page - 1); if (Number.isFinite(step.x) && Number.isFinite(step.y)) $('canvas-viewport').scrollTo({ left: Math.max(0, step.x * 2400 - 100), top: Math.max(0, step.y * 1600 - 100), behavior: 'smooth' }); });
          entry.append(jump, node('p', step.comment)); steps.append(entry);
        }); target.append(steps); math(steps);
        if (grade.recognizedWork) { const detail = node('details'); detail.append(node('summary', '核对识别出的作答'), node('div', grade.recognizedWork, 'practice-recognized')); target.append(detail); math(detail); }
        if (grade.uncertainties?.length) { const caution = node('p', `待澄清：${grade.uncertainties.join('；')}`, 'practice-caution'); target.append(caution); math(caution); }
      }
      const actions = node('div', undefined, 'practice-inline-actions'); actions.append(button('在副本上订正', action(() => newAttempt(true))), button('另起空白页重做', action(() => newAttempt(false)))); target.append(actions);
      const report = node('details'); report.append(node('summary', '报告识别或批改问题'));
      const reason = node('textarea'); reason.rows = 3; reason.placeholder = '例如：第 2 行写的是负号；这里使用的参考答案不适用。'; reason.setAttribute('aria-label', '批改问题说明');
      const correctionFields = {};
      const facts = node('div', undefined, 'practice-correction-facts');
      for (const [key, label] of [['closedBook', '全程闭卷'], ['firstSeen', '首次见题'], ['guessed', '含猜测']]) {
        const select = node('select'); select.setAttribute('aria-label', `更正${label}`);
        for (const [value, title] of [['', '未知'], ['true', '是'], ['false', '否']]) select.add(new Option(title, value));
        select.value = attempt.conditions?.[key] == null ? '' : String(attempt.conditions[key]); correctionFields[key] = select;
        const row = node('label', label); row.append(select); facts.append(row);
      }
      report.append(reason, facts, button('提交复核说明', action(async () => { if (!reason.value.trim()) throw new Error('请说明需要复核的具体位置或事实'); const conditions = Object.fromEntries(Object.entries(correctionFields).map(([key, select]) => [key, select.value === '' ? null : select.value === 'true'])); await api('practice/correct', { id: attempt.id, reason: reason.value.trim(), conditions }); await refresh(); toast('复核说明已留档，系统会重新检查证据。'); }))); target.append(report);
    }
    for (const [kind, label] of [['hint', '查看提示'], ['solution', '查看完整解析']]) {
      const help = node('section', undefined, 'practice-help'); const content = node('div', undefined, 'practice-help-content'); content.id = `practice-${kind}-content`; content.hidden = true;
      help.append(button(label, action(() => reveal(kind))), content); target.append(help);
    }
    target.append(node('p', '查看帮助会留痕；订正、同题重做与独立新题分别计证据。', 'practice-muted'));
  }
  function renderHistory(target) {
    target.append(node('h2', '作答档案'));
    const filters = node('div', undefined, 'practice-inline-actions');
    for (const [value, label] of [['all', '全部作答'], ['wrong', '错题本'], ['pending', '待核验']]) { const b = button(label, () => { historyFilter = value; renderRight(); }); b.setAttribute('aria-pressed', String(value === historyFilter)); filters.append(b); }
    target.append(filters);
    const rows = [...attempts].filter(a => historyFilter === 'all' || (historyFilter === 'wrong' ? a.grade?.verdict === 'wrong' : ['needs-review', 'source-issue'].includes(a.grade?.verdict) || ['queued', 'running', 'failed', 'needs-review'].includes(a.state))).sort((a, b) => stamp(b).localeCompare(stamp(a)));
    if (!rows.length) target.append(node('p', historyFilter === 'wrong' ? '当前没有已判定的错题。待核验记录单独保留。' : '当前没有这个范围的作答记录。'));
    for (const a of rows) {
      const item = catalog.items.find(i => i.id === a.itemId);
      const row = button('', action(async () => { if (a.lessonId?.startsWith('training-')) return enterTraining(a.lessonId, a.itemId, a.id); leaveTraining(); pinnedLessonId = a.lessonId || ''; if (item) { $('practice-track').value = item.track; $('practice-unit').value = ''; $('practice-kind').value = ''; renderUnits(); } await selectItem(a.itemId, a.id); tab = 'grade'; renderRight(); }), 'practice-history-item');
      row.append(node('strong', item?.title || a.itemId), node('span', `${VERDICTS[a.grade?.verdict] || STATES[a.state] || '已提交'} · ${date(stamp(a))}`));
      if (a.grade?.summary) { const summary = node('small', a.grade.summary); row.append(summary); math(summary); }
      if (a.parentAttemptId) row.append(node('small', '订正 / 同题重做 · 保留原提交'));
      target.append(row);
    }
  }
  function renderTopics(target) {
    target.append(node('h2', '知识点证据'), node('p', evidence.note || '掌握状态由有效作答证据计算。你可以纠正事实，不需要自评等级。', 'practice-muted'));
    const related = selected()?.topicIds || [];
    const rows = [...(evidence.topics || [])].sort((a, b) => Number(related.includes(b.id)) - Number(related.includes(a.id)));
    if (!rows.length) target.append(node('p', '尚无知识点证据。完成作答后，正确、错误与待核验记录会分别保留。'));
    for (const t of rows) {
      const card = node('article', undefined, 'practice-topic'); card.dataset.gap = t.gap || 'unknown';
      card.append(node('h3', `${t.title}${related.includes(t.id) ? ' · 本题涉及' : ''}`));
      const mastery = t.mastery == null ? '证据不足' : t.mastery >= 1 ? '延迟复测证据已达标' : t.mastery >= 0.75 ? '已有混合题证据' : '已有独立题证据';
      const gap = { unknown: '缺口未知', candidate: '发现候选缺口', confirmed: '存在待补缺口', resolved: '缺口已有修复证据' }[t.gap] || '缺口未知';
      card.append(node('p', `${mastery} · ${gap}`, 'practice-topic-state'));
      const count = node('dl', undefined, 'practice-topic-counts');
      for (const [label, value] of [['独立新题', t.independentItems], ['独立日期', t.independentDates], ['限时混合题', t.timedItems], ['待核验', t.pending]]) { const pair = node('div'); pair.append(node('dt', label), node('dd', value == null ? '未知' : String(Array.isArray(value) ? value.length : value))); count.append(pair); }
      card.append(count, node('p', `最近作答 ${date(t.lastAttemptAt)} · ${t.delayedPassed ? '已有延迟复测通过记录' : '延迟复测尚待证据'}`, 'practice-muted'));
      const names = (t.relatedTopicIds || []).map(id => catalog.topics.find(x => x.id === id)?.title || id); if (names.length) card.append(node('p', `关联：${names.join('、')}`, 'practice-muted'));
      target.append(card);
    }
  }
  function renderRight() {
    for (const b of right.querySelectorAll('[data-practice-tab]')) b.setAttribute('aria-pressed', String(b.dataset.practiceTab === tab));
    const target = $('practice-right-body'); target.replaceChildren();
    if (tab === 'training') { const report = node('div'); target.append(report); training.renderReport(report).catch(fail); }
    else if (tab === 'history') renderHistory(target); else if (tab === 'topics') renderTopics(target); else renderGrade(target);
  }
  async function loadSuggestions() {
    if (training.isActive() || $('practice-track').value === 'math1') { $('practice-suggestions').textContent = '数学题型请使用“题型训练”入口。'; return; }
    const topic = $('practice-topic'), previous = topic.value;
    topic.replaceChildren(new Option('从课程记录匹配', ''));
    const inTrack = new Set(catalog.items.filter(i => i.track === $('practice-track').value).flatMap(i => i.topicIds));
    for (const t of catalog.topics.filter(t => inTrack.has(t.id))) topic.add(new Option(t.title, t.id));
    if (inTrack.has(previous)) topic.value = previous;
    const target = $('practice-suggestions'); target.textContent = '正在匹配本节内容…';
    const plan = await api(`practice/plan?lessonId=${encodeURIComponent(lessonId())}&track=${encodeURIComponent($('practice-track').value)}&topicId=${encodeURIComponent(topic.value)}`);
    target.replaceChildren(node('p', plan.note, 'practice-muted'));
    for (const choice of plan.items) { const item = catalog.items.find(i => i.id === choice.id); if (!item) continue; const b = button(item.title, action(() => selectItem(item.id)), 'practice-suggestion'); b.title = choice.reason; target.append(b, node('p', choice.reason, 'practice-muted')); }
  }
  async function bootstrap() {
    bootError = '';
    try {
      catalog = catalogForSubject(await api('practice/catalog'), subject); loadedItems.clear(); ready = true;
      const match = `${getState().course.title} ${getState().course.videoName}`.match(/8[._-]?0([123])/); if (match) $('practice-track').value = `8.0${match[1]}`;
      renderSources(); renderUnits(); renderItems(); await refresh(); await loadSuggestions();
      const query = new URLSearchParams(location.search);
      if (query.has('training') || query.get('lesson')?.startsWith('training-')) { await enterTraining(query.get('training') || query.get('lesson'), query.get('practice'), query.get('attempt')); }
      else if (query.has('practice')) { pinnedLessonId = query.get('lesson') || ''; show(true); await selectItem(query.get('practice'), query.get('attempt')); }
      else if (subject === 'math') await enterTraining();
      else if (active && !selectedId && filteredItems()[0]) await selectItem(filteredItems()[0].id);
    } catch (error) { bootError = `题源读取失败：${error.message}`; renderItems(); }
  }
  function onLessonChange() {
    if (lastLessonId === getState().lessonId) return;
    if (training.isActive()) { lastLessonId = getState().lessonId; return; }
    for (const d of drafts.values()) if (d.dirty) saveDraft(d).catch(() => {});
    lastLessonId = getState().lessonId; pinnedLessonId = ''; selectedId = ''; viewedAttempt = null; activePage = 0; selectEpoch++;
    const match = `${getState().course.title} ${getState().course.videoName}`.match(/8[._-]?0([123])/); if (match) $('practice-track').value = `8.0${match[1]}`;
    renderUnits(); renderItems(); renderQuestion(); renderAnswer(); renderRight();
    if (active && ready && filteredItems()[0]) selectItem(filteredItems()[0].id).catch(fail);
    if (ready) loadSuggestions().catch(fail);
  }
  $('show-course-workspace').addEventListener('click', () => { leaveTraining(); show(false); });
  $('show-practice-workspace').addEventListener('click', () => { leaveTraining(); show(true); });
  $('show-training-workspace').addEventListener('click', action(() => enterTraining()));
  $('practice-track').addEventListener('change', action(async () => { await applyFilterChange(true); await loadSuggestions(); }));
  $('practice-topic').addEventListener('change', () => loadSuggestions().catch(fail));
  $('practice-current-item').addEventListener('change', action(e => { if (e.target.value) return selectItem(e.target.value); }));
  for (const id of ['practice-unit', 'practice-kind']) $(id).addEventListener('change', action(() => applyFilterChange()));
  for (const b of right.querySelectorAll('[data-practice-tab]')) b.addEventListener('click', () => { tab = b.dataset.practiceTab; renderRight(); });
  $('practice-page').addEventListener('change', e => setPage(Number(e.target.value)));
  $('practice-prev-page').addEventListener('click', () => setPage(activePage - 1)); $('practice-next-page').addEventListener('click', () => setPage(activePage + 1));
  $('practice-add-page').addEventListener('click', () => { if (!canEdit()) return; current().snapshot.pages.push({ objects: [] }); setPage(pages().length - 1); });
  for (const [id, name] of [['practice-closed-book', 'closedBook'], ['practice-first-seen', 'firstSeen'], ['practice-guessed', 'guessed']]) $(id).addEventListener('change', e => { if (!canEdit()) return; current().snapshot.conditions[name] = e.target.value === '' ? null : e.target.value === 'true'; markDirty(); renderAnswer(); });
  $('practice-note').addEventListener('input', e => { if (canEdit()) { current().snapshot.note = e.target.value; markDirty(); } });
  footer.addEventListener('submit', action(submit));
  $('practice-save-retry').addEventListener('click', action(() => saveDraft()));
  $('practice-export-draft').addEventListener('click', () => { const d = current(); if (!d) return; const content = d.recoveryConflict || { revision: d.revision, snapshot: d.snapshot }; const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' })); const a = node('a'); a.href = url; a.download = `${d.itemId}-unsaved-draft.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
  document.addEventListener('keydown', e => { if (!active || !e.altKey || e.target.closest('input, textarea, select')) return; if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setPage(activePage + (e.key === 'ArrowRight' ? 1 : -1)); } });
  document.addEventListener('keydown', e => {
    if (!active || e.defaultPrevented || e.repeat || e.isComposing || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !['ArrowRight', 'Enter'].includes(e.key)) return;
    if (e.target.closest('input, textarea, select, button, a, summary, [contenteditable="true"]') || document.querySelector('dialog[open]')) return;
    e.preventDefault(); navigateTraining();
  });
  window.addEventListener('beforeunload', () => { for (const d of drafts.values()) if (d.dirty) backup(d); });
  return { bootstrap, isActive: () => active, getObjects: objects, canEdit, markDirty, onLessonChange, renderAnnotations,
    getSecondaryQuestion, navigateTraining,
    async saveDrafts() { for (const d of drafts.values()) if (d.dirty || d.saving) await saveDraft(d); },
    async showCourse() { for (const d of drafts.values()) if (d.dirty || d.saving) await saveDraft(d); leaveTraining(); show(false); },
    async openItem(id) { for (const d of drafts.values()) if (d.dirty || d.saving) await saveDraft(d); leaveTraining(); pinnedLessonId = ''; $('practice-track').value = '8.01'; $('practice-unit').value = ''; $('practice-kind').value = ''; renderUnits(); renderItems(); show(true); await selectItem(id); },
    setQuestionScreenConnected: value => { screenConnected = value; updateQuestionPlacement(); } };
}
