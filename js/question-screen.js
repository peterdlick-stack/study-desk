// Teaching content is sent only after the main page records its help exposure.
export function mountQuestionScreen({ channel, viewerId, toggleFullscreen }) {
  const $ = id => document.getElementById(id);
  const panel = $('question-screen');
  const owner = window.opener;
  let view = { active: false }, zoom = 100, online = true, pending = false, requestedFullscreen = false;
  const text = (tag, value, cls) => { const e = document.createElement(tag); e.textContent = value || ''; if (cls) e.className = cls; return e; };
  function acknowledge() {
    if (view.active && online) channel.postMessage({ type: 'question-view-ready', viewerId, trainingId: view.trainingId, itemId: view.item?.id || '' });
  }
  function scale(value) {
    zoom = Math.min(200, Math.max(75, value));
    $('question-paper').style.width = `${zoom}%`;
    $('question-zoom-value').textContent = `${zoom}%`;
    $('question-zoom-out').disabled = zoom <= 75; $('question-zoom-in').disabled = zoom >= 200;
  }
  function show(next) {
    const changed = view.trainingId !== next.trainingId || view.item?.id !== next.item?.id || view.phase !== next.phase;
    view = next; online = true; pending = false;
    panel.hidden = !view.active;
    document.body.classList.toggle('question-mode', Boolean(view.active));
    if (!view.active) { document.title = '课程播放器'; return; }
    document.title = `${view.groupTitle || '题型训练'} · 副屏看题`;
    $('question-group').textContent = view.groupTitle || '题型训练';
    $('question-position').textContent = view.phase === 'loading' ? '正在载入题目…' : view.phase === 'method' ? '方法讲解与例题' : view.item ? `第 ${view.position} / ${view.total} ${view.itemMode === 'pages' ? '页' : '题'}` : '等待选择题目';
    connectionStatus();
    $('question-next').disabled = !view.item || view.phase === 'loading' || (view.phase === 'question' && view.position >= view.total);
    $('question-next').textContent = view.phase === 'method' ? '开始做题 →' : view.position >= view.total ? `已到最后一${view.itemMode === 'pages' ? '页' : '题'}` : `下一${view.itemMode === 'pages' ? '页' : '题'} →`;
    $('question-navigation-hint').textContent = view.phase === 'method' ? '→ / Enter 开始做题 · 主屏手写' : view.position >= view.total ? (view.mode === 'practice' ? '当前列表已展示完 · 请在主屏提交作答、查看批改' : '本组题目已展示完 · 请在主屏提交作答、查看复盘') : '→ / Enter 下一题 · 自动保存草稿，切题不自动提交';
    const paper = $('question-paper'); paper.replaceChildren();
    if (!view.item || view.phase === 'loading') paper.append(text('h1', view.mode === 'practice' ? '等待选择作业' : '正在准备训练'), text('p', view.mode === 'practice' ? '在主屏选择题目，题面会同步显示在这里。' : '在主屏选择题型并开始后，讲解和题目会显示在这里。'));
    else if (view.phase === 'method' && view.method) {
      paper.append(text('h1', '这类题怎么做'), text('p', `先备知识：${view.method.prerequisites || '见方法说明'}`, 'question-source'), text('div', view.method.method, 'training-method-text'));
      if (view.method.example) paper.append(text('h2', '示范例题'), text('div', view.method.example, 'training-example'));
      paper.append(text('p', view.method.source, 'question-source'));
      renderMath(paper);
    }
    else {
      paper.append(text('h1', view.item.title), text('p', view.item.sourceRef, 'question-source'));
      const prompt = text('div', view.item.prompt, 'question-prompt'); paper.append(prompt);
      renderMath(prompt);
      for (const picture of view.item.questionImages || []) {
        if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(picture.dataUrl || '')) continue;
        const img = document.createElement('img'); img.src = picture.dataUrl; img.alt = picture.name || '题面原图'; paper.append(img);
      }
    }
    if (changed) $('question-scroll').scrollTo(0, 0);
    scale(zoom); acknowledge();
    if (!requestedFullscreen && new URLSearchParams(location.search).has('present')) { requestedFullscreen = true; ensureFullscreen(); }
  }
  function renderMath(target) {
    window.renderMathInElement?.(target, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }, { left: '\\(', right: '\\)', display: false }, { left: '\\[', right: '\\]', display: true }], throwOnError: false, trust: false, strict: 'ignore' });
  }
  function connectionStatus() {
    $('question-connection').textContent = !online ? '主屏已断开，请回到主屏重新打开副屏看题。' : document.fullscreenElement ? '与主屏同步 · 已全屏 · Esc 退出全屏' : '与主屏同步 · 若浏览器未允许自动全屏，按 → / Enter 即可全屏并继续';
  }
  async function ensureFullscreen() {
    if (document.fullscreenElement) return;
    try { await document.documentElement.requestFullscreen(); } catch { /* A real key gesture can retry. */ }
    connectionStatus();
  }
  function next() {
    if (!view.active || !online || pending || $('question-next').disabled) return;
    ensureFullscreen();
    pending = true;
    channel.postMessage({ type: 'training-next', viewerId, trainingId: view.trainingId, revision: view.revision });
  }
  function disconnected() {
    if (!view.active) return;
    online = false; $('question-connection').textContent = '主屏已断开，请回到主屏重新打开副屏看题。';
    $('question-paper').replaceChildren(text('h1', '等待主屏重新连接'));
    $('question-next').disabled = true;
  }
  $('question-zoom-out').addEventListener('click', () => scale(zoom - 25));
  $('question-zoom-in').addEventListener('click', () => scale(zoom + 25));
  $('question-fit').addEventListener('click', () => scale(100));
  $('question-fullscreen').addEventListener('click', toggleFullscreen);
  $('question-next').addEventListener('click', next);
  document.addEventListener('keydown', e => {
    if (!view.active || e.repeat || e.isComposing || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !['ArrowRight', 'Enter'].includes(e.key)) return;
    if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === 'Enter' && e.target.closest('button') && e.target.id !== 'question-next') return;
    e.preventDefault(); next();
  });
  document.addEventListener('fullscreenchange', () => {
    $('question-fullscreen').textContent = document.fullscreenElement ? '退出全屏' : '全屏';
    $('question-fullscreen').setAttribute('aria-pressed', String(Boolean(document.fullscreenElement)));
    connectionStatus();
  });
  const heartbeat = setInterval(() => {
    if (owner?.closed) disconnected();
    else acknowledge();
  }, 3000);
  window.addEventListener('beforeunload', () => clearInterval(heartbeat));
  return { show, disconnected, ensureFullscreen, isActive: () => Boolean(view.active) };
}
