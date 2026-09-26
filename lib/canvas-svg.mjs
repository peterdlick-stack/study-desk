const n = value => { const number = Number(value ?? 0); if (!Number.isFinite(number)) throw new Error('画布坐标无效'); return number; };
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
// Portable rendering of the same finite geometry used by the learning canvas.
export function canvasSvg(objects) {
  const parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2400 1600"><rect width="2400" height="1600" fill="#fafaf7"/><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0 0 L0 6 L7 3z" fill="#202521"/></marker></defs>'];
  const line = (x1, y1, x2, y2, arrow = false) => `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}"${arrow ? ' marker-end="url(#arrow)"' : ''}/>`;
  for (const o of objects) {
    parts.push(`<g transform="translate(${n(o.offsetX)} ${n(o.offsetY)})" fill="none" stroke="#202521" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">`);
    if (o.type === 'ink') for (const stroke of o.strokes || []) parts.push(`<path d="${stroke.map((p, i) => `${i ? 'L' : 'M'}${n(p.x)} ${n(p.y)}`).join(' ')}"/>`);
    else if (o.start && o.end) {
      const a = { x: n(o.start.x), y: n(o.start.y) }, b = { x: n(o.end.x), y: n(o.end.y) };
      if (['line', 'arrow'].includes(o.type)) parts.push(line(a.x, a.y, b.x, b.y, o.type === 'arrow'));
      if (o.type === 'axes') parts.push(line(Math.min(a.x, b.x), a.y, Math.max(a.x, b.x), a.y, true), line(a.x, Math.max(a.y, b.y), a.x, Math.min(a.y, b.y), true));
      if (o.type === 'circle') parts.push(`<circle cx="${a.x}" cy="${a.y}" r="${Math.hypot(b.x - a.x, b.y - a.y)}"/>`);
      if (o.type === 'ellipse') parts.push(`<ellipse cx="${(a.x + b.x) / 2}" cy="${(a.y + b.y) / 2}" rx="${Math.abs(b.x - a.x) / 2}" ry="${Math.abs(b.y - a.y) / 2}"/>`);
      if (o.type === 'curve') parts.push(`<path d="M${a.x} ${a.y} Q${(a.x + b.x) / 2} ${Math.min(a.y, b.y) - Math.max(50, Math.abs(b.x - a.x) * .22)} ${b.x} ${b.y}"/>`);
    } else if (o.type === 'screenshot') parts.push(`<image x="${n(o.x)}" y="${n(o.y)}" width="${n(o.width || 360)}" height="${n(o.height || 240)}" preserveAspectRatio="xMinYMin meet" href="${esc(o.image)}"/>`);
    else parts.push(`<text x="${n(o.x)}" y="${n(o.y) + 20}" fill="#202521" stroke="none" font-size="18">${esc(o.type === 'question' ? '疑问' : '时间锚点')} ${n(o.time)} 秒</text>`);
    parts.push('</g>');
  }
  return parts.join('') + '</svg>';
}
