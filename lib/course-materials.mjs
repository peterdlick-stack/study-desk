import { readFile, stat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, extname } from 'node:path';
import { boundedPath, readJson } from './store.mjs';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export class CourseMaterials {
  constructor(root) { this.root = root; this.tokens = new Map(); this.verified = new Map(); }
  async index() { return await readJson(await boundedPath(this.root, 'materials', 'index.json'), { courses: [], assets: {} }); }
  async list() { return (await this.index()).courses.map(({ lessonId, title, number, video }) => ({ lessonId, title, number, videoSha256: video.sha256 })); }
  async asset(id) {
    const asset = (await this.index()).assets[id];
    if (!asset || !/^[a-z0-9-]+$/.test(id)) fail('资料不存在', 404);
    const directory = await boundedPath(this.root, 'materials', 'files');
    const file = await boundedPath(directory, asset.filename);
    return { ...asset, file, id };
  }
  token(file, type, fingerprint) {
    const now = Date.now();
    for (const [id, value] of this.tokens) if (value.expires < now) this.tokens.delete(id);
    if (this.tokens.size > 4096) this.tokens.delete(this.tokens.keys().next().value);
    const token = randomUUID();
    this.tokens.set(token, { file, type, fingerprint, expires: now + 4 * 3600_000 });
    return `/materials/file/${token}`;
  }
  async course(id) {
    const course = (await this.index()).courses.find(c => c.lessonId === id);
    if (!course) return null;
    const assets = [];
    for (const id of course.assetIds) {
      const a = await this.asset(id);
      assets.push({ id, title: a.title, type: extname(a.filename), url: this.token(a.file, extname(a.filename), { sha256: a.sha256 }) });
    }
    return { lessonId: id, title: course.title, number: course.number, assets, timeline: course.timeline,
      psets: course.psets, reviewAssetId: course.reviewAssetId, videoName: course.video.name,
      timingStatus: 'unverified', note: '复习稿待核验；目录时间来自原版，尚未与本地视频逐段对齐。' };
  }
  async text(id) {
    const a = await this.asset(id);
    if (!['.md', '.txt', '.srt'].includes(extname(a.filename))) fail('该资料不是文本');
    const data = await readFile(a.file);
    if (data.length > 2_000_000 || createHash('sha256').update(data).digest('hex') !== a.sha256) fail('资料已变化，请重新导入');
    return { title: a.title, text: data.toString('utf8') };
  }
  async video(id) {
    const c = (await this.index()).courses.find(c => c.lessonId === id);
    if (!c) fail('课程资料不存在', 404);
    const v = c.video, file = resolve(v.path);
    if (resolve(await realpath(file)).toLowerCase() !== file.toLowerCase()) fail('视频经过路径重定向');
    const info = await stat(file);
    if (!info.isFile() || info.size !== v.bytes) fail('视频文件已变化');
    const key = `${file}:${info.size}:${info.mtimeMs}`;
    let digest = this.verified.get(key);
    if (!digest) {
      const h = createHash('sha256'); for await (const chunk of createReadStream(file)) h.update(chunk);
      digest = h.digest('hex');
      const after = await stat(file);
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) fail('核验期间视频发生变化');
      if (digest !== v.sha256) fail('视频内容与课程登记不一致');
      this.verified.set(key, digest);
    }
    if (digest !== v.sha256) fail('视频内容与课程登记不一致');
    return { name: v.name, sha256: digest, duration: v.duration,
      url: this.token(file, '.mp4', { bytes: info.size, mtimeMs: info.mtimeMs }) };
  }
  async stream(token, request, response) {
    const item = this.tokens.get(token);
    if (!item || item.expires < Date.now()) fail('资料链接已失效，请在学习台重新打开', 404);
    if (!['GET', 'HEAD'].includes(request.method)) fail('方法不支持', 405);
    if (resolve(await realpath(item.file)).toLowerCase() !== resolve(item.file).toLowerCase()) fail('资料路径已变化');
    const info = await stat(item.file);
    if (item.type === '.mp4') {
      if (info.size !== item.fingerprint.bytes || info.mtimeMs !== item.fingerprint.mtimeMs) fail('视频已变化，请重新核验');
    } else if (createHash('sha256').update(await readFile(item.file)).digest('hex') !== item.fingerprint.sha256) fail('资料已变化，请重新导入');
    let start = 0, end = info.size - 1, status = 200;
    const headers = { 'Content-Type': item.type === '.mp4' ? 'video/mp4' : item.type === '.pdf' ? 'application/pdf' : item.type === '.vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8',
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' };
    if (request.headers.range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (!m || (!m[1] && !m[2])) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return response.end(); }
      if (!m[1]) { start = Math.max(0, info.size - Number(m[2])); }
      else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size || start < 0) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return response.end(); }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    response.writeHead(status, headers);
    if (request.method === 'HEAD') return response.end();
    const stream = createReadStream(item.file, { start, end });
    response.on('close', () => stream.destroy()); stream.on('error', () => response.destroy()).pipe(response);
  }
}
