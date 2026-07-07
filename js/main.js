// B-Town Wordle — daily Burlington, VT word puzzle for Btown Games.
// Plain ES modules, no build step. Answers are 4–7 letters; the board
// adapts to the day's answer length. Puzzle schedule lives in
// data/puzzles.json, topped up by a weekly GitHub Action.

import {
  lbEnabled, getName, submitScore, renamePlayer, fetchTop, monthLabel, playerId,
} from './leaderboard.js';

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
const TEST_DATE = new URLSearchParams(location.search).get('testdate');
const TODAY = TEST_DATE || nyDateStr();
let data, puzzle, dayNum, ANSWER, COLS, VALID;

async function boot() {
  data = await (await fetch(`data/puzzles.json?v=${TODAY}`)).json();
  dayNum = daysBetween(data.epoch, TODAY) + 1;
  puzzle = data.puzzles[TODAY];
  if (!puzzle) {
    // Schedule ran dry (shouldn't happen — the top-up Action keeps 90+ days
    // ahead). Deterministically replay an old answer so the game never breaks.
    const keys = Object.keys(data.puzzles).sort();
    puzzle = data.puzzles[keys[((dayNum % keys.length) + keys.length) % keys.length]];
  }
  ANSWER = puzzle.answer.toUpperCase();
  COLS = ANSWER.length;
  document.documentElement.style.setProperty('--cols', COLS);
  $('dayBar').textContent = `#${dayNum} · ${COLS} letters · Burlington, VT`;

  const mod = await import(`./words/w${COLS}.js`);
  VALID = mod.default;
  for (const day of Object.values(data.puzzles)) {
    const a = day.answer.toUpperCase();
    if (a.length === COLS) VALID.add(a);
  }
  buildBoard();
  buildKeyboard();
  restore();
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
  if (k === 'Backspace') { current = current.slice(0, -1); paintCurrent(); return; }
  if (/^[A-Z]$/.test(k) && current.length < COLS) { current += k; paintCurrent(); }
}

let toastTimer;
function toast(msg, ms = 1400) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function shakeRow() {
  const row = rowEl(guesses.length);
  row.classList.add('shake');
  setTimeout(() => row.classList.remove('shake'), 500);
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
  if (current.length < COLS) { toast('Not enough letters'); shakeRow(); return; }
  if (!VALID.has(current)) { toast('Not in word list'); shakeRow(); return; }
  const guess = current;
  guesses.push(guess);
  current = '';
  revealRow(guesses.length - 1, guess, evaluate(guess), true, () => {
    if (guess === ANSWER) {
      status = 'won';
      toast(WIN_WORDS[guesses.length - 1], 2200);
      bounceRow(guesses.length - 1);
      finish(true);
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

function revealRow(r, guess, res, animate, done) {
  const row = rowEl(r);
  revealing = animate;
  for (let c = 0; c < COLS; c++) {
    const t = row.children[c];
    t.textContent = guess[c];
    if (animate) {
      setTimeout(() => {
        t.style.setProperty('--reveal', COLORS[res[c]]);
        t.classList.add('flip');
        setTimeout(() => { t.className = `tile ${res[c]}`; t.style.removeProperty('--reveal'); }, 500);
      }, c * 260);
    } else {
      t.className = `tile ${res[c]}`;
    }
  }
  const finishUp = () => {
    for (let c = 0; c < COLS; c++) {
      const k = keyEls[guess[c]];
      if (!k) continue;
      const cur = ['correct', 'present', 'absent'].find((s) => k.classList.contains(s));
      if (!cur || RANK[res[c]] > RANK[cur]) k.className = `key ${res[c]}`;
    }
    revealing = false;
    if (done) done();
  };
  if (animate) setTimeout(finishUp, COLS * 260 + 300);
  else finishUp();
}

function bounceRow(r) {
  const row = rowEl(r);
  for (let c = 0; c < COLS; c++) {
    setTimeout(() => row.children[c].classList.add('bounce'), c * 90);
  }
}

// ------------------------------------------------------------ persistence
const STATE_KEY = 'bw-state';
function save() {
  if (TEST_DATE) return;
  localStorage.setItem(STATE_KEY, JSON.stringify({ date: TODAY, guesses, status }));
}
function restore() {
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

function finish(won) {
  save();
  const s = loadStats();
  if (!TEST_DATE && s.last !== TODAY) { // guard double-count
    s.played++;
    if (won) {
      s.wins++;
      s.dist[guesses.length - 1]++;
      // streak: consecutive-day wins
      s.cur = (s.lastWin && daysBetween(s.lastWin, TODAY) === 1) ? s.cur + 1 : 1;
      s.max = Math.max(s.max, s.cur);
      s.lastWin = TODAY;
    } else {
      s.cur = 0;
    }
    s.last = TODAY;
    localStorage.setItem(STATS_KEY, JSON.stringify(s));
  }
  setTimeout(() => showResults(true), won ? 1600 : 900);
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
  renderStats();
  if (status !== 'playing') showResults(false);
  else $('statsOverlay').classList.remove('hidden');
});
document.querySelectorAll('.overlay').forEach((ov) => {
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.add('hidden'); });
  ov.querySelector('[data-close]')?.addEventListener('click', () => ov.classList.add('hidden'));
});

// ------------------------------------------------------------ leaderboard (monthly longest streaks)
const lbBox = $('lb'), lbList = $('lbList'), lbStatus = $('lbStatus');
const lbForm = $('lbForm'), lbNameInput = $('lbNameInput');
const lbThisBtn = $('lbThisBtn'), lbLastBtn = $('lbLastBtn'), lbRenameBtn = $('lbRenameBtn');
let lbMonthOffset = 0;

if (lbEnabled()) {
  lbBox.classList.remove('hidden');
  lbThisBtn.textContent = monthLabel(0);
  lbLastBtn.textContent = monthLabel(-1);
}

const SUBMIT_KEY = 'bw-lb-submitted';
async function updateLeaderboard(fresh) {
  if (!lbEnabled()) return;
  // a win submits the current streak, once per day; a loss submits nothing
  const streak = loadStats().cur;
  const shouldSubmit = !TEST_DATE && fresh && status === 'won' && streak > 0 &&
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
  lbNameInput.value = getName();
  lbForm.classList.remove('hidden');
  lbRenameBtn.classList.add('hidden');
  lbNameInput.focus();
});
lbThisBtn.addEventListener('click', () => {
  lbMonthOffset = 0;
  lbThisBtn.classList.add('sel');
  lbLastBtn.classList.remove('sel');
  renderBoard();
});
lbLastBtn.addEventListener('click', () => {
  lbMonthOffset = -1;
  lbLastBtn.classList.add('sel');
  lbThisBtn.classList.remove('sel');
  renderBoard();
});

boot();
