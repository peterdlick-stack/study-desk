import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEnglishCoach, EnglishMethodCorpus, validateEnglishDiagnosis } from '../lib/english-coach.mjs';

async function transcripts() {
  const root = await mkdtemp(join(tmpdir(), 'english-methods-'));
  const fixtures = [
    ['应用文', 'Advertisement 1', '细节题最重要的是定位和关键词。正确选项一定和文章主题关系密切。'],
    ['记叙文', 'Story 1', '叙事要看人物、原因、过程、结果和最后的感悟。'],
    ['说明文', 'Fact 1', '说明文先找说明对象，研究类要抓研究结论。'],
    ['议论文', 'Opinion 1', '作者举例是为了支持观点，不要只看例子的表面内容。'],
    ['七选五', 'Completion 1', '七选五看相邻句对应、代词指代和转折关系。'],
  ];
  for (const [category, part, line] of fixtures) {
    const directory = join(root, category); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${category}_01_${part}.md`), `---\nsource: https://example.test/${category}\ncategory: ${category}\npart: ${part}\n---\n\n[00:00:01] ${line}\n[00:00:15] ${line}\n`, 'utf8');
  }
  return root;
}

const diagnosis = sourceId => ({
  summary: '把例子的表面内容当成了作者观点。', genre: 'argumentative', questionType: 'detail', languageBarrier: 'absent',
  expectedAction: '先定位例子，再回到它支持的观点。', articleEvidence: '例子后的总结句给出作者观点。', chosenAnswerProblem: '所选项只复述例子。',
  correctAnswerReason: '正确项概括例子支持的观点。', causeCode: 'EXAMPLE_AS_CLAIM', causeLabel: '把例子当成观点', certainty: 'medium',
  reason: '文章与选项支持这一判断，但仍不知道作答时的真实想法。', probe: { question: '你当时更接近哪种情况？', choices: [{ id: 'surface', label: '我停在例子表面' }, { id: 'viewpoint', label: '我找了观点但对应错了' }] },
  nextAction: '下一题先写出例子支持的观点，再看选项。', sourceIds: [sourceId],
});

test('transcript corpus loads all genres and retrieves the matching method', async () => {
  const corpus = new EnglishMethodCorpus(await transcripts()), loaded = await corpus.load();
  assert.equal(loaded.files, 5); assert.ok(loaded.chunks.length >= 5);
  const sources = await corpus.retrieve({ genreHint: 'argumentative', question: 'Why does the author mention the example?', options: 'A B C D', markedText: '', languageSignal: 'none' });
  assert.ok(sources.some(source => source.category === '议论文' && source.text.includes('例子')));
});

test('coach sends handbook, retrieved excerpts and task to one structured Codex call', async () => {
  const root = await transcripts(); let seen = '';
  const coach = createEnglishCoach({ transcriptRoot: root, runStructured: async args => {
    seen = args.prompt; const id = seen.match(/SOURCE_ID=([^\n]+)/)[1];
    return { grade: diagnosis(id), usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } };
  } });
  const result = await coach.diagnose({ article: 'The author gives an example and then states the claim.', question: 'Why is the example mentioned?', options: 'A. repeat it\nB. support the claim', selectedAnswer: 'A', correctAnswer: 'B', markedText: '', languageSignal: 'none', genreHint: 'argumentative', lessonTitle: 'Synthetic' });
  assert.equal(result.diagnosis.causeCode, 'EXAMPLE_AS_CLAIM');
  assert.match(seen, /阅读方法导航/); assert.match(seen, /COURSE_EXCERPTS/); assert.match(seen, /TASK_DATA_JSON/);
  assert.ok(result.sources.length); assert.equal(result.usage.input_tokens, 10);
});

test('diagnosis cannot cite a transcript excerpt that was not supplied', () => {
  assert.throws(() => validateEnglishDiagnosis(diagnosis('invented'), new Set(['real-source'])), /sourceIds/);
});
