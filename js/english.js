import { CHANNEL_NAME, formatTime } from './core.js';
import { PHASES, emptyEnglishState, applyEnglishEvent } from './english-state.js';

const HELP = { dictionary: '查词', translation: '中文译文', slides: '讲解课件', notes: '课程笔记', annotations: '批注讲义', video: '视频讲解', other: '其他帮助' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const minutes = seconds => `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`;
async function api(path, payload) {
  const response = await fetch(`/api/english${path}`, { headers: { 'X-Study-Desk': '1', ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    ...(payload ? { method: 'POST', body: JSON.stringify(payload) } : {}) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '本地保存失败'); return data;
}

export async function mountEnglish() {
  document.title = '英语 · 学习台'; document.body.className = 'english-body'; document.body.dataset.subject = 'english';
  document.body.innerHTML = `
    <header class="english-header">
      <nav class="subject-navigation"><a id="english-back" href="./">← 返回入口</a><strong>英语</strong></nav>
      <div class="english-identity"><strong>Study Desk 英语</strong><span>长文本阅读训练</span></div>
      <label class="english-picker">课程视频<select id="english-course" aria-label="英语课程"></select></label>
      <span id="english-save" role="status">正在读取本地记录</span>
      <button id="english-export">导出本课记录</button><button id="english-retry" hidden>重试保存</button>
      <button id="english-appearance">切换外观</button><button id="english-player" class="primary-button">打开副屏讲解</button>
    </header>
    <p class="public-demo-notice">公开作品演示 · 仓库仅附合成材料；预置诊断不代表实时模型输出。npm start 不调用在线模型。</p><nav class="english-tabs" aria-label="英语学习板块"><button data-pane="reading" aria-pressed="true">长文本阅读</button><button data-pane="samples" aria-pressed="false">阶段抽样</button><button data-pane="practice" aria-pressed="false">阅读错题诊断</button></nav>
    <main class="english-layout" id="english-reading">
      <aside class="english-side english-overview">
        <p class="english-eyebrow">本课训练</p><h1 id="english-title"></h1>
        <div id="english-phases" class="english-phases">${Object.entries(PHASES).map(([key, value], i) => `<button data-phase="${key}"><span>0${i + 1}</span>${value}</button>`).join('')}</div>
        <div class="english-clock"><span id="english-timer">尚未开始计时</span><button id="english-timer-toggle">开始阅读计时</button><small>离开页面或打开讲解时暂停；回来后手动继续。</small></div>
        <button id="english-resume">回到上次阅读位置</button>
        <label class="english-complete"><input id="english-complete" type="checkbox">本课训练已完成</label>
        <section class="english-observation"><h2>训练记录</h2><div id="english-process"></div></section>
        <section class="english-observation"><h2>课程推进</h2><p id="english-progress"></p><small>完成状态由你确认，播放位置不代表看完。</small></section>
        <section class="english-observation"><h2>能力变化</h2><p id="english-ability">尚未测量</p><small>课程完成与训练用时不换算为能力分数。</small></section>
      </aside>
      <section class="english-reader-shell">
        <header class="english-reader-header"><div><h2>英文原文</h2><p>先独立读，遇到不懂的地方留下卡点。</p></div><button id="english-original">核对原 PDF</button></header>
        <div class="english-reader-note">公开演示使用新编短文。自行导入的材料请结合原件核对。</div>
        <article id="english-text" class="english-text" aria-label="英文原文"></article>
      </section>
      <aside class="english-side english-notes">
        <h2>本讲资料</h2><p class="english-muted">需要时再打开，使用帮助会留在本课记录中。</p><div id="english-assets" class="english-assets"></div>
        <div class="english-helpers"><button id="english-dictionary">记一次查词</button><button id="english-other-help">记其他帮助</button></div>
        <details class="english-timeline" open><summary><span>讲解线性笔记</span><small id="english-timed-note-count"></small></summary><p id="english-timed-note-status" class="english-muted"></p><div id="english-timed-notes" class="english-timed-notes"></div></details>
        <h2 class="english-blocker-heading">阅读卡点 <span id="english-blocker-count"></span></h2><p class="english-muted">点原文旁的“没读懂”。看讲解后回到原文，再确认是否解决。</p><div id="english-blockers"></div>
        <details class="english-help-history"><summary>帮助使用记录</summary><div id="english-help-log"></div></details>
      </aside>
    </main>
    <section id="english-samples" class="english-secondary" hidden>
      <header><p class="english-eyebrow">阶段性留下一个样本</p><h1>换一篇新文章，再试一次</h1><p>每完成一个训练单元，选题材和难度尽量相近、没看过讲解的文章。允许看原文、用中文回答，不必每课都做。</p></header>
      <div class="english-sample-layout"><form id="english-sample-form">
        <label>文章标题<input name="title" required maxlength="5000"></label><label>来源 / 链接（可留空）<input name="source" maxlength="5000"></label>
        <label>新文章原文<textarea name="article" rows="8" required maxlength="100000" placeholder="粘贴本次独立阅读的新文章，保留核对依据。"></textarea></label>
        <div class="english-form-row"><label>未读过、未看过讲解？<select name="unseen"><option value="">尚未确认</option><option value="yes">是</option><option value="no">否</option></select></label><label>与训练材料题材、难度相近？<select name="comparable"><option value="">尚未确认</option><option value="yes">是，自述</option><option value="no">否</option></select></label></div>
        <div class="english-form-row"><label>阅读用时（分钟，未知留空）<input name="minutes" type="number" min="0" max="1440" step="0.1"></label><label>用了哪些帮助？<input name="help" placeholder="如查词 3 次；无帮助请写“无”；未知留空" maxlength="5000"></label></div>
        <label>作者主要想说什么？<textarea name="mainIdea" rows="3" required maxlength="5000"></textarea></label>
        <label>几个段落分别起什么作用，怎样连起来？<textarea name="structure" rows="3" required maxlength="5000"></textarea></label>
        <label>作者用什么理由支持结论？原文依据在哪里？<textarea name="evidence" rows="3" required maxlength="5000"></textarea></label>
        <p class="english-muted">提交后保留原始表现，状态为待核验。本版不自动评分或生成能力趋势。</p><button class="primary-button" type="submit">保存这次独立阅读表现</button>
      </form><aside><h2>本课关联的抽样记录</h2><div id="english-sample-history"></div></aside></div>
    </section>
    <section id="english-practice" class="english-secondary" hidden>
      <header><p class="english-eyebrow">阅读方法与证据</p><h1>把错题交给 GPT 定位</h1><p>不要求你解释为什么错。填入题目、选项、你的答案和正确答案；文章留空时使用当前课程原文。GPT 会先区分语言遮挡和阅读动作问题，证据不足时只追问一个选择题。</p></header>
      <div class="english-diagnosis-layout"><form id="english-diagnosis-form">
        <div class="english-form-row"><label>大致文体（不确定即可留给 GPT）<select name="genreHint"><option value="unknown">不确定</option><option value="application">应用文</option><option value="narrative">记叙文</option><option value="expository">说明文</option><option value="argumentative">议论文</option><option value="seven-choice">七选五 / 新题型</option></select></label><label>做题时的语言情况<select name="languageSignal"><option value="uncertain">不确定</option><option value="none">没有明显生词或句法障碍</option><option value="word">有关键词不认识</option><option value="syntax">有句子结构没读懂</option></select></label></div>
        <label>另贴文章（留空则用当前课程原文）<textarea name="article" rows="7" maxlength="120000" placeholder="做外部题时粘贴文章；当前课程内做题可以留空。"></textarea></label>
        <label>题目<textarea name="question" rows="3" required maxlength="10000"></textarea></label>
        <label>选项<textarea name="options" rows="5" required maxlength="30000" placeholder="A. ...&#10;B. ...&#10;C. ...&#10;D. ..."></textarea></label>
        <div class="english-form-row"><label>你的答案<input name="selectedAnswer" required maxlength="1000" placeholder="如 B"></label><label>正确答案<input name="correctAnswer" required maxlength="1000" placeholder="如 D"></label></div>
        <label>你在文中划过或犹豫的内容（可留空）<textarea name="markedText" rows="3" maxlength="10000"></textarea></label>
        <p class="english-muted">调用本机已登录的 Codex。只发送本题文本、所选答案和检索到的课程片段；不发送视频、文件路径或其他学习记录。结果保存为观察，不自动生成掌握分。</p>
        <button id="english-diagnose" class="primary-button" type="submit">让 GPT 按课程方法诊断</button>
      </form><aside><h2>本课诊断记录</h2><div id="english-diagnosis-history"></div></aside></div>
    </section>
    <dialog id="english-asset-dialog" class="english-asset-dialog"><header><strong id="english-asset-title"></strong><button id="english-close-asset">返回原文</button></header><iframe id="english-asset-frame" title="课程资料 PDF"></iframe></dialog>
    <p id="english-error" class="english-error" role="alert" hidden></p>`;
  const $ = id => document.getElementById(id);
  let catalog = [], course, state = emptyEnglishState(), revision = null, pending = [], saving = null, saveError = null;
  let pane = 'reading', ticking = false, elapsed = 0, lastTick = performance.now(), video = null, playerWindow = null, switching = false, loadingCourse = false;
  let draftTimeout, positionTimeout, restoring = false;
  const session = `english-${crypto.randomUUID()}`, channel = new BroadcastChannel(`${CHANNEL_NAME}-${session}`);
  const error = e => { $('english-error').textContent = e.message; $('english-error').hidden = false; };
  const action = fn => async event => { try { await fn(event); } catch (e) { error(e); } };
  function saveLabel() {
    const dirty = pending.length || draftTimeout;
    $('english-save').textContent = saveError ? `未保存：${saveError.message}` : loadingCourse ? '正在切换课程…' : dirty ? '正在保存到本地…' : '已保存到本地';
    $('english-save').dataset.state = saveError ? 'error' : loadingCourse ? 'loading' : dirty ? 'saving' : 'saved';
    $('english-retry').hidden = !saveError;
  }
  async function drain() {
    if (saving) return saving;
    if (!pending.length) { saveError = null; saveLabel(); return; }
    saving = (async () => {
      try {
        while (pending.length) {
          const e = pending[0], result = await api('/event', { lessonId: course.lessonId, expectedRevision: revision, event: e });
          revision = result.revision; pending.shift();
        }
        saveError = null;
      } catch (e) { saveError = e; error(e); }
      finally { saving = null; saveLabel(); }
    })();
    return saving;
  }
  function record(type, payload) {
    if (!course || switching) return;
    const event = { id: crypto.randomUUID(), type, payload, at: new Date().toISOString() };
    state = applyEnglishEvent(state, event, course); pending.push(event); saveLabel();
    if (!saveError) void drain();
    renderStats();
  }
  function sampleValues() { return Object.fromEntries(new FormData($('english-sample-form')).entries()); }
  function saveDraft() { clearTimeout(draftTimeout); if (draftTimeout) { draftTimeout = null; record('sample-draft', sampleValues()); } }
  function flushPosition() { clearTimeout(positionTimeout); if (positionTimeout) { positionTimeout = null; rememberPosition(); } }
  async function flush() { saveDraft(); flushPosition(); await drain(); if (pending.length) throw saveError || new Error('记录尚未保存，请重试或先导出记录'); }
  function timerLabel() {
    $('english-timer').textContent = `${PHASES[state.phase]} · ${minutes(state.seconds[state.phase] + elapsed)}`;
    $('english-timer-toggle').textContent = ticking ? '暂停计时' : '开始阅读计时';
    $('english-timer-toggle').disabled = !course?.blocks.length || state.phase === 'explanation';
  }
  function tick() {
    const now = performance.now();
    if (ticking) elapsed += Math.min(2, (now - lastTick) / 1000);
    lastTick = now;
    if (elapsed >= 15) commitTime(); timerLabel();
  }
  function commitTime() { if (elapsed > 0) { const seconds = elapsed; elapsed = 0; record('time', { phase: state.phase, seconds }); } }
  function pauseTimer() { tick(); ticking = false; commitTime(); timerLabel(); }
  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { pauseTimer(); saveDraft(); flushPosition(); } });
  function renderStats() {
    if (!course) return;
    timerLabel();
    $('english-process').innerHTML = `<p>独立阅读 ${minutes(state.seconds.independent)}</p><p>回读 ${minutes(state.seconds.reread)}</p><p>视频停在 ${formatTime(state.videoTime)}</p><p>卡点 ${state.blockers.length} 处 · 已解决 ${state.blockers.filter(b => b.resolved).length} 处</p><p>帮助记录 ${state.helps.length} 次</p>`;
    const completed = catalog.filter(c => c.lessonId === course.lessonId ? state.completed : c.completed).length;
    $('english-progress').textContent = `${completed} / ${catalog.length} 课已确认完成训练`;
    $('english-ability').textContent = state.samples.length ? `${state.samples.length} 次抽样待核验；能力变化尚未确认` : '尚未测量';
    $('english-blocker-count').textContent = `${state.blockers.filter(b => !b.resolved).length} 处待解决`;
    $('english-complete').checked = state.completed;
    for (const b of document.querySelectorAll('[data-phase]')) b.setAttribute('aria-pressed', String(b.dataset.phase === state.phase));
  }
  function renderHelp() {
    $('english-help-log').innerHTML = state.helps.length ? state.helps.slice().reverse().map(h => `<p>${esc(HELP[h.kind])} · ${esc(PHASES[h.phase])}<small>${esc(new Date(h.at).toLocaleString())}</small></p>`).join('') : '<p>尚无帮助记录。</p>';
  }
  function renderTimedNotes() {
    const notes = course?.timedNotes || [];
    $('english-timed-note-count').textContent = notes.length ? `${notes.length} 条` : '暂无';
    $('english-timed-note-status').textContent = notes.length
      ? '自动摘录，未经逐句精校。点时间戳会打开副屏并跳到附近位置。'
      : '本课尚无带时间戳的线性笔记。';
    $('english-timed-notes').innerHTML = notes.map(note => `<button type="button" data-note-time="${note.seconds}"><time>${esc(note.time)}</time><span>${esc(note.text)}</span></button>`).join('');
    updateTimedNote(state.videoTime);
  }
  function updateTimedNote(time) {
    const buttons = [...$('english-timed-notes').querySelectorAll('[data-note-time]')];
    let active = null;
    for (const button of buttons) {
      if (Number(button.dataset.noteTime) <= time) active = button;
      else break;
    }
    for (const button of buttons) button.toggleAttribute('aria-current', button === active);
  }
  async function help(kind) { record('help', { kind }); renderHelp(); await flush(); }
  function renderBlockers() {
    $('english-blockers').innerHTML = state.blockers.length ? state.blockers.map(b => {
      const block = course.blocks.find(p => p.id === b.blockId);
      return `<section class="english-blocker ${b.resolved ? 'resolved' : ''}" data-blocker="${b.id}"><button class="english-blocker-source" data-jump="${esc(b.blockId)}">第 ${block.page} 页 · 回到原文</button><blockquote>${esc(block.text.slice(0, 150))}${block.text.length > 150 ? '…' : ''}</blockquote><label>卡在哪里 / 回读后理解<textarea data-resolution="${b.id}" rows="2" maxlength="4000">${esc(b.resolution)}</textarea></label><label class="english-resolved"><input type="checkbox" data-resolved="${b.id}" ${b.resolved ? 'checked' : ''}>回到原文后已解决</label></section>`;
    }).join('') : '<p class="english-empty">还没有卡点。阅读时顺手标记即可，不必每段写总结。</p>';
  }
  function renderSamples() {
    $('english-sample-history').innerHTML = state.samples.length ? state.samples.slice().reverse().map(s => `<details class="english-sample"><summary>${esc(s.title)} · 待核验</summary><p>${esc(new Date(s.at).toLocaleString())} · ${s.minutes === null ? '用时未知' : `${s.minutes} 分钟`}</p><p>首次阅读：${s.unseen === 'yes' ? '是，自述' : s.unseen === 'no' ? '否' : '未知'} · 可比性：${s.comparable === 'yes' ? '自述相近，待核验' : s.comparable === 'no' ? '不相近' : '未知'}</p><p>帮助：${esc(s.help || '未知')}</p><h3>主旨</h3><p>${esc(s.mainIdea)}</p><h3>结构</h3><p>${esc(s.structure)}</p><h3>依据</h3><p>${esc(s.evidence)}</p><h3>来源</h3><p>${esc(s.source || '未填写')}</p><h3>原文</h3><p class="english-sample-article">${esc(s.article)}</p></details>`).join('') : '<p class="english-empty">尚无抽样记录。先完成一个训练单元，再用新文章留下第一次表现。</p>';
  }
  const GENRE_LABEL = { application: '应用文', narrative: '记叙文', expository: '说明文', argumentative: '议论文', 'seven-choice': '七选五 / 新题型', unknown: '文体待确认' };
  const TYPE_LABEL = { detail: '细节题', 'main-idea': '主旨题', completion: '篇章衔接题', unknown: '题型待确认' };
  function renderDiagnoses() {
    $('english-diagnosis-history').innerHTML = state.diagnoses.length ? state.diagnoses.slice().reverse().map(item => {
      const d = item.diagnosis, sources = item.sources.filter(source => d.sourceIds.includes(source.id));
      const probe = item.confirmation ? `<p class="english-diagnosis-confirmed">你确认：${esc(item.confirmation.label)}</p>` : d.probe.choices.length ? `<section class="english-diagnosis-probe"><strong>${esc(d.probe.question)}</strong>${d.probe.choices.map(choice => `<button type="button" data-diagnosis="${esc(item.id)}" data-probe="${esc(choice.id)}">${esc(choice.label)}</button>`).join('')}</section>` : '';
      return `<article class="english-diagnosis"><header><strong>${esc(d.causeLabel || '暂未定位')}</strong><span>${esc(GENRE_LABEL[d.genre] || d.genre)} · ${esc(TYPE_LABEL[d.questionType] || d.questionType)} · 把握 ${esc(d.certainty)}</span></header><p>${esc(d.summary)}</p><h3>这题应做什么</h3><p>${esc(d.expectedAction)}</p><h3>原文与选项</h3><p>${esc(d.articleEvidence)}</p><p>${esc(d.chosenAnswerProblem)}</p><p>${esc(d.correctAnswerReason)}</p><h3>当前判断</h3><p>${esc(d.reason)}</p>${probe}<h3>下一步</h3><p>${esc(d.nextAction)}</p>${sources.length ? `<details><summary>本次参考的课程片段</summary>${sources.map(source => `<p>${esc(source.category)} · ${esc(source.part)} · ${esc(source.start)}–${esc(source.end)}</p>`).join('')}</details>` : ''}</article>`;
    }).join('') : '<p class="english-empty">尚无诊断。GPT 只能看到你这次提交的题目和相关课程片段。</p>';
  }
  function rememberPosition() {
    if (!course || restoring || switching || pane !== 'reading') return;
    const top = $('english-text').getBoundingClientRect().top;
    const block = [...document.querySelectorAll('.english-paragraph')].find(p => p.getBoundingClientRect().bottom > top + 50);
    if (block && block.dataset.block !== state.position) record('position', { blockId: block.dataset.block });
  }
  function jump(id) {
    const target = [...document.querySelectorAll('.english-paragraph')].find(p => p.dataset.block === id);
    if (target) { restoring = true; target.scrollIntoView({ block: 'start' }); target.focus({ preventScroll: true }); setTimeout(() => { restoring = false; }, 300); }
  }
  function initPlayer() {
    if (!course) return;
    channel.postMessage({ type: 'init', lessonId: course.lessonId, courseTitle: course.title, theme: '英语长文本阅读', player: { currentTime: state.videoTime, rate: state.videoRate } });
    if (video) channel.postMessage({ type: 'load-video', ...video, currentTime: state.videoTime, rate: state.videoRate });
  }
  function playerPopup() {
    if (!playerWindow || playerWindow.closed) playerWindow = window.open(`player.html?session=${session}`, `english-player-${session}`, 'popup,width=1120,height=760');
    if (!playerWindow) throw new Error('浏览器阻止了播放器窗口，请允许本地页面弹窗后重试');
  }
  function seekOpenPlayer(time) {
    if (!Number.isFinite(time) || !playerWindow || playerWindow.closed) return false;
    try {
      return playerWindow.studyDeskPlayerBridge?.seekFromMain(course.lessonId, time) === true;
    } catch {
      return false;
    }
  }
  async function openLecture({ time = null, helpKind = 'video' } = {}) {
    playerPopup();
    const soughtOpenPlayer = seekOpenPlayer(time);
    pauseTimer(); record('phase', { phase: 'explanation' }); await help(helpKind);
    $('english-player').disabled = true; $('english-player').textContent = '正在核对视频内容…';
    const lessonId = course.lessonId;
    try {
      if (!video) video = await api('/video', { lessonId });
      if (course.lessonId === lessonId) {
        initPlayer();
        if (Number.isFinite(time) && !soughtOpenPlayer) channel.postMessage({ type: 'player-command', command: 'seek', time });
        if (!soughtOpenPlayer) playerWindow.focus();
      }
    } finally {
      $('english-player').disabled = !course.hasVideo;
      $('english-player').textContent = course.hasVideo ? '打开副屏讲解' : '本课视频待补';
    }
  }
  let lastVideoSave = 0;
  channel.onmessage = action(async ({ data }) => {
    if (data.type === 'player-ready') { initPlayer(); return; }
    if (data.type === 'player-error') { error(new Error(data.message)); return; }
    if (data.type !== 'player-state' || data.lessonId !== course?.lessonId || switching) return;
    const time = data.player.currentTime, now = Date.now();
    updateTimedNote(time);
    if (now - lastVideoSave > 5000 || !data.player.playing) {
      if (Math.abs(time - state.videoTime) > .1 || data.player.rate !== state.videoRate) record('video', { time: Math.min(time, course.duration || 86400), rate: data.player.rate });
      lastVideoSave = now;
    }
  });
  async function openCourse(id) {
    if (loadingCourse) return;
    loadingCourse = true; $('english-course').disabled = true; saveLabel();
    for (const key of ['reading', 'samples', 'practice']) $('english-' + key).inert = true;
    try {
      if (course) {
        pauseTimer(); channel.postMessage({ type: 'player-command', command: 'pause' }); await flush();
        Object.assign(catalog.find(c => c.lessonId === course.lessonId), { completed: state.completed });
      }
      switching = true;
      const next = await api(`/course?id=${encodeURIComponent(id)}`);
      channel.postMessage({ type: 'unload-video' }); video = null;
      course = next; state = next.state; revision = next.revision; pending = []; saveError = null;
      $('english-error').hidden = true;
      document.body.dataset.lessonId = course.lessonId;
      $('english-course').value = id; $('english-title').textContent = course.title;
      $('english-player').disabled = !course.hasVideo;
      $('english-player').textContent = course.hasVideo ? '打开副屏讲解' : '本课视频待补';
      $('english-original').disabled = !course.originalAssetId;
      $('english-text').innerHTML = course.blocks.length ? course.blocks.map(b => `<section class="english-paragraph" data-block="${esc(b.id)}" tabindex="-1"><div class="english-paragraph-meta"><span>${course.originalAssetId ? '原 PDF' : '阅读材料'} · 第 ${b.page} 页</span><button data-pin="${esc(b.id)}">没读懂</button></div><p lang="en">${esc(b.text)}</p></section>`).join('') : '<p class="english-empty">本课英文原文尚未提供。现有译文可查阅，独立阅读训练等待补齐原文。</p>';
      $('english-assets').innerHTML = course.assets.filter(a => a.kind !== 'original').map(a => `<button data-asset="${esc(a.id)}">${esc(a.title)}</button>`).join('');
      for (const input of $('english-sample-form').elements) if (input.name) input.value = state.sampleDraft[input.name] || '';
      renderStats(); renderHelp(); renderTimedNotes(); renderBlockers(); renderSamples(); renderDiagnoses(); saveLabel();
      const url = new URL(location.href); url.searchParams.set('subject', 'english'); url.searchParams.set('lesson', id); history.replaceState(null, '', url);
      try { localStorage.setItem('study-desk-last-english', id); } catch {}
      restoring = true; $('english-text').scrollTop = 0;
      setTimeout(() => { if (state.position) jump(state.position); else restoring = false; }, 50);
      initPlayer();
    } finally {
      switching = false; loadingCourse = false; $('english-course').disabled = false;
      for (const key of ['reading', 'samples', 'practice']) $('english-' + key).inert = false;
      saveLabel();
    }
  }
  async function showPane(name) {
    pauseTimer(); saveDraft(); await flush(); pane = name;
    for (const key of ['reading', 'samples', 'practice']) $('english-' + key).hidden = key !== name;
    document.querySelectorAll('[data-pane]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.pane === name)));
  }
  async function showAsset(assetId, page = 1) {
    pauseTimer(); const asset = course.assets.find(a => a.id === assetId);
    if (asset.kind !== 'original') await help(asset.kind);
    const data = await api('/asset', { lessonId: course.lessonId, assetId });
    $('english-asset-title').textContent = data.title;
    $('english-asset-frame').src = `${data.url}#page=${page}`; $('english-asset-dialog').showModal();
  }
  $('english-course').onchange = action(async () => { const target = $('english-course').value; try { await openCourse(target); } catch (e) { $('english-course').value = course?.lessonId || ''; throw e; } });
  $('english-phases').onclick = action(async e => { const b = e.target.closest('[data-phase]'); if (!b) return; pauseTimer(); record('phase', { phase: b.dataset.phase }); await flush(); });
  $('english-timer-toggle').onclick = () => { if (ticking) pauseTimer(); else { ticking = true; lastTick = performance.now(); timerLabel(); } };
  $('english-complete').onchange = () => record('complete', { value: $('english-complete').checked });
  $('english-resume').onclick = () => jump(state.position || course.blocks[0]?.id);
  $('english-text').onscroll = () => { if (restoring) return; clearTimeout(positionTimeout); positionTimeout = setTimeout(() => { positionTimeout = null; rememberPosition(); }, 500); };
  $('english-text').onclick = e => { const b = e.target.closest('[data-pin]'); if (!b) return; record('position', { blockId: b.dataset.pin }); record('blocker-add', { blockId: b.dataset.pin }); renderBlockers(); };
  $('english-blockers').onclick = e => { const b = e.target.closest('[data-jump]'); if (b) jump(b.dataset.jump); };
  $('english-blockers').oninput = e => {
    const id = e.target.dataset.resolution || e.target.dataset.resolved; if (!id) return;
    const wrapper = e.target.closest('[data-blocker]');
    record('blocker-update', { id, resolution: wrapper.querySelector('textarea').value, resolved: wrapper.querySelector('input').checked });
    wrapper.classList.toggle('resolved', wrapper.querySelector('input').checked);
  };
  $('english-assets').onclick = action(async e => { const b = e.target.closest('[data-asset]'); if (b) await showAsset(b.dataset.asset); });
  $('english-timed-notes').onclick = action(async e => { const b = e.target.closest('[data-note-time]'); if (b) await openLecture({ time: Number(b.dataset.noteTime), helpKind: 'notes' }); });
  $('english-original').onclick = action(() => showAsset(course.originalAssetId, course.blocks.find(b => b.id === state.position)?.page || 1));
  $('english-close-asset').onclick = () => $('english-asset-dialog').close();
  $('english-asset-dialog').onclose = () => { $('english-asset-frame').src = 'about:blank'; };
  $('english-dictionary').onclick = action(() => help('dictionary'));
  $('english-other-help').onclick = action(() => help('other'));
  $('english-player').onclick = action(async () => {
    await openLecture();
  });
  document.querySelectorAll('[data-pane]').forEach(b => b.onclick = action(() => showPane(b.dataset.pane)));
  $('english-sample-form').oninput = () => { clearTimeout(draftTimeout); draftTimeout = setTimeout(saveDraft, 600); saveLabel(); };
  $('english-sample-form').onsubmit = action(async e => {
    e.preventDefault(); saveDraft(); record('sample-submit', sampleValues()); await flush();
    $('english-sample-form').reset(); renderSamples(); $('english-samples').scrollTop = 0;
  });
  $('english-diagnosis-form').onsubmit = action(async e => {
    e.preventDefault(); pauseTimer(); await flush();
    const task = Object.fromEntries(new FormData(e.currentTarget).entries());
    const button = $('english-diagnose'); button.disabled = true; button.textContent = 'GPT 正在按课程方法分析…';
    try {
      const result = await api('/diagnose', { lessonId: course.lessonId, ...task });
      record('diagnosis-add', { task, diagnosis: result.diagnosis, sources: result.sources, usage: result.usage });
      await flush(); renderDiagnoses();
    } finally { button.disabled = false; button.textContent = '让 GPT 按课程方法诊断'; }
  });
  $('english-diagnosis-history').onclick = e => {
    const button = e.target.closest('[data-diagnosis][data-probe]'); if (!button) return;
    record('diagnosis-confirm', { id: button.dataset.diagnosis, choiceId: button.dataset.probe }); renderDiagnoses();
  };
  $('english-retry').onclick = action(() => flush());
  $('english-back').onclick = action(async e => { e.preventDefault(); pauseTimer(); await flush(); channel.postMessage({ type: 'unload-video' }); location.href = './'; });
  window.addEventListener('beforeunload', e => { pauseTimer(); saveDraft(); flushPosition(); if (pending.length) { e.preventDefault(); e.returnValue = ''; } });
  $('english-export').onclick = action(async () => {
    pauseTimer(); saveDraft(); flushPosition();
    const saved = await api(`/export?id=${course.lessonId}`);
    const blob = new Blob([JSON.stringify({ format: 'study-desk-english-records-v1', lessonId: course.lessonId, exportedAt: new Date().toISOString(), saved, unsaved: pending, localState: state }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `${course.lessonId}-records.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  function appearanceLabel() { $('english-appearance').textContent = `外观：${document.documentElement.dataset.colorMode === 'light' ? '浅色' : '深色'}`; }
  $('english-appearance').onclick = () => { const mode = document.documentElement.dataset.colorMode === 'light' ? 'dark' : 'light'; document.documentElement.dataset.colorMode = mode; document.documentElement.style.colorScheme = mode; try { localStorage.setItem('study-desk-color-mode', mode); } catch {} appearanceLabel(); };
  appearanceLabel();
  catalog = (await api('')).courses;
  if (!catalog.length) { $('english-text').textContent = 'Study Desk 英语资料尚未导入。'; $('english-save').textContent = '等待课程资料'; document.querySelectorAll('.english-body button,.english-body input,.english-body select,.english-body textarea').forEach(b => { b.disabled = true; }); return; }
  $('english-course').innerHTML = catalog.map(c => `<option value="${c.lessonId}">${esc(c.title)}${c.hasVideo ? '' : ' · 视频待补'}${c.hasOriginal ? '' : ' · 原文待补'}</option>`).join('');
  let preferred = new URL(location.href).searchParams.get('lesson');
  try { preferred ||= localStorage.getItem('study-desk-last-english'); } catch {}
  await openCourse(catalog.some(c => c.lessonId === preferred) ? preferred : catalog[0].lessonId);
}
