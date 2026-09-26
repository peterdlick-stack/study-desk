// Evidence is derived from immutable submissions and the latest reviewed report.
// These are the existing FORMULAS.md thresholds, never a model-estimated percentage.
const date = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const unique = values => [...new Set(values)];

export function summarizeAttempt(attempt) {
  const item = attempt.originalItem || attempt.item || {};
  return {
    id: attempt.id, itemId: attempt.itemId, lessonId: attempt.lessonId,
    submittedAt: attempt.submittedAt, updatedAt: attempt.updatedAt,
    state: attempt.state, conditions: attempt.conditions || {},
    parentAttemptId: attempt.parentAttemptId || null,
    helpHistory: attempt.helpHistory || [], corrections: attempt.corrections || [],
    grade: attempt.grade || null, lastError: attempt.lastError || '',
    item: { id: item.id || attempt.itemId, title: item.title || attempt.itemId,
      topicIds: item.topicIds || [], unitId: item.unitId, track: item.track,
      kind: item.kind, sourceId: item.sourceId, sourceRef: item.sourceRef,
      composite: item.composite === true, measurementEligible: item.measurementEligible,
      sourceQuality: item.sourceQuality || 'UNKNOWN', locator: item.locator,
      topicMapping: item.topicMapping || 'UNKNOWN' },
  };
}

export function derivePracticeEvidence(catalog, rawAttempts) {
  const attempts = rawAttempts.map(summarizeAttempt).filter(a => validTime(a.submittedAt))
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id));
  const firstByItem = new Map();
  for (const a of attempts) if (!firstByItem.has(a.itemId)) firstByItem.set(a.itemId, a.id);
  const rows = (catalog.topics || []).map(topic => {
    const relevant = attempts.filter(a => a.item.topicIds.includes(topic.id));
    const reviewed = relevant.filter(a => a.state === 'done' && a.grade?.verification?.status === 'verified' &&
      !(a.grade.uncertainties || []).length && a.item.sourceQuality !== 'disputed');
    const eligible = reviewed.filter(a => !a.item.composite && a.item.measurementEligible !== false && a.conditions.closedBook === true && a.conditions.firstSeen === true &&
      !a.parentAttemptId && firstByItem.get(a.itemId) === a.id &&
      !a.helpHistory.some(h => validTime(h.at) && h.at <= a.submittedAt));
    const positive = eligible.filter(a => a.grade.verdict === 'correct' && a.conditions.guessed === false &&
      a.grade.steps?.some(s => s.status === 'correct' && s.topicIds?.includes(topic.id)));
    // A wrong answer only identifies the concepts actually implicated by its reviewed steps.
    const negative = eligible.filter(a => (a.grade.verdict === 'wrong' && a.grade.errorTopicIds?.includes(topic.id)) ||
      (a.grade.verdict === 'correct' && a.conditions.guessed === true && a.grade.steps?.some(s => s.topicIds?.includes(topic.id))));
    const independent = positive.filter(a => !a.assessment || a.assessment.kind === 'independent');
    const independentItems = unique(independent.map(a => a.itemId)).length;
    const independentDates = unique(independent.map(a => date(a.submittedAt))).length;
    // Ordinary untimed exercises cannot manufacture timed-mixed or retention evidence.
    const timed = positive.filter(a => a.assessment?.serverVerified === true && a.assessment.kind === 'timed_mixed');
    const timedItems = unique(timed.map(a => a.itemId)).length;
    const timedDates = unique(timed.map(a => date(a.submittedAt))).length;
    const earliest = positive[0]?.submittedAt;
    const delayed = positive.filter(a => a.assessment?.serverVerified === true && a.assessment.kind === 'delayed_retest' &&
      earliest && Date.parse(a.submittedAt) - Date.parse(earliest) >= 7 * 86400000);
    let mastery = null;
    if (independentItems >= 3 && independentDates >= 2) mastery = 0.5;
    if (mastery === 0.5 && timedItems >= 3 && timedDates >= 2) mastery = 0.75;
    if (mastery === 0.75 && delayed.length) mastery = 1;
    const negativeItems = unique(negative.map(a => a.itemId)).length;
    const negativeDates = unique(negative.map(a => date(a.submittedAt))).length;
    let gap = negativeItems >= 2 && negativeDates >= 2 ? 'confirmed' : negativeItems ? 'candidate' : 'unknown';
    if (gap === 'confirmed' && delayed.at(-1)?.submittedAt > negative.at(-1)?.submittedAt) gap = 'resolved';
    return { ...topic, mastery, gap, independentItems, independentDates, timedItems, timedDates,
      delayedPassed: delayed.length > 0, attempts: relevant.length,
      pending: relevant.filter(a => !['done'].includes(a.state) || ['needs-review', 'source-issue'].includes(a.grade?.verdict)).length,
      negativeItems, negativeDates, lastAttemptAt: relevant.at(-1)?.submittedAt || null,
      evidenceIds: eligible.map(a => a.id), correctEvidenceIds: positive.map(a => a.id),
      relatedTopicIds: topic.relatedTopicIds || [] };
  });
  return { topics: rows, attempts: attempts.map(a => ({ ...a, grade: a.grade ? { ...a.grade, hint: undefined, solution: undefined } : null })),
    rulesVersion: 'FORMULAS-v1.0', note: '显示作答证据，不是掌握概率。至少 3 道首次见、闭卷、非蒙对的独立正确题，横跨 2 个日期，才达到独立证据阶梯。普通作业不自动充当限时混合或延迟测评。总体掌握率 UNKNOWN：知识范围与权重未冻结。' };
}
