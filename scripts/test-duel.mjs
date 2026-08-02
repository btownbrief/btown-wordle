// Duel wiring test: drives the real vendored duel client (js/duel.js →
// js/rooms.js) against the local shim as simulated phones playing the same
// answer-list index. No network and no Supabase required.
//
//   node scripts/test-duel.mjs

import { readFile } from 'node:fs/promises';
import { createRooms } from './rooms-shim.mjs';
import {
  duelEntryForPayload, randomDuelPayload, makeDuelResult, compareDuelResults,
} from '../js/duel-game.js';

const GAME = 'btown-wordle';
const puzzleData = JSON.parse(await readFile(new URL('../data/puzzles.json', import.meta.url), 'utf8'));
const htmlSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const mainSource = await readFile(new URL('../js/main.js', import.meta.url), 'utf8');

/* ----------------------------------------------------- device environment */

const stores = new Map();
let current = 'A';
globalThis.localStorage = {
  getItem: (k) => (stores.get(current).has(k) ? stores.get(current).get(k) : null),
  setItem: (k, v) => stores.get(current).set(k, String(v)),
  removeItem: (k) => stores.get(current).delete(k),
};
function device(d) {
  if (!stores.has(d)) stores.set(d, new Map());
  current = d;
}
device('A');
device('B');
device('C');

let passed = 0;
function t(cond, label) {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok — ${label}`);
}
async function expectCode(promise, code, label) {
  try {
    await promise;
    t(false, `${label} (no error thrown)`);
  } catch (e) {
    t(e && e.code === code, `${label} (got ${e && e.code})`);
  }
}

const { rpcs } = createRooms();
globalThis.BTOWN_ROOMS_URL = 'http://rooms.test';
globalThis.fetch = async (url, options = {}) => {
  const match = String(url).match(/\/rest\/v1\/rpc\/(\w+)$/);
  const send = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  if (!match || options.method !== 'POST' || !rpcs[match[1]]) {
    return send(404, { message: 'not a room rpc' });
  }
  try {
    const body = JSON.parse(options.body || '{}');
    return send(200, rpcs[match[1]](body) ?? {});
  } catch (error) {
    return send(error.rpc ? 400 : 500, { message: error.message });
  }
};
const { Duel, savedSession } = await import('../js/duel.js');

/* ------------------------------------------------------------ the tests */

const TODAY = '2026-07-30';
const todayAnswer = puzzleData.puzzles[TODAY].answer;
const requiredIds = [
  'duelBtn', 'hostBtn', 'joinBtn', 'rejoinBtn', 'onlinePanel', 'opTitle',
  'opName', 'opSeatsWrap', 'opSeats', 'opCodeWrap', 'opCode', 'opError',
  'opGo', 'opCancel', 'lobby', 'lobbyCode', 'lobbyList', 'inviteBtn',
  'lobbyCancel', 'duelBar', 'duelDone', 'duelDoneHead', 'duelDoneRows',
  'duelRematchBtn', 'duelExitBtn',
];
t(requiredIds.every((id) => htmlSource.includes(`id="${id}"`)),
  'fleet smoke-test element IDs are present');
t(mainSource.includes('const DAILY_STATE_ENABLED = !TEST_DATE && !DUEL_MODE;') &&
  mainSource.includes('if (DUEL_MODE || !lbEnabled()) return;') &&
  mainSource.includes('if (DUEL_MODE) {\n    onDuelFinish(won);\n    return;'),
'duel mode gates daily saves, results, stats, and leaderboard submission');
t(mainSource.includes('seats: duelSeats') && mainSource.includes("get('join')") &&
  mainSource.includes('renderLobbyRoster(d)'),
'group seats, live roster, and race-link invite wiring are present');
const payload = randomDuelPayload(puzzleData, TODAY, todayAnswer, () => 0.42);
const phoneAWord = duelEntryForPayload(puzzleData, payload);
const phoneBWord = duelEntryForPayload(puzzleData, JSON.parse(JSON.stringify(payload)));
t(phoneAWord.answer === phoneBWord.answer, 'same payload index derives the same word on both phones');
t(phoneAWord.answer !== todayAnswer && phoneAWord.date < TODAY,
  'duel word is archived and is not today’s answer');

const oneRow = ['absent', 'present', 'correct', 'absent'];
const solvedFast = makeDuelResult({
  solved: true, guesses: [oneRow, oneRow], ms: 41234,
});
const solvedSlow = makeDuelResult({
  solved: true, guesses: [oneRow, oneRow], ms: 48567,
});
const solvedMoreGuesses = makeDuelResult({
  solved: true, guesses: [oneRow, oneRow, oneRow], ms: 1000,
});
const unsolved = makeDuelResult({
  solved: false, guesses: [oneRow], ms: 500,
});
t(compareDuelResults(solvedFast, unsolved) > 0, 'win rule: solved beats unsolved');
t(compareDuelResults(solvedFast, solvedMoreGuesses) > 0, 'win rule: fewer guesses beats faster time');
t(compareDuelResults(solvedFast, solvedSlow) > 0, 'win rule: time breaks equal-guess ties');
t(compareDuelResults(solvedFast, { ...solvedFast }) === 0, 'win rule: exact ties draw');
t(solvedFast.guesses.flat().every((mark) => ['correct', 'present', 'absent'].includes(mark)),
  'result grids contain colored marks, never guess letters');

device('A');
const host = await Duel.create({ game: GAME, name: 'Ada', payload });
t(/^[A-Z2-9]{4}$/.test(host.code) && host.status === 'waiting', 'host opens a duel');
t(savedSession(GAME)?.roomId === host.match.roomId, 'host session saved');

device('B');
const guest = await Duel.join({ game: GAME, code: host.code.toLowerCase(), name: 'Bea' });
t(guest.status === 'playing' && guest.payload.index === payload.index,
  'guest joins with the identical word index');

device('A');
await host.match._fetch();
t(host.status === 'playing' && host.others()[0].name === 'Bea', 'host sees the duel start');

// Both submit concurrently — the version lock forces one to retry-merge.
device('A');
const pushA = host.submitResult(solvedFast);
device('B');
const pushB = guest.submitResult(solvedSlow);
await Promise.all([pushA, pushB]);
device('A');
await host.match._fetch();
device('B');
await guest.match._fetch();
t(host.isComplete() && guest.isComplete(), 'both results merged despite the race');
t(host.status === 'over' && guest.status === 'over', 'duel marked over');
t(host.others()[0].result.ms === solvedSlow.ms && guest.others()[0].result.ms === solvedFast.ms,
  'each phone sees the rival result');
t(compareDuelResults(host.myResult(), host.others()[0].result) > 0, 'Ada wins on the time tiebreak');

// Resubmitting is a write-once no-op.
await host.submitResult(makeDuelResult({ solved: true, guesses: [oneRow], ms: 1 }));
device('B');
await guest.match._fetch();
t(guest.others()[0].result.ms === solvedFast.ms, 'results are write-once');

// Rematch deals a fresh answer index to both.
const rematchPayload = randomDuelPayload(puzzleData, TODAY, todayAnswer, () => 0.73);
device('B');
await guest.rematch(rematchPayload);
device('A');
await host.match._fetch();
t(host.payload.index === rematchPayload.index && Object.keys(host.results).length === 0
  && host.status === 'playing', 'rematch: fresh word index, empty results');

// Racing rematches converge on exactly one deterministic index.
const dealOne = randomDuelPayload(puzzleData, TODAY, todayAnswer, () => 0.18);
const dealTwo = randomDuelPayload(puzzleData, TODAY, todayAnswer, () => 0.88);
device('A');
const dealA = host.rematch(dealOne);
device('B');
const dealB = guest.rematch(dealTwo);
await Promise.all([dealA, dealB]);
device('A'); await host.match._fetch();
device('B'); await guest.match._fetch();
t(host.payload.index === guest.payload.index, 'racing rematches converge on one word');
t(duelEntryForPayload(puzzleData, host.payload).answer ===
  duelEntryForPayload(puzzleData, guest.payload).answer,
'converged rematch payload derives identical challenge content');

// Resume after a refresh.
device('A');
const resumed = await Duel.resume({ game: GAME });
t(resumed.match.roomId === host.match.roomId && resumed.payload.index === host.payload.index,
  'resume reattaches to the duel');

// Leaving bars the stranded rival's submit and tells them why.
await resumed.leave();
t(savedSession(GAME) === null, 'leave clears the session');
device('B');
await guest.match._fetch();
t(guest.others()[0].left === true, 'guest sees the host left');
await expectCode(guest.submitResult(unsolved), 'opponent_left',
  'submit into an abandoned duel says why');

/* --------------------------------------------- 3-racer heat (group duel) */

device('A');
const h3 = await Duel.create({ game: GAME, name: 'Ada', payload, seats: 3 });
t(h3.status === 'waiting' && h3.match.maxSeats === 3,
  '3-seat heat opens, maxSeats tracked');
device('B');
const g3b = await Duel.join({ game: GAME, code: h3.code, name: 'Bea' });
t(g3b.status === 'waiting' && g3b.match.maxSeats === 3,
  'second racer seated, heat still waiting');
device('C');
const g3c = await Duel.join({ game: GAME, code: h3.code, name: 'Cal' });
t(g3c.status === 'playing' && g3c.payload.index === payload.index,
  'third racer fills the heat with the shared word index');

device('A');
await h3.match._fetch();
t(h3.others().map((racer) => racer.name).join(',') === 'Bea,Cal',
  'host sees both rivals in the full field');
await h3.submitResult(solvedMoreGuesses);
device('B');
await g3b.match._fetch();
t(!g3b.isComplete(), 'one of three in — heat stays open');
await g3b.submitResult(solvedSlow);
device('C');
await g3c.match._fetch();
t(!g3c.isComplete(), 'two of three in — heat still stays open');
await g3c.submitResult(unsolved);

device('A'); await h3.match._fetch();
device('B'); await g3b.match._fetch();
device('C'); await g3c.match._fetch();
t(h3.isComplete() && g3b.isComplete() && g3c.isComplete() && h3.status === 'over',
  'all three staggered results merge and close the heat');
const standings = [
  { name: 'Ada', result: h3.myResult() },
  ...h3.others().map((racer) => ({ name: racer.name, result: racer.result })),
].sort((a, b) => -compareDuelResults(a.result, b.result));
t(standings.map((racer) => racer.name).join(',') === 'Bea,Ada,Cal',
  'standings rank solved first, then fewer guesses, then unsolved');
t(compareDuelResults(standings[0].result, standings[1].result) > 0 &&
  compareDuelResults(standings[1].result, standings[2].result) > 0,
'three-racer standings have one correct winner and ordered field');
t(g3b.others().every((racer) => racer.result),
  'winning phone sees every rival grid result');

console.log(`\nALL DUEL TESTS PASSED (${passed} checks)`);
process.exit(0);
