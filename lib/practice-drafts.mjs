import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { boundedPath, atomicJson, readJson, sha } from './store.mjs';
import { requireId, validateSnapshot } from '../js/library.js';
import { createDefaultState } from '../js/core.js';

export class PracticeDrafts {
  constructor(courseRoot) { this.root = courseRoot; }
  async path(lessonId, itemId) {
    return boundedPath(this.root, 'practice', 'drafts', requireId(lessonId), `${requireId(itemId)}.json`);
  }
  async get(lessonId, itemId) { return readJson(await this.path(lessonId, itemId)); }
  async save({ lessonId, itemId, expectedRevision = null, snapshot }) {
    if (!snapshot || !Array.isArray(snapshot.pages) || !snapshot.pages.length || snapshot.pages.length > 32) throw new Error('作答需要 1 至 32 页');
    if (!Number.isInteger(snapshot.activePage) || snapshot.activePage < 0 || snapshot.activePage >= snapshot.pages.length) throw new Error('作答页码无效');
    for (const page of snapshot.pages) {
      if (!Array.isArray(page.objects) || page.objects.length > 10000) throw new Error('作答画布无效');
      validateSnapshot({ ...createDefaultState(), lessonId: requireId(lessonId), entries: [], canvasObjects: page.objects });
    }
    for (const key of ['attemptId', 'parentAttemptId', 'submittedId']) if (snapshot[key]) requireId(snapshot[key]);
    const path = await this.path(lessonId, itemId), old = await readJson(path);
    if ((old?.revision ?? null) !== expectedRevision) throw Object.assign(new Error('这道题的草稿已在另一个页面更新，请先导出当前作答再重新打开'), { status: 409 });
    const revision = sha(JSON.stringify(snapshot));
    if (old?.revision === revision) return old;
    const record = { revision, lessonId, itemId, savedAt: new Date().toISOString(), snapshot };
    await mkdir(dirname(path), { recursive: true });
    await atomicJson(path, record);
    return record;
  }
}
