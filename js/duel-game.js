// B-Town Wordle's game-specific duel contract. Transport and write-once
// behavior live in the vendored duel.js; challenge derivation, result shape,
// and the winner rule live here so the UI and tests cannot drift apart.

const MARKS = new Set(['correct', 'present', 'absent']);

export function answerEntries(data) {
  return Object.keys(data?.puzzles || {}).sort().map((date) => ({
    date,
    answer: String(data.puzzles[date].answer || '').toUpperCase(),
    puzzle: data.puzzles[date],
  }));
}

export function duelEntryForPayload(data, payload) {
  const entries = answerEntries(data);
  const index = Number(payload?.index);
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    throw new Error('bad_duel_index');
  }
  return entries[index];
}

export function randomDuelPayload(data, todayDate, todayAnswer, random = Math.random) {
  const entries = answerEntries(data);
  const daily = String(todayAnswer || '').toUpperCase();
  let eligible = entries
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => entry.date < todayDate && entry.answer !== daily);

  // The normal case is an archive word. This fallback only matters during a
  // brand-new game's first day, and still guarantees the daily answer is out.
  if (!eligible.length) {
    eligible = entries
      .map((entry, index) => ({ ...entry, index }))
      .filter((entry) => entry.answer !== daily);
  }
  if (!eligible.length) throw new Error('no_duel_words');

  const pick = Math.min(eligible.length - 1, Math.floor(random() * eligible.length));
  return { index: eligible[pick].index };
}

// Result shape: { solved, guesses, ms }. `guesses` is an array of rows made
// only of Wordle marks, never letters, so a rival's words cannot leak.
export function makeDuelResult({ solved, guesses, ms }) {
  const safeRows = (Array.isArray(guesses) ? guesses : []).map((row) =>
    (Array.isArray(row) ? row : []).map((mark) => (MARKS.has(mark) ? mark : 'absent')));
  return {
    solved: Boolean(solved),
    guesses: safeRows,
    ms: Math.max(0, Math.round(Number(ms) || 0)),
  };
}

// Positive means A wins, negative means B wins, zero is a draw.
export function compareDuelResults(a, b) {
  if (Boolean(a?.solved) !== Boolean(b?.solved)) return a?.solved ? 1 : -1;
  const aGuesses = Array.isArray(a?.guesses) ? a.guesses.length : Infinity;
  const bGuesses = Array.isArray(b?.guesses) ? b.guesses.length : Infinity;
  if (aGuesses !== bGuesses) return aGuesses < bGuesses ? 1 : -1;
  const aMs = Number.isFinite(a?.ms) ? a.ms : Infinity;
  const bMs = Number.isFinite(b?.ms) ? b.ms : Infinity;
  if (aMs !== bMs) return aMs < bMs ? 1 : -1;
  return 0;
}
