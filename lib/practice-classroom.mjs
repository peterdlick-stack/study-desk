import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { boundedPath, readJson, atomicJson, sha } from './store.mjs';
import { planPractice } from './practice-plan.mjs';

export async function addClassroomExercise(courseRoot, lesson, { screenshotId, title, track }) {
  const s = lesson?.snapshot;
  if (!s || s.course.demo) throw new Error('请先保存实际课程；演示课不能加入正式课堂题');
  if (!['8.01', '8.02', '8.03'].includes(track)) throw new Error('请选择课程 8.01、8.02 或 8.03');
  const screenshot = s.canvasObjects.find(o => o.id === screenshotId && o.type === 'screenshot');
  if (!screenshot || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(screenshot.image || '')) throw new Error('没有找到这张已保存的课程截图');
  const path = await boundedPath(courseRoot, 'practice/catalog.json');
  const catalog = await readJson(path, { schemaVersion: 1, sources: [], topics: [], items: [] });
  const sourceId = `classroom-${sha(s.lessonId).slice(0, 24)}`;
  const itemId = `classroom-${sha(s.lessonId + screenshot.id + screenshot.image).slice(0, 32)}`;
  if (catalog.items.some(i => i.id === itemId)) return { itemId, unchanged: true };
  const topicIds = planPractice(catalog, lesson, [], { track }).topics.map(t => t.id);
  const unitId = { '8.01': 'physics836-mechanics', '8.02': 'physics836-electrostatics', '8.03': 'physics836-optics-waves' }[track];
  if (!catalog.sources.some(source => source.id === sourceId)) catalog.sources.push({ id: sourceId, title: s.course.title, kind: 'local', status: 'available', note: '来自本人保存的课程截图，保留课程与时间点。课堂练习不自动充当首次见闭卷测量。' });
  catalog.items.push({ id: itemId, sourceId, title: String(title || `${s.course.title} · ${screenshot.time ?? 0} 秒课堂题`).slice(0, 300),
    sourceRef: `${s.course.title} · ${screenshot.time ?? 0} 秒`, prompt: '根据本课截图中的题目作答。若截图含已展示的讲解，请如实记录作答条件；批改只依据你的手写页。',
    referenceAnswer: '', questionImages: [{ name: '课程题目截图', dataUrl: screenshot.image }], referenceImages: [],
    topicIds, unitId, track, kind: 'classroom', sourceQuality: 'UNKNOWN', measurementEligible: false,
    sourceQualityNote: '课堂截图可能包含讲解或不完整题面。字迹、题干或答案有疑点时先复核；课堂练习不自动计入独立新题证据。',
    locator: { path: `lesson:${s.lessonId}`, lessonId: s.lessonId, screenshotId, time: screenshot.time ?? 0 } });
  await mkdir(dirname(path), { recursive: true });
  try { await copyFile(path, `${path}.before-classroom-${Date.now()}.json`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await atomicJson(path, catalog);
  return { itemId, unchanged: false };
}
