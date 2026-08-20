# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

A mobile-friendly, **static client-side** web app for studying the Canadian
**Advanced** amateur radio qualification exam, built on the official ISED
question bank. There is no server and no build/bundler step — the app in
`docs/` is plain HTML/CSS/ES-modules deployed straight to GitHub Pages.

Persistence is **local-first** (localStorage) with **optional** cloud sync via
Firebase. The app must always work with sync absent or unconfigured.

## Workflow

The maintainer wants changes delivered as pull requests. After committing and
pushing work to a feature branch, **open a PR automatically** (branch → `main`)
without asking first. **Do not put the Claude Code session link** (any
`claude.ai/code/session…` URL) in PR descriptions or commit messages — the short
"Generated with Claude Code" line is fine.

## Commands

```bash
# Regenerate the app dataset after editing the source question bank
python3 scripts/build_questions.py

# Regenerate per-question explainers after editing explanations/section-*.json
python3 scripts/build_explanations.py

# Run the logic tests (dataset integrity, quiz building, readiness scoring, state merge)
node scripts/selftest.mjs

# Serve locally (ES modules require HTTP, not file://)
python3 -m http.server 8765 --directory docs   # then http://localhost:8765
```

There is no linter/test-runner config; `node scripts/selftest.mjs` is the test
suite. UI behaviour is covered ad hoc — the pure modules (`quiz.js`,
`readiness.js`, `store.js`'s `mergeStates`) are intentionally DOM-free so they can
be unit-tested in Node.

## Architecture

**Data pipeline.** `amat_adv_quest_delim.txt` is the source of truth.
`scripts/build_questions.py` parses it and emits `docs/js/data/questions.js`
(an ES module exporting `QUESTIONS`, English fields only). The generated file
is committed; regenerate it whenever the `.txt` changes — never hand-edit it.

**Explainers (`explanations/section-*.json` → `docs/js/data/explanations.js`).**
Short, AI-generated study notes shown *after* the user answers, in addition to
their own note (see `explanationBlock` in `app.js`, used in the quiz, results,
and notes views). Authored by hand as one JSON file per exam section (`{ qid:
text }`), merged by `scripts/build_explanations.py` into a generated ES module
exporting `EXPLANATIONS` and `EXPLANATIONS_DISCLAIMER`. Like `questions.js` the
generated module is committed and must not be hand-edited — edit the section
JSON and rebuild. Coverage is partial-friendly (questions without an explainer
just don't show one), so they can be authored section by section. Every shown
explainer carries the AI-generated disclaimer; keep it.

**State (`docs/js/store.js`).** The single source of truth at runtime. Holds
`stats` (per-question attempts/correct/lastResult), `notes`, `flags` (the user
marking an AI explanation as possibly wrong, with an optional free-text reason),
`focus` (questions the user marked "I have no idea" — they rotate more often and
auto-clear after `FOCUS_CLEAR_STREAK` correct answers in a row that weren't
flagged as guesses; `recordAnswer` maintains the streak and a lucky guess resets
it), and `history`, persisted to localStorage under
`canham_adv_state_v1`. All writes
go through the store, which notifies subscribers. `mergeStates`/`mergeRemote`
reconcile local and cloud copies with **last-write-wins per record** (by
`lastSeenAt` / `updatedAt`); history is unioned by id. Flags are local-first
like notes and ride the user's own optional cloud sync; additionally, when
signed in, they're mirrored to a central `explanation_flags` collection for the
maintainer to review (see `cloud.js` / `SETUP.md`).

**Cloud sync (`docs/js/cloud.js`).** Optional, layered on top of the store.
Dynamically imports `docs/js/firebase-config.js`; if it's missing or has no
`apiKey`, the module reports `{ enabled: false }` and the app stays local-only.
When signed in, it mirrors `store.getState()` to `users/{uid}` in Firestore and
merges remote snapshots back via `store.mergeRemote`. It also exposes
`reportFlag`/`withdrawFlag`, which write a signed-in user's explanation flags to
a top-level `explanation_flags` collection (doc id `{uid}__{qid}`) for the
maintainer to review — the only data that leaves the user's own document. On sign-out it clears
local state (only after a confirmed cloud write) so a shared browser can't leak
the previous user's data; the cloud copy is restored on next sign-in. Keep this
strictly optional — never make core flows depend on it.

**Pure logic.** `quiz.js` builds sessions (randomizes question order *and*
answer-option order; filters by section and by mode:
all/unseen/incorrect/focus/smart/stale).
It also weights `focus` ("needs practice") questions so they're drawn
`FOCUS_WEIGHT`× more often (Efraimidis–Spirakis `random^(1/w)` keying in
`weightedOrder`). The smartest-gains mode (`smart`) draws only unmastered
questions (via `readiness.js`’s `questionStatus`), weighted by the share of
their subsection’s exam weight still unmastered, with the focus boost on top.
The `stale` mode ("Refresh older material") draws mastered answers that have aged
past the fresh window, oldest weighted heaviest. Smart mode is deliberately
staleness-blind: staleness is spread evenly across subsections, so folding it in
would flatten smart mode's between-subsection weighting and crowd out never-seen
material. `readiness.js` scores exam readiness the way the
Advanced exam is marked: the exam draws one question from each of the 50
subsections (A-SSS-BBB), so each subsection is worth 2% and section weights
follow from their subsection counts (A-001 10%, A-002 24%, A-003 12%, A-004 8%,
A-005 18%, A-006 10%, A-007 18%). Mastery is per unique question by *latest*
result (repeats don't distort it); a correct answer still on the needs-practice
list — e.g. a lucky guess — is only "pending" until the store's streak logic
confirms it. It reports accuracy and coverage separately, an equally weighted
overall readiness, a conservative score that counts unanswered questions as not
yet mastered, and per-row recoverable exam weight with study priorities
(subsection topic labels live in `data/subsections.js`). **Freshness:** a correct
answer counts fully for `MASTERY_FRESH_DAYS` (14), then at `STALE_CREDIT` (0.5),
then at `COLD_CREDIT` (0.25) past 3× the window — never 0, since a 4-option
question still returns 0.25 by guessing. Staleness is an *overlay* on `mastered`,
never a sibling status: it must not touch `questionStatus`, `masteryRate`
("Accuracy" in the UI), `score`, `conservative` or `recoverable`, all of which
keep their exact meanings. It feeds only the additive `freshScore` /
`freshReadiness` figures (shown as "today") and the `stale` counters. Timestamps
are defensive: missing/NaN/zero counts as maximally old, a future one (clock skew
from a synced device) as brand new. `computeReadiness(..., now)` takes the clock
as an argument so tests are deterministic. Both take data as
arguments and import no DOM/store — keep them that way.

**UI (`docs/js/app.js`).** A small view-switching controller (no framework):
`appState.view` selects a template, `render()` writes `#view.innerHTML`, and a
single set of delegated `click`/`input`/`change`/`submit` listeners on
`document` drives everything via `data-action` / `data-nav` / `data-setup`
attributes. The active quiz session lives in `appState.session`, not the store.

## Conventions and gotchas

- **Always shuffle answer options.** In the source data the correct answer is
  always the first option (field 3 EN / field 8 FR). `quiz.js` randomizes
  positions; never render options in source order.
- **Escape all dynamic text** with `escapeHTML` before inserting into HTML —
  question/answer/note text contains `<`, `>`, `&`, and quotes.
- **`docs/js/firebase-config.js` is committed** — the deployed GitHub Pages site
  can only load files in the repo (copy from `firebase-config.example.js` for a
  new project). Firebase web config is non-secret by design; security is
  enforced by Auth + Firestore rules (see `SETUP.md`).
- **English-only** today. The source bank is bilingual, so a French toggle is a
  natural extension — the data is already there.

## Source data format (`amat_adv_quest_delim.txt`)

Documented in `readme_adv.txt`. Relevant when touching the build script:

- UTF-8 with **CRLF** line endings; a header row whose first field name has a
  **trailing space**.
- 11 semicolon-delimited fields, **no quoting** (no field contains `;`, so a
  plain split is safe — preserve this invariant if editing the data).
- IDs are `A-SSS-BBB-QQQ`: Advanced, section (001–007), sub-section, question.
