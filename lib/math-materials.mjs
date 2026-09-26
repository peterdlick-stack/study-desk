import { readFile } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { boundedPath, sha } from './store.mjs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export class MathMaterials {
  constructor({ vaultRoot, manifest, practice, training }) {
    this.vaultRoot = vaultRoot; this.manifest = manifest; this.practice = practice; this.training = training;
  }
  entry(id) {
    const item = [...this.manifest.chapters, this.manifest.repair].find(c => c.id === id);
    if (!item) fail('数学材料不存在', 404);
    return item;
  }
  index() {
    const clean = c => { const { noteFile, ...publicEntry } = c; return publicEntry; };
    return { chapters: this.manifest.chapters.map(clean), repair: clean(this.manifest.repair),
      topics: this.manifest.topics, source: { title: this.manifest.source.title, pages: this.manifest.source.pages },
      note: '公开版本未附个人讲义。可通过配置资料清单接入有权使用的本地材料。' };
  }
  async exposure(entry, sessionId) {
    const catalog = await this.practice.catalog();
    const topics = entry?.trainingTopicIds || [];
    const itemIds = new Set(catalog.items.filter(i => i.track === 'math1' &&
      (!entry || entry.id === 'repair' || i.topicIds.some(t => topics.includes(t)))).map(i => i.id));
    if (sessionId) {
      const session = await this.training.get(sessionId);
      if (!session) fail('训练组不存在，未打开材料', 404);
      // Any reference consulted during a round counts as help for that round.
      for (const id of session.itemIds) itemIds.add(id);
    }
    await this.practice.recordMethodExposure([...itemIds], sessionId || `materials-${entry?.id || 'source'}`);
  }
  async note({ id, sessionId } = {}) {
    const entry = this.entry(id);
    const file = await boundedPath(this.vaultRoot, this.manifest.notesDirectory, entry.noteFile);
    let markdown;
    try { markdown = await readFile(file, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') fail('这份笔记暂时不可用，请检查数学物料目录', 404); throw e; }
    // Do not deliver the teaching content until exposure has been committed.
    await this.exposure(entry, sessionId);
    markdown = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
      .replace(/\[\[00-使用入口\]\]\s*·?\s*/g, '');
    return { id, title: entry.title, markdown, revision: sha(markdown), helped: true };
  }
  async pdf({ page, sessionId } = {}) {
    if (!Number.isInteger(page) || page < 1 || page > this.manifest.source.pages) fail('讲义页码无效');
    // Only the configured user-supplied PDF is readable; no caller-supplied path.
    const path = this.manifest.source.path;
    const bytes = await readFile(await boundedPath(dirname(path), basename(path)));
    if (sha(bytes) !== this.manifest.source.sha256) fail('讲义文件已变化，请重新核对版本后接入', 409);
    await this.exposure(null, sessionId);
    return bytes;
  }
}
