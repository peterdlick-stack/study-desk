import { createDefaultState, normaliseStudyBundle } from './core.js';

export const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/;
export function requireId(value) {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('条目标识无效');
  return value;
}
export function validateSnapshot(value) {
  if (!value || value.version !== 1 || !value.course || typeof value.course.title !== 'string') throw new Error('不是完整课程备份');
  requireId(value.lessonId);
  if (!Array.isArray(value.canvasObjects) || !Array.isArray(value.notes) || !Array.isArray(value.themes)) throw new Error('课程备份缺少笔记或画布');
  const defaults = createDefaultState();
  const state = structuredClone(value);
  if (state.studyBundle) {
    const bundle = normaliseStudyBundle({ schemaVersion: 1, title: state.course.title,
      source: state.studyBundle.source, cues: state.studyBundle.cues, notes: state.notes, map: state.map });
    state.notes = bundle.notes;
    state.map = bundle.map;
    state.studyBundle = { schemaVersion: 1, source: bundle.source, cues: bundle.cues };
  } else {
    state.notes = normaliseStudyBundle({ notes: state.notes }).notes;
    state.map = { nodes: [], edges: [] };
  }
  state.player = { ...defaults.player, ...state.player, playing: false };
  if (!Number.isFinite(state.player.currentTime) || state.player.currentTime < 0) throw new Error('课程进度无效');
  state.layout = { ...defaults.layout, ...state.layout };
  state.entries ??= [];
  if (!Array.isArray(state.entries)) throw new Error('整理条目无效');
  const ids = new Set();
  for (const object of [...state.canvasObjects, ...state.entries]) {
    requireId(object.id);
    if (ids.has(object.id)) throw new Error('课程对象标识重复');
    ids.add(object.id);
    if (object.image && !/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(object.image)) throw new Error('截图格式无效');
  }
  for (const o of state.canvasObjects) {
    if (!['ink', 'line', 'arrow', 'axes', 'circle', 'ellipse', 'curve', 'screenshot', 'anchor', 'question'].includes(o.type)) throw new Error('未知画布对象');
    const point = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
    if (o.type === 'ink' && (!Array.isArray(o.strokes) || o.strokes.some(s => !Array.isArray(s) || s.some(p => !point(p))))) throw new Error('笔迹坐标无效');
    if (['line', 'arrow', 'axes', 'circle', 'ellipse', 'curve'].includes(o.type) && (!point(o.start) || !point(o.end))) throw new Error('几何对象坐标无效');
    if (['screenshot', 'anchor', 'question'].includes(o.type) && !point(o)) throw new Error('画布卡片坐标无效');
    if (o.type === 'screenshot' && !o.image) throw new Error('截图内容缺失');
  }
  for (const entry of state.entries) {
    if (typeof entry.title !== 'string' || typeof entry.personalText !== 'string' || !Array.isArray(entry.history)) throw new Error('整理条目缺少正文或历史');
    if (!['inbox', 'ready', 'pending'].includes(entry.status)) throw new Error('整理状态无效');
    if (!['UNKNOWN', 'needs-review', 'verified'].includes(entry.reviewStatus)) throw new Error('复核状态无效');
    if (entry.reviewStatus === 'verified' && !entry.reviewBasis?.trim()) throw new Error('核验通过必须记录依据');
    if (!Number.isFinite(entry.time) || entry.time < 0) throw new Error('条目时间无效');
    if (!Array.isArray(entry.attachmentIds) || entry.attachmentIds.some(id => !state.canvasObjects.some(o => o.id === id))) throw new Error('条目引用了缺失的画布对象');
  }
  return state;
}
export function makeBackup(state) {
  return { format: 'study-desk-backup', version: 1, exportedAt: new Date().toISOString(), snapshot: validateSnapshot(state) };
}
export function readBackup(payload) {
  if (payload?.format !== 'study-desk-backup' || payload.version !== 1) throw new Error('不支持的备份格式');
  return validateSnapshot(payload.snapshot);
}
export function newEntry(state, source = null) {
  return { id: `entry-${crypto.randomUUID()}`, title: source?.title || '待整理记录',
    originalText: source?.summary || source?.translatedText || '', personalText: '',
    origin: source ? 'course-draft' : 'personal', sourceItemId: source?.id || '',
    time: source?.timingStatus === 'untimed' ? state.player.currentTime : (source?.start ?? state.player.currentTime), status: 'inbox', reviewStatus: 'UNKNOWN',
    reviewBasis: '', aliases: '', relatedPath: '', attachmentIds: [], history: [],
    createdAt: new Date().toISOString() };
}
export function reviseEntry(entry, fields) {
  if (fields.reviewStatus === 'verified' && !fields.reviewBasis?.trim()) throw new Error('请填写核验依据；内容核验不等于掌握');
  return { ...entry, ...fields, id: entry.id, originalText: entry.originalText,
    updatedAt: new Date().toISOString(), history: [...entry.history, {
      at: new Date().toISOString(), personalText: entry.personalText, title: entry.title,
      reviewStatus: entry.reviewStatus, reviewBasis: entry.reviewBasis, status: entry.status,
    }] };
}
export function searchLesson(state, query) {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [];
  return [...state.notes.map(n => ({ id: n.id, title: n.title, text: n.summary, time: n.start, kind: 'note' })),
    ...state.entries.map(e => ({ id: e.id, title: e.title, text: `${e.personalText}\n${e.originalText}\n${e.aliases}`, time: e.time, kind: 'entry' })),
    ...state.canvasObjects.filter(o => o.type === 'question').map(o => ({ id: o.id, title: '画布疑问', text: o.text || '', time: o.time, kind: 'canvas' }))]
    .filter(x => `${x.title} ${x.text}`.toLocaleLowerCase().includes(q))
    .map(x => ({ ...x, lessonId: state.lessonId, courseTitle: state.course.title }));
}
