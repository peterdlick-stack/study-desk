import { createReadStream } from "node:fs";
import { stat, mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from 'node:crypto';
import { CourseStore, boundedPath, sha } from './lib/store.mjs';
import { VaultBridge } from './lib/vault.mjs';
import { readBackup, makeBackup } from './js/library.js';
import { PracticeStore } from './lib/practice.mjs';
import { PracticeDrafts } from './lib/practice-drafts.mjs';
import { PracticeVault } from './lib/practice-vault.mjs';
import { derivePracticeEvidence } from './lib/practice-evidence.mjs';
import { planPractice } from './lib/practice-plan.mjs';
import { TopicTraining } from './lib/topic-training.mjs';
import { MathMaterials } from './lib/math-materials.mjs';
import { addClassroomExercise } from './lib/practice-classroom.mjs';
import { createCodexPracticeGrader } from './lib/practice-grader.mjs';
import { CourseMaterials } from './lib/course-materials.mjs';
import { EnglishStore } from './lib/english.mjs';
import { createEnglishCoach } from './lib/english-coach.mjs';

const root = fileURLToPath(new URL(".", import.meta.url));
if (process.env.STUDY_DESK_DEMO === '1') {
  const { prepareDemo } = await import('./scripts/prepare-demo.mjs');
  await prepareDemo(process.env.STUDY_DESK_DATA || resolve(root, '.local/study-library'));
}
const port = Number(process.env.STUDY_DESK_PORT || 4183);
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".srt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

const courseRoot = process.env.STUDY_DESK_DATA || resolve(root, '.local/study-library');
const vaultRoot = process.env.STUDY_DESK_VAULT || resolve(root, '.local/vault');
const store = new CourseStore(courseRoot), vault = new VaultBridge(vaultRoot, `http://127.0.0.1:${port}`);
const practiceVault = new PracticeVault({ vaultRoot, courseRoot, baseUrl: `http://127.0.0.1:${port}` });
const practice = new PracticeStore({ courseRoot, grader: createCodexPracticeGrader({ codexPath: process.env.STUDY_DESK_CODEX }), onChange: event => event.attempt ? practiceVault.record(event) : Promise.resolve() });
const drafts = new PracticeDrafts(courseRoot);
const training = new TopicTraining(courseRoot, practice);
const mathMaterials = new MathMaterials({ vaultRoot, practice, training,
  manifest: JSON.parse(await readFile(resolve(root, 'assets/math-materials.json'), 'utf8')) });
const materials = new CourseMaterials(courseRoot);
const aiEnabled = process.env.STUDY_DESK_ENABLE_AI === '1';
const englishCoach = createEnglishCoach({ codexPath: process.env.STUDY_DESK_CODEX, transcriptRoot: process.env.FREE_READING_TRANSCRIPTS });
const english = new EnglishStore(courseRoot, { coach: aiEnabled ? englishCoach : null });
await practice.init();
const recordPreviews = new Map();
let queue = Promise.resolve();
const serial = task => { const next = queue.then(task); queue = next.catch(() => {}); return next; };
function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}
async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('需要 JSON 请求');
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 64 * 1024 * 1024) throw new Error('请求超过 64 MB，请分课归档'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const server = createServer(async (request, response) => {
  try {
    const host = request.headers.host;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) return json(response, { error: '无效的本地主机' }, 403);
    const origin = `http://${host}`;
    if (request.headers.origin && request.headers.origin !== origin) return json(response, { error: '不接受跨站访问' }, 403);
    const url = new URL(request.url, origin), path = decodeURIComponent(url.pathname);
    if (path.startsWith('/english/file/')) return await english.stream(path.slice('/english/file/'.length), request, response);
    if (path.startsWith('/materials/file/')) return await materials.stream(path.slice('/materials/file/'.length), request, response);
    if (path.startsWith('/api/')) {
      if (request.headers['x-study-desk'] !== '1') return json(response, { error: '请通过学习台访问本地接口' }, 403);
      if (request.method === 'GET') {
        if (path === '/api/english') return json(response, await english.list());
        if (path === '/api/english/course') return json(response, await english.course(url.searchParams.get('id')));
        if (path === '/api/english/export') return json(response, await english.record(url.searchParams.get('id')));
        if (path === '/api/materials') return json(response, await materials.list());
        if (path === '/api/materials/course') return json(response, await materials.course(url.searchParams.get('lessonId')));
        if (path === '/api/materials/text') return json(response, await materials.text(url.searchParams.get('id')));
        if (path === '/api/config') return json(response, { ...(await vault.configuration()), courseRoot });
        if (path === '/api/courses') return json(response, await store.list());
        if (path.startsWith('/api/courses/')) {
          const record = await store.get(path.slice('/api/courses/'.length));
          return json(response, record || { error: '课程不存在' }, record ? 200 : 404);
        }
        if (path === '/api/search') return json(response, { courses: await store.search(url.searchParams.get('q') || ''), vault: await vault.search(url.searchParams.get('q') || '') });
        if (path === '/api/entry') return json(response, await vault.readEntry(url.searchParams.get('path') || ''));
        if (path === '/api/records') return json(response, await vault.records());
        if (path === '/api/practice/catalog') return json(response, await practice.catalog());
        if (path === '/api/practice/item') return json(response, await practice.item(url.searchParams.get('id')));
        if (path === '/api/training/options') return json(response, await training.options());
        if (path === '/api/math-materials') return json(response, mathMaterials.index());
        if (path === '/api/training/sessions') return json(response, (await training.list()).map(s => training.publicSession(s)));
        if (path === '/api/training/report') return json(response, await training.report(url.searchParams.get('id')));
        if (path === '/api/practice/attempts') return json(response, await practice.list());
        if (path === '/api/practice/attempt') return json(response, await practice.get(url.searchParams.get('id')));
        if (path === '/api/practice/draft') return json(response, await drafts.get(url.searchParams.get('lessonId'), url.searchParams.get('itemId')));
        if (path === '/api/practice/evidence') return json(response, derivePracticeEvidence(await practice.catalog(), await practice.list()));
        if (path === '/api/practice/plan') return json(response, planPractice(await practice.catalog(), await store.get(url.searchParams.get('lessonId')), await practice.list(), { topicId: url.searchParams.get('topicId'), track: url.searchParams.get('track') }));
      }
      if (request.method === 'POST') {
        if (path === '/api/media-hash') {
          const hash = createHash('sha256');
          for await (const chunk of request) hash.update(chunk);
          return json(response, { sha256: hash.digest('hex') });
        }
        const payload = await body(request);
        if (!aiEnabled && ['/api/english/diagnose', '/api/practice/submit', '/api/practice/retry'].includes(path)) {
          return json(response, { error: '公开演示默认不调用模型。请先阅读 docs/RUNNING.md，再显式启用 AI。预置诊断仅用于交互演示。' }, 503);
        }
        if (path === '/api/english/video') return json(response, await english.video(payload.lessonId));
        if (path === '/api/english/asset') return json(response, await english.openAsset(payload.lessonId, payload.assetId));
        if (path === '/api/math-materials/pdf') {
          const bytes = await serial(() => mathMaterials.pdf(payload));
          response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length,
            'Content-Disposition': 'inline; filename="math-handout.pdf"', 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff' });
          return response.end(bytes);
        }
        if (path === '/api/materials/video') return json(response, await materials.video(payload.lessonId));
        const result = await serial(async () => {
          if (path === '/api/english/event') return english.append(payload);
          if (path === '/api/english/diagnose') return english.diagnose(payload);
          if (path === '/api/math-materials/note') return mathMaterials.note(payload);
          if (path === '/api/practice/draft') return drafts.save(payload);
          if (path === '/api/training/create') return training.create(payload);
          if (path === '/api/training/method') return training.method(payload.id);
          if (path === '/api/practice/classroom') return addClassroomExercise(courseRoot, await store.get(payload.lessonId), payload);
          if (path === '/api/practice/submit') {
            if (payload.lessonId?.startsWith('training-')) return training.submit(payload);
            const lesson = await store.get(payload.lessonId);
            if (!lesson || lesson.snapshot.course.demo) throw new Error('请先新建或导入实际课程；演示课不能产生学习证据');
            return practice.submit(payload);
          }
          if (path === '/api/practice/retry') return practice.retry(payload.id);
          if (path === '/api/practice/reveal') return practice.reveal(payload.itemId, { kind: payload.kind, attemptId: payload.attemptId });
          if (path === '/api/practice/correct') return practice.correct(payload.id, { reason: payload.reason, conditions: payload.conditions });
          if (path === '/api/practice/sync') {
            for (const a of await practice.list()) { const synced = await practice.syncArchive(a.id); if (synced.archiveError) throw new Error(synced.archiveError); }
            return { synced: true };
          }
          if (path === '/api/courses') return store.save(payload.snapshot, payload.expectedRevision ?? null);
          if (path === '/api/backup') {
            const snapshot = readBackup(payload), backup = makeBackup(snapshot);
            const directory = await boundedPath(courseRoot, 'exports');
            await mkdir(directory, { recursive: true });
            const filename = `${snapshot.lessonId}-${sha(JSON.stringify(backup))}.backup.json`;
            const dest = await boundedPath(courseRoot, 'exports', filename);
            await writeFile(dest, JSON.stringify(backup, null, 2), { flag: 'wx' });
            return { path: dest };
          }
          if (path === '/api/archive/preview') return vault.previewArchive(payload.snapshot, payload.entryId);
          if (path === '/api/archive/commit') return vault.commitArchive(payload.token);
          if (path === '/api/records/preview') {
            if (payload.kind === 'attempt') throw new Error('练习成绩由作业批改产生；请在“作业与错题”提交作答或申请事实复核');
            await vault.validateRecord(payload);
            const token = sha(JSON.stringify(payload));
            recordPreviews.set(token, payload);
            if (recordPreviews.size > 100) recordPreviews.delete(recordPreviews.keys().next().value);
            return { token, event: payload, path: '考研/数据/study_desk_events.csv', note: '追加原始事件；更正保留旧记录，并用于下一次看板刷新。' };
          }
          if (path === '/api/records/commit') {
            const event = recordPreviews.get(payload.token);
            if (!event) throw new Error('预览已失效，请重新预览');
            return vault.appendRecord(event);
          }
          throw Object.assign(new Error('接口不存在'), { status: 404 });
        });
        return json(response, result);
      }
      return json(response, { error: '接口或方法不存在' }, 404);
    }
    if (!['GET', 'HEAD'].includes(request.method)) return json(response, { error: '方法不支持' }, 405);
    const relative = path === '/' ? 'index.html' : path.slice(1);
    if (!/^(index\.html|player\.html|styles\.css|js\/[a-zA-Z0-9-]+\.js|vendor\/katex\/(katex\.min\.(js|css)|auto-render\.min\.js|fonts\/[a-zA-Z0-9_-]+\.(woff2?|ttf)))$/.test(relative)) return json(response, { error: '文件不存在' }, 404);
    const file = await boundedPath(root, relative);
    await stat(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (request.method === 'HEAD') return response.end();
    createReadStream(file).on('error', () => response.destroy()).pipe(response);
  } catch (error) {
    if (!response.headersSent) json(response, { error: error.code === 'ENOENT' ? '文件不存在' : error.message }, error.status || 400);
    else response.destroy();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`学习台：http://127.0.0.1:${port}\n课程保存：${courseRoot}\n知识库：${vaultRoot}\n停止：Ctrl+C`);
});
