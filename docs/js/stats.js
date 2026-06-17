// Pure aggregation of the user's per-question stats into the numbers the
// dashboard and stats views display. `stats` is the store's stats map:
//   { [qid]: { attempts, correct, lastResult, lastSeenAt } }

import { pct } from "./util.js";

export function computeOverall(questions, stats) {
  let seen = 0;
  let attempts = 0;
  let correct = 0;
  for (const q of questions) {
    const s = stats[q.id];
    if (s && s.attempts > 0) {
      seen += 1;
      attempts += s.attempts;
      correct += s.correct;
    }
  }
  const total = questions.length;
  return {
    total,
    seen,
    attempts,
    correct,
    coverage: pct(seen, total),
    accuracy: pct(correct, attempts),
  };
}

export function computeBySection(questions, stats) {
  const map = new Map();
  for (const q of questions) {
    if (!map.has(q.section)) {
      map.set(q.section, { section: q.section, total: 0, seen: 0, attempts: 0, correct: 0 });
    }
    const m = map.get(q.section);
    m.total += 1;
    const s = stats[q.id];
    if (s && s.attempts > 0) {
      m.seen += 1;
      m.attempts += s.attempts;
      m.correct += s.correct;
    }
  }
  return [...map.values()]
    .sort((a, b) => a.section - b.section)
    .map((m) => ({
      ...m,
      coverage: pct(m.seen, m.total),
      accuracy: pct(m.correct, m.attempts),
    }));
}
