// Quiz construction. Pure functions: given the question list and the user's
// stats, produce a session with randomized question order and randomized
// answer-option order. The app layer drives progression and records results.

import { shuffle } from "./util.js";

export const MODES = {
  all: "All questions",
  unseen: "Only unseen",
  incorrect: "Review my mistakes",
  focus: "Needs practice",
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
  }
  return pool;
}

// Order a pool so "needs practice" questions are FOCUS_WEIGHT× more likely to
// land near the front (and so be kept when the list is capped to `length`).
// Uses Efraimidis–Spirakis weighted sampling: key = random^(1/weight). With no
// focused questions every weight is 1, so this is just a uniform shuffle.
function weightedOrder(pool, focus = {}) {
  return pool
    .map((q) => ({ q, key: Math.pow(Math.random(), 1 / (focus[q.id] ? FOCUS_WEIGHT : 1)) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.q);
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
  let chosen = weightedOrder(eligible(questions, { section, mode, stats, focus }), focus);
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
