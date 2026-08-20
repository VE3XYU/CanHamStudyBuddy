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
`stats` (per-question attempts/correct/lastResult, plus `guessed` — whether the
*latest* attempt was flagged "I'm just guessing"; the record is rebuilt on every
write, so one un-guessed correct answer clears it, and `questionStatus` treats a
guessed correct answer as pending, not mastered), `notes`, `flags` (the user
marking an AI explanation as possibly wrong, with an optional free-text reason),
`focus` (questions the user explicitly ticked "Practice this more" after
answering — they rotate more often and auto-clear after `FOCUS_CLEAR_STREAK`
correct answers in a row that weren't flagged as guesses; `recordAnswer`
maintains the streak and a lucky guess resets it; the pre-answer guess tick
deliberately does *not* enroll), and `history`, persisted to localStorage under
`canham_adv_state_v1`. All writes
go through the store, which notifies subscribers. `mergeStates`/`mergeRemote`
reconcile local and cloud copies with **last-write-wins per record** (by
`lastSeenAt` / `updatedAt`); history is unioned by id. **Deletions are
tombstones, never real deletes** — clearing a note/flag/focus mark writes
`{ cleared: true, updatedAt }` and every reader (`isLive`, `noteIds`, `flagIds`,
`focusCount`, and `readiness.js`'s `isFocusMark`, which `quiz.js` also uses)
treats a cleared record as absent. An outright delete cannot survive sync: an
absence carries no timestamp, so `mergeStates` always kept the peer's surviving
copy and any device holding the old record resurrected it everywhere. The
store's `now()` is monotonic for the same reason — two writes in one millisecond
would otherwise tie and resolve arbitrarily. Flags are local-first
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
past the fresh window, oldest weighted heaviest. `buildExam` builds the
dashboard's "Practice exam": one random question from each of the 50
subsections, mirroring the real draw — the results view shows a pass/fail
verdict against the 35/50 (70%) pass mark only for a *completed* 50-question
run, so an early exit can't read as a pass. Smart mode is deliberately
staleness-blind: staleness is spread evenly across subsections, so folding it in
would flatten smart mode's between-subsection weighting and crowd out never-seen
material. `readiness.js` scores exam readiness the way the
Advanced exam is marked: the exam draws one question from each of the 50
subsections (A-SSS-BBB), so each subsection is worth 2% and section weights
follow from their subsection counts (A-001 10%, A-002 24%, A-003 12%, A-004 8%,
A-005 18%, A-006 10%, A-007 18%). Mastery is per unique question by *latest*
result (repeats don't distort it); a correct answer is only "pending", not
mastered, while the attempt was flagged as a guess (one un-guessed correct
answer clears that) or the question sits on the needs-practice list (the
store's streak logic clears that). It reports accuracy and coverage separately, an equally weighted
overall readiness, a conservative score that counts unanswered questions as not
yet mastered, and per-row recoverable exam weight with study priorities
(subsection topic labels live in `data/subsections.js`). **Freshness:** a correct
answer counts fully for `MASTERY_FRESH_DAYS` (21), then at `STALE_CREDIT` (0.8),
then at `COLD_CREDIT` (0.6) past 3× the window — always above the 0.25 a 4-option
question returns by guessing, and never 0 (only a wrong answer scores 0). Staleness is an *overlay* on `mastered`,
never a sibling status: it must not touch `questionStatus`, `masteryRate`
("Accuracy" in the UI), `score`, `conservative` or `recoverable`, all of which
keep their exact meanings. It feeds only the additive `freshScore` /
`freshReadiness` figures (shown as "today") and the `stale` counters. Timestamps
are defensive: missing/NaN/zero counts as maximally old, a future one (clock skew
from a synced device) as brand new, but only within a day's grace, so a device
with a badly-set clock cannot pin a question as permanently fresh. Note that
refreshing a stale answer can only restore `freshReadiness` — it never raises
`readiness`/`conservative`/`recoverable`, and lowers them if the retest is wrong
— so the UI gives the refresh queue the primary button only when `recoverable`
is under 10%. `computeReadiness(..., now)` takes the clock
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

## Working notes

Hard-won, in rough order of how much time they cost:

- **Check before you diagnose.** The most expensive mistakes here came from
  reasoning off conversation context instead of a cheap direct check. The user's
  study data is in `localStorage` under `canham_adv_state_v1` — inspect it (the
  `updatedAt` stamps on `focus`/`notes`/`flags` records in particular) before
  theorising about a data bug; the timestamps usually settle it in seconds.
- **Cloud sync is not broken.** It works, and was fixed by a Firebase console
  config change. At least three duplicate issues have been filed against it by
  different sessions reading stale conversation context. Verify against the app
  and the Firestore console before filing another.
- **The feature branch is long-lived and may carry an open PR.** Before
  `reset --hard` or a force-push, confirm the remote tip is already merged:
  `git merge-base --is-ancestor origin/<branch> origin/main`. If the branch's PR
  has already merged, restart from the new `main` and open a *new* PR rather than
  reusing merged history. Never edit a merged PR's description to describe work it
  does not contain.
- **The PR tooling appends a session link to the body at creation time**, even
  when you carefully leave it out. Read the PR back after creating it and strip
  the footer (see Workflow above).
- **Deletions must be tombstones** (see State). Any new per-question record type
  has to follow the same rule, or clearing it will silently resurrect from
  whichever device missed the clear.
- **Trust the maintainer's account of their own setup.** On both the sync
  question and a bad state count, their model of the system was right and the
  agent's inference was wrong.

### Known rough edges

- `freshEarned` is computed and rolled up but not shown anywhere; it is pinned
  by tests so it cannot drift silently. (`freshConservative` now appears in the
  Progress view's stale note as "the conservative floor today".)
- `resetAll` is an outright delete, so on a synced setup another signed-in
  device can resurrect everything at its next merge (same failure class the
  tombstones fix addressed, at whole-state scale). The reset confirm dialog
  warns about this; a real fix needs a reset watermark that `mergeStates`
  honours. The sign-out wipe in `cloud.js` is *intentionally* this way — the
  cloud copy is supposed to survive there.
- A guess-pending question (correct latest answer, `guessed: true`, no focus
  mark) appears in smart mode and "all", but on no list of its own — if the
  user never re-meets it honestly it sits pending indefinitely. Post-exam idea:
  surface a "guessed, unconfirmed" count or list.

## Source data format (`amat_adv_quest_delim.txt`)

Documented in `readme_adv.txt`. Relevant when touching the build script:

- UTF-8 with **CRLF** line endings; a header row whose first field name has a
  **trailing space**.
- 11 semicolon-delimited fields, **no quoting** (no field contains `;`, so a
  plain split is safe — preserve this invariant if editing the data).
- IDs are `A-SSS-BBB-QQQ`: Advanced, section (001–007), sub-section, question.
