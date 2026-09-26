#!/usr/bin/env node
// Append-only catalog import from an explicitly selected local directory.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, open, unlink, rename, copyFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SOURCE = resolve('examples/local-exercises');
export const DEFAULT_OUTPUT = resolve(PROJECT, '.local/study-library/practice/catalog.json');
const SOURCE_ID = 'thu-local-physics-bank';
const sha = value => createHash('sha256').update(value).digest('hex');
const CHAPTERS = [
  { no: '01', title: '力学', track: '8.01', unitId: 'physics836-mechanics', fallback: 'mechanics-general' },
  { no: '02', title: '刚体', track: '8.01', unitId: 'physics836-mechanics', fallback: 'rigid-body' },
  { no: '08', title: '电学', track: '8.02', unitId: 'physics836-electrostatics', fallback: 'electrostatics-general' },
  { no: '09', title: '磁学', track: '8.02', unitId: 'physics836-magnetism', fallback: 'magnetism-general' },
];
// Candidate associations only; grading must establish which concept an actual error concerns.
const TOPICS = [
  ['mechanics-general', '力学综合（待细分）', 'physics836-mechanics', /$^/],
  ['kinematics', '位移、速度与加速度', 'physics836-mechanics', /速度|加速度|运动学|位矢|位移|矢径|抛体|斜抛/],
  ['newton-laws', '牛顿定律与受力分析', 'physics836-mechanics', /牛顿|受力|摩擦|拉力|张力|绳|斜面/],
  ['work-energy', '功、能量与守恒', 'physics836-mechanics', /动能|势能|机械能|功率|作功|做功|保守力/],
  ['momentum', '动量、冲量与碰撞', 'physics836-mechanics', /动量|冲量|碰撞|弹性碰撞|爆炸/],
  ['gravitation', '万有引力与轨道', 'physics836-mechanics', /万有引力|卫星|行星|地球|轨道/],
  ['rigid-body', '刚体转动', 'physics836-mechanics', /转动惯量|刚体|角速度|角加速度|力矩|角动量|转轴|飞轮/],
  ['electrostatics-general', '电学综合（待细分）', 'physics836-electrostatics', /$^/],
  ['electric-field', '库仑定律与电场叠加', 'physics836-electrostatics', /电场|场强|库仑/],
  ['gauss-law', '电通量与高斯定律', 'physics836-electrostatics', /高斯|电通量|闭合曲面|闭合面/],
  ['electric-potential', '电势与电势能', 'physics836-electrostatics', /电势|电位|电场力.*功/],
  ['conductors-capacitors', '导体、电介质与电容', 'physics836-electrostatics', /导体|电容|电介质|极化|介电/],
  ['magnetism-general', '磁学综合（待细分）', 'physics836-magnetism', /$^/],
  ['magnetic-field', '磁场与安培环路定律', 'physics836-magnetism', /磁场|磁感应强度|毕奥|环路|螺线管|直导线/],
  ['magnetic-force', '洛伦兹力与安培力', 'physics836-magnetism', /洛伦兹|安培力|带电粒子|带电质点|磁力矩/],
  ['induction', '电磁感应与电感', 'physics836-magnetism', /感应电动势|感生|动生|楞次|磁通|自感|互感|电感/],
  ['maxwell', '位移电流与麦克斯韦方程', 'physics836-magnetism', /位移电流|麦克斯韦|电磁波/],
];

function argumentAt(text, start) {
  if (text[start] !== '{') return null;
  let depth = 1;
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === '{') depth++;
    if (text[index] === '}' && --depth === 0) return { body: text.slice(start + 1, index), end: index + 1 };
  }
  return null;
}

function replaceMacro(text, name, replacement) {
  const re = new RegExp(String.raw`\\${name}\s*(?=\{)`, 'g');
  let result = '', position = 0, match;
  while ((match = re.exec(text))) {
    const arg = argumentAt(text, re.lastIndex);
    if (!arg) continue;
    result += text.slice(position, match.index) + replacement(arg.body);
    position = arg.end;
    re.lastIndex = arg.end;
  }
  return result + text.slice(position);
}

export function cleanLatex(text) {
  let output = text.replace(/(?<!\\)%[^\r\n]*/g, '');
  output = replaceMacro(output, 'problemref', () => '');
  output = output.replace(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g, (_, name) => `【图 ${basename(name)}】`);
  output = replaceMacro(output, 'ensuremath', body => `\\(${body}\\)`);
  for (const name of ['textbf', 'textit', 'emph', 'mbox']) output = replaceMacro(output, name, body => body);
  output = output.replace(/\\(?:begin|end)\{(?:center|flushleft|flushright)\}/g, '')
    .replace(/\\(?:small|footnotesize|noindent)\b/g, '')
    .replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return output;
}

function imageNames(text) {
  return [...text.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)].map(match => match[1]);
}

export function contentFingerprint(item) {
  const prompt = cleanLatex(item.prompt ?? '').normalize('NFKC')
    .replace(/\\(?:left|right)\b/g, '').replace(/\s+/g, '');
  return sha(prompt + '\n' + (item.questionImages ?? []).map(image => sha(image.dataUrl)).join('\n'));
}

export function parseChapter(text, chapter, sourcePath) {
  const starts = [...text.matchAll(/\\begin\{problembox\}\{([^}]+)\}/g)];
  const items = [], skipped = [];
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index];
    const block = text.slice(start.index + start[0].length, starts[index + 1]?.index ?? text.length);
    const end = block.indexOf('\\end{problembox}');
    const sections = [...text.slice(0, start.index).matchAll(/\\section\{([^}]+)\}/g)];
    const section = sections.at(-1)?.[1] ?? '未分类';
    const reference = block.slice(0, end).match(/\\problemref\{([^}]+)\}/)?.[1] ?? '';
    const code = reference.match(/编号\s*([A-Za-z0-9-]+)/)?.[1];
    const label = `${chapter.title} ${section} ${start[1]}`;
    const official = block.match(/\\begin\{officialbox\}([\s\S]*?)\\end\{officialbox\}/)?.[1];
    const analysis = block.match(/\\begin\{analysisbox\}([\s\S]*?)\\end\{analysisbox\}/)?.[1];
    if (end < 0 || !code || !official?.trim()) {
      skipped.push({ label, reason: 'missing-body-id-or-reference-answer' }); continue;
    }
    const rawPrompt = block.slice(0, end);
    const rawAnswer = `题库答案（未经独立核验）\n${official}\n\n整理本解析（可能含编者推导，未经独立核验）\n${analysis ?? ''}`;
    if (/\\begin\{tikzpicture\}/.test(rawPrompt + rawAnswer)) {
      skipped.push({ label, code, reason: 'tikz-rendering-required' }); continue;
    }
    const disputed = /\\todocheck\b|命题缺陷|题目存在.*(?:错误|歧义)|待人工核|待核原题/.test(block);
    const prompt = cleanLatex(rawPrompt);
    const matchedTopics = TOPICS.filter(([, , unit, re]) => unit === chapter.unitId && re.test(prompt));
    const topicIds = (matchedTopics.length ? matchedTopics.map(topic => topic[0]) : [chapter.fallback]).map(id => `practice-${id}`);
    items.push({
      id: `thu-local-${code}`, sourceId: SOURCE_ID, sourceRef: `${chapter.no} ${chapter.title} / ${section} / ${start[1]} / 原题库编号 ${code}`,
      title: label, prompt, referenceAnswer: cleanLatex(rawAnswer), topicIds,
      unitId: chapter.unitId, track: chapter.track, kind: 'supplement',
      sourceQuality: disputed ? 'disputed' : 'UNKNOWN',
      sourceQualityNote: disputed ? '整理本标出题源争议，批改须先核对题面及参考答案。' : 'OCR/LaTeX 整理本，答案与解析未经本次独立物理核验。',
      topicMapping: 'keyword-candidate',
      locator: { path: sourcePath, exercise: code, section: `${chapter.title} / ${section}` },
      _questionImages: imageNames(rawPrompt), _referenceImages: imageNames(rawAnswer),
      _missingFigure: /如图|图中|下图|图示|图所示/.test(prompt) && !imageNames(rawPrompt).length,
    });
  }
  return { items, skipped, parsedCount: starts.length };
}

async function loadImages(names, sourceRoot) {
  const images = [];
  const figureRoot = resolve(sourceRoot, 'assets/figures');
  for (const name of [...new Set(names)]) {
    const target = resolve(figureRoot, name);
    const rel = relative(figureRoot, target);
    if (isAbsolute(name) || rel.startsWith('..') || isAbsolute(rel)) throw new Error('image-path-outside-source');
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extname(target).toLowerCase()];
    if (!mime) throw new Error('unsupported-image-format');
    const bytes = await readFile(target);
    images.push({ name: basename(name), dataUrl: `data:${mime};base64,${bytes.toString('base64')}` });
  }
  return images;
}

export async function buildCatalog(sourceRoot = DEFAULT_SOURCE) {
  const root = resolve(sourceRoot);
  const sources = [
    { id: SOURCE_ID, title: '本地大学物理题库（清华题库 LaTeX 整理本）', kind: 'local', status: 'available', path: root,
      note: '只导入力学、刚体、电学、磁学四章；原题编号定位。整理本曾有 OCR、缺图和答案问题，题面/答案未逐题验证。关键词关联为候选；不含真题、模拟卷或波光补题。' },
    { id: 'mit-801-lewin-pset', title: 'MIT 8.01 Lewin PSET', kind: 'pset', status: 'pending', note: '1999 录像版本候选；尚未确认可用的同版本官方 PSET，不用其他年份冒充。' },
    { id: 'mit-802-lewin-pset', title: 'MIT 8.02 Lewin PSET（Spring 2002）', kind: 'pset', status: 'pending', note: '已核对官方 Spring02 原站与 PSET 链接；整份 PDF 与拆题、逐讲匹配的状态分别记录。官方目录 https://web.mit.edu/8.02/www/Spring02/probsets.htm' },
    { id: 'mit-803-lewin-pset', title: 'MIT 8.03 Lewin PSET', kind: 'pset', status: 'pending', note: '待核对录像及配套作业版本；波动与光的补充题源暂未确定。' },
    { id: 'electromagnetism-qian', title: '电磁学千题解', kind: 'qian', status: 'pending', note: '用户尚未下载；尚未取得可导入的资料。' },
  ];
  const items = [], skipped = [], seen = new Set(), fingerprints = new Set();
  let parsedCount = 0;
  for (const chapter of CHAPTERS) {
    const path = join(root, 'chapters', `${chapter.no}-generated.tex`);
    const parsed = parseChapter(await readFile(path, 'utf8'), chapter, path);
    parsedCount += parsed.parsedCount; skipped.push(...parsed.skipped);
    for (const candidate of parsed.items) {
      const { _questionImages, _referenceImages, _missingFigure, ...item } = candidate;
      if (_missingFigure) { skipped.push({ id: item.id, reason: 'figure-mentioned-but-no-embedded-figure' }); continue; }
      try {
        item.questionImages = await loadImages(_questionImages, root);
        item.referenceImages = await loadImages(_referenceImages, root);
      } catch (error) { skipped.push({ id: item.id, reason: `figure-unavailable: ${error.code ?? error.message}` }); continue; }
      item.sourceFingerprint = contentFingerprint(item);
      if (seen.has(item.id) || fingerprints.has(item.sourceFingerprint)) {
        skipped.push({ id: item.id, reason: 'duplicate-source-id-or-content' }); continue;
      }
      seen.add(item.id); fingerprints.add(item.sourceFingerprint); items.push(item);
    }
  }
  return {
    catalog: { schemaVersion: 1, sources, topics: TOPICS.map(([id, title, unitId]) => ({ id: `practice-${id}`, title, unitId })), items },
    report: { parsedCount, importedCount: items.length, skipped, byTrack: Object.fromEntries(['8.01', '8.02'].map(track => [track, items.filter(item => item.track === track).length])),
      questionImageCount: items.reduce((sum, item) => sum + item.questionImages.length, 0), referenceImageCount: items.reduce((sum, item) => sum + item.referenceImages.length, 0) },
  };
}

export function mergeCatalog(existing, incoming) {
  if (!existing) return { catalog: incoming, added: incoming.items.length, conflicts: [] };
  if (existing.schemaVersion !== 1 || !['sources', 'topics', 'items'].every(key => Array.isArray(existing[key]))) throw new Error('Existing catalog has an unsupported schema; no files changed.');
  const catalog = structuredClone(existing), conflicts = [];
  const fingerprints = new Set(existing.items.map(contentFingerprint));
  let added = 0;
  for (const key of ['sources', 'topics', 'items']) {
    const current = new Map(catalog[key].map(item => [item.id, item]));
    for (const candidate of incoming[key]) {
      if (current.has(candidate.id)) {
        if (key === 'items' && contentFingerprint(current.get(candidate.id)) !== contentFingerprint(candidate)) conflicts.push(candidate.id);
        continue;
      }
      if (key === 'items') {
        const fingerprint = contentFingerprint(candidate);
        if (fingerprints.has(fingerprint)) continue;
        fingerprints.add(fingerprint); added++;
      }
      catalog[key].push(candidate); current.set(candidate.id, candidate);
    }
  }
  return { catalog, added, conflicts };
}

export async function importCatalog({ sourceRoot = DEFAULT_SOURCE, output = DEFAULT_OUTPUT, reportPath } = {}) {
  const result = await buildCatalog(sourceRoot);
  output = resolve(output);
  await mkdir(dirname(output), { recursive: true });
  const lockPath = output + '.import.lock';
  const lock = await open(lockPath, 'wx');
  let temporary;
  try {
    let existing;
    try { existing = JSON.parse(await readFile(output, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const merged = mergeCatalog(existing, result.catalog);
    if (!existing || merged.added || merged.catalog.sources.length !== existing.sources.length || merged.catalog.topics.length !== existing.topics.length) {
      temporary = output + `.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(merged.catalog, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      if (existing) await copyFile(output, output + `.before-import-${Date.now()}-${randomUUID()}.json`);
      await rename(temporary, output); temporary = null;
    }
    const report = { ...result.report, output, added: merged.added, retainedConflictingIds: merged.conflicts, totalItems: merged.catalog.items.length };
    if (reportPath) await writeFile(resolve(reportPath), JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    return report;
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    await lock.close(); await unlink(lockPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  const names = { '--source': 'sourceRoot', '--output': 'output', '--report': 'reportPath' };
  try {
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = names[process.argv[index]], value = process.argv[index + 1];
      if (!key || !value) throw new Error('Usage: node scripts/import-local-exercises.mjs [--source DIR] [--output FILE] [--report NEW_FILE]');
      options[key] = value;
    }
    console.log(JSON.stringify(await importCatalog(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
