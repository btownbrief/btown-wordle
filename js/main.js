// B-Town Wordle — daily Burlington, VT word puzzle for Btown Games.
// Plain ES modules, no build step. Answers are 4–7 letters; the board
// adapts to the day's answer length. Puzzle schedule lives in
// data/puzzles.json, topped up by a weekly GitHub Action.

import {
  lbEnabled, getName, submitScore, renamePlayer, fetchTop, monthLabel, playerId,
} from './leaderboard.js';
import {
  Duel,
  getName as duelGetName,
  savedSession as duelSavedSession,
  clearSession as duelClearSession,
} from './duel.js';
import {
  answerEntries, duelEntryForPayload, randomDuelPayload,
  makeDuelResult, compareDuelResults,
} from './duel-game.js';
import {
  soundEnabled, setSoundEnabled, playTap, playFlip, playError, playWin,
} from './audio.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ date (America/New_York)
const NY = 'America/New_York';
function nyDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d); // YYYY-MM-DD
}
function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
}
// ms until the next NY midnight (walk forward until the NY date flips)
function msToNextNyMidnight() {
  const today = nyDateStr();
  let lo = Date.now(), hi = Date.now() + 26 * 3600000;
  while (hi - lo > 500) {
    const mid = (lo + hi) / 2;
    if (nyDateStr(new Date(mid)) === today) lo = mid; else hi = mid;
  }
  return hi - Date.now();
}

// ------------------------------------------------------------ load puzzle
// ?testdate=YYYY-MM-DD plays another day's puzzle (testing only; skips
// stats/streak/leaderboard writes so real progress is never touched)
const QUERY = new URLSearchParams(location.search);
const TEST_DATE = QUERY.get('testdate');
const DUEL_MODE = QUERY.get('duel') === '1';
const DUEL_INDEX = Number(QUERY.get('word'));
const TODAY = TEST_DATE || nyDateStr();
const DAILY_STATE_ENABLED = !TEST_DATE && !DUEL_MODE;
let data, puzzle, dailyAnswer, dayNum, ANSWER, COLS, VALID;

function scheduledPuzzle(dataset, date) {
  const num = daysBetween(dataset.epoch, date) + 1;
  if (dataset.puzzles[date]) return dataset.puzzles[date];
  // Schedule ran dry (shouldn't happen — the top-up Action keeps 90+ days
  // ahead). Deterministically replay an old answer so the game never breaks.
  const keys = Object.keys(dataset.puzzles).sort();
  return dataset.puzzles[keys[((num % keys.length) + keys.length) % keys.length]];
}

async function boot() {
  data = await (await fetch(`data/puzzles.json?v=${TODAY}`)).json();
  dayNum = daysBetween(data.epoch, TODAY) + 1;
  dailyAnswer = scheduledPuzzle(data, nyDateStr()).answer.toUpperCase();
  puzzle = scheduledPuzzle(data, TODAY);
  if (DUEL_MODE) {
    try {
      puzzle = duelEntryForPayload(data, { index: DUEL_INDEX }).puzzle;
    } catch {
      // A hand-edited URL is corrected by bootDuel after it resumes the room.
      // Until then, show a harmless archive word rather than today's answer.
      puzzle = answerEntries(data).find((entry) => entry.answer !== dailyAnswer)?.puzzle || puzzle;
    }
  }
  ANSWER = puzzle.answer.toUpperCase();
  COLS = ANSWER.length;
  document.documentElement.style.setProperty('--cols', COLS);
  $('dayBar').textContent = DUEL_MODE
    ? `⚔️ FRIEND DUEL · ${COLS} letters · Burlington, VT`
    : `#${dayNum} · ${COLS} letters · Burlington, VT`;

  const mod = await import(`./words/w${COLS}.js`);
  VALID = mod.default;
  for (const day of Object.values(data.puzzles)) {
    const a = day.answer.toUpperCase();
    if (a.length === COLS) VALID.add(a);
  }
  buildBoard();
  buildKeyboard();
  restore();
  updateHeaderStreak();
  updateSoundButton();
  maybeShowKbHint();
}

// First-time cue: nudge players to use the on-screen keyboard. Shows until
// they type their first letter ever, then stays gone for good.
const TYPED_KEY = 'bw-typed';
function maybeShowKbHint() {
  if (!DAILY_STATE_ENABLED) return;
  if (status === 'playing' && guesses.length === 0 && !localStorage.getItem(TYPED_KEY)) {
    $('kbHint').classList.remove('hidden');
  }
}
function dismissKbHint() {
  if (!DAILY_STATE_ENABLED) {
    $('kbHint').classList.add('hidden');
    return;
  }
  if (localStorage.getItem(TYPED_KEY)) return;
  localStorage.setItem(TYPED_KEY, '1');
  $('kbHint').classList.add('hidden');
}

// ------------------------------------------------------------ board + keyboard
const ROWS = 6;
let guesses = [];         // submitted guesses
let current = '';         // letters typed on the active row
let status = 'playing';   // playing | won | lost
let revealing = false;

function buildBoard() {
  const board = $('board');
  for (let r = 0; r < ROWS; r++) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.row = r;
    for (let c = 0; c < COLS; c++) {
      const t = document.createElement('div');
      t.className = 'tile';
      row.appendChild(t);
    }
    board.appendChild(row);
  }
  // example row in the help modal (always 5 wide, independent of today)
  const ex = $('exRow');
  'MAPLE'.split('').forEach((ch, i) => {
    const t = document.createElement('div');
    t.className = 'tile ' + (i === 0 ? 'correct' : i === 2 ? 'present' : 'absent');
    t.textContent = ch;
    ex.appendChild(t);
  });
}

const KB_ROWS = ['QWERTYUIOP', 'ASDFGHJKL', '⏎ZXCVBNM⌫'];
const keyEls = {};
function buildKeyboard() {
  const kb = $('keyboard');
  for (const rowStr of KB_ROWS) {
    const row = document.createElement('div');
    row.className = 'kb-row';
    for (const ch of rowStr) {
      const b = document.createElement('button');
      if (ch === '⏎') { b.className = 'key wide'; b.textContent = 'ENTER'; b.dataset.k = 'Enter'; }
      else if (ch === '⌫') { b.className = 'key wide'; b.textContent = '⌫'; b.dataset.k = 'Backspace'; }
      else { b.className = 'key'; b.textContent = ch; b.dataset.k = ch; keyEls[ch] = b; }
      b.addEventListener('click', () => handleKey(b.dataset.k));
      row.appendChild(b);
    }
    kb.appendChild(row);
  }
}

function rowEl(r) { return $('board').children[r]; }
function paintCurrent() {
  const row = rowEl(guesses.length);
  for (let c = 0; c < COLS; c++) {
    const t = row.children[c];
    t.textContent = current[c] || '';
    t.className = 'tile' + (current[c] ? ' filled' : '');
  }
}

// ------------------------------------------------------------ input
document.addEventListener('keydown', (e) => {
  // never steal keys while the leaderboard name input (or any input) is focused
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Enter' || e.key === 'Backspace' || /^[a-zA-Z]$/.test(e.key)) {
    handleKey(e.key.length === 1 ? e.key.toUpperCase() : e.key);
  }
});

function handleKey(k) {
  if (status !== 'playing' || revealing) return;
  const ae = document.activeElement;
  if (ae && ae.tagName === 'INPUT') return;
  if (k === 'Enter') return submitGuess();
  if (k === 'Backspace' && current) {
    playTap();
    current = current.slice(0, -1);
    paintCurrent();
    return;
  }
  if (/^[A-Z]$/.test(k) && current.length < COLS) {
    playTap();
    current += k;
    paintCurrent();
    dismissKbHint();
  }
}

function updateSoundButton() {
  const on = soundEnabled();
  const button = $('soundBtn');
  button.textContent = on ? '🔊' : '🔇';
  button.setAttribute('aria-pressed', String(on));
  button.setAttribute('aria-label', `Turn sound ${on ? 'off' : 'on'}`);
}

$('soundBtn').addEventListener('click', () => {
  setSoundEnabled(!soundEnabled());
  updateSoundButton();
  if (soundEnabled()) playTap();
});

let toastTimer;
function toast(msg, ms = 1400) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

let invalidTimer;
function shakeRow() {
  const row = rowEl(guesses.length);
  row.classList.remove('shake');
  void row.offsetWidth;
  row.classList.add('shake', 'invalid');
  clearTimeout(invalidTimer);
  invalidTimer = setTimeout(() => row.classList.remove('shake', 'invalid'), 650);
}

// ------------------------------------------------------------ guessing
function evaluate(guess) {
  // classic Wordle duplicate handling: greens first, then yellows by remaining count
  const res = Array(COLS).fill('absent');
  const remaining = {};
  for (let i = 0; i < COLS; i++) {
    if (guess[i] === ANSWER[i]) res[i] = 'correct';
    else remaining[ANSWER[i]] = (remaining[ANSWER[i]] || 0) + 1;
  }
  for (let i = 0; i < COLS; i++) {
    if (res[i] === 'correct') continue;
    if (remaining[guess[i]] > 0) { res[i] = 'present'; remaining[guess[i]]--; }
  }
  return res;
}

const WIN_WORDS = ['Jeezum Crow!', 'Wicked good!', 'Champ-level!', 'Nice one, bud', 'Cutting it close', 'Phew!'];

function submitGuess() {
  if (current.length < COLS) {
    const missing = COLS - current.length;
    toast(`Add ${missing} more letter${missing === 1 ? '' : 's'} before ENTER`);
    playError();
    shakeRow();
    return;
  }
  if (!VALID.has(current)) {
    toast(`“${current}” isn’t in the word list — try another word`);
    playError();
    shakeRow();
    return;
  }
  const guess = current;
  guesses.push(guess);
  current = '';
  revealRow(guesses.length - 1, guess, evaluate(guess), true, () => {
    if (guess === ANSWER) {
      status = 'won';
      const result = finish(true) || {};
      const streakBeat = result.streakSaved ? ` · 🔥 ${result.streak} streak saved!` : '';
      toast(`${WIN_WORDS[guesses.length - 1]}${streakBeat}`, 2400);
      bounceRow(guesses.length - 1);
      celebrateWin(guesses.length - 1);
      playWin(guesses.length - 1);
    } else if (guesses.length >= ROWS) {
      status = 'lost';
      toast(ANSWER, 3000);
      finish(false);
    } else {
      save();
    }
  });
}

const COLORS = { correct: '#4f9d5d', present: '#d4a72c', absent: '#33453a' };
const RANK = { absent: 0, present: 1, correct: 2 };
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function upgradeKey(letter, result, animate) {
  const key = keyEls[letter];
  if (!key) return;
  const currentState = ['correct', 'present', 'absent'].find((state) => key.classList.contains(state));
  if (currentState && RANK[result] <= RANK[currentState]) return;
  key.className = `key ${result}`;
  if (animate) {
    key.classList.remove('upgrade');
    void key.offsetWidth;
    key.classList.add('upgrade');
    setTimeout(() => key.classList.remove('upgrade'), 260);
  }
}

function revealRow(r, guess, res, animate, done) {
  const row = rowEl(r);
  const useMotion = animate && !reducedMotion.matches;
  revealing = useMotion;
  for (let c = 0; c < COLS; c++) {
    const t = row.children[c];
    t.textContent = guess[c];
    if (useMotion) {
      setTimeout(() => {
        t.style.setProperty('--reveal', COLORS[res[c]]);
        t.classList.add('flip');
        setTimeout(() => {
          playFlip(res[c]);
          upgradeKey(guess[c], res[c], true);
        }, 250);
        setTimeout(() => { t.className = `tile ${res[c]}`; t.style.removeProperty('--reveal'); }, 500);
      }, c * 260);
    } else {
      t.className = `tile ${res[c]}`;
      upgradeKey(guess[c], res[c], false);
    }
  }
  const finishUp = () => {
    revealing = false;
    if (done) done();
  };
  if (useMotion) setTimeout(finishUp, COLS * 260 + 300);
  else finishUp();
}

function bounceRow(r) {
  if (reducedMotion.matches) return;
  const row = rowEl(r);
  for (let c = 0; c < COLS; c++) {
    setTimeout(() => row.children[c].classList.add('bounce'), c * 90);
  }
}

let celebrationTimer;
let leafTimer;
function celebrateWin(rowIndex) {
  const row = rowEl(rowIndex);
  const brilliance = ROWS - rowIndex;
  row.style.setProperty('--win-strength', String(0.35 + brilliance * 0.1));
  row.classList.add('win-flash');
  clearTimeout(celebrationTimer);
  celebrationTimer = setTimeout(() => row.classList.remove('win-flash'), 1400);
  if (reducedMotion.matches) return;

  const layer = $('celebration');
  clearTimeout(leafTimer);
  layer.replaceChildren();
  const count = Math.min(36, 8 + brilliance * 4);
  const center = row.getBoundingClientRect();
  layer.style.setProperty('--burst-x', `${center.left + center.width / 2}px`);
  layer.style.setProperty('--burst-y', `${center.top + center.height / 2}px`);
  for (let i = 0; i < count; i++) {
    const leaf = document.createElement('span');
    leaf.className = 'leaf';
    leaf.textContent = i % 3 === 0 ? '🍂' : '🍁';
    leaf.style.setProperty('--angle', `${(360 / count) * i + Math.random() * 14 - 7}deg`);
    leaf.style.setProperty('--distance', `${70 + Math.random() * (55 + brilliance * 8)}px`);
    leaf.style.setProperty('--spin', `${Math.random() * 540 - 270}deg`);
    leaf.style.setProperty('--delay', `${Math.random() * 90}ms`);
    layer.appendChild(leaf);
  }
  leafTimer = setTimeout(() => layer.replaceChildren(), 1400);
}

// ------------------------------------------------------------ persistence
const STATE_KEY = 'bw-state';
function save() {
  if (!DAILY_STATE_ENABLED) return;
  localStorage.setItem(STATE_KEY, JSON.stringify({ date: TODAY, guesses, status }));
}
function restore() {
  if (DUEL_MODE) return;
  let st;
  try { st = JSON.parse(localStorage.getItem(STATE_KEY)); } catch { /* corrupt */ }
  if (!st || st.date !== TODAY) {
    if (!localStorage.getItem('bw-seen-help')) {
      localStorage.setItem('bw-seen-help', '1');
      $('helpOverlay').classList.remove('hidden');
    }
    return;
  }
  guesses = st.guesses || [];
  status = st.status || 'playing';
  guesses.forEach((g, i) => revealRow(i, g, evaluate(g), false));
  if (status !== 'playing') {
    // finished day: hard-block replay, show results + countdown
    showResults(false);
  }
}

// ------------------------------------------------------------ stats + streak
const STATS_KEY = 'bw-stats';
function loadStats() {
  try {
    return JSON.parse(localStorage.getItem(STATS_KEY)) ||
      { played: 0, wins: 0, cur: 0, max: 0, dist: [0, 0, 0, 0, 0, 0], last: '' };
  } catch {
    return { played: 0, wins: 0, cur: 0, max: 0, dist: [0, 0, 0, 0, 0, 0], last: '' };
  }
}

function updateHeaderStreak(pulse = false) {
  const badge = $('streakBadge');
  if (!DAILY_STATE_ENABLED) {
    badge.classList.add('hidden');
    return;
  }
  const streak = loadStats().cur || 0;
  badge.textContent = `🔥 ${streak}`;
  badge.setAttribute('aria-label', `Current streak: ${streak}`);
  badge.classList.toggle('hidden', streak < 1);
  if (pulse && streak > 0 && !reducedMotion.matches) {
    badge.classList.remove('saved');
    void badge.offsetWidth;
    badge.classList.add('saved');
    setTimeout(() => badge.classList.remove('saved'), 700);
  }
}

function finish(won) {
  if (DUEL_MODE) {
    onDuelFinish(won);
    return;
  }
  save();
  const s = loadStats();
  let streakSaved = false;
  if (DAILY_STATE_ENABLED && s.last !== TODAY) { // guard double-count
    s.played++;
    if (won) {
      s.wins++;
      s.dist[guesses.length - 1]++;
      // streak: consecutive-day wins
      s.cur = (s.lastWin && daysBetween(s.lastWin, TODAY) === 1) ? s.cur + 1 : 1;
      s.max = Math.max(s.max, s.cur);
      s.lastWin = TODAY;
      streakSaved = true;
    } else {
      s.cur = 0;
    }
    s.last = TODAY;
    localStorage.setItem(STATS_KEY, JSON.stringify(s));
  }
  updateHeaderStreak(streakSaved);
  setTimeout(() => showResults(true), won ? 1600 : 900);
  return { streak: s.cur || 0, streakSaved };
}

// ------------------------------------------------------------ results modal
function renderStats() {
  const s = loadStats();
  $('stPlayed').textContent = s.played;
  $('stWinPct').textContent = s.played ? Math.round((s.wins / s.played) * 100) : 0;
  $('stCur').textContent = s.cur;
  $('stMax').textContent = s.max;
  const dist = $('dist');
  dist.innerHTML = '';
  const maxD = Math.max(1, ...s.dist);
  s.dist.forEach((n, i) => {
    const row = document.createElement('div');
    row.className = 'dist-row';
    const hl = status === 'won' && guesses.length === i + 1;
    row.innerHTML = `<span class="n">${i + 1}</span><span class="bar${hl ? ' hl' : ''}"></span>`;
    const bar = row.querySelector('.bar');
    bar.style.width = `${Math.max(8, (n / maxD) * 100)}%`;
    bar.textContent = n;
    dist.appendChild(row);
  });
}

let countdownTimer;
function showResults(fresh) {
  if (DUEL_MODE) return;
  renderStats();
  $('resultCard').classList.remove('hidden');
  $('resultHead').textContent = status === 'won'
    ? `Solved in ${guesses.length}/${ROWS}` : `Tough one — it was ${ANSWER}`;
  $('whyAnswer').textContent = ANSWER;
  $('whyText').textContent = puzzle.whyLocal;
  const link = $('whyLink');
  if (puzzle.sourceUrl) { link.href = puzzle.sourceUrl; link.classList.remove('hidden'); }
  $('finishedRow').classList.remove('hidden');
  clearInterval(countdownTimer);
  const tick = () => {
    const ms = msToNextNyMidnight();
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60;
    $('countdown').textContent =
      `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
  $('statsOverlay').classList.remove('hidden');
  updateLeaderboard(fresh);
}

// ------------------------------------------------------------ share
$('shareBtn').addEventListener('click', async () => {
  if (DUEL_MODE) return;
  const rows = guesses.map((g) =>
    evaluate(g).map((r) => (r === 'correct' ? '🟩' : r === 'present' ? '🟨' : '⬛')).join('')).join('\n');
  const score = status === 'won' ? guesses.length : 'X';
  const text = `B-Town Wordle #${dayNum} ${score}/${ROWS}\n\n${rows}\n\nhttps://btownbrief.github.io/btown-wordle/`;
  try {
    if (navigator.share && /Mobi|Android|iPhone|iPad/.test(navigator.userAgent)) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
  } catch { /* user cancelled */ }
});

// ------------------------------------------------------------ modals
$('helpBtn').addEventListener('click', () => $('helpOverlay').classList.remove('hidden'));
$('statsBtn').addEventListener('click', () => {
  if (DUEL_MODE) return;
  renderStats();
  if (status !== 'playing') showResults(false);
  else $('statsOverlay').classList.remove('hidden');
});
document.querySelectorAll('.overlay').forEach((ov) => {
  ov.addEventListener('click', (e) => {
    if (e.target === ov && !ov.hasAttribute('data-static')) ov.classList.add('hidden');
  });
  ov.querySelector('[data-close]')?.addEventListener('click', () => ov.classList.add('hidden'));
});

// ------------------------------------------------------------ leaderboard (monthly longest streaks)
const lbBox = $('lb'), lbList = $('lbList'), lbStatus = $('lbStatus');
const lbForm = $('lbForm'), lbNameInput = $('lbNameInput');
const lbThisBtn = $('lbThisBtn'), lbLastBtn = $('lbLastBtn'), lbRenameBtn = $('lbRenameBtn');
let lbMonthOffset = 0;

if (lbEnabled() && !DUEL_MODE) {
  lbBox.classList.remove('hidden');
  lbThisBtn.textContent = monthLabel(0);
  lbLastBtn.textContent = monthLabel(-1);
}

const SUBMIT_KEY = 'bw-lb-submitted';
async function updateLeaderboard(fresh) {
  if (DUEL_MODE || !lbEnabled()) return;
  // a win submits the current streak, once per day; a loss submits nothing
  const streak = loadStats().cur;
  const shouldSubmit = DAILY_STATE_ENABLED && fresh && status === 'won' && streak > 0 &&
    localStorage.getItem(SUBMIT_KEY) !== TODAY;
  if (shouldSubmit && !getName()) {
    lbForm.classList.remove('hidden');
    lbRenameBtn.classList.add('hidden');
    lbStatus.textContent = 'Pick a name to join the monthly leaderboard!';
    lbList.innerHTML = '';
    lbForm.dataset.pendingScore = String(streak);
    return;
  }
  if (shouldSubmit) {
    try {
      await submitScore(streak);
      localStorage.setItem(SUBMIT_KEY, TODAY);
    } catch { /* offline — still show the board */ }
  }
  renderBoard();
}

async function renderBoard() {
  if (DUEL_MODE) return;
  lbForm.classList.add('hidden');
  lbRenameBtn.classList.remove('hidden');
  lbStatus.textContent = 'Loading…';
  try {
    const rows = await fetchTop(lbMonthOffset);
    const me = playerId();
    lbList.innerHTML = '';
    rows.slice(0, 10).forEach((r, i) => {
      const li = document.createElement('li');
      if (r.player_id === me) li.className = 'me';
      const medal = ['🥇', '🥈', '🥉'][i];
      li.innerHTML = `<span class="rank">${medal || i + 1}</span><span class="nm"></span><span class="sc"></span>`;
      li.querySelector('.nm').textContent = r.name;
      li.querySelector('.sc').textContent = `${r.score}🔥`;
      lbList.appendChild(li);
    });
    const myRank = rows.findIndex((r) => r.player_id === me);
    lbStatus.textContent = rows.length === 0
      ? 'No streaks yet this month — be the first!'
      : myRank >= 0 ? `You're #${myRank + 1} of ${rows.length} this month` : '';
  } catch {
    lbStatus.textContent = 'Leaderboard unavailable (offline?)';
  }
}

$('lbSaveBtn').addEventListener('click', async () => {
  if (DUEL_MODE) return;
  const name = lbNameInput.value.trim();
  if (!name) { lbNameInput.focus(); return; }
  const pending = Number(lbForm.dataset.pendingScore || 0);
  lbForm.dataset.pendingScore = '';
  try {
    await renamePlayer(name);
    if (pending > 0) {
      await submitScore(pending);
      localStorage.setItem(SUBMIT_KEY, TODAY);
    }
  } catch { /* offline */ }
  renderBoard();
});
lbNameInput.addEventListener('keydown', (e) => {
  e.stopPropagation(); // keep game input handler away while typing a name
  if (e.key === 'Enter') $('lbSaveBtn').click();
});
lbRenameBtn.addEventListener('click', () => {
  if (DUEL_MODE) return;
  lbNameInput.value = getName();
  lbForm.classList.remove('hidden');
  lbRenameBtn.classList.add('hidden');
  lbNameInput.focus();
});
lbThisBtn.addEventListener('click', () => {
  if (DUEL_MODE) return;
  lbMonthOffset = 0;
  lbThisBtn.classList.add('sel');
  lbLastBtn.classList.remove('sel');
  renderBoard();
});
lbLastBtn.addEventListener('click', () => {
  if (DUEL_MODE) return;
  lbMonthOffset = -1;
  lbLastBtn.classList.add('sel');
  lbThisBtn.classList.remove('sel');
  renderBoard();
});

// ------------------------------------------------------------ duel mode
// ⚔️ Challenge a friend: both phones derive the same off-calendar answer
// from one answer-list index. The vendored duel client owns transport and
// write-once submission; this section owns B-Town Wordle's UI.

const DUEL_GAME = 'btown-wordle';
let duel = null;
let duelSubmitted = false;
let duelSubmitting = false;
let duelStartedAt = 0;
let duelPendingResult = null;
let duelPrimaryAction = 'rematch';

const duelActive = () => DUEL_MODE && duel !== null;
const duelUrl = (payload) => `?duel=1&word=${payload.index}`;
const freshDuelPayload = () =>
  randomDuelPayload(data, nyDateStr(), dailyAnswer);

const FRIENDLY_DUEL_ERRORS = {
  not_found: 'That duel has already disappeared.',
  not_seated: 'This phone no longer has a seat in that duel.',
  room_full: 'That duel is already full.',
  room_started: 'That duel already started without you.',
  opponent_left: 'A rival left the duel.',
  not_ready: "Friend duels aren't switched on yet — check back soon!",
  offline: "Can't reach the duel board — are you online?",
};
function duelFriendly(err) {
  if (err && err.code === 'wrong_game') {
    return `That code belongs to ${String(err.detail || 'another game').replace(/-/g, ' ')}.`;
  }
  return (err && FRIENDLY_DUEL_ERRORS[err.code]) || 'The duel board hiccupped — please try again.';
}

let duelPanelIntent = 'host';
let duelSeats = 2;

document.querySelectorAll('#opSeats .seat-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    duelSeats = +btn.dataset.seats;
    document.querySelectorAll('#opSeats .seat-btn').forEach((b) => {
      const selected = b === btn;
      b.classList.toggle('selected', selected);
      b.setAttribute('aria-pressed', String(selected));
    });
  });
});

$('duelBtn').addEventListener('click', () => {
  refreshDuelRejoin();
  $('duelOverlay').classList.remove('hidden');
});
$('hostBtn').addEventListener('click', () => openDuelPanel('host'));
$('joinBtn').addEventListener('click', () => openDuelPanel('join'));
$('opCancel').addEventListener('click', () => {
  $('onlinePanel').classList.add('hidden');
  $('duelOverlay').classList.remove('hidden');
});
$('opGo').addEventListener('click', duelGo);
$('lobbyCancel').addEventListener('click', cancelDuelLobby);
$('rejoinBtn').addEventListener('click', rejoinDuel);
$('duelRematchBtn').addEventListener('click', duelPrimary);
$('duelExitBtn').addEventListener('click', exitDuel);
$('duelGiveUpBtn').addEventListener('click', giveUpDuel);
$('opCode').addEventListener('input', () => {
  $('opCode').value = $('opCode').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
['opName', 'opCode'].forEach((id) => $(id).addEventListener('keydown', (e) => {
  if (e.key === 'Enter') duelGo();
}));

function openDuelPanel(intent) {
  duelPanelIntent = intent;
  $('duelOverlay').classList.add('hidden');
  $('opTitle').textContent = intent === 'host' ? 'Start a duel' : 'Join a duel';
  $('opGo').textContent = intent === 'host' ? 'Get a code' : 'Play!';
  $('opCodeWrap').classList.toggle('hidden', intent === 'host');
  $('opSeatsWrap').classList.toggle('hidden', intent !== 'host');
  $('opError').classList.add('hidden');
  $('opName').value = $('opName').value || duelGetName();
  $('onlinePanel').classList.remove('hidden');
  (intent === 'join' && $('opName').value ? $('opCode') : $('opName')).focus();
}

async function duelGo() {
  if ($('opGo').disabled) return;
  const name = $('opName').value.trim();
  if (!name) {
    $('opError').textContent = 'Every wordsmith needs a name.';
    $('opError').classList.remove('hidden');
    $('opName').focus();
    return;
  }
  $('opGo').disabled = true;
  $('opError').classList.add('hidden');
  try {
    if (duelPanelIntent === 'host') {
      const d = await Duel.create({
        game: DUEL_GAME, name, payload: freshDuelPayload(), seats: duelSeats,
      });
      $('onlinePanel').classList.add('hidden');
      openDuelLobby(d);
    } else {
      const code = $('opCode').value.trim();
      if (code.length !== 4) {
        $('opError').textContent = 'The duel code is 4 characters.';
        $('opError').classList.remove('hidden');
        $('opCode').focus();
        return;
      }
      const d = await Duel.join({ game: DUEL_GAME, code, name });
      location.href = duelUrl(d.payload);
    }
  } catch (err) {
    $('opError').textContent = duelFriendly(err);
    $('opError').classList.remove('hidden');
  } finally {
    $('opGo').disabled = false;
  }
}

function openDuelLobby(d) {
  if ($('lobby')._duel && $('lobby')._duel !== d) $('lobby')._duel.stop();
  $('lobby')._duel = d;
  $('lobbyCode').textContent = d.code;
  $('lobbyStatus').innerHTML =
    'They tap ⚔️ → <b>Join a duel</b> and enter it. When the last chair fills, every puzzle opens.';
  renderLobbyRoster(d);
  $('lobby').classList.remove('hidden');
  const refresh = () => {
    renderLobbyRoster(d);
    if (d.status !== 'waiting') location.href = duelUrl(d.payload);
  };
  d.match.start({
    onStatus: refresh,
    onPresence: () => {
      renderLobbyRoster(d);
      if (d.status !== 'waiting') location.href = duelUrl(d.payload);
    },
    onError: (err) => {
      $('lobbyStatus').textContent = `${duelFriendly(err)} You can call it off below.`;
    },
  });
}

function renderLobbyRoster(d) {
  const box = $('lobbyList');
  box.textContent = '';
  const seated = d.match.seats || [];
  const total = d.match.maxSeats || seated.length || 2;
  for (let i = 0; i < total; i++) {
    const span = document.createElement('span');
    const who = seated[i];
    span.textContent = (i ? ' · ' : '') + (who ? who.name : 'open chair');
    if (!who) span.className = 'chair-empty';
    box.appendChild(span);
  }
}

function cancelDuelLobby() {
  const d = $('lobby')._duel;
  if (d) void d.leave();
  $('lobby')._duel = null;
  $('lobby').classList.add('hidden');
}

function refreshDuelRejoin() {
  const saved = duelSavedSession(DUEL_GAME);
  const btn = $('rejoinBtn');
  btn.classList.toggle('hidden', !saved || duelActive());
  if (saved) btn.textContent = `↩ Rejoin duel ${saved.code}`;
}

async function rejoinDuel() {
  $('rejoinBtn').disabled = true;
  try {
    const d = await Duel.resume({ game: DUEL_GAME });
    if (d.status === 'waiting') {
      $('duelOverlay').classList.add('hidden');
      openDuelLobby(d);
    } else {
      location.href = duelUrl(d.payload);
    }
  } catch (err) {
    if (err && ['not_found', 'not_seated', 'room_started'].includes(err.code)) {
      duelClearSession(DUEL_GAME);
      refreshDuelRejoin();
    }
    toast(duelFriendly(err), 2600);
  } finally {
    $('rejoinBtn').disabled = false;
  }
}

function renderDuelBar() {
  if (!duel) return;
  const rivals = duel.others();
  let note = rivals.length
    ? `vs ${rivals.map((r) => r.name || 'Rival').join(' + ')}`
    : 'waiting for your rivals';
  if (duelSubmitting) {
    note += ' — sending your result…';
  } else if (rivals.some((r) => r.left) && !duel.isComplete()) {
    const quitters = rivals.filter((r) => r.left).map((r) => r.name || 'Rival');
    note += ` — ${quitters.join(' + ')} left`;
  } else if (duelSubmitted && !duel.isComplete()) {
    const waiting = rivals.filter((r) => !r.result && !r.left).map((r) => r.name || 'Rival');
    if (waiting.length) note += ` — waiting on ${waiting.join(' + ')}…`;
  } else if (!duelSubmitted) {
    const finished = rivals.filter((r) => r.result).map((r) => r.name || 'Rival');
    if (finished.length) note += ` — ${finished.join(' + ')} finished`;
  }
  $('duelBarText').textContent = `⚔️ DUEL ${duel.code} · ${note}`;
  $('duelGiveUpBtn').textContent = duelSubmitted ? 'Back to daily' : 'Give up';
  $('duelBar').classList.remove('hidden');
}

function fmtDuelTime(ms) {
  const total = Math.max(0, Number(ms) || 0);
  const minutes = Math.floor(total / 60000);
  const seconds = ((total % 60000) / 1000).toFixed(1).padStart(4, '0');
  return `${minutes}:${seconds}`;
}

function setDuelPrimary(action, label, visible = true) {
  duelPrimaryAction = action;
  $('duelRematchBtn').textContent = label;
  $('duelRematchBtn').classList.toggle('hidden', !visible);
  $('duelRematchBtn').disabled = false;
}

function showDuelNotice(head, detail, { retry = false } = {}) {
  $('duelDoneHead').textContent = head;
  $('duelDoneRows').innerHTML = '';
  if (detail) {
    const p = document.createElement('p');
    p.className = 'fine';
    p.textContent = detail;
    $('duelDoneRows').appendChild(p);
  }
  $('duelDoneAnswer').textContent = `The word: ${ANSWER}`;
  $('duelDoneAnswer').classList.add('hidden');
  setDuelPrimary(retry ? 'retry' : 'rematch', retry ? 'Try sending again' : '', retry);
  $('duelDone').classList.remove('hidden');
}

function appendDuelResult(label, result, { winner = false, dnf = false } = {}) {
  const box = document.createElement('div');
  box.className = `duel-result${winner ? ' win' : ''}`;
  const meta = document.createElement('div');
  meta.className = 'duel-player-meta';
  const name = document.createElement('span');
  name.textContent = label;
  const score = document.createElement('span');
  const count = Array.isArray(result?.guesses) ? result.guesses.length : 0;
  score.textContent = dnf
    ? 'DNF'
    : result?.solved
      ? `${count}/${ROWS} · ${fmtDuelTime(result.ms)}`
      : `unsolved · ${fmtDuelTime(result?.ms)}`;
  meta.append(name, score);
  box.appendChild(meta);

  const grid = document.createElement('div');
  grid.className = 'duel-grid';
  for (const marks of (result?.guesses || [])) {
    const row = document.createElement('div');
    row.className = 'duel-grid-row';
    for (const mark of marks) {
      const cell = document.createElement('span');
      cell.className = `duel-cell ${mark}`;
      row.appendChild(cell);
    }
    grid.appendChild(row);
  }
  box.appendChild(grid);
  $('duelDoneRows').appendChild(box);
}

function showDuelDone() {
  duel.stop();
  const field = [
    { seat: duel.seat, label: 'You', me: true, left: false, result: duel.myResult() },
    ...duel.others().map((rival) => ({
      seat: rival.seat,
      label: rival.name || 'Rival',
      me: false,
      left: rival.left,
      result: rival.result,
    })),
  ].map((racer) => ({ ...racer, dnf: !racer.result || racer.left }))
    .sort((a, b) => {
      if (a.dnf !== b.dnf) return a.dnf - b.dnf;
      if (!a.dnf) return -compareDuelResults(a.result, b.result);
      return a.seat - b.seat;
    });
  const best = field.find((racer) => !racer.dnf);
  const winners = best
    ? field.filter((racer) => !racer.dnf && compareDuelResults(racer.result, best.result) === 0)
    : [];
  $('duelDoneHead').textContent = !winners.length
    ? 'NO FINISHERS — NO WINNER'
    : winners.length > 1
      ? 'DRAW — PERFECTLY MATCHED'
      : winners[0].me
        ? 'YOU WIN THE WORD DUEL! 🏆'
        : `${winners[0].label.toUpperCase()} WINS`;
  $('duelDoneAnswer').textContent = `The word: ${ANSWER}`;
  $('duelDoneAnswer').classList.remove('hidden');
  $('duelDoneRows').innerHTML = '';
  for (const racer of field) {
    appendDuelResult(racer.me ? 'You' : racer.label, racer.result, {
      winner: winners.includes(racer),
      dnf: racer.dnf,
    });
  }
  const canRematch = !field.some((racer) => racer.left);
  setDuelPrimary('rematch', '↻ Rematch — new word', canRematch);
  $('duelDone').classList.remove('hidden');
}

async function duelSubmit(result) {
  if (!duel || duelSubmitting || duelSubmitted) return;
  duelPendingResult = result;
  duelSubmitting = true;
  renderDuelBar();
  try {
    await duel.submitResult(result);
    duelSubmitted = true;
    duelPendingResult = null;
  } catch (err) {
    duelSubmitting = false;
    renderDuelBar();
    if (err && err.code === 'opponent_left') {
      await duel.match._fetch().catch(() => {});
      showDuelDone();
      return;
    }
    showDuelNotice('RESULT NOT SENT', duelFriendly(err), { retry: true });
    return;
  }
  duelSubmitting = false;
  renderDuelBar();
  if (duel.isComplete()) {
    showDuelDone();
  } else {
    const waiting = duel.others()
      .filter((rival) => !rival.result && !rival.left)
      .map((rival) => rival.name || 'Rival');
    showDuelNotice(
      result.solved ? 'SOLVED — RESULT LOCKED IN' : 'RESULT LOCKED IN',
      `Waiting for ${waiting.join(' + ')}. You can return to the daily and rejoin later.`,
    );
  }
}

// Timing is self-reported by each phone. That is intentional for a casual
// friend challenge; preventing devtools cheating is outside the fleet model.
function onDuelFinish(solved) {
  if (!duelActive() || duelSubmitted || duelSubmitting) return;
  const result = makeDuelResult({
    solved,
    guesses: guesses.map((guess) => evaluate(guess)),
    ms: Date.now() - (duelStartedAt || Date.now()),
  });
  void duelSubmit(result);
}

function giveUpDuel() {
  if (!duel) return;
  if (duelSubmitted) {
    exitDuel();
    return;
  }
  status = 'lost';
  current = '';
  onDuelFinish(false);
}

function showDuelBootError(err) {
  const terminal = err && ['not_found', 'not_seated', 'room_started'].includes(err.code);
  if (terminal) duelClearSession(DUEL_GAME);
  $('duelDoneHead').textContent = terminal ? 'THAT DUEL IS GONE' : 'CAN’T REACH THE DUEL';
  $('duelDoneAnswer').classList.add('hidden');
  $('duelDoneRows').innerHTML = '';
  const p = document.createElement('p');
  p.className = 'fine';
  p.textContent = duelFriendly(err);
  $('duelDoneRows').appendChild(p);
  setDuelPrimary('reload', 'Try reconnecting', !terminal);
  $('duelDone').classList.remove('hidden');
}

async function bootDuel() {
  if (!DUEL_MODE) return;
  document.body.classList.add('duel-mode');
  try {
    duel = await Duel.resume({ game: DUEL_GAME });
  } catch (err) {
    showDuelBootError(err);
    return;
  }

  let entry;
  try {
    entry = duelEntryForPayload(data, duel.payload);
    if (entry.answer === dailyAnswer) throw new Error('daily_word');
  } catch {
    duelClearSession(DUEL_GAME);
    showDuelBootError({ code: 'not_found' });
    return;
  }
  if (duel.payload.index !== DUEL_INDEX) {
    location.replace(duelUrl(duel.payload));
    return;
  }

  duelSubmitted = duel.myResult() !== null;
  if (!duelSubmitted) duelStartedAt = Date.now();
  renderDuelBar();
  duel.start({
    onChange: () => {
      if (duel.payload?.index !== DUEL_INDEX) {
        location.replace(duelUrl(duel.payload));
        return;
      }
      renderDuelBar();
      if (duel.isComplete()) showDuelDone();
      else if (duel.others().some((rival) => rival.left)) showDuelDone();
    },
    onError: (err) => {
      if (err && ['not_found', 'not_seated'].includes(err.code)) {
        duel.stop();
        showDuelBootError(err);
      } else {
        toast(duelFriendly(err), 2600);
      }
    },
  });
  if (duel.isComplete()) showDuelDone();
  else if (duel.others().some((rival) => rival.left)) showDuelDone();
  else if (duelSubmitted) {
    const waiting = duel.others()
      .filter((rival) => !rival.result && !rival.left)
      .map((rival) => rival.name || 'Rival');
    showDuelNotice(
      'RESULT LOCKED IN',
      `Waiting for ${waiting.join(' + ')}. You can return to the daily and rejoin later.`,
    );
  }
}

async function duelRematch() {
  if (!duel) return;
  $('duelRematchBtn').disabled = true;
  try {
    await duel.rematch(freshDuelPayload());
    location.href = duelUrl(duel.payload);
  } catch (err) {
    toast(duelFriendly(err), 2600);
    $('duelRematchBtn').disabled = false;
  }
}

function duelPrimary() {
  if (duelPrimaryAction === 'retry' && duelPendingResult) {
    $('duelDone').classList.add('hidden');
    void duelSubmit(duelPendingResult);
  } else if (duelPrimaryAction === 'reload') {
    location.reload();
  } else {
    void duelRematch();
  }
}

function exitDuel() {
  if (duel) duel.stop();
  const rivalLeft = duel ? duel.others().some((rival) => rival.left) : false;
  if (duel && (duel.isComplete() || rivalLeft)) duelClearSession(DUEL_GAME);
  location.replace(location.pathname);
}

/* ------------------------------------------------- race-link invites */

$('inviteBtn').addEventListener('click', async () => {
  const d = $('lobby')._duel;
  if (!d) return;
  const url = `${location.origin}${location.pathname}?join=${d.code}`;
  const text = `Race me in B-Town Wordle! Tap to join: ${url}`;
  try {
    if (navigator.share && /Mobi|Android|iPhone|iPad/.test(navigator.userAgent)) {
      await navigator.share({ text });
    } else {
      await navigator.clipboard.writeText(url);
      $('inviteBtn').textContent = '✓ Link copied';
      setTimeout(() => { $('inviteBtn').textContent = '📲 Send an invite'; }, 1800);
    }
  } catch { /* share sheet closed */ }
});

(() => {
  const code = new URLSearchParams(location.search).get('join');
  if (!code || !/^[A-Za-z0-9]{4}$/.test(code)) return;
  history.replaceState(null, '', location.pathname);
  openDuelPanel('join');
  $('opCode').value = code.toUpperCase();
})();

async function startApp() {
  await boot();
  await bootDuel();
  refreshDuelRejoin();
}

void startApp();
