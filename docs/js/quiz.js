// Quiz construction. Pure functions: given the question list and the user's
// stats, produce a session with randomized question order and randomized
// answer-option order. The app layer drives progression and records results.

import { shuffle } from "./util.js";

export const MODES = {
  all: "All questions",
  unseen: "Only unseen",
  incorrect: "Review my mistakes",
};

// Questions eligible for a quiz given the section + mode filters.
export function eligible(questions, { section = "all", mode = "all", stats = {} } = {}) {
  let pool =
    section === "all"
      ? questions
      : questions.filter((q) => q.section === Number(section));

  if (mode === "unseen") {
    pool = pool.filter((q) => !stats[q.id] || stats[q.id].attempts === 0);
  } else if (mode === "incorrect") {
    pool = pool.filter((q) => stats[q.id] && stats[q.id].lastResult === "incorrect");
  }
  return pool;
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

export function buildQuiz(questions, { section = "all", mode = "all", length = 0, stats = {} } = {}) {
  let chosen = shuffle(eligible(questions, { section, mode, stats }));
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
