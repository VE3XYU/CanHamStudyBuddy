# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

CanHamStudyBuddy is intended as a study aid for the Canadian amateur radio
qualification exams. **It currently contains only source data — there is no
application code, build system, test suite, linter, or dependency manifest
yet.** Any of these will be introduced from scratch; do not assume a toolchain
exists. There are no build/lint/test commands to run.

The single data asset is the question bank for the **Advanced** qualification
(`amat_adv_quest_delim.txt`). These are the official ISED (Innovation, Science
and Economic Development Canada) exam questions, provided bilingually.

## Question bank format (`amat_adv_quest_delim.txt`)

`readme_adv.txt` documents the schema. The file is semicolon-delimited with one
question per line and a header row. Each record has **11 fields** in this fixed
order:

1. `question_id`
2. English question
3. **Correct** English answer
4–6. Incorrect English answers 1–3
7. French question
8. **Correct** French answer
9–11. Incorrect French answers 1–3

Critical details for anyone writing a parser (these are easy to get wrong):

- **The correct answer is always field 3 (English) and field 8 (French).** The
  data is not pre-shuffled — a quiz UI must randomize option order itself, or
  every answer is trivially the first choice.
- **The file uses CRLF (`\r\n`) line endings and is UTF-8** (French text has
  accented characters). Strip the trailing `\r` and decode as UTF-8.
- **The header's first field is `question_id ` with a trailing space.** Trim
  header field names before matching.
- All 549 data rows have exactly 11 fields — no answer text contains a `;`, so a
  plain split on `;` is safe (no CSV quoting is used). Preserve this invariant if
  you ever edit the data: a stray semicolon in answer text would silently break
  field alignment.

## Question ID taxonomy

IDs follow `A-SSS-BBB-QQQ`:

- `A` = Advanced qualification.
- `SSS` = section (`001`–`007`).
- `BBB` = sub-section within the section.
- `QQQ` = question number within the sub-section.

This hierarchy is the natural grouping for organizing study by topic.
