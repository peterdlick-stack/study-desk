import { mkdir, readFile, writeFile, rename, readdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { requireId, validateSnapshot, searchLesson } from '../js/library.js';

export const sha = value => createHash('sha256').update(value).digest('hex');
export async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' });
  await rename(temp, path);
}
// Refuse links at every existing component; writes stay within their configured root.
export async function boundedPath(root, ...parts) {
  const base = resolve(root), target = resolve(base, ...parts), rel = relative(base, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('路径超出允许目录');
  let current = base;
  for (const piece of ['', ...rel.split(/[\\/]/).filter(Boolean)]) {
    current = piece ? join(current, piece) : current;
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('不处理符号链接目录或文件'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  // Check the real root too, including ancestor junctions.
  try { if (resolve(await realpath(base)).toLowerCase() !== base.toLowerCase()) throw new Error('根目录经过重定向'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return target;
}
export class CourseStore {
  constructor(root) { this.root = resolve(root); }
  async get(id) { return readJson(await boundedPath(this.root, `${requireId(id)}.json`)); }
  async list() {
    await mkdir(this.root, { recursive: true });
    const result = [];
    for (const name of await readdir(this.root)) {
      if (!name.endsWith('.json')) continue;
      try {
        const record = await readJson(await boundedPath(this.root, name));
        const snapshot = validateSnapshot(record.snapshot);
        result.push({ id: snapshot.lessonId, title: snapshot.course.title,
          revision: record.revision, savedAt: record.savedAt, entries: snapshot.entries.length });
      } catch (error) { result.push({ id: name.slice(0, -5), title: `无法读取的课程：${name}`, savedAt: '', entries: 0, error: error.message }); }
    }
    return result.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
  async save(snapshot, expectedRevision) {
    const valid = validateSnapshot(snapshot), id = valid.lessonId;
    await mkdir(this.root, { recursive: true });
    const old = await this.get(id);
    if ((old?.revision ?? null) !== expectedRevision) throw Object.assign(new Error('课程在另一个页面已更新，请先导出当前副本，再重新打开课程'), { status: 409 });
    const revision = sha(JSON.stringify(valid));
    if (old?.revision === revision) return old;
    const record = { revision, savedAt: new Date().toISOString(), snapshot: valid };
    const content = s => JSON.stringify({ ...s, player: null, layout: null });
    if (!old || content(old.snapshot) !== content(valid)) {
      const history = await boundedPath(this.root, 'history', id);
      await mkdir(history, { recursive: true });
      const archive = join(history, `${revision}.json`);
      try { await writeFile(archive, JSON.stringify(record), { flag: 'wx' }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    await atomicJson(await boundedPath(this.root, `${id}.json`), record);
    return record;
  }
  async search(query) {
    const hits = [];
    for (const course of await this.list()) if (!course.error) hits.push(...searchLesson((await this.get(course.id)).snapshot, query));
    return hits.slice(0, 100);
  }
}
