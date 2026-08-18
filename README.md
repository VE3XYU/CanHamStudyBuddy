# CanHam Study Buddy — Advanced

A mobile-friendly web app for studying the **Canadian Advanced amateur radio
qualification** exam, built around the official ISED question bank (549
questions). Inspired by Hamtest.ca, which doesn't offer an Advanced study mode.

## Features

- **Study by section** or across the whole bank.
- **Randomized** question order *and* answer-option order on every quiz.
- **Four modes:** all questions, only-unseen, review-my-mistakes, or needs-practice.
- **"I have no idea" tick** on any question — check it *before* answering to flag
  a guess, so a lucky correct answer doesn't count. Marked questions come up more
  often (a dedicated *Needs practice* mode plus weighted rotation), and a mark
  drops off only after three correct-and-not-guessed answers in a row.
- **Per-question explainers** shown after you answer — a short note on how the
  calculation is done or why the tricky distractors are wrong (AI-generated, so
  flagged as such alongside your own notes). If one looks wrong, **flag it** and
  optionally say why; flagged explanations collect in the Notes tab, and (when
  you're signed in for sync) are reported to the author for review.
- **Per-question notes** you add after answering — they reappear automatically
  the next time that question comes up, and collect in a Notes tab.
- **Exam-weighted readiness score:** the real exam draws one question from
  each of 50 subsections, so every subsection is worth 2% (sections: A-001 10%,
  A-002 24%, A-003 12%, A-004 8%, A-005 18%, A-006 10%, A-007 18%). Mastery is
  judged once per question by your latest answer (re-drilling a question doesn't
  inflate the score, and a lucky guess doesn't count until confirmed), with
  accuracy and coverage shown separately, a conservative score that treats
  unanswered questions as not yet mastered, and a sortable section/subsection
  table showing where extra study gains the most marks — plus a history of
  recent sessions.
- **Local-first:** no account or server needed — your notes, scores, and
  progress live in your browser, with zero setup.
- **Optional cross-device sync** (Firebase) so your notes/scores/progress
  follow you between phone and computer.

## Quick start

It's a static site — serve `docs/` and open it (ES modules need HTTP, not
`file://`):

```bash
python3 -m http.server 8765 --directory docs
# open http://localhost:8765
```

To put it on your phone, deploy free to **GitHub Pages** (`main` branch,
`/docs` folder). Full instructions — including optional sync setup — are in
[SETUP.md](SETUP.md).

## How it's organized

- `amat_adv_quest_delim.txt` — source question bank (semicolon-delimited,
  bilingual). The canonical data; see `readme_adv.txt` for its format.
- `scripts/build_questions.py` — generates `docs/js/data/questions.js` from the
  source bank. Rerun it after editing the `.txt`.
- `explanations/section-*.json` — hand-authored, AI-generated per-question
  explainers (one file per exam section). `scripts/build_explanations.py`
  merges them into `docs/js/data/explanations.js`. Rerun it after editing them.
- `docs/` — the app (deploy this folder):
  - `js/store.js` — local-first state (stats, notes, history) in localStorage.
  - `js/cloud.js` — optional Firebase sync layered on top.
  - `js/quiz.js`, `js/readiness.js` — pure quiz-building and exam-weighted
    readiness-scoring logic.
  - `js/app.js` — views, routing, and event wiring.
- `scripts/selftest.mjs` — `node scripts/selftest.mjs` to test the core logic.

The app is English-only for now; the source data also contains French, so a
language toggle could be added later.
