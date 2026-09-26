import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { CourseMaterials } from './course-materials.mjs';
import { readJson, boundedPath, sha } from './store.mjs';
import { applyEnglishEvent, emptyEnglishState } from '../js/english-state.js';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export class EnglishStore extends CourseMaterials {
  constructor(root, { coach = null } = {}) { super(resolve(root, 'english')); this.coach = coach; }
  token(...args) { return super.token(...args).replace('/materials/file/', '/english/file/'); }
  async definition(id) {
    if (!/^free-english-\d{2}$/.test(id || '')) fail('英语课程不存在', 404);
    const c = (await this.index()).courses.find(c => c.lessonId === id);
    if (!c) fail('英语课程不存在', 404);
    return c;
  }
  async record(id) {
    const course = await this.definition(id);
    const directory = await boundedPath(this.root, 'events', id);
    let names = [];
    try { names = (await readdir(directory)).filter(n => n.endsWith('.json')).sort(); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    let state = emptyEnglishState(), revision = null;
    const events = [];
    for (const name of names) {
      const e = await readJson(await boundedPath(directory, name));
      if (e.previous !== revision || e.sequence !== events.length + 1) fail('英语记录链损坏，请保留备份后检查');
      const { revision: digest, ...content } = e;
      if (sha(JSON.stringify(content)) !== digest) fail('英语记录校验失败');
      state = applyEnglishEvent(state, e, course); revision = digest; events.push(e);
    }
    return { state, revision, events };
  }
  async list() {
    const courses = [];
    for (const c of (await this.index()).courses) {
      const { state } = await this.record(c.lessonId);
      courses.push({ lessonId: c.lessonId, number: c.number, title: c.title, hasVideo: !!c.video,
        hasOriginal: c.blocks.length > 0, completed: state.completed, position: state.position,
        seconds: state.seconds, videoTime: state.videoTime, blockers: state.blockers.length,
        unresolved: state.blockers.filter(b => !b.resolved).length, samples: state.samples.length });
    }
    return { courses, mastery: 'UNKNOWN' };
  }
  async course(id) {
    const c = await this.definition(id), record = await this.record(id);
    return { lessonId: c.lessonId, number: c.number, title: c.title, blocks: c.blocks, pages: c.pages,
      hasVideo: !!c.video, duration: c.video?.duration ?? null, originalAssetId: c.originalAssetId,
      timedNotes: Array.isArray(c.timedNotes) ? c.timedNotes : [], timedNotesStatus: c.timedNotesStatus ?? null,
      hasSubtitles: !!c.subtitleAssetId, subtitleStatus: c.subtitleStatus ?? null,
      ...(await this.assetLabels(c)), state: record.state, revision: record.revision };
  }
  async assetLabels(course) {
    const index = await this.index();
    return { assets: course.assetIds.map(id => ({ id, title: index.assets[id].title, kind: index.assets[id].kind })) };
  }
  async openAsset(id, assetId) {
    const c = await this.definition(id);
    if (!c.assetIds.includes(assetId)) fail('资料不属于当前课程', 404);
    const a = await this.asset(assetId);
    return { url: this.token(a.file, extname(a.filename), { sha256: a.sha256 }), title: a.title };
  }
  async video(id) {
    const course = await this.definition(id);
    if (!course.video) fail('本课视频尚未提供', 404);
    const video = await super.video(id);
    if (!course.subtitleAssetId) return video;
    const subtitle = await this.asset(course.subtitleAssetId);
    if (extname(subtitle.filename) !== '.vtt') fail('本课字幕格式无效');
    return { ...video, captions: { label: '自动转写字幕', language: 'zh', status: course.subtitleStatus,
      url: this.token(subtitle.file, '.vtt', { sha256: subtitle.sha256 }) } };
  }
  async diagnose(payload) {
    if (!this.coach) fail('阅读诊断尚未配置', 503);
    const course = await this.definition(payload.lessonId);
    const article = typeof payload.article === 'string' && payload.article.trim()
      ? payload.article : course.blocks.map(block => block.text).join('\n\n');
    if (!article.trim()) fail('请粘贴文章；当前课程没有可用英文原文');
    return this.coach.diagnose({ ...payload, article, lessonTitle: course.title });
  }
  async append({ lessonId, expectedRevision, event }) {
    const course = await this.definition(lessonId), old = await this.record(lessonId);
    if (!event || !/^[a-zA-Z0-9-]{8,80}$/.test(event.id || '')) fail('记录 ID 无效');
    const existing = old.events.find(e => e.id === event.id);
    if (existing) {
      if (existing.type !== event.type || JSON.stringify(existing.payload) !== JSON.stringify(event.payload)) fail('记录 ID 已用于其他内容', 409);
      return { revision: old.revision };
    }
    if (old.revision !== expectedRevision) fail('另一个页面已更新本课。请导出未保存记录，再刷新核对。', 409);
    const content = { id: event.id, type: event.type, payload: event.payload, at: new Date().toISOString(),
      previous: old.revision, sequence: old.events.length + 1 };
    applyEnglishEvent(old.state, content, course);
    const revision = sha(JSON.stringify(content)), record = { ...content, revision };
    const directory = await boundedPath(this.root, 'events', lessonId); await mkdir(directory, { recursive: true });
    await writeFile(await boundedPath(directory, `${String(record.sequence).padStart(8, '0')}-${record.id}.json`), JSON.stringify(record), { flag: 'wx' });
    return { revision };
  }
}
