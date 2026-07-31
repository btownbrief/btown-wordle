// BTOWN DUELS — vendored async head-to-head client, identical in every
// Btown game repo that offers a "challenge a friend" mode. CANONICAL copy:
// maple-scramble/js/duel.js. Built on js/rooms.js (canonical in
// four-in-a-rowboat) and the same shared Supabase rooms backend — a duel
// is just a room with no turns: the state carries a shared challenge
// payload (a seed, a date, a question set) plus one result per seat, and
// the duel is over when every seated player has submitted theirs.
//
// This file knows NOTHING about any particular game. What a payload or a
// result looks like — and who "won" — is entirely the game's business.

import {
  OnlineMatch, RoomsError, savedSession, clearSession, getName, setName, playerId,
} from './rooms.js';

export { RoomsError, savedSession, clearSession, getName, setName, playerId };

export class Duel {
  constructor(match) {
    this.match = match;
  }

  get code() { return this.match.code; }
  get seat() { return this.match.seat; }
  get status() { return this.match.status; }
  get payload() { return this.match.state?.payload; }
  get results() { return this.match.state?.results || {}; }

  static async create({ game, name, payload, seats = 2 }) {
    const match = await OnlineMatch.create({
      game, name, seats,
      state: { kind: 'duel', payload, results: {} },
    });
    return new Duel(match);
  }

  static async join({ game, code, name }) {
    return new Duel(await OnlineMatch.join({ game, code, name }));
  }

  /** Reattach to the saved duel; throws not_found once the room is gone. */
  static async resume({ game }) {
    return new Duel(await OnlineMatch.resume({ game }));
  }

  /** Poll. onChange(duel) fires on every meaningful update (someone
   *  joined, a result landed, a rematch was dealt, someone left). */
  start({ onChange, onError } = {}) {
    const fire = () => { if (onChange) onChange(this); };
    this.match.start({
      onState: fire,
      onStatus: fire,
      onPresence: (opps) => {
        if (opps.some((o) => o.left)) fire();
      },
      onError: (err) => { if (onError) onError(err, this); },
    });
    return this;
  }

  stop() { this.match.stop(); }
  async leave() { await this.match.leave(); }

  myResult() { return this.results[this.seat] ?? null; }

  /** [{seat, name, left, result|null}] for everyone else at the table. */
  others() {
    return (this.match.seats || [])
      .filter((s) => s.seat !== this.seat)
      .map((s) => ({
        seat: s.seat, name: s.name, left: !!s.left,
        result: this.results[s.seat] ?? null,
      }));
  }

  /** Every seated player has a result in. */
  isComplete() {
    const seated = (this.match.seats || []).length;
    return seated >= 2 && Object.keys(this.results).length >= seated;
  }

  /**
   * Record MY result (a plain JSON object the game defines). Results are
   * write-once: resubmitting is a no-op. Concurrent submissions from both
   * phones are merged by retrying on the version lock — push() refetches
   * the newer state on conflict, so each retry re-merges against truth.
   */
  async submitResult(result) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const s = this.match.state;
      if (s.results && s.results[this.seat] !== undefined) return;
      const results = { ...(s.results || {}), [this.seat]: result };
      const over = Object.keys(results).length >= (this.match.seats || []).length;
      try {
        await this.match.push({ ...s, results }, { over });
        return;
      } catch (err) {
        if (!(err instanceof RoomsError) || err.code !== 'version_conflict') throw err;
        // push() already refetched the latest state — loop and re-merge.
      }
    }
    throw new RoomsError('conflict_storm');
  }

  /**
   * Deal a fresh challenge into a finished duel (either phone may).
   * A version conflict means the other phone dealt first — their payload
   * arrives via onChange; treat it as success.
   */
  async rematch(payload) {
    try {
      await this.match.push({ kind: 'duel', payload, results: {} }, {});
    } catch (err) {
      if (!(err instanceof RoomsError) || err.code !== 'version_conflict') throw err;
    }
  }
}
