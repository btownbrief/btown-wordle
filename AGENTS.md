# Btown Wordle — agent instructions

Shared brain for any AI agent working in this repo (Codex, Claude Code, etc.).
Read `README.md` first for how the game works — this file only adds the rules an
agent needs so it doesn't break something.

## What this is
Plain static site, **no build step**: `index.html` + `style.css` + ES modules in
`js/`. Deployed by GitHub Pages via `.github/workflows/deploy.yml` on push to the
default branch. Stephen is non-technical — explain consequential changes in plain
language.

## Rules that will trip you up
- **`data/puzzles.json` is machine-maintained — do not hand-edit it.** The weekly
  Action `.github/workflows/topup.yml` (script `scripts/topup-puzzles.mjs`) keeps
  the schedule ≥90 days ahead: it seeds Claude with recent RSS + every previously
  used answer (repeats forbidden), validates the batch hard, and **commits only
  what passes**. If you change the puzzle format, update the validator and the
  generation prompt in the same change, and keep the "commit nothing on validation
  failure" invariant.
- **`js/words/*.js`** are the open-licensed guess-validation word lists split by
  length (dwyl/english-words), unioned at runtime with scheduled answers. Bulk data,
  not logic — don't reformat by hand.
- The leaderboard uses the **shared Btown Games Supabase backend** (`js/leaderboard.js`,
  game slug `btown-wordle`). The public anon key can only call security-definer RPCs;
  never put a service-role key or secret in client JS.

## Runtime AI (leave on Claude)
`topup.yml` calls the Anthropic API via the `ANTHROPIC_API_KEY` repo secret. This is
runtime puzzle generation and is independent of which coding assistant edits the repo —
do not switch it to another provider unless Stephen explicitly asks.

## Before you finish
No test suite. Sanity-check by running the generator locally if you touched it
(`node scripts/topup-puzzles.mjs`), and confirm `data/puzzles.json` still parses and
the site loads. Say what you verified.
