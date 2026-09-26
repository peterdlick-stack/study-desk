function parseTimestamp(value) {
  const match = /^(\d{2}):([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

export function parseWebVtt(value) {
  const text = String(value ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.startsWith('WEBVTT')) throw new Error('字幕文件不是有效的 WebVTT');
  const cues = [];
  for (const block of text.split(/\n{2,}/).slice(1)) {
    const lines = block.split('\n').filter((line, index, all) => line.trim() || (index > 0 && index < all.length - 1));
    const timingIndex = lines.findIndex(line => line.includes('-->'));
    if (timingIndex < 0) continue;
    const timing = /^(\S+)\s+-->\s+(\S+)/.exec(lines[timingIndex].trim());
    if (!timing) continue;
    const start = parseTimestamp(timing[1]), end = parseTimestamp(timing[2]);
    const cueText = lines.slice(timingIndex + 1).join('\n').replace(/<[^>]*>/g, '').trim();
    if (start === null || end === null || end <= start || !cueText) continue;
    cues.push({ start, end, text: cueText });
  }
  if (!cues.length) throw new Error('字幕文件没有可用的时间段');
  return cues.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function captionTextAt(cues, time) {
  const current = Number(time);
  if (!Number.isFinite(current)) return '';
  return cues.filter(cue => cue.start <= current && current < cue.end).map(cue => cue.text).join('\n');
}
