/* Synchronous, presentation-only initialization before the stylesheet loads. */
(() => {
  const key = 'study-desk-color-mode';
  const root = document.documentElement;
  const valid = value => value === 'light' ? 'light' : 'dark';
  function apply(value) {
    const colorMode = valid(value);
    root.dataset.colorMode = colorMode;
    root.style.colorScheme = colorMode;
    document.querySelectorAll('[data-color-mode-toggle]').forEach(button => {
      button.textContent = `外观：${colorMode === 'dark' ? '深色' : '浅色'}`;
      button.setAttribute('aria-label', `当前${colorMode === 'dark' ? '深色' : '浅色'}外观，切换为${colorMode === 'dark' ? '浅色' : '深色'}`);
    });
  }
  let colorMode = 'dark';
  try { colorMode = valid(localStorage.getItem(key)); } catch { /* Unavailable storage keeps this window usable. */ }
  apply(colorMode);
  document.addEventListener('DOMContentLoaded', () => {
    apply(root.dataset.colorMode);
    document.querySelectorAll('[data-color-mode-toggle]').forEach(button => {
      button.addEventListener('click', () => {
        const next = root.dataset.colorMode === 'dark' ? 'light' : 'dark';
        apply(next);
        try { localStorage.setItem(key, next); } catch { /* The selection lasts for this window. */ }
      });
    });
    for (const id of ['course-title', 'course-meta', 'current-theme', 'player-course-title']) {
      const node = document.getElementById(id);
      if (!node) continue;
      const title = () => { node.title = node.textContent; };
      title();
      new MutationObserver(title).observe(node, { childList: true, characterData: true, subtree: true });
    }
  });
  window.addEventListener('storage', event => {
    if (event.storageArea === localStorage && (event.key === key || event.key === null)) apply(event.newValue);
  });
})();
