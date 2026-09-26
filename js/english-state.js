export const PHASES = { independent: '独立读原文', explanation: '看课程讲解', reread: '回读与解决卡点' };
const fail = message => { throw new Error(message); };
const str = (v, max = 4000) => typeof v === 'string' && v.length <= max ? v : fail('文字为空或过长');
const number = (v, max) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : fail('数值无效');
export function emptyEnglishState() {
  return { phase: 'independent', position: '', videoTime: 0, videoRate: 1, completed: false,
    seconds: { independent: 0, explanation: 0, reread: 0 }, blockers: [], helps: [], samples: [], sampleDraft: {}, diagnoses: [] };
}
function sampleFields(value) {
  const v = value || {}, out = {};
  for (const key of ['title', 'source', 'article', 'mainIdea', 'structure', 'evidence', 'help', 'unseen', 'comparable', 'minutes']) out[key] = str(v[key] ?? '', key === 'article' ? 100000 : 5000);
  if (!['', 'yes', 'no'].includes(out.unseen) || !['', 'yes', 'no'].includes(out.comparable)) fail('请选择实际条件');
  if (out.minutes !== '' && (!Number.isFinite(Number(out.minutes)) || Number(out.minutes) < 0 || Number(out.minutes) > 1440)) fail('用时无效');
  return out;
}
function diagnosisPayload(value) {
  const v = value || {}, task = v.task || {}, diagnosis = v.diagnosis || {};
  const cleanTask = {};
  for (const [key, max] of Object.entries({ article: 120000, question: 10000, options: 30000, selectedAnswer: 1000, correctAnswer: 1000, markedText: 10000, languageSignal: 40, genreHint: 40 })) cleanTask[key] = str(task[key] ?? '', max);
  if (!cleanTask.question.trim() || !cleanTask.options.trim() || !cleanTask.selectedAnswer.trim() || !cleanTask.correctAnswer.trim()) fail('诊断题目信息不完整');
  if (!['none', 'word', 'syntax', 'uncertain'].includes(cleanTask.languageSignal) || !['application', 'narrative', 'expository', 'argumentative', 'seven-choice', 'unknown'].includes(cleanTask.genreHint)) fail('诊断选择无效');
  const cleanDiagnosis = {};
  for (const key of ['summary', 'genre', 'questionType', 'languageBarrier', 'expectedAction', 'articleEvidence', 'chosenAnswerProblem', 'correctAnswerReason', 'causeCode', 'causeLabel', 'certainty', 'reason', 'nextAction']) cleanDiagnosis[key] = str(diagnosis[key] ?? '', 8000);
  const probe = diagnosis.probe || {};
  cleanDiagnosis.probe = { question: str(probe.question || '', 2000), choices: Array.isArray(probe.choices) ? probe.choices.slice(0, 4).map(choice => ({ id: str(choice?.id || '', 40), label: str(choice?.label || '', 500) })) : [] };
  cleanDiagnosis.sourceIds = Array.isArray(diagnosis.sourceIds) ? diagnosis.sourceIds.slice(0, 12).map(id => str(id, 80)) : [];
  const sources = Array.isArray(v.sources) ? v.sources.slice(0, 12).map(source => ({ id: str(source?.id || '', 80), category: str(source?.category || '', 100), part: str(source?.part || '', 500), source: str(source?.source || '', 2000), start: str(source?.start || '', 20), end: str(source?.end || '', 20) })) : [];
  return { task: cleanTask, diagnosis: cleanDiagnosis, sources, usage: v.usage && typeof v.usage === 'object' ? structuredClone(v.usage) : null };
}
// Server and UI use the same reducer; completion never creates a mastery score.
export function applyEnglishEvent(previous, event, course) {
  const s = structuredClone(previous), p = event.payload || {};
  const block = id => course.blocks.some(b => b.id === id) || fail('原文位置不存在');
  const now = event.at;
  switch (event.type) {
    case 'phase': if (!PHASES[p.phase]) fail('训练阶段无效'); s.phase = p.phase; break;
    case 'position': block(p.blockId); s.position = p.blockId; break;
    case 'video': s.videoTime = number(p.time, course.video?.duration || 86400); s.videoRate = number(p.rate, 4); break;
    case 'time': if (!PHASES[p.phase]) fail('训练阶段无效'); s.seconds[p.phase] += number(p.seconds, 120); break;
    case 'complete': if (typeof p.value !== 'boolean') fail('完成状态无效'); s.completed = p.value; break;
    case 'help': {
      if (!['dictionary', 'translation', 'slides', 'notes', 'annotations', 'video', 'other'].includes(p.kind)) fail('帮助类型无效');
      s.helps.push({ id: event.id, kind: p.kind, at: now, phase: s.phase, blockId: s.position, videoTime: s.videoTime }); break;
    }
    case 'blocker-add': {
      block(p.blockId);
      s.blockers.push({ id: event.id, blockId: p.blockId, note: str(p.note || ''), at: now, resolved: false, resolution: '', videoTime: s.videoTime }); break;
    }
    case 'blocker-update': {
      const b = s.blockers.find(b => b.id === p.id); if (!b) fail('卡点不存在');
      if (typeof p.resolved !== 'boolean') fail('卡点状态无效');
      b.resolved = p.resolved; b.resolution = str(p.resolution); b.updatedAt = now; b.resolvedVideoTime = s.videoTime; break;
    }
    case 'sample-draft': s.sampleDraft = sampleFields(p); break;
    case 'sample-submit': {
      const v = sampleFields(p);
      if (!v.title.trim() || !v.article.trim() || !v.mainIdea.trim() || !v.structure.trim() || !v.evidence.trim()) fail('请留下文章、主旨、结构和原文依据');
      s.samples.push({ ...v, id: event.id, at: now, reviewStatus: 'pending', minutes: v.minutes === '' ? null : Number(v.minutes) });
      s.sampleDraft = {}; break;
    }
    case 'diagnosis-add': {
      const v = diagnosisPayload(p);
      s.diagnoses.push({ ...v, id: event.id, at: now, confirmation: null }); break;
    }
    case 'diagnosis-confirm': {
      const diagnosis = s.diagnoses.find(value => value.id === p.id); if (!diagnosis) fail('诊断记录不存在');
      const choice = diagnosis.diagnosis.probe.choices.find(value => value.id === p.choiceId); if (!choice) fail('确认选项不存在');
      diagnosis.confirmation = { choiceId: choice.id, label: choice.label, at: now }; break;
    }
    default: fail('未知英语记录类型');
  }
  return s;
}
