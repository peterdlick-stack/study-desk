import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicJson, boundedPath, readJson } from './store.mjs';
import { requireId } from '../js/library.js';
import { createCodexPracticeGrader, reconcilePracticeGrades, summarizeCodexUsage, validatePracticeGrade } from './practice-grader.mjs';

const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const canonical = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(value => JSON.parse(canonical(value)))
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))]))
  : value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

function object(value, context) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${context} 必须是对象`); }
function only(value, keys, context) {
  object(value, context);
  if (Object.keys(value).some(key => !keys.includes(key))) fail(`${context} 包含不允许的字段`);
}
function text(value, context, max = 8000, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) fail(`${context} 无效`);
  return value;
}
function list(value, context, max) { if (!Array.isArray(value) || value.length > max) fail(`${context} 无效`); return value; }
function conditions(value, partial = false) {
  only(value, ['closedBook', 'guessed', 'firstSeen'], '作答条件');
  if (!partial && ['closedBook', 'guessed', 'firstSeen'].some(key => !(key in value))) fail('请明确作答条件；不知道时使用 null');
  for (const item of Object.values(value)) if (item !== true && item !== false && item !== null) fail('作答条件只能为 true、false 或 null');
  return clone(value);
}
function image(value, context, sourceImage = false) {
  const pattern = sourceImage ? /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/ : /^data:image\/(png);base64,[A-Za-z0-9+/]+={0,2}$/;
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${context} 必须是有效图片`);
  const bytes = Buffer.from(value.split(',')[1], 'base64');
  const isPng = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  const isJpeg = sourceImage && value.startsWith('data:image/jpeg;') && bytes.subarray(0, 3).toString('hex') === 'ffd8ff';
  if (bytes.length > 12 * 1024 * 1024 || !(isPng || isJpeg)) fail(`${context} 格式或大小不合法`);
}
function publicItem(item) {
  const safe = clone(item);
  delete safe.referenceAnswer;
  delete safe.referenceImages;
  delete safe.importText;
  delete safe.dedupSignatures;
  if (safe.imageBundle) { safe.hasImageBundle = true; delete safe.imageBundle; }
  return safe;
}

function validateCatalog(value) {
  only(value, ['schemaVersion', 'sources', 'topics', 'items'], '题库');
  if (value.schemaVersion !== 1) fail('不支持的题库版本');
  for (const [key, max] of [['sources', 1000], ['topics', 5000], ['items', 15000]]) list(value[key], key, max);
  const sourceIds = new Set(), topicIds = new Set(), itemIds = new Set();
  for (const source of value.sources) {
    object(source, '题源'); text(source.id, '题源 ID', 200); text(source.title, '题源标题', 2000);
    if (sourceIds.has(source.id)) fail('题源 ID 重复'); sourceIds.add(source.id);
    if (!['available', 'pending'].includes(source.status) || !['local', 'pset', 'qian'].includes(source.kind)) fail('题源状态或种类无效');
  }
  for (const topic of value.topics) {
    object(topic, '知识点'); text(topic.id, '知识点 ID', 101); text(topic.title, '知识点标题', 2000); text(topic.unitId, '知识点单元', 200);
    if (topicIds.has(topic.id)) fail('知识点 ID 重复'); topicIds.add(topic.id);
  }
  for (const topic of value.topics) for (const id of topic.relatedTopicIds || []) if (!topicIds.has(id)) fail('知识点关联引用不存在');
  for (const item of value.items) {
    object(item, '题目'); text(item.id, '题目 ID', 200); text(item.title, '题目标题', 2000);
    if (itemIds.has(item.id)) fail('题目 ID 重复'); itemIds.add(item.id);
    if (!sourceIds.has(item.sourceId)) fail('题目引用不存在的题源');
    text(item.sourceRef, '题目出处', 4000); text(item.prompt, '题干', 100000, Boolean(item.questionImages?.length));
    text(item.referenceAnswer, '参考答案', 100000, true); text(item.unitId, '题目单元', 200);
    if (!['8.01', '8.02', '8.03', '836-thermal', '836-modern', 'math1'].includes(item.track) || !['supplement', 'pset', 'classroom'].includes(item.kind) || !['verified', 'UNKNOWN', 'disputed'].includes(item.sourceQuality)) fail('题目分类或质量状态无效');
    if (item.imageBundle) {
      only(item.imageBundle, ['path', 'sha256'], '题图文件');
      if (!/^sources\/[A-Za-z0-9-]+\/images\/[A-Za-z0-9-]+\.json$/.test(item.imageBundle.path) || !/^[a-f0-9]{64}$/.test(item.imageBundle.sha256)) fail('题图文件路径或哈希无效');
    }
    list(item.topicIds, '题目知识点', 30);
    if (new Set(item.topicIds).size !== item.topicIds.length || item.topicIds.some(id => !topicIds.has(id))) fail('题目知识点引用无效');
    object(item.locator, '题目定位'); text(item.locator.path, '题目定位路径', 4000);
    for (const key of ['questionImages', 'referenceImages']) {
      if (item[key] === undefined) continue;
      for (const entry of list(item[key], key, 20)) { object(entry, key); text(entry.name, '图片名称', 400); image(entry.dataUrl, key, true); }
    }
  }
  return clone(value);
}

function validateSubmission(payload) {
  only(payload, ['id', 'itemId', 'lessonId', 'pages', 'conditions', 'note', 'parentAttemptId'], '作答');
  requireId(payload.id); requireId(payload.lessonId); text(payload.itemId, '题目 ID', 200);
  if (payload.parentAttemptId != null) requireId(payload.parentAttemptId);
  if (!list(payload.pages, '作答页面', 32).length) fail('至少提交一页作答');
  let total = 0;
  for (const page of payload.pages) {
    only(page, ['objects', 'image'], '作答页面'); list(page.objects, '手写原对象', 50000); image(page.image, '作答图片');
    total += JSON.stringify(page).length;
  }
  if (total > 48 * 1024 * 1024) fail('本次作答过大，请减少页面');
  return { id: payload.id, itemId: payload.itemId, lessonId: payload.lessonId, pages: clone(payload.pages),
    conditions: conditions(payload.conditions), note: text(payload.note ?? '', '作答备注', 8000, true), parentAttemptId: payload.parentAttemptId ?? null };
}

async function immutableJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await link(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

const EMPTY_CATALOG = {
  schemaVersion: 1,
  sources: [
    { id: 'local-physics', title: '本地练习资料', kind: 'local', status: 'pending', path: '', note: '等待有出处的题目导入；不会自动编造题目。' },
    { id: 'mit-pset', title: 'Walter Lewin MIT 8.01–8.03 配套 PSET', kind: 'pset', status: 'pending', note: '等待课程版本与 PSET 配对核对。' },
    { id: 'qian-electromagnetism', title: '电磁学千题解', kind: 'qian', status: 'pending', note: '等待确认本地资料位置。' },
  ], topics: [], items: [],
};

export class PracticeStore {
  constructor({ courseRoot, grader = createCodexPracticeGrader(), onChange = async () => {} }) {
    this.courseRoot = resolve(courseRoot);
    this.root = join(this.courseRoot, 'practice');
    this.grader = grader; this.onChange = onChange;
    this._mutations = Promise.resolve(); this._jobs = Promise.resolve(); this._queued = new Set();
    this._initializing = null;
  }

  async init() {
    if (!this._initializing) this._initializing = this._initialize();
    await this._initializing;
    return this;
  }

  async _initialize() {
    await boundedPath(this.courseRoot, 'practice');
    await mkdir(this.root, { recursive: true });
    for (const dir of ['attempts', 'events']) await mkdir(await boundedPath(this.root, dir), { recursive: true });
    for (const entry of await readdir(join(this.root, 'attempts'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      requireId(entry.name);
      const path = await this._attemptPath(entry.name);
      const submission = await readJson(join(path, 'submission.json'));
      if (!submission) continue;
      let state = await readJson(join(path, 'state.json'));
      if (!state || ['queued', 'running'].includes(state.state)) {
        state = { ...(state || this._newState(submission)), state: 'needs-review', updatedAt: now(), lastError: '上次保存后批改未完成；原卷已保留，请在本次作答上重试。', interrupted: true };
        await atomicJson(join(path, 'state.json'), state);
        await this._notify('recovered', submission.id);
      }
    }
  }

  async _attemptPath(id) { return boundedPath(this.root, 'attempts', requireId(id)); }
  _mutate(work) {
    const result = this._mutations.then(work);
    this._mutations = result.catch(() => {});
    return result;
  }
  async _rawCatalog() {
    return validateCatalog(await readJson(await boundedPath(this.root, 'catalog.json'), EMPTY_CATALOG));
  }
  async catalog() {
    await this.init();
    const catalog = await this._rawCatalog();
    return { ...catalog, items: catalog.items.map(publicItem) };
  }

  async _withImages(item) {
    if (!item.imageBundle) return item;
    const bytes = await readFile(await boundedPath(this.root, item.imageBundle.path));
    if (createHash('sha256').update(bytes).digest('hex') !== item.imageBundle.sha256) fail('题图文件已变化，请重新核对来源', 409);
    const bundle = JSON.parse(bytes);
    only(bundle, ['questionImages', 'referenceImages'], '题图文件');
    for (const key of ['questionImages', 'referenceImages']) {
      for (const entry of list(bundle[key], key, 20)) {
        object(entry, key); text(entry.name, '图片名称', 400); image(entry.dataUrl, key, true);
      }
    }
    if (!bundle.questionImages.length) fail('题面原图缺失', 409);
    return { ...item, ...bundle };
  }

  async item(id) {
    await this.init(); text(id, '题目 ID', 200);
    const item = (await this._rawCatalog()).items.find(i => i.id === id);
    if (!item) fail('题目不存在', 404);
    return publicItem(await this._withImages(item));
  }
  _newState(submission) {
    return { schemaVersion: 1, id: submission.id, state: 'queued', updatedAt: submission.submittedAt,
      gradingRun: 0, grade: null, agreement: false, usage: null, lastError: null, archiveError: null, interrupted: false };
  }
  async _events(itemId) {
    const result = [];
    for (const name of await readdir(join(this.root, 'events'))) {
      if (!name.endsWith('.json')) continue;
      const event = await readJson(await boundedPath(this.root, 'events', name));
      if (!itemId || event.itemId === itemId) result.push(event);
    }
    return result.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }
  async _appendEvent(event) {
    const record = { ...event, id: randomUUID(), at: now() };
    await immutableJson(await boundedPath(this.root, 'events', `${record.id}.json`), record);
    return record;
  }
  async getInternal(id) {
    const path = await this._attemptPath(id);
    const submission = await readJson(await boundedPath(path, 'submission.json'));
    if (!submission) return null;
    const state = await readJson(await boundedPath(path, 'state.json')) || this._newState(submission);
    const events = await this._events(submission.itemId);
    const corrections = events.filter(event => event.type === 'correction' && event.attemptId === id);
    const effectiveConditions = Object.assign({}, submission.conditions, ...corrections.map(event => event.conditions || {}));
    return { ...clone(submission), ...clone(state), status: state.state, originalItem: clone(submission.item),
      originalConditions: clone(submission.conditions), conditions: effectiveConditions, corrections,
      helpHistory: clone(submission.helpHistory || []), exposures: events.filter(event => event.type === 'help') };
  }
  _public(record, compact = false) {
    if (!record) return null;
    const result = clone(record);
    result.item = publicItem(result.item);
    delete result.originalItem;
    delete result.requestHash;
    if (result.grade) { delete result.grade.hint; delete result.grade.solution; }
    if (compact) delete result.pages;
    return result;
  }
  async get(id) { await this.init(); return this._public(await this.getInternal(id)); }
  async list() {
    await this.init();
    const records = [];
    for (const entry of await readdir(join(this.root, 'attempts'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const record = await this.getInternal(entry.name);
      if (record) records.push(this._public(record, true));
    }
    return records.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || a.id.localeCompare(b.id));
  }
  async _notify(type, id, extra = {}) {
    const attempt = id ? await this.getInternal(id) : null;
    try {
      await this.onChange({ type, attempt, ...extra });
      if (id) {
        const path = await this._attemptPath(id), state = await readJson(join(path, 'state.json'));
        if (state?.archiveError) { state.archiveError = null; await atomicJson(join(path, 'state.json'), state); }
      }
    } catch (error) {
      if (!id) return;
      const path = await this._attemptPath(id), state = await readJson(join(path, 'state.json'));
      state.archiveError = `归档同步失败，原始作答已保存：${String(error.message || error).slice(0, 2000)}`;
      await atomicJson(join(path, 'state.json'), state);
    }
  }

  async recordMethodExposure(itemIds, sessionId) {
    await this.init();
    return this._mutate(async () => {
      for (const itemId of itemIds) {
        const exists = (await this._events(itemId)).some(e => e.type === 'help' && e.kind === 'method' && e.sessionId === sessionId);
        if (!exists) await this._appendEvent({ type: 'help', kind: 'method', itemId, sessionId });
      }
    });
  }

  async submit(payload, { trainingMode } = {}) {
    await this.init();
    const valid = validateSubmission(payload), requestHash = hash(valid);
    return this._mutate(async () => {
      const old = await this.getInternal(valid.id);
      if (old) {
        if (old.requestHash !== requestHash) fail('同一个作答 ID 已保存不同内容；原卷不可覆盖，请创建新的作答。', 409);
        return this._public(old);
      }
      const catalog = await this._rawCatalog(), entry = catalog.items.find(item => item.id === valid.itemId);
      if (!entry) fail('题目不存在或尚未导入', 404);
      const item = await this._withImages(entry);
      if (catalog.sources.find(source => source.id === item.sourceId)?.status !== 'available') fail('题源尚未准备好，不能提交批改', 409);
      if (valid.parentAttemptId) {
        const parent = await this.getInternal(valid.parentAttemptId);
        if (!parent || parent.itemId !== valid.itemId) fail('订正关联的原作答不存在或题目不一致', 409);
      }
      const submission = { schemaVersion: 1, ...valid, item: clone(item), submittedAt: now(), requestHash,
        helpHistory: (await this._events(item.id)).filter(event => event.type === 'help') };
      if (trainingMode === 'guided') submission.item.measurementEligible = false;
      const path = await this._attemptPath(valid.id);
      await mkdir(path, { recursive: true });
      try { await immutableJson(await boundedPath(path, 'submission.json'), submission); }
      catch (error) { if (error.code === 'EEXIST') fail('该作答已经被另一个请求保存，请重新读取。', 409); throw error; }
      await atomicJson(await boundedPath(path, 'state.json'), this._newState(submission));
      await this._notify('submitted', valid.id);
      const result = this._public(await this.getInternal(valid.id));
      this._queueJob(valid.id);
      return result;
    });
  }

  _queueJob(id) {
    if (this._queued.has(id)) return;
    this._queued.add(id);
    const job = this._jobs.then(() => this._runJob(id));
    this._jobs = job.catch(() => {}).finally(() => this._queued.delete(id));
  }
  async _runJob(id) {
    let record, run, path;
    try {
      await this._mutate(async () => {
        record = await this.getInternal(id);
        if (!record || record.state !== 'queued') return;
        path = await this._attemptPath(id);
        const state = await readJson(join(path, 'state.json'));
        state.state = 'running'; state.gradingRun += 1; state.updatedAt = now(); state.lastError = null; state.interrupted = false;
        run = state.gradingRun;
        await atomicJson(join(path, 'state.json'), state);
        await this._notify('running', id);
        record = await this.getInternal(id);
      });
      if (!run) return;
      const result = await this.grader({ attempt: clone(record), item: clone(record.originalItem),
        images: record.pages.map(page => page.image), corrections: clone(record.corrections), helpHistory: clone(record.helpHistory) });
      await this._mutate(async () => {
        const runDir = await boundedPath(path, 'runs', String(run).padStart(4, '0'));
        await mkdir(runDir, { recursive: true });
        // Keep the raw grader return even when structural validation fails.
        await immutableJson(await boundedPath(runDir, 'raw-result.json'), { completedAt: now(), result });
        const context = { topicIds: record.item.topicIds, pageCount: record.pages.length, sourceQuality: record.item.sourceQuality };
        let verified;
        if (Array.isArray(result?.reports) && result.reports.length === 2) {
          verified = reconcilePracticeGrades(result.reports[0].grade ?? result.reports[0], result.reports[1].grade ?? result.reports[1], context);
          if (result.grade) validatePracticeGrade(result.grade, context);
        } else {
          const grade = validatePracticeGrade(result?.grade ?? result, context);
          verified = { grade: { ...grade, verdict: 'needs-review', errorTopicIds: [],
            uncertainties: [...grade.uncertainties, '未取得两次完整批改报告，暂不形成知识点证据。'],
            verification: { status: 'needs-review', reason: '缺少独立复核报告。' } }, agreement: false };
        }
        const state = await readJson(join(path, 'state.json'));
        state.grade = verified.grade; state.agreement = verified.agreement; state.usage = result.usage ?? null;
        state.state = ['needs-review', 'source-issue'].includes(verified.grade.verdict) ? 'needs-review' : 'done';
        state.updatedAt = now(); state.lastError = null;
        await immutableJson(await boundedPath(runDir, 'result.json'), { at: state.updatedAt, grade: state.grade, agreement: state.agreement, usage: state.usage });
        await atomicJson(join(path, 'state.json'), state);
        await this._notify('graded', id);
      });
    } catch (error) {
      await this._mutate(async () => {
        path = await this._attemptPath(id);
        const state = await readJson(join(path, 'state.json'));
        if (!state) return;
        state.state = 'failed'; state.updatedAt = now(); state.lastError = String(error.message || error).slice(0, 6000);
        state.grade = null; state.agreement = false;
        state.usage = error.partialReports?.some(report => report.usage) ? summarizeCodexUsage(error.partialReports) : null;
        if (run) {
          const runDir = await boundedPath(path, 'runs', String(run).padStart(4, '0'));
          await mkdir(runDir, { recursive: true });
          await immutableJson(join(runDir, `failure-${randomUUID()}.json`), { at: state.updatedAt, message: state.lastError, partialReports: error.partialReports || [] });
        }
        await atomicJson(join(path, 'state.json'), state);
        await this._notify('failed', id);
      });
    }
  }

  async retry(id) {
    await this.init(); requireId(id);
    return this._mutate(async () => {
      const record = await this.getInternal(id);
      if (!record) fail('作答不存在', 404);
      if (['queued', 'running'].includes(record.state)) return this._public(record);
      if (record.state === 'done') fail('批改已完成；如有事实错误，请提交事实更正。', 409);
      const path = await this._attemptPath(id), state = await readJson(join(path, 'state.json'));
      state.state = 'queued'; state.updatedAt = now(); state.grade = null; state.agreement = false; state.usage = null; state.lastError = null;
      await atomicJson(join(path, 'state.json'), state);
      await this._notify('retried', id);
      const result = this._public(await this.getInternal(id));
      this._queueJob(id);
      return result;
    });
  }

  async correct(id, payload) {
    await this.init(); requireId(id);
    only(payload, ['reason', 'conditions'], '事实更正');
    const reason = text(payload.reason, '更正理由', 8000);
    const correctedConditions = payload.conditions === undefined ? {} : conditions(payload.conditions, true);
    return this._mutate(async () => {
      const record = await this.getInternal(id);
      if (!record) fail('作答不存在', 404);
      if (['queued', 'running'].includes(record.state)) fail('请等待本次批改完成，再追加事实更正。', 409);
      const event = await this._appendEvent({ type: 'correction', itemId: record.itemId, attemptId: id, reason, conditions: correctedConditions });
      const path = await this._attemptPath(id), state = await readJson(join(path, 'state.json'));
      state.state = 'queued'; state.updatedAt = now(); state.grade = null; state.agreement = false; state.usage = null; state.lastError = null;
      await atomicJson(join(path, 'state.json'), state);
      await this._notify('corrected', id, { event });
      const result = this._public(await this.getInternal(id));
      this._queueJob(id);
      return result;
    });
  }

  async reveal(itemId, payload = {}) {
    await this.init(); text(itemId, '题目 ID', 200);
    only(payload, ['kind', 'attemptId'], '解析展开');
    if (!['hint', 'solution'].includes(payload.kind)) fail('只能展开提示或解析');
    if (payload.attemptId != null) requireId(payload.attemptId);
    return this._mutate(async () => {
      const attempt = payload.attemptId ? await this.getInternal(payload.attemptId) : null;
      if (payload.attemptId && (!attempt || attempt.itemId !== itemId)) fail('关联作答不存在或题目不一致', 404);
      const entry = attempt?.originalItem ?? (await this._rawCatalog()).items.find(item => item.id === itemId);
      if (!entry) fail('题目不存在', 404);
      const item = entry.questionImages?.length ? entry : await this._withImages(entry);
      const content = payload.kind === 'hint' ? attempt?.grade?.hint : attempt?.grade?.solution || item.referenceAnswer;
      const images = payload.kind === 'solution' ? clone(item.referenceImages || []) : [];
      if (!content && !images.length) fail(payload.kind === 'hint' ? '批改完成后才有针对本次作答的提示。' : '当前还没有可展开的解析。', 409);
      const event = await this._appendEvent({ type: 'help', itemId, attemptId: attempt?.id ?? null, kind: payload.kind });
      await this._notify('revealed', attempt?.id ?? null, { event });
      return { itemId, attemptId: attempt?.id ?? null, kind: payload.kind, text: content || '', images, event };
    });
  }

  async waitForIdle() {
    await this.init();
    for (;;) {
      const mutations = this._mutations, jobs = this._jobs;
      await mutations; await jobs;
      if (mutations === this._mutations && jobs === this._jobs) return;
    }
  }

  async syncArchive(id) {
    await this.init(); requireId(id);
    return this._mutate(async () => {
      const record = await this.getInternal(id);
      if (!record) fail('作答不存在', 404);
      await this._notify(record.grade ? 'graded' : record.state === 'failed' ? 'failed' : 'submitted', id);
      return this._public(await this.getInternal(id));
    });
  }
}
