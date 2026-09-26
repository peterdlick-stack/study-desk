// Untimed source passages stay visible without pretending they occur locally.
export function detailedLearningItems(state, showingCues = false) {
  const items = showingCues ? state.studyBundle?.cues || [] : state.notes;
  if (state.course.transcriptFormat !== 'aligned-detailed-notes') return items;
  const order = state.course.noteTimingAudit?.segments || [];
  const byId = new Map(items.map(item => [item.id, item]));
  const supplements = new Map((state.course.sourceOnlyNotes || []).map(item => [item.id, item]));
  return order.map(segment => {
    if (segment.localStart !== null) return byId.get(showingCues ? segment.cueId : segment.noteId);
    const note = supplements.get(segment.noteId);
    if (!note) return null;
    return showingCues ? { ...note, id: segment.cueId, translatedText: note.summary, boundaryRisk: 'none' } : note;
  }).filter(Boolean);
}

export function isTimedLearningItem(item) {
  return item.timingStatus !== 'untimed' && Number.isFinite(item.start);
}
