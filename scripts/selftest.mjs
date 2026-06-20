// Logic self-test for the pure modules (no browser/DOM needed).
//   node scripts/selftest.mjs
import assert from "node:assert/strict";

import { QUESTIONS } from "../docs/js/data/questions.js";
import { EXPLANATIONS, EXPLANATIONS_DISCLAIMER } from "../docs/js/data/explanations.js";
import { buildQuiz, eligible, buildFromQuestions } from "../docs/js/quiz.js";
import { computeOverall, computeBySection } from "../docs/js/stats.js";
import { stableStringify } from "../docs/js/util.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// --- dataset integrity ------------------------------------------------------
check("dataset loaded with 549 questions", () => {
  assert.equal(QUESTIONS.length, 549);
});

check("every question has 4 distinct options and required fields", () => {
  for (const q of QUESTIONS) {
    assert.ok(q.id && q.q && q.correct, `missing fields on ${q.id}`);
    assert.equal(q.wrong.length, 3, `expected 3 wrong answers on ${q.id}`);
    const opts = new Set([q.correct, ...q.wrong]);
    assert.equal(opts.size, 4, `duplicate options on ${q.id}`);
    assert.ok(q.section >= 1 && q.section <= 7, `bad section on ${q.id}`);
  }
});

// --- explainers -------------------------------------------------------------
check("explainers reference only real questions and are non-empty", () => {
  const ids = new Set(QUESTIONS.map((q) => q.id));
  const keys = Object.keys(EXPLANATIONS);
  assert.ok(keys.length > 0, "no explainers loaded");
  for (const [id, text] of Object.entries(EXPLANATIONS)) {
    assert.ok(ids.has(id), `explainer for unknown question ${id}`);
    assert.equal(typeof text, "string");
    assert.ok(text.trim().length > 0, `empty explainer for ${id}`);
  }
  const covered = keys.length;
  console.log(`      (${covered}/${QUESTIONS.length} questions have an explainer)`);
});

check("explainers stay concise", () => {
  // Length proxy for the "at most ~5 sentences" guideline — a runaway entry
  // (e.g. a duplicated paragraph) trips this well before it reaches the user.
  for (const [id, text] of Object.entries(EXPLANATIONS)) {
    assert.ok(text.length <= 800, `explainer for ${id} is too long (${text.length} chars)`);
  }
});

check("the AI-generated disclaimer is present", () => {
  assert.equal(typeof EXPLANATIONS_DISCLAIMER, "string");
  assert.ok(/AI-generated/i.test(EXPLANATIONS_DISCLAIMER), "disclaimer should mention it's AI-generated");
});

// --- quiz construction ------------------------------------------------------
check("buildQuiz randomizes options but correctIndex points at the answer", () => {
  const quiz = buildQuiz(QUESTIONS, { section: "all", mode: "all" });
  assert.equal(quiz.items.length, 549);
  for (const item of quiz.items) {
    assert.equal(item.options.length, 4);
    assert.equal(item.options[item.correctIndex], item.correct);
  }
});

check("section filter only returns questions from that section", () => {
  const quiz = buildQuiz(QUESTIONS, { section: 2, mode: "all" });
  assert.equal(quiz.items.length, 132);
  assert.ok(quiz.items.every((i) => i.section === 2));
});

check("length caps the number of questions", () => {
  const quiz = buildQuiz(QUESTIONS, { section: "all", mode: "all", length: 10 });
  assert.equal(quiz.items.length, 10);
});

check("answer options actually get shuffled across the bank", () => {
  // The source always lists the correct answer first; after shuffling, the
  // correct index should land in varied positions, not always 0.
  const quiz = buildQuiz(QUESTIONS, { section: "all", mode: "all" });
  const positions = new Set(quiz.items.map((i) => i.correctIndex));
  assert.ok(positions.size > 1, "correct answer never moved from position 0");
});

check("unseen vs incorrect modes filter by stats", () => {
  const sample = QUESTIONS.slice(0, 5).map((q) => q.id);
  const stats = {
    [sample[0]]: { attempts: 1, correct: 1, lastResult: "correct", lastSeenAt: 1 },
    [sample[1]]: { attempts: 2, correct: 0, lastResult: "incorrect", lastSeenAt: 2 },
  };
  const unseen = eligible(QUESTIONS, { section: "all", mode: "unseen", stats });
  assert.equal(unseen.length, QUESTIONS.length - 2);
  const wrong = eligible(QUESTIONS, { section: "all", mode: "incorrect", stats });
  assert.deepEqual(wrong.map((q) => q.id), [sample[1]]);
});

check("buildFromQuestions wraps an explicit list", () => {
  const list = QUESTIONS.slice(0, 3);
  const quiz = buildFromQuestions(list);
  assert.equal(quiz.items.length, 3);
  assert.equal(quiz.mode, "retry");
});

// --- stats ------------------------------------------------------------------
check("overall + per-section stats reconcile", () => {
  const ids = QUESTIONS.filter((q) => q.section === 1).slice(0, 4).map((q) => q.id);
  const stats = {
    [ids[0]]: { attempts: 2, correct: 2, lastResult: "correct", lastSeenAt: 1 },
    [ids[1]]: { attempts: 2, correct: 1, lastResult: "incorrect", lastSeenAt: 2 },
  };
  const overall = computeOverall(QUESTIONS, stats);
  assert.equal(overall.total, 549);
  assert.equal(overall.seen, 2);
  assert.equal(overall.attempts, 4);
  assert.equal(overall.correct, 3);
  assert.equal(overall.accuracy, 75);

  const bySection = computeBySection(QUESTIONS, stats);
  const s1 = bySection.find((s) => s.section === 1);
  assert.equal(s1.total, 54);
  assert.equal(s1.seen, 2);
  assert.equal(s1.accuracy, 75);
  const sumSeen = bySection.reduce((n, s) => n + s.seen, 0);
  assert.equal(sumSeen, overall.seen);
});

// --- store merge (needs the in-memory storage fallback) ---------------------
check("mergeStates resolves notes and stats by last-write-wins", async () => {
  const store = await import("../docs/js/store.js");
  const a = {
    v: 1,
    stats: { q1: { attempts: 1, correct: 1, lastResult: "correct", lastSeenAt: 100 } },
    notes: { q1: { text: "old", updatedAt: 100 } },
    history: [{ id: "h1", startedAt: 1 }],
    updatedAt: 100,
  };
  const b = {
    v: 1,
    stats: { q1: { attempts: 3, correct: 2, lastResult: "incorrect", lastSeenAt: 200 } },
    notes: { q1: { text: "new", updatedAt: 200 } },
    history: [{ id: "h1", startedAt: 1 }, { id: "h2", startedAt: 2 }],
    updatedAt: 200,
  };
  const merged = store.mergeStates(a, b);
  assert.equal(merged.stats.q1.attempts, 3, "newer stats win");
  assert.equal(merged.notes.q1.text, "new", "newer note wins");
  assert.equal(merged.history.length, 2, "history deduped by id");
});

check("stableStringify ignores key order but not content or array order", () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.equal(stableStringify({ x: { p: 1, q: 2 } }), stableStringify({ x: { q: 2, p: 1 } }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
});

check("mergeRemote: identical remote is a no-op, real differences are detected", async () => {
  const store = await import("../docs/js/store.js");
  const qid = QUESTIONS[0].id;
  store.resetAll();
  store.recordAnswer(qid, true);
  store.setNote(qid, "hello");

  const remote = JSON.parse(JSON.stringify(store.getState()));
  assert.equal(store.mergeRemote(remote), false, "same content should not count as a change");

  remote.notes[qid] = { text: "changed", updatedAt: Date.now() + 1000 };
  assert.equal(store.mergeRemote(remote), true, "a newer note should be detected as a change");
  assert.equal(store.getNote(qid), "changed", "the newer note should win");
});

console.log(`\n${passed} checks passed.`);
