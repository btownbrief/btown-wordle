# B-Town Wordle

The daily word puzzle where every answer is local to Burlington, Vermont —
a [Btown Games](https://btownbrief.github.io/btown-wordle/) production from
the [BTown Brief](https://www.btownbrief.com).

**Play: https://btownbrief.github.io/btown-wordle/**

- Faithful Wordle mechanics, but answers are **4–7 letters** and the board
  adapts to the day's answer length.
- One puzzle per day (America/New_York). After finishing, a **WHY IT'S LOCAL**
  card explains the answer's Burlington/Vermont significance.
- Streaks, stats, emoji-grid sharing, and a shared monthly
  **longest-streak leaderboard** (Supabase, shared Btown Games backend).

## Zero-maintenance schedule

`data/puzzles.json` maps dates → `{answer, whyLocal, sourceUrl?}`. A weekly
GitHub Action (`.github/workflows/topup.yml`) keeps the schedule at least
90 days ahead: it seeds Claude with recent BTown Brief RSS content and all
previously used answers (repeats forbidden), validates the batch hard, and
commits only what passes. Deploys are automatic via GitHub Pages
(`deploy.yml`).

Guess validation uses the open-licensed
[dwyl/english-words](https://github.com/dwyl/english-words) list, split by
length in `js/words/`, unioned at runtime with every scheduled answer.

Plain static site — no build step.
