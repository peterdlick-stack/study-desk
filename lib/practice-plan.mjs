const words = {
  'kinematics': /运动学|位移|速度|加速度|矢量|kinematic|velocity|acceleration|vector/i,
  'newton-laws': /牛顿|受力|摩擦|newton|force|friction/i,
  'work-energy': /动能|势能|能量|做功|功率|energy|work|power/i,
  'momentum': /动量|冲量|碰撞|momentum|collision|impulse/i,
  'gravitation': /引力|卫星|行星|轨道|gravity|gravitation|orbit/i,
  'rigid-body': /刚体|转动|力矩|角动量|rotation|torque|angular/i,
  'electric-field': /库仑|电场|场强|coulomb|electric field/i,
  'gauss-law': /高斯|电通量|gauss|electric flux/i,
  'electric-potential': /电势|电位|potential/i,
  'conductors-capacitors': /导体|电介质|电容|capacitor|dielectric|conductor/i,
  'magnetic-field': /磁场|安培环路|毕奥|magnetic field|biot|ampere/i,
  'magnetic-force': /洛伦兹|安培力|lorentz|magnetic force/i,
  'induction': /电磁感应|电感|法拉第|楞次|induction|inductance|faraday|lenz/i,
  'maxwell': /麦克斯韦|位移电流|maxwell|displacement current/i,
};

export function planPractice(catalog, lesson, attempts, { topicId, track } = {}) {
  const s = lesson?.snapshot || lesson || {};
  const theme = s.themes?.find(t => t.id === s.activeThemeId);
  const focused = (s.notes || []).filter(n => !theme || n.themeId === theme.id);
  const text = [s.course?.title, theme?.title, ...focused.map(n => `${n.title || ''} ${n.summary || ''}`)].join('\n');
  const actualTrack = track || /8[._-]?0([123])/.exec(text)?.[0]?.replace(/[_-]/g, '.') || null;
  const matches = topicId ? catalog.topics.filter(t => t.id === topicId) : catalog.topics.filter(t => words[t.id.replace(/^practice-/, '')]?.test(text));
  if (!matches.length) return { status: 'needs-topic', topics: [], items: [], note: '当前课程记录还不足以匹配本节内容。可选一个已学主题，再由系统从约定题源选题。' };
  const ids = new Set(matches.map(t => t.id));
  const tried = new Set(attempts.map(a => a.itemId));
  const available = catalog.items.filter(i => i.kind === 'supplement' && i.sourceQuality !== 'disputed' && (!actualTrack || i.track === actualTrack) && i.topicIds.some(id => ids.has(id)));
  const candidates = available.filter(i => !tried.has(i.id));
  const ranked = candidates.map(item => ({ item, score: item.topicIds.filter(id => ids.has(id)).length - item.topicIds.filter(id => !ids.has(id)).length * 0.3 }))
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  // A small transparent suggestion; no automatic expansion of the user's workload.
  return { status: ranked.length ? 'ready' : 'no-new-items', topics: matches.map(t => ({ id: t.id, title: t.title })),
    items: ranked.slice(0, 3).map(({ item }) => ({ id: item.id, reason: `对应本节主题：${matches.filter(t => item.topicIds.includes(t.id)).map(t => t.title).join('、')}；尚未在学习台提交过。` })),
    note: ranked.length ? '按课程记录匹配的补充题候选，最多 3 道；不要求一次做完。PSET 保留课程原来的作业安排。' : '该主题暂时没有未提交的新题，原题重做仍保留为复习记录。' };
}
