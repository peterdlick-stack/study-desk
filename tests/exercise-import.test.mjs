import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCatalog, cleanLatex, contentFingerprint, importCatalog, mergeCatalog, parseChapter } from '../scripts/import-local-exercises.mjs';

const chapter = { no: '01', title: '力学', track: '8.01', unitId: 'physics836-mechanics', fallback: 'mechanics-general' };
const question = (code, prompt, answer = '答案甲', analysis = '推导甲') => String.raw`\begin{problembox}{第 ${code} 题}
${prompt}
\problemref{原题库编号 ${code}}
\end{problembox}
\begin{officialbox}${answer}\end{officialbox}
\begin{analysisbox}${analysis}\end{analysisbox}`;

async function fixture(t, body) {
  const root = await mkdtemp(join(tmpdir(), 'study-desk-exercise-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'chapters'));
  await mkdir(join(root, 'assets/figures'), { recursive: true });
  for (const no of ['01', '02', '08', '09']) await writeFile(join(root, 'chapters', `${no}-generated.tex`), no === '01' ? body : '');
  return root;
}

test('pairs each original problem with its own answer and preserves nested formula braces', () => {
  const text = String.raw`\chapter{01 力学}\section{选择题}` +
    question('0123', String.raw`速度为 $\frac{d\vec{r}}{dt}$，位移 x\ensuremath{{}^{3}}。`, 'A', '推导一') +
    String.raw`\section{计算题}` + question('0124', '第二题动量', 'B', '推导二');
  const result = parseChapter(text, chapter, '/source/chapters/01-generated.tex');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].id, 'thu-local-0123');
  assert.match(result.items[0].prompt, /\\frac\{d\\vec\{r\}\}\{dt\}/);
  assert.match(result.items[0].prompt, /\\\(\{\}\^\{3\}\\\)/);
  assert.doesNotMatch(result.items[0].prompt, /problemref|答案|推导/);
  assert.match(result.items[0].referenceAnswer, /推导一/);
  assert.doesNotMatch(result.items[0].referenceAnswer, /推导二/);
  assert.match(result.items[1].locator.section, /计算题/);
  assert.equal(result.items[0].sourceQuality, 'UNKNOWN');
  assert.equal(result.items[0].topicMapping, 'keyword-candidate');
  assert.deepEqual(result.items[1].topicIds, ['practice-momentum']);
});

test('marks documented disputes and quarantines unavailable diagrams or malformed answers', () => {
  const text = question('1111', '速度多选', 'C、D', '题目存在命题缺陷') +
    question('1112', String.raw`\begin{tikzpicture}a\end{tikzpicture}`, 'B') +
    String.raw`\begin{problembox}{第 3 题}没有参考答案\problemref{原题库编号 1113}\end{problembox}`;
  const result = parseChapter(text, chapter, '01-generated.tex');
  assert.equal(result.items[0].sourceQuality, 'disputed');
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.skipped.map(item => item.reason), ['tikz-rendering-required', 'missing-body-id-or-reference-answer']);
});

test('embeds only matching assets, excludes missing figure dependencies and ignores unapproved chapters', async t => {
  const body = question('1000', String.raw`如图速度\includegraphics[width=.5\linewidth]{q.png}`, String.raw`答案\includegraphics{a.png}`) +
    question('1001', '如图所示的轨道') +
    question('1002', String.raw`图示\includegraphics{absent.png}`) +
    question('1003', String.raw`图示\includegraphics{../../outside.png}`);
  const root = await fixture(t, body);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4uoAAAAASUVORK5CYII=', 'base64');
  await writeFile(join(root, 'assets/figures/q.png'), png);
  await writeFile(join(root, 'assets/figures/a.png'), png);
  // This chapter deliberately has invalid bytes: it must never be opened/imported.
  await writeFile(join(root, 'chapters/06-generated.tex'), question('6000', '未经授权的光学补题'));
  const { catalog, report } = await buildCatalog(root);
  assert.equal(catalog.items.length, 1);
  assert.equal(catalog.items[0].questionImages[0].name, 'q.png');
  assert.equal(catalog.items[0].referenceImages[0].name, 'a.png');
  assert.match(catalog.items[0].questionImages[0].dataUrl, /^data:image\/png;base64,/);
  assert.match(catalog.items[0].prompt, /【图 q.png】/);
  assert.equal(report.skipped.length, 3);
  assert.ok(report.skipped.some(item => item.reason.includes('image-path-outside-source')));
  assert.ok(!catalog.items.some(item => item.track === '8.03'));
  assert.ok(catalog.sources.filter(item => item.kind !== 'local').every(item => item.status === 'pending'));
});

test('merge preserves user edits, retained metadata and histories; ignores formatting duplicates', () => {
  const original = { id: 'q1', prompt: '$x + y$', referenceAnswer: '用户修正过的答案', sourceQuality: 'disputed', questionImages: [], attempts: [{ id: 'attempt-kept' }] };
  const existing = { schemaVersion: 1, sources: [{ id: 's1', note: '用户备注' }], topics: [], items: [original], extraUserField: { keep: true } };
  const incoming = { schemaVersion: 1, sources: [{ id: 's1', note: '新版备注' }], topics: [], items: [
    { ...original, prompt: '导入端改过题面', referenceAnswer: '不应覆盖' },
    { id: 'q2', prompt: '$x+y$', questionImages: [] },
    { id: 'q3', prompt: '另一道不同题', questionImages: [] },
  ] };
  const result = mergeCatalog(existing, incoming);
  assert.deepEqual(result.catalog.items[0], original);
  assert.deepEqual(result.catalog.extraUserField, { keep: true });
  assert.equal(result.catalog.sources[0].note, '用户备注');
  assert.deepEqual(result.conflicts, ['q1']);
  assert.equal(result.added, 1);
  assert.deepEqual(result.catalog.items.map(item => item.id), ['q1', 'q3']);
  assert.equal(existing.items.length, 1);
  assert.equal(contentFingerprint({ prompt: String.raw`\textbf{位移} $x+y$` }), contentFingerprint({ prompt: '位移 $x + y$' }));
});

test('repeat import is byte-identical and source additions retain edited answers with a backup', async t => {
  const root = await fixture(t, question('1111', '速度问题'));
  const output = join(root, 'private/practice/catalog.json');
  const first = await importCatalog({ sourceRoot: root, output });
  assert.equal(first.added, 1);
  const bytes = await readFile(output, 'utf8');
  const second = await importCatalog({ sourceRoot: root, output });
  assert.equal(second.added, 0);
  assert.equal(await readFile(output, 'utf8'), bytes);
  const edited = JSON.parse(bytes);
  edited.items[0].referenceAnswer = '用户核对后的答案';
  await writeFile(output, JSON.stringify(edited));
  await writeFile(join(root, 'chapters/01-generated.tex'), question('1111', '速度问题') + question('2222', '动量问题'));
  const third = await importCatalog({ sourceRoot: root, output });
  assert.equal(third.added, 1);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).items[0].referenceAnswer, '用户核对后的答案');
  const files = await readdir(join(root, 'private/practice'));
  assert.ok(files.some(name => name.includes('.before-import-')));
  assert.ok(!files.some(name => name.endsWith('.import.lock') || name.endsWith('.tmp')));
});

test('nested non-math wrappers and literal escaped percent remain intact', () => {
  assert.equal(cleanLatex(String.raw`\textbf{公式 $\frac{a}{b}$} % comment
50\%`), String.raw`公式 $\frac{a}{b}$
50\%`);
});
