// Exam-weighted readiness scoring. Pure functions: given the question list,
// the user's per-question stats, and the "needs practice" (focus) map, score
// every exam subsection, section, and the whole bank the way the Advanced
// exam is marked. The real exam draws exactly one question from each of the
// 50 subsections (A-SSS-BBB), so every subsection is worth 2% regardless of
// how many bank questions it holds, and a section's weight is simply its
// subsection count × 2% (A-001 10%, A-002 24%, A-003 12%, A-004 8%,
// A-005 18%, A-006 10%, A-007 18%).
//
// Mastery is judged per unique bank question from the LATEST result only, so
// re-answering the same question never inflates (or deflates) the score:
//   - mastered: latest answer correct and not on the needs-practice list;
//   - pending:  latest answer correct but still on the needs-practice list —
//     e.g. a lucky guess ("I have no idea" was ticked), which store.js only
//     clears after FOCUS_CLEAR_STREAK un-guessed correct answers in a row.
//     Pending counts as answered but not yet mastered;
//   - missed:   latest answer incorrect;
//   - unseen:   never answered.
// All rates and weights are fractions in [0, 1]; the UI formats percentages.

export function subsectionCode(section, sub) {
  const pad = (n) => String(n).padStart(3, "0");
  return `A-${pad(section)}-${pad(sub)}`;
}

// Status of one bank question given its stats record and needs-practice mark.
export function questionStatus(stat, focused) {
  if (!stat || !stat.attempts) return "unseen";
  if (stat.lastResult !== "correct") return "missed";
  return focused ? "pending" : "mastered";
}

// Study priority: rank rows by how much exam weight is still recoverable —
// where extra study gains the most marks. 1 = study this first. Ties go to
// the row with less coverage (fresh material first), then bank order.
function rank(rows) {
  [...rows]
    .sort((a, b) =>
      b.recoverable - a.recoverable ||
      a.coverage - b.coverage ||
      a.section - b.section ||
      (a.sub || 0) - (b.sub || 0))
    .forEach((row, i) => { row.priority = i + 1; });
}

export function computeReadiness(questions, stats, focus = {}) {
  // Group the bank by subsection.
  const subMap = new Map();
  for (const q of questions) {
    const code = subsectionCode(q.section, q.sub);
    let m = subMap.get(code);
    if (!m) {
      m = { section: q.section, sub: q.sub, code, total: 0, answered: 0, mastered: 0, pending: 0, missed: 0, attempts: 0 };
      subMap.set(code, m);
    }
    m.total += 1;
    const s = stats[q.id];
    const status = questionStatus(s, !!focus[q.id]);
    if (status !== "unseen") {
      m.answered += 1;
      m.attempts += s.attempts;
    }
    if (status === "mastered") m.mastered += 1;
    else if (status === "pending") m.pending += 1;
    else if (status === "missed") m.missed += 1;
  }

  const subsections = [...subMap.values()].sort((a, b) => a.section - b.section || a.sub - b.sub);
  const weight = subsections.length ? 1 / subsections.length : 0; // 2% each on the real exam

  for (const m of subsections) {
    m.weight = weight;
    m.unseen = m.total - m.answered;
    m.coverage = m.total ? m.answered / m.total : 0;
    // Accuracy view: mastery among the questions actually answered. An
    // untouched subsection has no accuracy yet and can't contribute marks,
    // so it scores 0 in the equally weighted average.
    m.masteryRate = m.answered ? m.mastered / m.answered : null;
    m.score = m.answered ? m.mastered / m.answered : 0;
    // Conservative view: every unanswered question counts as not yet mastered.
    m.conservative = m.total ? m.mastered / m.total : 0;
    m.earned = m.score * weight;
    m.recoverable = (1 - m.conservative) * weight;
  }
  rank(subsections);

  // Sections roll up from their constituent subsections; since every
  // subsection weighs the same, the section score is a plain mean.
  const secMap = new Map();
  for (const m of subsections) {
    let s = secMap.get(m.section);
    if (!s) {
      s = { section: m.section, subCount: 0, subsStarted: 0, total: 0, answered: 0, mastered: 0, pending: 0, missed: 0, attempts: 0, score: 0, conservative: 0, earned: 0, recoverable: 0 };
      secMap.set(m.section, s);
    }
    s.subCount += 1;
    if (m.answered) s.subsStarted += 1;
    for (const k of ["total", "answered", "mastered", "pending", "missed", "attempts", "earned", "recoverable"]) s[k] += m[k];
    s.score += m.score;
    s.conservative += m.conservative;
  }
  const sections = [...secMap.values()].sort((a, b) => a.section - b.section);
  for (const s of sections) {
    s.weight = s.subCount * weight;
    s.unseen = s.total - s.answered;
    s.coverage = s.total ? s.answered / s.total : 0;
    s.masteryRate = s.answered ? s.mastered / s.answered : null;
    s.score /= s.subCount;
    s.conservative /= s.subCount;
  }
  rank(sections);

  // Overall: the equally weighted average of all subsection scores (the
  // predicted exam mark if your accuracy holds), its conservative floor, and
  // the complement — exam weight still recoverable through study.
  const overall = { total: 0, answered: 0, mastered: 0, pending: 0, missed: 0, attempts: 0, readiness: 0, conservative: 0, recoverable: 0 };
  for (const m of subsections) {
    for (const k of ["total", "answered", "mastered", "pending", "missed", "attempts"]) overall[k] += m[k];
    overall.readiness += m.score * weight;
    overall.conservative += m.conservative * weight;
    overall.recoverable += m.recoverable;
  }
  overall.unseen = overall.total - overall.answered;
  overall.coverage = overall.total ? overall.answered / overall.total : 0;
  overall.masteryRate = overall.answered ? overall.mastered / overall.answered : null;
  overall.subsectionCount = subsections.length;
  overall.subsectionsStarted = subsections.filter((m) => m.answered > 0).length;

  return { weight, overall, sections, subsections };
}
