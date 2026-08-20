// Main controller: view rendering, routing, and event wiring.
// Data lives in store.js (local-first) and optionally syncs via cloud.js.

import { QUESTIONS } from "./data/questions.js";
import { EXPLANATIONS, EXPLANATIONS_DISCLAIMER } from "./data/explanations.js";
import { sectionLabel, sectionShortLabel, sectionCode } from "./data/sections.js";
import * as store from "./store.js";
import * as cloud from "./cloud.js";
import { buildQuiz, buildFromQuestions, eligible, MODES } from "./quiz.js";
import { computeReadiness, MASTERY_FRESH_DAYS } from "./readiness.js";
import { SUBSECTION_TOPICS } from "./data/subsections.js";
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
  // Sort state for the Progress view's readiness tables.
  readinessSort: { sections: { key: "section", dir: 1 }, subs: { key: "priority", dir: 1 } },
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

// Readiness fractions (0..1) → display percentages: whole numbers for rates,
// one decimal for exam-weight slices (a subsection is only ever worth 2.0%).
function fmtPct(f) {
  return Math.round((f || 0) * 100) + "%";
}

function fmtW(f) {
  return ((f || 0) * 100).toFixed(1) + "%";
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

// Copy shared by the dashboard card and the Progress hero. Stale answers are
// still counted as mastered (accuracy is unchanged) — they just carry reduced
// weight in the forward-looking projection until refreshed.
function refreshButton(n, primary) {
  return `<button class="btn ${primary ? "btn-primary " : ""}btn-block" data-action="study-stale">Refresh ${n} older answer${n === 1 ? "" : "s"}</button>`;
}

// --- dashboard --------------------------------------------------------------
function renderDashboard() {
  const { stats, focus, history } = store.getState();
  const r = computeReadiness(QUESTIONS, stats, focus);
  const nFocus = store.focusCount();
  // Refreshing restores the "today" projection but cannot raise readiness,
  // conservative or recoverable — only new and missed material can. So it only
  // earns the primary button once there is almost nothing left to gain.
  const refreshFirst = r.overall.recoverable < 0.10;

  const sectionCards = r.sections.map((s) => `
    <div class="section-row">
      <div class="section-head">
        <div>
          <div class="section-name">${escapeHTML(sectionLabel(s.section))}</div>
          <div class="muted small">${sectionCode(s.section)} · ${s.total} questions · ${fmtPct(s.weight)} of exam</div>
        </div>
        <button class="btn btn-sm" data-action="study" data-section="${s.section}">Study</button>
      </div>
      <div class="meter-line">
        <span class="muted small">Seen ${s.answered}/${s.total}</span>
        ${bar(s.coverage * 100)}
      </div>
      <div class="meter-line">
        <span class="muted small">Mastery ${s.masteryRate === null ? "—" : fmtPct(s.masteryRate)}</span>
        ${bar((s.masteryRate || 0) * 100, accuracyKind(Math.round((s.masteryRate || 0) * 100)))}
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

  const practice = nFocus ? `
    <div class="card">
      <div class="card-title">Needs practice</div>
      <p class="muted small">${nFocus} question${nFocus === 1 ? "" : "s"} you marked “I have no idea” — these come up more often, and drop off after 3 correct in a row.</p>
      <button class="btn btn-primary btn-block" data-action="study-focus">Practice ${nFocus === 1 ? "it" : "them"}</button>
      <button class="btn btn-sm btn-ghost" data-action="clear-focus">Clear the list</button>
    </div>` : "";

  const nDue = r.overall.stale;
  const due = nDue ? `
    <div class="card">
      <div class="card-title">Due for review</div>
      <p class="muted small">${nDue} answer${nDue === 1 ? "" : "s"} you last got right more than ${MASTERY_FRESH_DAYS} days ago. ${nDue === 1 ? "It still counts" : "They still count"} toward your accuracy, but your projection for today (${fmtPct(r.overall.freshReadiness)}) weighs ${nDue === 1 ? "it" : "them"} at less than full strength until you see ${nDue === 1 ? "it" : "them"} again.</p>
      ${refreshButton(nDue, refreshFirst)}
    </div>` : "";

  return `
    <section class="stack">
      <div class="card hero">
        <div class="hero-stats">
          <div class="stat">
            <div class="stat-num">${fmtPct(r.overall.readiness)}</div>
            <div class="stat-label">Readiness</div>
          </div>
          <div class="stat">
            <div class="stat-num">${r.overall.masteryRate === null ? "—" : fmtPct(r.overall.masteryRate)}</div>
            <div class="stat-label">Accuracy</div>
          </div>
          <div class="stat">
            <div class="stat-num">${fmtPct(r.overall.coverage)}</div>
            <div class="stat-label">Bank seen</div>
          </div>
        </div>
        ${bar(r.overall.readiness * 100, accuracyKind(Math.round(r.overall.readiness * 100)))}
        <p class="muted small">Exam-weighted: each of the 50 exam subsections counts 2% · conservative score ${fmtPct(r.overall.conservative)}</p>
        <button class="btn btn-primary btn-block" data-action="study" data-section="all">Start studying</button>
      </div>
      ${recent}
      ${practice}
      ${due}
      <h2 class="section-title">Study by section</h2>
      <div class="stack">${sectionCards}</div>
    </section>`;
}

// --- quiz setup -------------------------------------------------------------
function renderSetup() {
  const { section, mode, length } = appState.setup;
  const stats = store.getState().stats;
  const focus = store.getState().focus;
  // Just need the count here — avoid building (and shuffling) a throwaway quiz
  // on every filter change.
  const pool = eligible(QUESTIONS, { section, mode, stats, focus }).length;

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
    ? `<p class="empty">No questions match this filter${mode === "incorrect" ? " — you have no recorded mistakes here yet." : mode === "unseen" ? " — you've seen them all here." : mode === "focus" ? " — nothing marked “I have no idea” yet." : mode === "smart" ? " — nothing left to gain here, it’s all mastered!" : mode === "stale" ? " — nothing you’ve mastered has aged out yet." : "."}</p>`
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

  // "I have no idea" is available before answering (so a correct answer while
  // guessing is flagged as a lucky guess) and stays after. It's per-attempt:
  // default unchecked each time the question appears, even if it's already on
  // the needs-practice list — un-guessed correct answers are what clear it.
  const guessed = !!s.guessed[s.idx];
  const idkBox = `
    <label class="idk">
      <input type="checkbox" data-idk-qid="${escapeHTML(item.id)}" ${guessed ? "checked" : ""}>
      <span>I have no idea${answered ? " — practice this more" : " — I'm just guessing"}</span>
    </label>`;

  let feedback = "";
  if (answered) {
    const note = escapeHTML(store.getNote(item.id));
    const verdict = ans.correct
      ? (ans.guessed
          ? `<div class="verdict ok">Correct — but you were guessing, so this stays on your practice list.</div>`
          : `<div class="verdict ok">Correct</div>`)
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
      ${idkBox}
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

// --- stats / readiness -------------------------------------------------------
// Column definitions for the sortable readiness tables. `val` supplies the
// sort key; `cell` renders the cell HTML (all dynamic text escaped).
function masteryCell(r) {
  const main = r.masteryRate === null ? "—" : fmtPct(r.masteryRate);
  const pend = r.pending ? ` <span class="muted">+${r.pending}⏳</span>` : "";
  // Rendered as a block on a second line: every table cell is `white-space:
  // nowrap`, so anything inline here widens the column and would bring back the
  // phone scrollbar that was just removed.
  const stale = r.stale ? `<span class="cell-sub">♻ ${r.stale} old</span>` : "";
  return `<strong>${main}</strong>${pend}${stale}`;
}

function priorityCell(r) {
  // Colour by how much of the row's exam weight is still open to study.
  const open = r.weight ? r.recoverable / r.weight : 0;
  const kind = open >= 2 / 3 ? "low" : open >= 1 / 3 ? "ok" : "good";
  return `<span class="pri ${kind}">#${r.priority}</span>`;
}

const READY_COLUMNS = {
  sections: [
    { key: "section", label: "Section", val: (r) => r.section, cell: (r) => `<div class="cell-name">${escapeHTML(sectionShortLabel(r.section))}</div><span class="topic">${r.subCount} subsections · ${fmtW(r.weight)} of exam</span>` },
    { key: "mastery", label: "Mastery", num: true, val: (r) => (r.masteryRate === null ? -1 : r.masteryRate), cell: masteryCell },
    { key: "answered", label: "Seen", num: true, val: (r) => r.answered, cell: (r) => `${r.answered}/${r.total}` },
    { key: "earned", label: "Earned", num: true, val: (r) => r.earned, cell: (r) => fmtW(r.earned) },
    { key: "recoverable", label: "To gain", num: true, val: (r) => r.recoverable, cell: (r) => fmtW(r.recoverable) },
    { key: "priority", label: "Priority", num: true, val: (r) => r.priority, cell: priorityCell },
  ],
  subs: [
    { key: "code", label: "Subsection", val: (r) => r.code, cell: (r) => `<div class="cell-name">${escapeHTML(r.code)}</div><span class="topic">${escapeHTML(SUBSECTION_TOPICS[r.code] || "")}</span>` },
    { key: "mastery", label: "Mastery", num: true, val: (r) => (r.masteryRate === null ? -1 : r.masteryRate), cell: masteryCell },
    { key: "answered", label: "Seen", num: true, val: (r) => r.answered, cell: (r) => `${r.answered}/${r.total}` },
    { key: "earned", label: "Earned", num: true, val: (r) => r.earned, cell: (r) => fmtW(r.earned) },
    { key: "recoverable", label: "To gain", num: true, val: (r) => r.recoverable, cell: (r) => fmtW(r.recoverable) },
    { key: "priority", label: "Priority", num: true, val: (r) => r.priority, cell: priorityCell },
  ],
};

function readyTable(tbl, rows) {
  const sort = appState.readinessSort[tbl];
  const cols = READY_COLUMNS[tbl];
  const col = cols.find((c) => c.key === sort.key) || cols[0];
  const sorted = [...rows].sort((a, b) => {
    const va = col.val(a);
    const vb = col.val(b);
    const d = typeof va === "string" ? va.localeCompare(vb) : va - vb;
    return d * sort.dir || a.section - b.section || (a.sub || 0) - (b.sub || 0);
  });
  const head = cols.map((c) =>
    `<th${c.num ? ' class="num"' : ""}><button class="th-sort${c.key === sort.key ? " active" : ""}" data-action="sort-ready" data-tbl="${tbl}" data-key="${c.key}">${c.label}${c.key === sort.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}</button></th>`).join("");
  const body = sorted.map((r) =>
    `<tr>${cols.map((c) => `<td${c.num ? ' class="num"' : ""}>${c.cell(r)}</td>`).join("")}</tr>`).join("");
  return `<div class="table-wrap"><table class="rtable"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function sortReady(tbl, key) {
  const cur = appState.readinessSort[tbl];
  if (!cur || !READY_COLUMNS[tbl].some((c) => c.key === key)) return;
  appState.readinessSort[tbl] = cur.key === key ? { key, dir: -cur.dir } : { key, dir: 1 };
  render();
}

function renderStats() {
  const state = store.getState();
  const r = computeReadiness(QUESTIONS, state.stats, state.focus);
  const o = r.overall;

  const pendingNote = o.pending
    ? `<p class="muted small">⏳ ${o.pending} correct answer${o.pending === 1 ? "" : "s"} (e.g. lucky guesses) ${o.pending === 1 ? "is" : "are"} still on your needs-practice list — counted as answered, but not mastered until confirmed by 3 un-guessed correct answers in a row.</p>`
    : "";

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
        <div class="big-score ${accuracyKind(Math.round(o.readiness * 100))}">${fmtPct(o.readiness)}</div>
        <p class="muted">Exam-weighted readiness — the exam draws one question from each of the 50 subsections, so every subsection counts 2%.</p>
        <div class="hero-stats">
          <div class="stat"><div class="stat-num">${o.masteryRate === null ? "—" : fmtPct(o.masteryRate)}</div><div class="stat-label">Accuracy</div></div>
          <div class="stat"><div class="stat-num">${fmtPct(o.coverage)}</div><div class="stat-label">Bank seen</div></div>
          <div class="stat"><div class="stat-num">${fmtPct(o.conservative)}</div><div class="stat-label">Conservative</div></div>
        </div>
        <div class="hero-stats">
          <div class="stat"><div class="stat-num">${fmtW(o.recoverable)}</div><div class="stat-label">To gain</div></div>
          <div class="stat"><div class="stat-num">${o.subsectionsStarted}/${o.subsectionCount}</div><div class="stat-label">Subsections</div></div>
          <div class="stat"><div class="stat-num">${o.attempts}</div><div class="stat-label">Answers logged</div></div>
        </div>
        <p class="muted small">Accuracy counts each question once, by its latest answer. The conservative score also treats every unanswered question as not yet mastered; “to gain” is the exam weight still open to study.</p>
        ${o.stale ? `<p class="muted small">♻ ${o.stale} answer${o.stale === 1 ? "" : "s"} you last got right more than ${MASTERY_FRESH_DAYS} days ago ${o.stale === 1 ? "counts" : "count"} at reduced strength, so your projection <strong>today</strong> is ${fmtW(o.freshReadiness)} against ${fmtW(o.readiness)} if every answer were fresh. Ageing alone never changes your accuracy — only a wrong answer does. Get ${o.stale === 1 ? "it" : "them"} right again and full credit is restored.</p>` : ""}
        ${pendingNote}
        ${o.recoverable > 0 ? `<button class="btn ${o.stale && o.recoverable < 0.10 ? "" : "btn-primary "}btn-block" data-action="study-smart">Study the smartest gains</button>` : ""}
        ${o.stale ? refreshButton(o.stale, o.recoverable < 0.10) : ""}
      </div>

      <h2 class="section-title">Sections</h2>
      <div class="card">${readyTable("sections", r.sections)}</div>

      <h2 class="section-title">Subsections</h2>
      <div class="card">
        ${readyTable("subs", r.subsections)}
        <p class="muted small">Each subsection is worth 2.0% of the exam. Priority ranks where extra study gains the most marks — tap any column heading to sort.</p>
      </div>

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
  const noteIds = store.noteIds().sort();
  const flagIds = store.flagIds().sort();

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
        ${c.syncError
          ? `<p class="error">${escapeHTML(c.error || "Sync error — your data is safe on this device.")}</p>`
          : `<p class="muted small">Your notes, scores, and progress sync across your devices automatically.</p>`}
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
  appState.session = { quiz, idx: 0, answers: [], answered: 0, correct: 0, guessed: {} };
  navigate("quiz");
}

function startQuiz() {
  const { section, mode, length } = appState.setup;
  const quiz = buildQuiz(QUESTIONS, {
    section,
    mode,
    length: length === "all" ? 0 : Number(length),
    stats: store.getState().stats,
    focus: store.getState().focus,
  });
  startSession(quiz);
}

function answer(optIndex) {
  const s = appState.session;
  if (!s || s.answers[s.idx]) return;
  const item = s.quiz.items[s.idx];
  const correct = optIndex === item.correctIndex;
  const guessed = !!s.guessed[s.idx];
  s.answers[s.idx] = { selected: optIndex, correct, guessed };
  s.answered += 1;
  if (correct) s.correct += 1;
  store.recordAnswer(item.id, correct, guessed);
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
  const ids = store.noteIds();
  const qs = ids.map((id) => QMAP.get(id)).filter(Boolean);
  if (qs.length) startSession(buildFromQuestions(qs));
}

function clearFocusList() {
  const n = store.focusCount();
  if (!n) return;
  if (window.confirm(`Clear all ${n} “I have no idea” mark${n === 1 ? "" : "s"}? Your scores, notes and answers are untouched.`)) {
    store.clearAllFocus();
    render();
  }
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
    case "sort-ready": sortReady(el.dataset.tbl, el.dataset.key); break;
    case "del-note": delNote(el.dataset.qid); break;
    case "study-notes": studyNotes(); break;
    case "study-focus": navigate("setup", { setup: { ...appState.setup, section: "all", mode: "focus" } }); break;
    case "clear-focus": clearFocusList(); break;
    case "study-smart": navigate("setup", { setup: { ...appState.setup, section: "all", mode: "smart" } }); break;
    case "study-stale": navigate("setup", { setup: { ...appState.setup, section: "all", mode: "stale" } }); break;
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
  const idk = e.target.closest("input[data-idk-qid]");
  if (idk) {
    store.setFocus(idk.dataset.idkQid, idk.checked);
    // Remember, for this attempt, that the user said they were guessing, so a
    // correct answer won't count as mastering the question.
    const s = appState.session;
    if (s && appState.view === "quiz") s.guessed[s.idx] = idk.checked;
    return;
  }
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
  if (c.enabled && c.signedIn && c.syncError) {
    text = "Sync error";
    cls = "chip chip-bad";
  } else if (c.enabled && c.signedIn) {
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
