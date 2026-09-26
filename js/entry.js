import { subjectFromUrl } from './subject.js';

const subject = subjectFromUrl(location.href);
if (!subject) {
  document.title = '学习台 · 选择科目';
  document.body.className = 'subject-home';
  document.body.replaceChildren(document.querySelector('#subject-home-template').content.cloneNode(true));
  const toggle = document.querySelector('[data-home-appearance]');
  const label = () => { toggle.textContent = `外观：${document.documentElement.dataset.colorMode === 'light' ? '浅色' : '深色'}`; };
  label();
  toggle.addEventListener('click', () => {
    const mode = document.documentElement.dataset.colorMode === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.colorMode = mode;
    document.documentElement.style.colorScheme = mode;
    try { localStorage.setItem('study-desk-color-mode', mode); } catch {}
    label();
  });
} else if (subject === 'english') {
  try { await (await import('./english.js')).mountEnglish(); }
  catch (error) {
    document.body.textContent = `英语页面未能打开：${error.message}。刷新可重试。`;
  }
} else {
  document.body.dataset.subject = subject;
  document.querySelector('#subject-name').textContent = subject === 'math' ? '数学' : '物理';
  const url = new URL(location.href); url.searchParams.set('subject', subject);
  history.replaceState(null, '', url);
  try { await import('./main.js'); }
  catch (error) {
    const message = document.createElement('p'); message.setAttribute('role', 'alert');
    message.textContent = `学习页面未能打开：${error.message}。可返回入口后重试。`;
    document.querySelector('#workspace').replaceChildren(message);
  }
}
document.body.hidden = false;
