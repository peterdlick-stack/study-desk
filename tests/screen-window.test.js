import { test } from 'node:test';
import assert from 'node:assert/strict';
import { otherScreen, openTrainingWindow } from '../js/screen-window.js';

const primary = { left: 0, top: 0, availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040 };
const secondary = { left: -1920, top: 200, availLeft: -1920, availTop: 200, availWidth: 1920, availHeight: 1040 };
test('choose the other monitor relative to the main page, including negative coordinates', async () => {
  assert.equal(otherScreen({ screens: [primary, secondary], currentScreen: primary }), secondary);
  assert.equal(otherScreen({ screens: [primary, secondary], currentScreen: secondary }), primary);
  let call;
  await openTrainingWindow({ url: '/player', name: 'training', notify: assert.fail, browser: {
    getScreenDetails: async () => ({ screens: [primary, secondary], currentScreen: primary }),
    open: (...args) => { call = args; return {}; }
  } });
  assert.deepEqual(call, ['/player', 'training', 'popup,left=-1920,top=200,width=1920,height=1040,fullscreen']);
});
test('reuse the viewer without navigation and preserve browser-blocked popup result', async () => {
  const calls = [], existing = { closed: false, moveTo: (...a) => calls.push(a), resizeTo: (...a) => calls.push(a), focus: () => calls.push('focus') };
  const browser = { getScreenDetails: async () => ({ screens: [primary, secondary], currentScreen: primary }), open: assert.fail };
  assert.equal(await openTrainingWindow({ existing, browser, notify: assert.fail }), existing);
  assert.deepEqual(calls, [[-1920, 200], [1920, 1040], 'focus']);
  const notes = [];
  assert.equal(await openTrainingWindow({ browser: { getScreenDetails: async () => { throw Error('denied'); }, open: () => null }, notify: text => notes.push(text) }), null);
  assert.match(notes[0], /未获准/);
});
