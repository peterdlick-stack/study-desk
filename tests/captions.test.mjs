import test from 'node:test';
import assert from 'node:assert/strict';
import { captionTextAt, parseWebVtt } from '../js/captions.js';

const sample = `WEBVTT

1
00:07:30.850 --> 00:07:35.490
你就会看到一些和以往不太一样的东西，

2
00:07:35.610 --> 00:07:38.030
比如说这里面的重点，
`;

test('visible captions parse the converted CARE WebVTT shape', () => {
  const cues = parseWebVtt(sample);
  assert.equal(cues.length, 2);
  assert.equal(captionTextAt(cues, 454), '你就会看到一些和以往不太一样的东西，');
  assert.equal(captionTextAt(cues, 455.55), '');
  assert.equal(captionTextAt(cues, 456), '比如说这里面的重点，');
});

test('invalid or empty WebVTT fails instead of showing a false enabled state', () => {
  assert.throws(() => parseWebVtt('not captions'), /WebVTT/);
  assert.throws(() => parseWebVtt('WEBVTT\n\nNOTE nothing'), /时间段/);
});
