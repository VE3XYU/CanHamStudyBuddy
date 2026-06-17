# CanHam Study Buddy — Advanced

A mobile-friendly web app for studying the **Canadian Advanced amateur radio
qualification** exam, built around the official ISED question bank (549
questions). Inspired by Hamtest.ca, which doesn't offer an Advanced study mode.

## Features

- **Study by section** or across the whole bank.
- **Randomized** question order *and* answer-option order on every quiz.
- **Three modes:** all questions, only-unseen, or review-my-mistakes.
- **Per-question notes** you add after answering — they reappear automatically
  the next time that question comes up, and collect in a Notes tab.
- **Scores & progress:** coverage and accuracy overall and per section, plus a
  history of recent sessions.
- **Local-first:** works fully offline on one device with zero setup.
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
- `docs/` — the app (deploy this folder):
  - `js/store.js` — local-first state (stats, notes, history) in localStorage.
  - `js/cloud.js` — optional Firebase sync layered on top.
  - `js/quiz.js`, `js/stats.js` — pure quiz-building and aggregation logic.
  - `js/app.js` — views, routing, and event wiring.
- `scripts/selftest.mjs` — `node scripts/selftest.mjs` to test the core logic.

The app is English-only for now; the source data also contains French, so a
language toggle could be added later.
