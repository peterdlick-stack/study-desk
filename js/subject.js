// Keep old lesson / practice / training bookmarks usable.
export function subjectFromUrl(url) {
  const q = new URL(url).searchParams;
  if (q.get('lesson')?.startsWith('free-english-')) return 'english';
  if (q.has('training') || q.get('lesson')?.startsWith('training-') || q.get('practice')?.startsWith('math1-')) return 'math';
  if (q.has('lesson') && q.get('lesson') !== 'math-workspace') return 'physics';
  if (['math', 'physics', 'english'].includes(q.get('subject'))) return q.get('subject');
  if (q.has('practice') || q.has('entry') || q.has('time')) return 'physics';
  return null;
}

export function catalogForSubject(catalog, subject) {
  const matches = track => subject === 'math' ? track === 'math1' : track !== 'math1';
  const items = catalog.items.filter(i => matches(i.track));
  const topicIds = new Set(items.flatMap(i => i.topicIds));
  const sourceIds = new Set(items.map(i => i.sourceId));
  const mathSourceIds = new Set(catalog.items.filter(i => i.track === 'math1').map(i => i.sourceId));
  return { ...catalog, items,
    topics: catalog.topics.filter(t => topicIds.has(t.id)),
    sources: catalog.sources.filter(s => sourceIds.has(s.id) || (subject === 'physics' && !mathSourceIds.has(s.id))),
  };
}
