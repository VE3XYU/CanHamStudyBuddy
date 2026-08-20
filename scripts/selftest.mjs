// Logic self-test for the pure modules (no browser/DOM needed).
//   node scripts/selftest.mjs
import assert from "node:assert/strict";

import { QUESTIONS } from "../docs/js/data/questions.js";
import { EXPLANATIONS, EXPLANATIONS_DISCLAIMER } from "../docs/js/data/explanations.js";
import { buildQuiz, eligible, buildFromQuestions, MODES } from "../docs/js/quiz.js";
import {
  computeReadiness, subsectionCode, questionStatus,
  masteryCredit, answerAge, MASTERY_FRESH_DAYS, STALE_CREDIT, COLD_CREDIT,
} from "../docs/js/readiness.js";
import { SUBSECTION_TOPICS } from "../docs/js/data/subsections.js";
import { stableStringify } from "../docs/js/util.js";

let passed = 0;
// Await fn() so async checks (dynamic store imports) report failures in place
// instead of printing "ok" — and the final summary — before their assertions run.
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// --- dataset integrity ------------------------------------------------------
await check("dataset loaded with 549 questions", () => {
  assert.equal(QUESTIONS.length, 549);
});

await check("every question has 4 distinct options and required fields", () => {
  for (const q of QUESTIONS) {
    assert.ok(q.id && q.q && q.correct, `missing fields on ${q.id}`);
    assert.equal(q.wrong.length, 3, `expected 3 wrong answers on ${q.id}`);
    const opts = new Set([q.correct, ...q.wrong]);
    assert.equal(opts.size, 4, `duplicate options on ${q.id}`);
    assert.ok(q.section >= 1 && q.section <= 7, `bad section on ${q.id}`);
  }
});

// --- explainers -------------------------------------------------------------
await check("explainers reference only real questions and are non-empty", () => {
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

await check("explainers stay concise", () => {
  // Length proxy for the "at most ~5 sentences" guideline — a runaway entry
  // (e.g. a duplicated paragraph) trips this well before it reaches the user.
  for (const [id, text] of Object.entries(EXPLANATIONS)) {
    assert.ok(text.length <= 800, `explainer for ${id} is too long (${text.length} chars)`);
  }
});

await check("the AI-generated disclaimer is present", () => {
  assert.equal(typeof EXPLANATIONS_DISCLAIMER, "string");
  assert.ok(/AI-generated/i.test(EXPLANATIONS_DISCLAIMER), "disclaimer should mention it's AI-generated");
});

// --- quiz construction ------------------------------------------------------
await check("buildQuiz randomizes options but correctIndex points at the answer", () => {
  const quiz = buildQuiz(QUESTIONS, { section: "all", mode: "all" });
  assert.equal(quiz.items.length, 549);
  for (const item of quiz.items) {
    assert.equal(item.options.length, 4);
    assert.equal(item.options[item.correctIndex], item.correct);
  }
});

await check("section filter only returns questions from that section", () => {
  const quiz = buildQuiz(QUESTIONS, { section: 2, mode: "all" });
  assert.equal(quiz.items.length, 132);
  assert.ok(quiz.items.every((i) => i.section === 2));
});

await check("length caps the number of questions", () => {
  const quiz = buildQuiz(QUESTIONS, { section: "all", mode: "all", length: 10 });
  assert.equal(quiz.items.length, 10);
});

await check("answer options actually get shuffled across the bank", () => {
  // The source always lists the correct answer first; after shuffling, the
  // correct index should land in varied positions, not always 0.
  const quiz = buildQuiz(QUESTIONS, { section: "all", mode: "all" });
  const positions = new Set(quiz.items.map((i) => i.correctIndex));
  assert.ok(positions.size > 1, "correct answer never moved from position 0");
});

await check("unseen vs incorrect modes filter by stats", () => {
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

await check("buildFromQuestions wraps an explicit list", () => {
  const list = QUESTIONS.slice(0, 3);
  const quiz = buildFromQuestions(list);
  assert.equal(quiz.items.length, 3);
  assert.equal(quiz.mode, "retry");
});

await check("focus mode filters to marked questions; weighting favours them", () => {
  const ids = QUESTIONS.slice(0, 2).map((q) => q.id);
  const focus = { [ids[0]]: { streak: 0, updatedAt: 1 }, [ids[1]]: { streak: 0, updatedAt: 1 } };

  const only = eligible(QUESTIONS, { section: "all", mode: "focus", focus });
  assert.deepEqual(only.map((q) => q.id).sort(), [...ids].sort());

  // Over many capped builds a marked question is included far more often than a
  // specific unmarked one (weight FOCUS_WEIGHT vs 1).
  const marked = ids[0];
  const plain = QUESTIONS[200].id;
  let markedIn = 0, plainIn = 0;
  for (let i = 0; i < 600; i++) {
    const picked = new Set(buildQuiz(QUESTIONS, { mode: "all", length: 25, focus }).items.map((it) => it.id));
    if (picked.has(marked)) markedIn++;
    if (picked.has(plain)) plainIn++;
  }
  assert.ok(markedIn > plainIn, `marked inclusion ${markedIn} should exceed plain ${plainIn}`);
});

await check("smart mode: only unmastered questions are eligible", () => {
  const [q0, q1, q2] = QUESTIONS;
  const stats = {
    [q0.id]: { attempts: 2, correct: 2, lastResult: "correct", lastSeenAt: 1 },   // mastered
    [q1.id]: { attempts: 1, correct: 1, lastResult: "correct", lastSeenAt: 2 },   // pending (focused)
    [q2.id]: { attempts: 1, correct: 0, lastResult: "incorrect", lastSeenAt: 3 }, // missed
  };
  const focus = { [q1.id]: { streak: 1, updatedAt: 2 } };
  const pool = eligible(QUESTIONS, { mode: "smart", stats, focus });
  const ids = new Set(pool.map((q) => q.id));
  assert.equal(pool.length, QUESTIONS.length - 1, "only the mastered question drops out");
  assert.ok(!ids.has(q0.id), "mastered is excluded");
  assert.ok(ids.has(q1.id) && ids.has(q2.id), "pending and missed stay in");
});

await check("smart mode favours subsections with the most weight left to gain", () => {
  // Master all but one question of the first subsection; leave the rest of the
  // bank untouched. The leftover's subsection has little weight to gain, so it
  // should be drawn far less often than a question from an untouched one.
  const firstCode = subsectionCode(QUESTIONS[0].section, QUESTIONS[0].sub);
  const subQs = QUESTIONS.filter((q) => subsectionCode(q.section, q.sub) === firstCode);
  const leftover = subQs[subQs.length - 1];
  const stats = {};
  for (const q of subQs.slice(0, -1)) stats[q.id] = { attempts: 1, correct: 1, lastResult: "correct", lastSeenAt: 1 };
  const other = QUESTIONS.find((q) => subsectionCode(q.section, q.sub) !== firstCode);
  let leftoverIn = 0;
  let otherIn = 0;
  for (let i = 0; i < 500; i++) {
    const picked = new Set(buildQuiz(QUESTIONS, { mode: "smart", length: 50, stats }).items.map((it) => it.id));
    if (picked.has(leftover.id)) leftoverIn++;
    if (picked.has(other.id)) otherIn++;
    if (picked.has(subQs[0].id)) assert.fail("a mastered question was drawn in smart mode");
  }
  assert.ok(otherIn > leftoverIn * 2, `untouched ${otherIn} should dwarf nearly-mastered ${leftoverIn}`);
});

// --- exam-weighted readiness --------------------------------------------------
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);
const won = (subQs, extra = {}) => {
  const stats = {};
  for (const q of subQs) stats[q.id] = { attempts: 1, correct: 1, lastResult: "correct", lastSeenAt: 1 };
  return Object.assign(stats, extra);
};

await check("bank matches the 50-subsection exam blueprint and section weights", () => {
  const r = computeReadiness(QUESTIONS, {});
  assert.equal(r.subsections.length, 50, "the exam draws one question from each of 50 subsections");
  near(r.weight, 0.02, "each subsection worth 2%");
  const subCounts = {};
  for (const s of r.sections) subCounts[s.section] = s.subCount;
  assert.deepEqual(subCounts, { 1: 5, 2: 12, 3: 6, 4: 4, 5: 9, 6: 5, 7: 9 });
  const SECTION_WEIGHTS = { 1: 0.10, 2: 0.24, 3: 0.12, 4: 0.08, 5: 0.18, 6: 0.10, 7: 0.18 };
  for (const s of r.sections) near(s.weight, SECTION_WEIGHTS[s.section], `section ${s.section} weight`);
});

await check("every exam subsection has a topic label (and no strays)", () => {
  const codes = new Set(QUESTIONS.map((q) => subsectionCode(q.section, q.sub)));
  assert.deepEqual([...Object.keys(SUBSECTION_TOPICS)].sort(), [...codes].sort());
});

await check("empty state scores zero with the full exam weight recoverable", () => {
  const o = computeReadiness(QUESTIONS, {}).overall;
  assert.equal(o.answered, 0);
  assert.equal(o.masteryRate, null, "no accuracy to report yet");
  near(o.readiness, 0, "readiness");
  near(o.conservative, 0, "conservative");
  near(o.coverage, 0, "coverage");
  near(o.recoverable, 1, "everything is still up for grabs");
});

await check("mastery is per unique question by latest result — repeats don't distort", () => {
  const subQs = QUESTIONS.filter((q) => q.section === 1 && q.sub === 1);
  const stats = {
    // hammered wrong many times, finally correct -> mastered
    [subQs[0].id]: { attempts: 12, correct: 3, lastResult: "correct", lastSeenAt: 1 },
    // usually right, but the latest answer was a miss -> not mastered
    [subQs[1].id]: { attempts: 9, correct: 8, lastResult: "incorrect", lastSeenAt: 2 },
  };
  const r = computeReadiness(QUESTIONS, stats);
  const m = r.subsections.find((s) => s.code === "A-001-001");
  assert.equal(m.answered, 2);
  assert.equal(m.mastered, 1);
  assert.equal(m.missed, 1);
  near(m.masteryRate, 0.5, "half of the answered questions mastered");
  near(r.overall.masteryRate, 0.5, "attempt counts don't leak into accuracy");
});

await check("readiness averages all 50 subsections; conservative counts unanswered questions", () => {
  const full = QUESTIONS.filter((q) => q.section === 1 && q.sub === 1);
  const partial = QUESTIONS.filter((q) => q.section === 2 && q.sub === 3);
  const stats = won(full, won([partial[0]]));
  const r = computeReadiness(QUESTIONS, stats);

  const a = r.subsections.find((s) => s.code === "A-001-001");
  near(a.score, 1, "fully mastered subsection");
  near(a.conservative, 1, "no unanswered questions left there");
  near(a.recoverable, 0, "nothing left to gain there");

  const b = r.subsections.find((s) => s.code === "A-002-003");
  near(b.score, 1, "accuracy view extrapolates from the one answered question");
  near(b.conservative, 1 / b.total, "conservative counts the unanswered ones");
  near(b.recoverable, 0.02 * (1 - 1 / b.total), "most of its 2% is still open");

  near(r.overall.readiness, 0.04, "two subsections at 100% accuracy = 2 × 2%");
  near(r.overall.conservative, 0.02 + 0.02 / b.total, "conservative only banks confirmed marks");
  near(r.overall.recoverable, 1 - r.overall.conservative, "recoverable is the complement");
});

await check("section scores roll up from their subsections; weights decompose exactly", () => {
  const r = computeReadiness(QUESTIONS, won(QUESTIONS.filter((q) => q.section === 4 && q.sub === 2)));
  const s4 = r.sections.find((s) => s.section === 4);
  near(s4.score, 1 / 4, "one of A-004's four subsections is mastered");
  near(s4.earned, 0.02, "worth one subsection of exam weight");
  near(r.sections.reduce((n, s) => n + s.earned, 0), r.overall.readiness, "sections decompose overall readiness");
  near(r.subsections.reduce((n, s) => n + s.recoverable, 0), r.overall.recoverable, "subsections decompose recoverable weight");
});

await check("study priority ranks the biggest recoverable exam weight first", () => {
  const r = computeReadiness(QUESTIONS, won(QUESTIONS.filter((q) => q.section === 1 && q.sub === 1)));
  const done = r.subsections.find((s) => s.code === "A-001-001");
  assert.equal(done.priority, 50, "a fully mastered subsection is the last priority");
  for (const s of r.subsections) {
    if (s.code !== "A-001-001") assert.ok(s.priority < 50, `${s.code} should outrank the mastered one`);
  }
  const most = [...r.sections].sort((x, y) => y.recoverable - x.recoverable)[0];
  assert.equal(most.priority, 1, "the section with the most recoverable weight is priority 1");
  assert.equal(most.section, 2, "that's A-002 (24%) when only part of A-001 is done");
});

await check("a lucky guess counts as answered but stays unmastered until confirmed", async () => {
  const store = await import("../docs/js/store.js");
  const qid = QUESTIONS[0].id; // in A-001-001
  store.resetAll();
  store.setFocus(qid, true);            // "I have no idea" ticked before answering
  store.recordAnswer(qid, true, true);  // lucky guess: correct but flagged
  let st = store.getState();
  assert.equal(questionStatus(st.stats[qid], !!st.focus[qid]), "pending");
  let m = computeReadiness(QUESTIONS, st.stats, st.focus).subsections.find((s) => s.code === "A-001-001");
  assert.equal(m.answered, 1);
  assert.equal(m.mastered, 0, "a guessed answer is not yet mastered");
  assert.equal(m.pending, 1, "…it's pending confirmation");

  store.recordAnswer(qid, true);        // the existing streak logic confirms it:
  store.recordAnswer(qid, true);        // three un-guessed correct answers in a row
  store.recordAnswer(qid, true);        // clear the needs-practice mark
  st = store.getState();
  m = computeReadiness(QUESTIONS, st.stats, st.focus).subsections.find((s) => s.code === "A-001-001");
  assert.equal(m.mastered, 1, "confirmed per the existing focus-streak logic");
  assert.equal(m.pending, 0);
  store.resetAll();
});


// --- mastery freshness (decay) ----------------------------------------------
// Every test below pins a fixed clock: nothing here may read the wall clock, or
// the suite would start failing on its own N days after it was written.
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 20, 12);
const ago = (days) => NOW - days * DAY;
const okAt = (t) => ({ attempts: 1, correct: 1, lastResult: "correct", lastSeenAt: t });
const badAt = (t) => ({ attempts: 1, correct: 0, lastResult: "incorrect", lastSeenAt: t });
const stamp = (qs, t) => Object.fromEntries(qs.map((q) => [q.id, okAt(t)]));

await check("mastery credit decays in tiers and never reaches zero for age alone", () => {
  assert.equal(masteryCredit(okAt(ago(0)), NOW), 1);
  assert.equal(masteryCredit(okAt(ago(MASTERY_FRESH_DAYS - 1)), NOW), 1, "inside the window");
  assert.equal(masteryCredit(okAt(ago(MASTERY_FRESH_DAYS)), NOW), STALE_CREDIT, "at the boundary");
  assert.equal(masteryCredit(okAt(ago(3 * MASTERY_FRESH_DAYS)), NOW), COLD_CREDIT);
  assert.equal(masteryCredit(okAt(ago(9999)), NOW), COLD_CREDIT);
  assert.ok(COLD_CREDIT >= 0.25, "must stay at or above the 4-option guess floor — never credit 0 for age");
  assert.ok(STALE_CREDIT >= COLD_CREDIT, "credit must decrease monotonically with age");
});

await check("unusable and future timestamps are handled, never silently fresh", () => {
  for (const bad of [undefined, null, 0, NaN, "nonsense"]) {
    assert.equal(
      masteryCredit({ attempts: 1, correct: 1, lastResult: "correct", lastSeenAt: bad }, NOW),
      COLD_CREDIT, `lastSeenAt=${String(bad)} must not read as fresh`);
  }
  const HOUR = 60 * 60 * 1000;
  assert.equal(masteryCredit(okAt(NOW + HOUR), NOW), 1, "ordinary clock drift is tolerated as fresh");
  assert.equal(answerAge(okAt(NOW + HOUR), NOW), 0);
  assert.equal(masteryCredit(okAt(NOW + 5 * DAY), NOW), COLD_CREDIT,
    "a badly-set clock must not pin a question as permanently fresh — stats merge by newest lastSeenAt");
});

await check("staleness never touches accuracy, mastery counts, or question status", () => {
  const fresh = computeReadiness(QUESTIONS, stamp(QUESTIONS, ago(1)), {}, NOW).overall;
  const old = computeReadiness(QUESTIONS, stamp(QUESTIONS, ago(400)), {}, NOW).overall;
  assert.equal(old.mastered, fresh.mastered, "a stale answer is still a mastered answer");
  near(old.masteryRate, 1, "accuracy records the past and must not decay");
  near(old.readiness, fresh.readiness, "the headline keeps its definition");
  near(old.conservative, fresh.conservative);
  assert.equal(questionStatus(okAt(ago(400)), false), "mastered", "status stays staleness-blind");
  assert.equal(old.stale, QUESTIONS.length, "…but every answer is flagged stale");
});

await check("the freshness projection decays while the headline holds", () => {
  const at = (d) => computeReadiness(QUESTIONS, stamp(QUESTIONS, ago(d)), {}, NOW).overall;
  near(at(1).freshReadiness, 1, "all fresh: today equals readiness");
  near(at(MASTERY_FRESH_DAYS + 6).freshReadiness, STALE_CREDIT);
  near(at(3 * MASTERY_FRESH_DAYS + 27).freshReadiness, COLD_CREDIT);
  for (const d of [1, MASTERY_FRESH_DAYS + 6, 3 * MASTERY_FRESH_DAYS + 27]) {
    assert.ok(at(d).freshReadiness <= at(d).readiness + 1e-9, "today never exceeds the headline");
  }
});

await check("stale counts roll up exactly and stay an overlay on mastered", () => {
  const mixed = {};
  QUESTIONS.forEach((q, i) => { mixed[q.id] = okAt(i % 2 ? ago(1) : ago(MASTERY_FRESH_DAYS + 9)); });
  const r = computeReadiness(QUESTIONS, mixed, {}, NOW);
  assert.equal(r.subsections.reduce((n, s) => n + s.stale, 0), r.overall.stale);
  assert.equal(r.sections.reduce((n, s) => n + s.stale, 0), r.overall.stale);
  for (const row of [...r.subsections, ...r.sections, r.overall]) {
    assert.ok(Number.isFinite(row.stale) && Number.isFinite(row.credited), "counters numeric everywhere");
    assert.ok(row.stale <= row.mastered, "stale is a subset of mastered, never larger");
  }
  near(r.subsections.reduce((n, s) => n + s.credited, 0), r.overall.credited, "credited rolls up");
  near(r.subsections.reduce((n, s) => n + s.freshEarned, 0), r.overall.freshReadiness, "freshEarned decomposes today");
  near(r.sections.reduce((n, s) => n + s.freshEarned, 0), r.overall.freshReadiness, "…at section level too");
  for (const row of r.subsections) {
    near(row.freshConservative, row.total ? row.credited / row.total : 0, `${row.code} freshConservative`);
  }
  const empty = computeReadiness(QUESTIONS, {}, {}, NOW).overall;
  assert.equal(empty.stale, 0);
  near(empty.freshReadiness, 0);
});

await check("focus and a wrong answer outrank staleness", () => {
  assert.equal(questionStatus(okAt(ago(400)), true), "pending", "an old lucky guess is pending, not stale");
  assert.equal(questionStatus(badAt(ago(400)), false), "missed");
  const qid = QUESTIONS[0].id;
  const o = computeReadiness(QUESTIONS, { [qid]: okAt(ago(400)) }, { [qid]: { streak: 0, updatedAt: 1 } }, NOW).overall;
  assert.equal(o.pending, 1);
  assert.equal(o.mastered, 0);
  assert.equal(o.stale, 0, "a question must never be counted in two buckets at once");
});

await check("every mode in MODES is actually implemented by eligible()", () => {
  const stats = {};
  QUESTIONS.forEach((q, i) => {
    if (i % 4 === 1) stats[q.id] = okAt(ago(1));
    else if (i % 4 === 2) stats[q.id] = okAt(ago(MASTERY_FRESH_DAYS + 9));
    else if (i % 4 === 3) stats[q.id] = badAt(ago(1));
  });
  const focus = { [QUESTIONS[1].id]: { streak: 0, updatedAt: 1 } };
  const size = (mode) => eligible(QUESTIONS, { mode, stats, focus, now: NOW }).length;
  assert.equal(size("all"), QUESTIONS.length);
  for (const key of Object.keys(MODES)) {
    if (key === "all") continue;
    assert.ok(size(key) < QUESTIONS.length,
      `mode "${key}" returned the whole bank — is it missing a branch in eligible()?`);
    assert.ok(size(key) > 0, `mode "${key}" found nothing in a fixture that contains every state`);
  }
});

await check("the Refresh button's count matches the quiz it starts", () => {
  const stats = {};
  QUESTIONS.forEach((q, i) => { stats[q.id] = okAt(i % 3 ? ago(2) : ago(MASTERY_FRESH_DAYS + 19)); });
  const o = computeReadiness(QUESTIONS, stats, {}, NOW).overall;
  assert.ok(o.stale > 0);
  assert.equal(eligible(QUESTIONS, { mode: "stale", stats, now: NOW }).length, o.stale,
    "readiness.js and quiz.js must agree on what counts as stale");
});

await check("now is threaded through eligible(), never taken from the wall clock", () => {
  const stats = stamp(QUESTIONS, ago(MASTERY_FRESH_DAYS + 6));
  assert.equal(eligible(QUESTIONS, { mode: "stale", stats, now: NOW }).length, QUESTIONS.length,
    "past the window as of NOW");
  assert.equal(eligible(QUESTIONS, { mode: "stale", stats, now: ago(MASTERY_FRESH_DAYS + 6) + DAY }).length, 0,
    "…and fresh when evaluated the day after it was answered");
});

await check("smart mode stays staleness-blind so its targeting cannot flatten", () => {
  const first = subsectionCode(QUESTIONS[0].section, QUESTIONS[0].sub);
  const sub = QUESTIONS.filter((q) => subsectionCode(q.section, q.sub) === first);
  const staleStats = stamp(sub, ago(400));
  const freshStats = stamp(sub, ago(1));
  const n = (stats) => eligible(QUESTIONS, { mode: "smart", stats, now: NOW }).length;
  assert.equal(n(staleStats), n(freshStats),
    "stale answers must not re-flood the smartest-gains pool and crowd out unseen material");
  assert.equal(n(staleStats), QUESTIONS.length - sub.length);
});

// --- store merge (needs the in-memory storage fallback) ---------------------
await check("mergeStates resolves notes and stats by last-write-wins", async () => {
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

await check("setFlagged stores, trims, and clears an explanation flag", async () => {
  const store = await import("../docs/js/store.js");
  const qid = QUESTIONS[0].id;
  store.resetAll();
  assert.equal(store.getFlag(qid), null, "starts unflagged");
  store.setFlagged(qid, true, "  looks wrong  ");
  assert.equal(store.getFlag(qid).reason, "looks wrong", "reason is trimmed and stored");
  store.setFlagged(qid, false);
  assert.equal(store.getFlag(qid), null, "unflagging removes the record");
});

await check("mergeStates resolves explanation flags by last-write-wins", async () => {
  const store = await import("../docs/js/store.js");
  const a = { stats: {}, notes: {}, flags: { q1: { reason: "old", updatedAt: 100 }, q2: { reason: "keep", updatedAt: 50 } }, history: [], updatedAt: 100 };
  const b = { stats: {}, notes: {}, flags: { q1: { reason: "new", updatedAt: 200 } }, history: [], updatedAt: 200 };
  const merged = store.mergeStates(a, b);
  assert.equal(merged.flags.q1.reason, "new", "newer flag wins");
  assert.equal(merged.flags.q2.reason, "keep", "non-conflicting flag retained");
});

await check("focus auto-clears after 3 correct in a row and resets on a miss", async () => {
  const store = await import("../docs/js/store.js");
  const qid = QUESTIONS[0].id;
  store.resetAll();
  store.setFocus(qid, true);
  assert.equal(store.isFocused(qid), true);
  store.recordAnswer(qid, true);   // streak 1
  store.recordAnswer(qid, true);   // streak 2
  assert.equal(store.isFocused(qid), true, "still marked before the threshold");
  store.recordAnswer(qid, true);   // streak 3 -> mastered
  assert.equal(store.isFocused(qid), false, "cleared after 3 correct in a row");

  store.setFocus(qid, true);
  store.recordAnswer(qid, true);   // streak 1
  store.recordAnswer(qid, false);  // a miss resets it
  store.recordAnswer(qid, true);   // streak 1
  store.recordAnswer(qid, true);   // streak 2
  assert.equal(store.isFocused(qid), true, "a miss resets the streak, so still marked");
});

await check("a lucky guess (correct but flagged) does not advance the focus streak", async () => {
  const store = await import("../docs/js/store.js");
  const qid = QUESTIONS[0].id;
  store.resetAll();
  store.setFocus(qid, true);
  store.recordAnswer(qid, true, true);  // correct but flagged as a guess
  store.recordAnswer(qid, true, true);
  store.recordAnswer(qid, true, true);
  assert.equal(store.isFocused(qid), true, "three lucky guesses never clear the mark");
  store.recordAnswer(qid, true);        // correct, not guessed
  store.recordAnswer(qid, true);
  store.recordAnswer(qid, true);        // 3rd un-guessed correct clears it
  assert.equal(store.isFocused(qid), false, "un-guessed corrects still clear it");
});

await check("mergeStates resolves focus marks by last-write-wins", async () => {
  const store = await import("../docs/js/store.js");
  const a = { stats: {}, notes: {}, flags: {}, focus: { q1: { streak: 1, updatedAt: 100 }, q2: { streak: 0, updatedAt: 50 } }, history: [], updatedAt: 100 };
  const b = { stats: {}, notes: {}, flags: {}, focus: { q1: { streak: 2, updatedAt: 200 } }, history: [], updatedAt: 200 };
  const merged = store.mergeStates(a, b);
  assert.equal(merged.focus.q1.streak, 2, "newer focus mark wins");
  assert.equal(merged.focus.q2.streak, 0, "non-conflicting focus mark retained");
});

await check("stableStringify ignores key order but not content or array order", () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.equal(stableStringify({ x: { p: 1, q: 2 } }), stableStringify({ x: { q: 2, p: 1 } }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
});

await check("mergeRemote: identical remote is a no-op, real differences are detected", async () => {
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
