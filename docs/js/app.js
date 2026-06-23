// Main controller: view rendering, routing, and event wiring.
// Data lives in store.js (local-first) and optionally syncs via cloud.js.

import { QUESTIONS } from "./data/questions.js";
import { EXPLANATIONS, EXPLANATIONS_DISCLAIMER } from "./data/explanations.js";
import { sectionLabel, sectionCode } from "./data/sections.js";
import * as store from "./store.js";
import * as cloud from "./cloud.js";
import { buildQuiz, buildFromQuestions, eligible, MODES } from "./quiz.js";
import { computeOverall, computeBySection } from "./stats.js";
import { escapeHTML, pct } from "./util.js";

// --- precomputed lookups ----------------------------------------------------
const SECTION_NUMBERS = [...new Set(QUESTIONS.map((q) => q.section))].sort((a, b) => a - b);
const SECTION_COUNT = QUESTIONS.reduce((acc, q) => {
  acc[q.section] = (acc[q.section] || 0) + 1;
  return acc;
}, {});
const QMAP = new Map(QUESTIONS.map((q) => [q.id, q]));

// --- app state --------------------------------------------------------------
const appState = {
  view: "dashboard",
  setup: { section: "all", mode: "all", length: "25" },
  session: null, // { quiz, idx, answers[], answered, correct }
  lastResult: null,
  authError: "",
};

const viewEl = () => document.getElementById("view");
const navEl = () => document.getElementById("nav");
const noteTimers = {};

// Views that should re-render when the store's data changes (e.g. a cloud sync
// merges in new progress). Views hosting live <input>/<textarea> are excluded
// so a re-render can't wipe in-progress typing: notes (note editors) and
// account (the sign-in form). The account view shows no store-derived data
// anyway — its sign-in/out transitions are driven by cloud.onCloud instead.
const AUTO_RERENDER = new Set(["dashboard", "stats"]);

// --- routing ----------------------------------------------------------------
function navigate(view, patch = {}) {
  Object.assign(appState, patch);
  appState.view = view;
  render();
  window.scrollTo(0, 0);
}

function render() {
  const view = appState.view;
  const el = viewEl();
  if (!el) return;
  el.innerHTML = TEMPLATES[view] ? TEMPLATES[view]() : renderDashboard();
  updateNav(view);
  afterRender(view);
  updateSyncChip();
}

function updateNav(view) {
  const navKey = ["setup", "quiz", "results"].includes(view) ? "dashboard" : view;
  navEl().querySelectorAll("button[data-nav]").forEach((b) => {
    b.classList.toggle("active", b.dataset.nav === navKey);
  });
  document.body.classList.toggle("quiz-active", view === "quiz");
}

// --- shared bits ------------------------------------------------------------
function bar(percent, kind = "") {
  const p = Math.max(0, Math.min(100, percent || 0));
  return `<div class="bar"><div class="bar-fill ${kind}" style="width:${p}%"></div></div>`;
}

function fmtDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function sessionContext(quiz) {
  const sec =
    quiz.section === "all" ? "All sections"
    : quiz.section === "custom" ? "Review"
    : sectionLabel(quiz.section);
  const mode = MODES[quiz.mode] || (quiz.mode === "retry" ? "Retry mistakes" : "");
  return mode ? `${sec} · ${mode}` : sec;
}

function accuracyKind(p) {
  if (p >= 80) return "good";
  if (p >= 60) return "ok";
  return "low";
}

// A short, AI-generated study explainer for a question, shown after answering
// (alongside the user's own note). Returns "" when no explainer exists yet, so
// it's safe to drop into any view. The AI-generated disclaimer travels with it.
function explanationBlock(id) {
  const text = EXPLANATIONS[id];
  if (!text) return "";
  const safeId = escapeHTML(id);
  const flag = store.getFlag(id);
  const c = cloud.cloudState();
  const stateMsg = c.enabled && c.signedIn
    ? "⚑ Flagged — sent to the author for review. Thanks!"
    : c.enabled
      ? "⚑ Flagged on this device — sign in to send it to the author."
      : "⚑ Flagged on this device. Thanks!";
  const flagUI = flag
    ? `<div class="flag-row">
        <span class="flag-state">${stateMsg}</span>
        <button class="link" data-action="unflag-expl" data-qid="${safeId}">Undo</button>
      </div>
      <label class="field flag-reason">
        <span>What seems wrong? <span class="muted">(optional)</span> <span class="saved" data-saved-for="flag:${safeId}"></span></span>
        <textarea data-flag-qid="${safeId}" rows="2" placeholder="Tell the author what looks wrong.">${escapeHTML(flag.reason || "")}</textarea>
      </label>`
    : `<div class="flag-row">
        <button class="link flag-btn" data-action="flag-expl" data-qid="${safeId}">⚑ Flag as wrong</button>
      </div>`;
  return `
    <div class="explain">
      <div class="explain-head">Explanation</div>
      <p class="explain-body">${escapeHTML(text)}</p>
      <p class="explain-note">${escapeHTML(EXPLANATIONS_DISCLAIMER)}</p>
      ${flagUI}
    </div>`;
}

// --- dashboard --------------------------------------------------------------
function renderDashboard() {
  const stats = store.getState().stats;
  const overall = computeOverall(QUESTIONS, stats);
  const bySection = computeBySection(QUESTIONS, stats);
  const history = store.getState().history;

  const sectionCards = bySection.map((s) => `
    <div class="section-row">
      <div class="section-head">
        <div>
          <div class="section-name">${escapeHTML(sectionLabel(s.section))}</div>
          <div class="muted small">${sectionCode(s.section)} · ${s.total} questions</div>
        </div>
        <button class="btn btn-sm" data-action="study" data-section="${s.section}">Study</button>
      </div>
      <div class="meter-line">
        <span class="muted small">Seen ${s.seen}/${s.total}</span>
        ${bar(s.coverage)}
      </div>
      <div class="meter-line">
        <span class="muted small">Accuracy ${s.attempts ? s.accuracy + "%" : "—"}</span>
        ${bar(s.accuracy, accuracyKind(s.accuracy))}
      </div>
    </div>`).join("");

  const recent = history.length ? `
    <div class="card">
      <div class="card-title">Last session</div>
      <p class="muted">${fmtDate(history[0].startedAt)} · ${escapeHTML(
        history[0].section === "all" ? "All sections"
          : history[0].section === "custom" ? "Review"
          : sectionLabel(history[0].section))}
        — scored <strong>${history[0].correct}/${history[0].total}</strong>
        (${pct(history[0].correct, history[0].total)}%)</p>
    </div>` : "";

  return `
    <section class="stack">
      <div class="card hero">
        <div class="hero-stats">
          <div class="stat">
            <div class="stat-num">${overall.coverage}%</div>
            <div class="stat-label">Bank seen</div>
          </div>
          <div class="stat">
            <div class="stat-num">${overall.attempts ? overall.accuracy + "%" : "—"}</div>
            <div class="stat-label">Accuracy</div>
          </div>
          <div class="stat">
            <div class="stat-num">${overall.seen}/${overall.total}</div>
            <div class="stat-label">Questions</div>
          </div>
        </div>
        ${bar(overall.coverage)}
        <button class="btn btn-primary btn-block" data-action="study" data-section="all">Start studying</button>
      </div>
      ${recent}
      <h2 class="section-title">Study by section</h2>
      <div class="stack">${sectionCards}</div>
    </section>`;
}

// --- quiz setup -------------------------------------------------------------
function renderSetup() {
  const { section, mode, length } = appState.setup;
  const stats = store.getState().stats;
  // Just need the count here — avoid building (and shuffling) a throwaway quiz
  // on every filter change.
  const pool = eligible(QUESTIONS, { section, mode, stats }).length;

  const sectionOpts = [
    `<option value="all" ${section === "all" ? "selected" : ""}>All sections (${QUESTIONS.length})</option>`,
    ...SECTION_NUMBERS.map((n) =>
      `<option value="${n}" ${String(section) === String(n) ? "selected" : ""}>${escapeHTML(sectionLabel(n))} — ${sectionCode(n)} (${SECTION_COUNT[n]})</option>`),
  ].join("");

  const modeOpts = Object.entries(MODES).map(([k, v]) =>
    `<option value="${k}" ${mode === k ? "selected" : ""}>${escapeHTML(v)}</option>`).join("");

  const lengthOpts = ["10", "25", "50", "all"].map((l) =>
    `<option value="${l}" ${length === l ? "selected" : ""}>${l === "all" ? "All available" : l + " questions"}</option>`).join("");

  const none = pool === 0;
  const hint = none
    ? `<p class="empty">No questions match this filter${mode === "incorrect" ? " — you have no recorded mistakes here yet." : mode === "unseen" ? " — you've seen them all here." : "."}</p>`
    : `<p class="muted small">${pool} question${pool === 1 ? "" : "s"} available with these filters.</p>`;

  return `
    <section class="stack">
      <h2 class="section-title">New quiz</h2>
      <div class="card stack">
        <label class="field">
          <span>Section</span>
          <select data-setup="section">${sectionOpts}</select>
        </label>
        <label class="field">
          <span>Mode</span>
          <select data-setup="mode">${modeOpts}</select>
        </label>
        <label class="field">
          <span>Length</span>
          <select data-setup="length">${lengthOpts}</select>
        </label>
        ${hint}
        <button class="btn btn-primary btn-block" data-action="begin" ${none ? "disabled" : ""}>Start quiz</button>
      </div>
    </section>`;
}

// --- quiz -------------------------------------------------------------------
function renderQuiz() {
  const s = appState.session;
  if (!s) return renderDashboard();
  const item = s.quiz.items[s.idx];
  const ans = s.answers[s.idx];
  const answered = !!ans;
  const total = s.quiz.items.length;
  const progress = pct(s.idx + (answered ? 1 : 0), total);

  const options = item.options.map((opt, oi) => {
    let cls = "opt";
    let attrs = `data-action="answer" data-index="${oi}"`;
    if (answered) {
      attrs = "disabled";
      if (oi === item.correctIndex) cls += " opt-correct";
      else if (oi === ans.selected) cls += " opt-wrong";
    }
    return `<button class="${cls}" ${attrs}>${escapeHTML(opt)}</button>`;
  }).join("");

  let feedback = "";
  if (answered) {
    const note = escapeHTML(store.getNote(item.id));
    const verdict = ans.correct
      ? `<div class="verdict ok">Correct</div>`
      : `<div class="verdict bad">Not quite — the correct answer is highlighted.</div>`;
    const isLast = s.idx + 1 >= total;
    feedback = `
      ${verdict}
      ${explanationBlock(item.id)}
      <div class="note-block">
        <label class="field">
          <span>Your note for this question <span class="saved" data-saved-for="${escapeHTML(item.id)}"></span></span>
          <textarea data-note-qid="${escapeHTML(item.id)}" rows="3"
            placeholder="Add a note — it'll show here whenever you answer this question again.">${note}</textarea>
        </label>
      </div>
      <button class="btn btn-primary btn-block" data-action="next">${isLast ? "Finish" : "Next question"}</button>`;
  }

  return `
    <section class="quiz">
      <div class="quiz-top">
        <button class="link" data-action="end-quiz">Exit</button>
        <div class="quiz-meta">
          <span>Q ${s.idx + 1} / ${total}</span>
          <span class="muted">·</span>
          <span>Score ${s.correct}/${s.answered}</span>
        </div>
      </div>
      ${bar(progress)}
      <div class="muted small ctx">${escapeHTML(sessionContext(s.quiz))} · ${escapeHTML(item.id)}</div>
      <h2 class="question">${escapeHTML(item.question)}</h2>
      <div class="options">${options}</div>
      ${feedback}
    </section>`;
}

// --- results ----------------------------------------------------------------
function renderResults() {
  const r = appState.lastResult;
  if (!r) return renderDashboard();

  const missedList = r.missed.length ? `
    <h2 class="section-title">Review (${r.missed.length})</h2>
    <div class="stack">
      ${r.missed.map((it) => {
        const note = store.getNote(it.id);
        return `<div class="card review">
          <div class="muted small">${escapeHTML(it.id)}</div>
          <div class="review-q">${escapeHTML(it.question)}</div>
          <div class="review-a"><span class="tag ok">Correct</span> ${escapeHTML(it.correct)}</div>
          ${explanationBlock(it.id)}
          ${note ? `<div class="review-note"><span class="tag">Note</span> ${escapeHTML(note)}</div>` : ""}
        </div>`;
      }).join("")}
    </div>` : `<p class="empty">Perfect — no mistakes to review!</p>`;

  return `
    <section class="stack">
      <div class="card hero">
        <div class="big-score ${accuracyKind(r.accuracy)}">${r.accuracy}%</div>
        <p class="muted">You scored <strong>${r.correct}/${r.total}</strong> · ${escapeHTML(sessionContext({ section: r.section, mode: r.mode }))}</p>
        <div class="row">
          ${r.missed.length ? `<button class="btn btn-primary" data-action="retry-mistakes">Retry my mistakes</button>` : ""}
          <button class="btn" data-action="new-quiz">New quiz</button>
          <button class="btn btn-ghost" data-action="home">Home</button>
        </div>
      </div>
      ${missedList}
    </section>`;
}

// --- stats ------------------------------------------------------------------
function renderStats() {
  const state = store.getState();
  const overall = computeOverall(QUESTIONS, state.stats);
  const bySection = computeBySection(QUESTIONS, state.stats);

  const rows = bySection.map((s) => `
    <div class="section-row">
      <div class="section-head">
        <div class="section-name">${escapeHTML(sectionLabel(s.section))}</div>
        <div class="muted small">${s.attempts ? s.accuracy + "% · " : ""}seen ${s.seen}/${s.total}</div>
      </div>
      ${bar(s.coverage)}
      ${bar(s.accuracy, accuracyKind(s.accuracy))}
    </div>`).join("");

  const history = state.history.slice(0, 15).map((h) => `
    <div class="hist-row">
      <span>${fmtDate(h.startedAt)}</span>
      <span class="muted">${escapeHTML(h.section === "all" ? "All" : h.section === "custom" ? "Review" : sectionLabel(h.section))}</span>
      <span class="${accuracyKind(pct(h.correct, h.total))}">${h.correct}/${h.total}</span>
    </div>`).join("");

  return `
    <section class="stack">
      <h2 class="section-title">Your progress</h2>
      <div class="card hero">
        <div class="hero-stats">
          <div class="stat"><div class="stat-num">${overall.coverage}%</div><div class="stat-label">Bank seen</div></div>
          <div class="stat"><div class="stat-num">${overall.attempts ? overall.accuracy + "%" : "—"}</div><div class="stat-label">Accuracy</div></div>
          <div class="stat"><div class="stat-num">${overall.attempts}</div><div class="stat-label">Answers logged</div></div>
        </div>
      </div>
      <div class="card stack">${rows}</div>
      <h2 class="section-title">Recent sessions</h2>
      <div class="card">${history || `<p class="empty">No quizzes yet.</p>`}</div>
      <button class="btn btn-danger btn-block" data-action="reset">Reset all progress</button>
    </section>`;
}

// --- notes ------------------------------------------------------------------
function questionMeta(id) {
  const q = QMAP.get(id);
  return `<div class="muted small">${escapeHTML(id)}${q ? " · " + escapeHTML(sectionLabel(q.section)) : ""}</div>
    ${q ? `<div class="review-q">${escapeHTML(q.q)}</div>
      <div class="review-a"><span class="tag ok">Correct</span> ${escapeHTML(q.correct)}</div>` : ""}`;
}

function renderNotes() {
  const state = store.getState();
  const noteIds = Object.keys(state.notes).sort();
  const flagIds = Object.keys(state.flags).sort();

  if (!noteIds.length && !flagIds.length) {
    return `<section class="stack"><h2 class="section-title">Notes &amp; flags</h2>
      <p class="empty">Nothing here yet. After answering a question you can add a note, or flag an explanation that looks wrong — both collect here.</p></section>`;
  }

  const flagged = flagIds.length ? `
    <h2 class="section-title">Flagged explanations (${flagIds.length})</h2>
    <div class="stack">
      ${flagIds.map((id) => `<div class="card stack">
        ${questionMeta(id)}
        ${explanationBlock(id)}
      </div>`).join("")}
    </div>` : "";

  const notes = noteIds.length ? `
    <h2 class="section-title">My notes (${noteIds.length})</h2>
    <button class="btn btn-block" data-action="study-notes">Quiz these ${noteIds.length} question${noteIds.length === 1 ? "" : "s"}</button>
    <div class="stack">
      ${noteIds.map((id) => `<div class="card stack">
        ${questionMeta(id)}
        ${QMAP.get(id) ? explanationBlock(id) : ""}
        <label class="field">
          <span>Note <span class="saved" data-saved-for="${escapeHTML(id)}"></span></span>
          <textarea data-note-qid="${escapeHTML(id)}" rows="3">${escapeHTML(state.notes[id].text)}</textarea>
        </label>
        <button class="btn btn-sm btn-ghost" data-action="del-note" data-qid="${escapeHTML(id)}">Delete note</button>
      </div>`).join("")}
    </div>` : "";

  return `<section class="stack">${flagged}${notes}</section>`;
}

// --- account / sync ---------------------------------------------------------
function renderAccount() {
  const c = cloud.cloudState();
  if (!c.ready) {
    return `<section class="stack"><h2 class="section-title">Login</h2><p class="muted">Checking…</p></section>`;
  }
  if (!c.enabled) {
    return `<section class="stack">
      <h2 class="section-title">Login</h2>
      <div class="card stack">
        <p>Cloud sync isn't configured, so everything is saved on <strong>this device only</strong>.</p>
        <p class="muted small">To sync across devices, add your Firebase config (see <code>SETUP.md</code>) and reload.</p>
      </div>
    </section>`;
  }
  if (c.signedIn) {
    return `<section class="stack">
      <h2 class="section-title">Login</h2>
      <div class="card stack">
        <p>Signed in as <strong>${escapeHTML(c.email || "")}</strong>.</p>
        <p class="muted small">Your notes, scores, and progress sync across your devices automatically.</p>
        <button class="btn btn-ghost" data-action="signout">Sign out</button>
      </div>
    </section>`;
  }
  return `<section class="stack">
    <h2 class="section-title">Login</h2>
    <div class="card stack">
      <p class="muted small">Sign in to sync your study data across devices. Use the same account everywhere.</p>
      <form id="auth-form" class="stack">
        <label class="field"><span>Email</span><input type="email" id="auth-email" autocomplete="username" required></label>
        <label class="field"><span>Password</span><input type="password" id="auth-pass" autocomplete="current-password" minlength="6" required></label>
        ${appState.authError ? `<p class="error">${escapeHTML(appState.authError)}</p>` : ""}
        <div class="row">
          <button class="btn btn-primary" type="submit">Sign in</button>
          <button class="btn" type="button" data-action="signup">Create account</button>
        </div>
      </form>
    </div>
  </section>`;
}

const TEMPLATES = {
  dashboard: renderDashboard,
  setup: renderSetup,
  quiz: renderQuiz,
  results: renderResults,
  stats: renderStats,
  notes: renderNotes,
  account: renderAccount,
};

// --- actions ----------------------------------------------------------------
function startSession(quiz) {
  if (!quiz.items.length) return;
  appState.session = { quiz, idx: 0, answers: [], answered: 0, correct: 0 };
  navigate("quiz");
}

function startQuiz() {
  const { section, mode, length } = appState.setup;
  const quiz = buildQuiz(QUESTIONS, {
    section,
    mode,
    length: length === "all" ? 0 : Number(length),
    stats: store.getState().stats,
  });
  startSession(quiz);
}

function answer(optIndex) {
  const s = appState.session;
  if (!s || s.answers[s.idx]) return;
  const item = s.quiz.items[s.idx];
  const correct = optIndex === item.correctIndex;
  s.answers[s.idx] = { selected: optIndex, correct };
  s.answered += 1;
  if (correct) s.correct += 1;
  store.recordAnswer(item.id, correct);
  render();
}

function saveCurrentNote() {
  const ta = viewEl().querySelector("textarea[data-note-qid]");
  if (ta) store.setNote(ta.dataset.noteQid, ta.value);
}

// Persist any live note / flag-reason fields before a re-render so toggling a
// flag never discards what the user was typing.
function flushVisibleInputs() {
  const root = viewEl();
  if (!root) return;
  root.querySelectorAll("textarea[data-note-qid]").forEach((ta) => store.setNote(ta.dataset.noteQid, ta.value));
  root.querySelectorAll("textarea[data-flag-qid]").forEach((ta) => store.setFlagged(ta.dataset.flagQid, true, ta.value));
}

function flagExpl(qid) {
  flushVisibleInputs();
  store.setFlagged(qid, true);
  const f = store.getFlag(qid);
  cloud.reportFlag(qid, f ? f.reason : "");
  render();
}

function unflagExpl(qid) {
  flushVisibleInputs();
  store.setFlagged(qid, false);
  cloud.withdrawFlag(qid);
  render();
}

function nextQuestion() {
  const s = appState.session;
  if (!s) return;
  saveCurrentNote();
  if (s.idx + 1 >= s.quiz.items.length) return finishQuiz({ completed: true });
  s.idx += 1;
  render();
}

// `completed` is true only when the user answered through to the last question.
// Exiting early still shows results (so you see how you did) but isn't logged as
// a session, keeping the history limited to quizzes actually finished.
function finishQuiz({ completed = false } = {}) {
  const s = appState.session;
  if (!s) return navigate("dashboard");
  saveCurrentNote();
  const total = s.answered;
  const correct = s.correct;
  const missed = s.quiz.items.filter((_, i) => s.answers[i] && !s.answers[i].correct);
  if (total > 0 && completed) {
    store.addHistory({
      startedAt: s.quiz.startedAt,
      finishedAt: Date.now(),
      section: s.quiz.section,
      mode: s.quiz.mode,
      total,
      correct,
    });
  }
  appState.lastResult = { total, correct, accuracy: pct(correct, total), section: s.quiz.section, mode: s.quiz.mode, missed };
  appState.session = null;
  if (total === 0) return navigate("dashboard");
  navigate("results");
}

function retryMistakes() {
  const r = appState.lastResult;
  if (!r || !r.missed.length) return navigate("setup");
  const qs = r.missed.map((it) => QMAP.get(it.id)).filter(Boolean);
  startSession(buildFromQuestions(qs));
}

function studyNotes() {
  const ids = Object.keys(store.getState().notes);
  const qs = ids.map((id) => QMAP.get(id)).filter(Boolean);
  if (qs.length) startSession(buildFromQuestions(qs));
}

function resetProgress() {
  if (window.confirm("Reset all progress, notes, scores, and history? This can't be undone.")) {
    store.resetAll();
    navigate("dashboard");
  }
}

function delNote(qid) {
  store.setNote(qid, "");
  render();
}

async function doAuth(kind) {
  const email = document.getElementById("auth-email");
  const pass = document.getElementById("auth-pass");
  if (!email || !pass) return;
  appState.authError = "";
  try {
    if (kind === "signup") await cloud.signUp(email.value, pass.value);
    else await cloud.signIn(email.value, pass.value);
  } catch (e) {
    appState.authError = friendlyAuthError(e);
    if (appState.view === "account") render();
  }
}

function friendlyAuthError(e) {
  const code = (e && e.code) || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found"))
    return "Incorrect email or password.";
  if (code.includes("email-already-in-use")) return "That email already has an account — try signing in.";
  if (code.includes("weak-password")) return "Password should be at least 6 characters.";
  if (code.includes("invalid-email")) return "That doesn't look like a valid email.";
  if (code.includes("network-request-failed")) return "Network error — check your connection and try again.";
  if (code.includes("too-many-requests")) return "Too many attempts — please wait a moment and try again.";
  // Don't surface raw SDK error text to the user; keep a generic fallback.
  return "Something went wrong. Please try again.";
}

// --- event wiring -----------------------------------------------------------
function onClick(e) {
  const nav = e.target.closest("button[data-nav]");
  if (nav) {
    navigate(nav.dataset.nav);
    return;
  }
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const a = el.dataset.action;
  switch (a) {
    case "study": navigate("setup", { setup: { ...appState.setup, section: el.dataset.section || "all" } }); break;
    case "begin": startQuiz(); break;
    case "answer": answer(Number(el.dataset.index)); break;
    case "next": nextQuestion(); break;
    case "end-quiz": finishQuiz(); break;
    case "retry-mistakes": retryMistakes(); break;
    case "new-quiz": navigate("setup"); break;
    case "home": navigate("dashboard"); break;
    case "reset": resetProgress(); break;
    case "del-note": delNote(el.dataset.qid); break;
    case "study-notes": studyNotes(); break;
    case "flag-expl": flagExpl(el.dataset.qid); break;
    case "unflag-expl": unflagExpl(el.dataset.qid); break;
    case "signup": doAuth("signup"); break;
    case "signout": cloud.signOutUser(); break;
    case "toggle-theme": toggleTheme(); break;
    default: break;
  }
}

function onInput(e) {
  const ta = e.target.closest("textarea[data-note-qid]");
  if (ta) {
    const qid = ta.dataset.noteQid;
    clearTimeout(noteTimers[qid]);
    noteTimers[qid] = setTimeout(() => {
      store.setNote(qid, ta.value);
      flashSaved(qid);
    }, 400);
    return;
  }
  const flagTa = e.target.closest("textarea[data-flag-qid]");
  if (flagTa) {
    const qid = flagTa.dataset.flagQid;
    const key = "flag:" + qid;
    clearTimeout(noteTimers[key]);
    noteTimers[key] = setTimeout(() => {
      store.setFlagged(qid, true, flagTa.value);
      cloud.reportFlag(qid, flagTa.value);
      flashSaved(key);
    }, 400);
  }
}

function onChange(e) {
  const sel = e.target.closest("select[data-setup]");
  if (!sel) return;
  appState.setup = { ...appState.setup, [sel.dataset.setup]: sel.value };
  if (appState.view === "setup") render();
}

function onSubmit(e) {
  if (e.target.id === "auth-form") {
    e.preventDefault();
    doAuth("signin");
  }
}

function flashSaved(qid) {
  const el = document.querySelector(`[data-saved-for="${qid}"]`);
  if (!el) return;
  el.textContent = "Saved";
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 1400);
}

function updateSyncChip() {
  const chip = document.getElementById("sync-chip");
  if (!chip) return;
  const c = cloud.cloudState();
  let text = "On this device";
  let cls = "chip";
  if (c.enabled && c.signedIn) {
    text = "Synced";
    cls = "chip chip-good";
  } else if (c.enabled) {
    text = "Sync off";
    cls = "chip chip-warn";
  }
  chip.textContent = text;
  chip.className = cls;
}

function afterRender(_view) {
  // Intentionally no auto-focus: focusing the note field after each answer
  // would pop the mobile keyboard open and cover the Next button.
}

// --- theme ------------------------------------------------------------------
const THEME_KEY = "canham_theme";

function getTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch (_) {
    return "dark";
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#0b5fff" : "#3b82f6");
}

function toggleTheme() {
  const next = getTheme() === "light" ? "dark" : "light";
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (_) {
    /* ignore storage errors */
  }
  applyTheme(next);
}

// --- boot -------------------------------------------------------------------
function boot() {
  applyTheme(getTheme());
  document.addEventListener("click", onClick);
  document.addEventListener("input", onInput);
  document.addEventListener("change", onChange);
  document.addEventListener("submit", onSubmit);

  // Re-render data views when state changes underneath them (e.g. cloud merge).
  store.subscribe(() => {
    if (AUTO_RERENDER.has(appState.view)) render();
  });
  cloud.onCloud(() => {
    updateSyncChip();
    if (appState.view === "account") render();
  });

  render();
  cloud.initCloud();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
