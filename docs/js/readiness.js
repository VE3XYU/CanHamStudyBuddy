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

// --- freshness --------------------------------------------------------------
// A correct answer counts as fully mastered for this long. Past it the answer
// is "stale": we still believe it was right, we just don't believe it would
// still be right today, so it is credited at less than full value in the
// FORWARD-looking scores only. Staleness is deliberately orthogonal to
// questionStatus: it is a claim about recency, not about whether the answer was
// correct, so it must never touch `mastered` (which feeds the backward-looking
// "Accuracy" figure) — see computeReadiness.
export const MASTERY_FRESH_DAYS = 21;
export const STALE_CREDIT = 0.8;  // past the window
export const COLD_CREDIT = 0.6;   // past 3x the window
const DAY_MS = 24 * 60 * 60 * 1000;
// A future timestamp is normally harmless drift, but stats merge by newest
// lastSeenAt, so a device with a badly-set clock would otherwise win every
// merge AND read as "answered today" forever — never ageing, never refreshable.
const SKEW_GRACE_MS = DAY_MS;

// Age of a stats record in ms. An unusable timestamp (missing, zero, NaN, or a
// non-numeric string) counts as maximally old rather than silently fresh; a
// future one (clock skew on another synced device) counts as brand new.
export function answerAge(stat, now) {
  const seen = Number(stat && stat.lastSeenAt);
  if (!Number.isFinite(seen) || seen <= 0 || seen > now + SKEW_GRACE_MS) return Infinity;
  return Math.max(0, now - seen);
}

// How much a mastered question still contributes to the forward-looking score.
// Always well above 0.25 — a 4-option question returns that much by guessing
// alone — and never 0: only a wrong answer, which is positive evidence, scores 0.
export function masteryCredit(stat, now = Date.now()) {
  const age = answerAge(stat, now);
  const fresh = MASTERY_FRESH_DAYS * DAY_MS;
  if (age < fresh) return 1;
  if (age < 3 * fresh) return STALE_CREDIT;
  return COLD_CREDIT;
}

// True when a correct answer has aged past the fresh window.
export function isStale(stat, now = Date.now()) {
  return masteryCredit(stat, now) < 1;
}

// A needs-practice mark counts only while it is live: clearing one writes a
// `cleared` tombstone (see store.js) rather than deleting it, so that the
// clearing survives a cloud merge. Every reader of a focus map must use this.
export function isFocusMark(rec) {
  return !!rec && !rec.cleared;
}

// Status of one bank question given its stats record and needs-practice mark.
// Intentionally staleness-blind — see the note above.
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

export function computeReadiness(questions, stats, focus = {}, now = Date.now()) {
  // Group the bank by subsection.
  const subMap = new Map();
  for (const q of questions) {
    const code = subsectionCode(q.section, q.sub);
    let m = subMap.get(code);
    if (!m) {
      m = { section: q.section, sub: q.sub, code, total: 0, answered: 0, mastered: 0, stale: 0, credited: 0, pending: 0, missed: 0, attempts: 0 };
      subMap.set(code, m);
    }
    m.total += 1;
    const s = stats[q.id];
    const status = questionStatus(s, isFocusMark(focus[q.id]));
    if (status !== "unseen") {
      m.answered += 1;
      m.attempts += s.attempts;
    }
    if (status === "mastered") {
      m.mastered += 1;
      // `stale` is an OVERLAY on mastered, not a sibling status: a stale
      // question is still mastered (and still counts in accuracy), it just
      // carries less than full weight in the forward-looking scores.
      const credit = masteryCredit(s, now);
      m.credited += credit;
      if (credit < 1) m.stale += 1;
    } else if (status === "pending") m.pending += 1;
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
    // Freshness-adjusted twins of score/conservative: same formulas, but each
    // mastered question counts at its age credit instead of a flat 1. These are
    // additive — the originals above keep their exact meaning and callers.
    m.freshScore = m.answered ? m.credited / m.answered : 0;
    m.freshConservative = m.total ? m.credited / m.total : 0;
    m.freshEarned = m.freshScore * weight;
  }
  rank(subsections);

  // Sections roll up from their constituent subsections; since every
  // subsection weighs the same, the section score is a plain mean.
  const secMap = new Map();
  for (const m of subsections) {
    let s = secMap.get(m.section);
    if (!s) {
      s = { section: m.section, subCount: 0, subsStarted: 0, total: 0, answered: 0, mastered: 0, stale: 0, credited: 0, pending: 0, missed: 0, attempts: 0, score: 0, conservative: 0, freshScore: 0, freshConservative: 0, earned: 0, freshEarned: 0, recoverable: 0 };
      secMap.set(m.section, s);
    }
    s.subCount += 1;
    if (m.answered) s.subsStarted += 1;
    for (const k of ["total", "answered", "mastered", "stale", "credited", "pending", "missed", "attempts", "earned", "freshEarned", "recoverable"]) s[k] += m[k];
    s.score += m.score;
    s.conservative += m.conservative;
    s.freshScore += m.freshScore;
    s.freshConservative += m.freshConservative;
  }
  const sections = [...secMap.values()].sort((a, b) => a.section - b.section);
  for (const s of sections) {
    s.weight = s.subCount * weight;
    s.unseen = s.total - s.answered;
    s.coverage = s.total ? s.answered / s.total : 0;
    s.masteryRate = s.answered ? s.mastered / s.answered : null;
    s.score /= s.subCount;
    s.conservative /= s.subCount;
    s.freshScore /= s.subCount;
    s.freshConservative /= s.subCount;
  }
  rank(sections);

  // Overall: the equally weighted average of all subsection scores (the
  // predicted exam mark if your accuracy holds), its conservative floor, and
  // the complement — exam weight still recoverable through study.
  const overall = { total: 0, answered: 0, mastered: 0, stale: 0, credited: 0, pending: 0, missed: 0, attempts: 0, readiness: 0, conservative: 0, freshReadiness: 0, freshConservative: 0, recoverable: 0 };
  for (const m of subsections) {
    for (const k of ["total", "answered", "mastered", "stale", "credited", "pending", "missed", "attempts"]) overall[k] += m[k];
    overall.readiness += m.score * weight;
    overall.conservative += m.conservative * weight;
    overall.freshReadiness += m.freshScore * weight;
    overall.freshConservative += m.freshConservative * weight;
    overall.recoverable += m.recoverable;
  }
  overall.unseen = overall.total - overall.answered;
  overall.coverage = overall.total ? overall.answered / overall.total : 0;
  overall.masteryRate = overall.answered ? overall.mastered / overall.answered : null;
  overall.subsectionCount = subsections.length;
  overall.subsectionsStarted = subsections.filter((m) => m.answered > 0).length;

  return { weight, overall, sections, subsections };
}
