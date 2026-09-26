// Display coordinates may be negative. Choose a display other than the main page's.
export function otherScreen(details) {
  return details.screens.find(s => s !== details.currentScreen &&
    (s.left !== details.currentScreen.left || s.top !== details.currentScreen.top));
}

export async function openTrainingWindow({ url, name, existing, notify, browser = window }) {
  let target;
  if (browser.getScreenDetails) {
    try {
      target = otherScreen(await browser.getScreenDetails());
      if (!target) notify('未检测到第二块屏幕，训练页将用独立窗口打开。');
    } catch { notify('未获准定位屏幕，训练页将用独立窗口打开；允许本站“窗口管理”后可自动定位。'); }
  } else notify('当前浏览器不支持自动定位屏幕；可在新版 Edge 或 Chrome 中打开学习台。');
  const bounds = target ? `left=${target.availLeft},top=${target.availTop},width=${target.availWidth},height=${target.availHeight}` : 'width=1200,height=780';
  if (existing && !existing.closed) {
    if (target) { existing.moveTo(target.availLeft, target.availTop); existing.resizeTo(target.availWidth, target.availHeight); }
    existing.focus();
    return existing;
  }
  // Browsers that support fullscreen popups can honor this at launch. The viewer
  // also requests fullscreen and reports the actual result, never assumed success.
  return browser.open(url, name, `popup,${bounds},fullscreen`);
}
