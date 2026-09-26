import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { EnglishStore } from '../lib/english.mjs';

export async function prepareDemo(directory) {
  const root = resolve(directory), materials = join(root, 'english', 'materials');
  const indexPath = join(materials, 'index.json');
  try { await access(indexPath); return { created: false }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(materials, { recursive: true });
  const passages = [
    { title: 'The garden experiment · 合成阅读示例', paragraphs: [
      'A neighbourhood library replaced a small paved corner with a garden. During the first month, several residents began stopping there after work. One visitor brought a book; another watered the plants. These observations suggested that a small shared space could encourage brief conversations.',
      'The librarian described one visitor who initially stayed for only five minutes but later offered to help maintain the garden. This example illustrates how repeated, low-pressure visits can make participation easier. It does not establish that every visitor will become a volunteer.',
      'The library has not compared the garden with another site. Weather and a new bus stop may also have influenced attendance. The team plans to record visits before drawing a broader conclusion.'
    ] },
    { title: 'A quieter reading room · 合成阅读示例', paragraphs: [
      'A college opened a quiet reading room for a two-week trial. Students could choose a desk, leave a short note about distractions and return later to the same task. The organisers recorded requests and comments rather than assuming that time spent in the room meant learning had improved.',
      'Some students valued the quiet desks, while others preferred group discussion. The trial offered evidence about these visitors and their immediate experience. Longer-term learning outcomes remained unmeasured.'
    ] }
  ];
  const courses = passages.map((p, n) => ({ lessonId: `free-english-${String(n).padStart(2, '0')}`, number: n,
    title: p.title, pages: 1, blocks: p.paragraphs.map((text, i) => ({ id: `p1-b${i + 1}`, page: 1, text })),
    assetIds: [], originalAssetId: null, video: null }));
  await writeFile(indexPath, JSON.stringify({ assets: {}, courses }, null, 2), { flag: 'wx' });
  const store = new EnglishStore(root);
  await store.append({ lessonId: courses[0].lessonId, expectedRevision: null,
    event: { id: 'demo-diagnosis-0001', type: 'diagnosis-add', payload: {
      task: { article: courses[0].blocks.map(b => b.text).join('\n\n'), question: 'Why does the librarian describe the visitor?',
        options: 'A. To claim all visitors become volunteers.\nB. To illustrate how participation can become easier.',
        selectedAnswer: 'A', correctAnswer: 'B', markedText: '', languageSignal: 'none', genreHint: 'argumentative' },
      diagnosis: { summary: '预置示例，非实时模型输出：把一个人的变化推广成了所有访客的结果。',
        genre: 'argumentative', questionType: 'detail', languageBarrier: 'uncertain',
        expectedAction: '回到例子后的解释句，核对它支持的结论和范围。',
        articleEvidence: 'This example illustrates how repeated, low-pressure visits can make participation easier.',
        chosenAnswerProblem: 'A 的 all visitors 超出了文章证据，且与原文限定相反。',
        correctAnswerReason: 'B 对应例子后的解释句，保留 can 的范围。', causeCode: 'OVERSTATEMENT',
        causeLabel: '预置示例 · 结论范围扩大', certainty: 'medium',
        reason: '选项差异可以核对，但仅凭结果无法知道当时的思考过程。',
        probe: { question: '你当时更接近哪一种？', choices: [
          { id: 'scope', label: '没有注意 all 和 can 的差别' },
          { id: 'example', label: '把一个例子理解成了普遍结论' }] },
        nextAction: '再次比较 all visitors 与 can make participation easier。此建议为演示内容。',
        sourceIds: ['demo-method-1'] },
      sources: [{ id: 'demo-method-1', category: '合成示例', part: '观点与例子的范围', source: 'synthetic:study-desk/argument', start: '00:00:01', end: '00:00:01' }],
      usage: null
    } } });
  return { created: true };
}
