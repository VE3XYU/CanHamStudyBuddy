// Quiz construction. Pure functions: given the question list and the user's
// stats, produce a session with randomized question order and randomized
// answer-option order. The app layer drives progression and records results.

import { shuffle } from "./util.js";
import { questionStatus, subsectionCode } from "./readiness.js";

export const MODES = {
  all: "All questions",
  unseen: "Only unseen",
  incorrect: "Review my mistakes",
  focus: "Needs practice",
  smart: "Smartest gains",
};

// How much more often a "needs practice" question is drawn than an ordinary one.
export const FOCUS_WEIGHT = 3;

// Questions eligible for a quiz given the section + mode filters.
export function eligible(questions, { section = "all", mode = "all", stats = {}, focus = {} } = {}) {
  let pool =
    section === "all"
      ? questions
      : questions.filter((q) => q.section === Number(section));

  if (mode === "unseen") {
    pool = pool.filter((q) => !stats[q.id] || stats[q.id].attempts === 0);
  } else if (mode === "incorrect") {
    pool = pool.filter((q) => stats[q.id] && stats[q.id].lastResult === "incorrect");
  } else if (mode === "focus") {
    pool = pool.filter((q) => focus[q.id]);
  } else if (mode === "smart") {
    // Smartest gains: only questions that don't yet count as mastered — the
    // ones where exam marks are still on the table.
    pool = pool.filter((q) => questionStatus(stats[q.id], !!focus[q.id]) !== "mastered");
  }
  return pool;
}

// Weighted shuffle (Efraimidis–Spirakis): key = random^(1/weight), sorted by
// key descending. Higher-weight questions are more likely to land near the
// front (and so be kept when the list is capped to `length`). With uniform
// weights this is just a fair shuffle.
function weightedOrder(pool, weightOf) {
  return pool
    .map((q) => ({ q, key: Math.pow(Math.random(), 1 / weightOf(q)) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.q);
}

// Per-question draw weight for the smartest-gains mode. Every subsection is
// worth the same 2% on the exam, so the payoff of studying a question is how
// much of its subsection's weight is still unmastered (the complement of the
// conservative score — what readiness.js reports as recoverable). Questions
// from wide-open subsections are drawn far more often than the last stragglers
// of a nearly mastered one; the needs-practice boost stacks on top. `open` is
// always > 0 for an unmastered question, so nothing eligible starves.
function smartWeightOf(questions, stats, focus) {
  const total = new Map();
  const mastered = new Map();
  for (const q of questions) {
    const code = subsectionCode(q.section, q.sub);
    total.set(code, (total.get(code) || 0) + 1);
    if (questionStatus(stats[q.id], !!focus[q.id]) === "mastered")
      mastered.set(code, (mastered.get(code) || 0) + 1);
  }
  return (q) => {
    const code = subsectionCode(q.section, q.sub);
    const open = 1 - (mastered.get(code) || 0) / (total.get(code) || 1);
    return open * (focus[q.id] ? FOCUS_WEIGHT : 1);
  };
}

function toItem(q) {
  const options = shuffle([q.correct, ...q.wrong]);
  return {
    id: q.id,
    section: q.section,
    question: q.q,
    options,
    correctIndex: options.indexOf(q.correct),
    correct: q.correct,
  };
}

export function buildQuiz(questions, { section = "all", mode = "all", length = 0, stats = {}, focus = {} } = {}) {
  const pool = eligible(questions, { section, mode, stats, focus });
  const weightOf =
    mode === "smart"
      ? smartWeightOf(questions, stats, focus)
      : (q) => (focus[q.id] ? FOCUS_WEIGHT : 1);
  let chosen = weightedOrder(pool, weightOf);
  if (length && length > 0) chosen = chosen.slice(0, length);
  return {
    section,
    mode,
    items: chosen.map(toItem),
    startedAt: Date.now(),
  };
}

// Build a session from an explicit list of question objects (e.g. "retry the
// ones I just missed").
export function buildFromQuestions(qList, meta = {}) {
  return {
    section: "custom",
    mode: "retry",
    ...meta,
    items: shuffle(qList).map(toItem),
    startedAt: Date.now(),
  };
}
