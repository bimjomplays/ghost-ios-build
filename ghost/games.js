// Ghost games: the registry + match logic every Ghost-to-Ghost game uses (UI glue lives in ui.js, section "Ghost games").
// Games are SHARED STATE between two connected Ghosts: a match is one network.js "item" (kind "game"), versioned and
// re-sent until the friend confirms it, so a move made days later still arrives. No server, no DOM in this file.
//
// ---- The contract a game implements (GhostGames.register) ----
//   id           short lowercase id, letters then letters/digits ("chess", "pool8"); also shown in logs
//   name         "Chess"
//   icon         an <svg> string (24x24 viewBox) for menus and chat cards
//   minPlayers   2 (only two-player games for now)
//   newGame({ players: [a, b], seed }) -> state
//                players are Ghost ids; index 0 = whoever started the match. seed: a random 32-bit number for games that
//                need randomness - every random choice must come from the state/seed, never Math.random, so both
//                Ghosts compute the same thing. v: when check() rebuilds a match a friend started, the `v` its state
//                carries (s.v) - a game that changed its state format makes that older format, so a match started
//                on an older Ghost still replays the same; undefined = the newest format.
//   apply(state, move, by) -> newState          by = the mover's player index (0|1)
//                must be deterministic and pure (don't mutate state), and throw an Error for an illegal move or a move
//                out of turn. Moves are small JSON objects.
//   status(state) -> { turn: 0|1|null, winner: 0|1|null, draw: bool, text: "White to move" }
//                turn is null once the game is over.
//   view(container, { state, me, players, names, onMove(move), onClose(), theme, embedded }) -> { update(state), destroy() }
//                draws the game inside container (a div the size of the game area) for player index `me` (null =
//                spectator). onMove(move) asks to play a move; the framework checks the turn, applies it and calls
//                update(newState) - the view shouldn't change its own state. Resign/close/rematch buttons are the
//                framework's, not the game's.
//                embedded: true inside Ghost's game view, whose header already shows the title, whose turn it is
//                and Close - don't repeat them.
//   preview(state, me) -> string   (optional) one line for the chat card ("12. Nf3", "You sank the 8")
//   playerIds    (optional) true = the game names players by Ghost id instead of index: apply() gets by = the id,
//                status() may return ids for turn/winner (the framework maps them back to 0|1), view() gets me = the id.
//   sizeLimit    (optional) the most JSON characters a whole match may have: play() refuses a move whose match would
//                be bigger ("this match got too big to send"). A match goes to the friend as ONE ntfy message, which
//                fits ~2500 characters of match (network.js putItem checks the sealed size and throws "item too big").
//
// ---- A match (the item's data) ----
//   { g: gameId, p: [idA, idB], s: state, n: moveCount, m: [last few moves {m, by, v}], r: result|null,
//     re: the rematch's item key|null, rf: the match this one is a rematch of|null, seed }
//   r = { winner: 0|1|null, draw: bool, reason: "resign" } for endings the game itself doesn't know about (resign).
//   Item version v = n + 1 (+1 for a resign); every move carries the version it was made on, so a stale move is refused.
"use strict";
const GhostGames = (() => {
  const defs = new Map();
  const KEEP_MOVES = 6;
  function register(def) {
    for (const k of ["id", "name", "icon", "newGame", "apply", "status", "view"]) if (!def || def[k] == null) throw new Error("game is missing " + k);
    if (!/^[a-z][a-z0-9]{1,11}$/.test(def.id)) throw new Error("bad game id");
    defs.set(def.id, def);
    return def;
  }
  const get = (id) => defs.get(id) || null;
  const list = () => Array.from(defs.values());
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const randomSeed = () => { try { return crypto.getRandomValues(new Uint32Array(1))[0]; } catch (e) { return Math.floor(Math.random() * 4294967295); } };

  // a new match between players [me, them] (me moves first unless the game says otherwise)
  function newMatch(gameId, players, opts) {
    const def = get(gameId);
    if (!def) throw new Error("unknown game " + gameId);
    const seed = (opts && Number.isInteger(opts.seed)) ? opts.seed : randomSeed();
    return { g: gameId, p: players.slice(0, 2), s: def.newGame({ players: players.slice(0, 2), seed, v: opts && opts.v }), n: 0, m: [], r: null, re: null, rf: (opts && opts.rematchOf) || null, seed };
  }
  // what the match looks like now (the game's status, overridden by a resign)
  function status(data) {
    const def = get(data && data.g);
    if (!def) return { turn: null, winner: null, draw: false, text: "Needs a newer Ghost" };
    let st;
    try { st = def.status(data.s); } catch (e) { st = { turn: null, winner: null, draw: false, text: "Can't read this game" }; }
    if (def.playerIds) { const ix = (x) => (x == null ? null : typeof x === "number" ? x : data.p.indexOf(x)); st = Object.assign({}, st, { turn: ix(st.turn), winner: ix(st.winner) }); }
    if (data.r) return { turn: null, winner: data.r.winner == null ? null : data.r.winner, draw: !!data.r.draw, text: data.r.reason === "resign" ? "Resigned" : st.text, reason: data.r.reason };
    return st;
  }
  const over = (data) => { const s = status(data); return s.turn == null; };
  // play a move on version v (the item's current version) -> the next match data. Throws on anything illegal, and on a
  // move that makes the match bigger than the game's sizeLimit (not when replaying a friend's move: replay = true, and
  // not for a resign, so a match at the limit can still end - network.js still checks the real size).
  function play(data, move, by, v, replay) {
    if (!data || !get(data.g)) throw new Error("unknown game");
    if (by !== 0 && by !== 1) throw new Error("not a player");
    if (over(data)) throw new Error("the game is over");
    const next = clone(data);
    if (move && move.resign === true) {
      next.r = { winner: 1 - by, draw: false, reason: "resign" };
    } else {
      if (status(data).turn !== by) throw new Error("not your turn");
      const def = get(data.g);
      next.s = def.apply(clone(data.s), clone(move), def.playerIds ? data.p[by] : by);
      next.n = (data.n || 0) + 1;
    }
    next.m = (data.m || []).concat([{ m: clone(move), by, v }]).slice(-KEEP_MOVES);
    const lim = get(data.g).sizeLimit;
    if (!replay && lim && !(move && move.resign === true) && JSON.stringify(next).length > lim) throw new Error("this match got too big to send");
    return next;
  }
  // an incoming version of a match we also hold: check that replaying its newest move on our copy gives the same state
  // (both Ghosts run the same deterministic rules). Returns { ok, replayed } - ok false = the copies disagreed; the
  // higher version is kept anyway (network.js already chose it), the caller just logs it.
  function verify(local, localV, incoming, incomingV) {
    if (!local || !incoming || incomingV !== localV + 1) return { ok: true, replayed: false };
    // no move, only the match's links changed (re: a rematch was started)
    if ((incoming.n || 0) === (local.n || 0) && JSON.stringify(incoming.s) === JSON.stringify(local.s) && JSON.stringify(incoming.r) === JSON.stringify(local.r)) return { ok: true, replayed: false };
    const last = (incoming.m || [])[incoming.m.length - 1];
    if (!last || last.v !== localV) return { ok: false, replayed: false, stale: true };
    try {
      const mine = play(local, last.m, last.by, localV, true);
      return { ok: JSON.stringify(mine.s) === JSON.stringify(incoming.s) && JSON.stringify(mine.r) === JSON.stringify(incoming.r), replayed: true };
    } catch (e) { return { ok: false, replayed: true, error: e.message }; }
  }
  // an incoming copy of a match, before it's stored: only accept what the rules produce. Replays the moves it carries
  // (made on versions >= ours) on our copy - or, for a match we've never seen, on a fresh match from its game,
  // players and seed - and needs the same state, result and move count. So a friend's Ghost can't send a forged
  // position or "you lost". Links (re/rf) may change without a move. Unknown games (a newer Ghost) pass unchecked.
  function check(local, localV, inc, incV) {
    const bad = (why) => ({ ok: false, why });
    if (!inc || typeof inc !== "object" || !Array.isArray(inc.p) || inc.p.length !== 2 || !inc.p.every((x) => typeof x === "string")) return bad("shape");
    for (const k of ["re", "rf"]) if (inc[k] != null && typeof inc[k] !== "string") return bad("links");
    const def = get(inc.g);
    if (!def) return { ok: true, unknown: true };
    if (!Array.isArray(inc.m) || !Number.isInteger(inc.n || 0)) return bad("shape");
    let cur, fromV;
    if (local) {
      if (local.g !== inc.g || JSON.stringify(local.p) !== JSON.stringify(inc.p) || local.seed !== inc.seed) return bad("not the same match");
      cur = local; fromV = localV;
    } else {
      if (!Number.isInteger(inc.seed)) return bad("seed");
      try { cur = newMatch(inc.g, inc.p, { seed: inc.seed, rematchOf: inc.rf || null, v: inc.s && inc.s.v }); } catch (e) { return bad("new: " + e.message); }
      fromV = 1;
    }
    let lastV = fromV - 1;
    for (const e of inc.m) {
      if (!e || !Number.isInteger(e.v) || e.v < fromV) continue; // (moves we already have)
      if (e.v <= lastV || e.v >= incV) return bad("move versions");
      try { cur = play(cur, e.m, e.by, e.v, true); } catch (err) { return bad("illegal: " + err.message); }
      lastV = e.v;
    }
    if (JSON.stringify(cur.s) !== JSON.stringify(inc.s) || JSON.stringify(cur.r || null) !== JSON.stringify(inc.r || null) || (cur.n || 0) !== (inc.n || 0)) return bad("state doesn't follow from the moves");
    return { ok: true };
  }
  const preview = (data, me) => { const def = get(data && data.g); try { return def && def.preview ? def.preview(data.s, me) : ""; } catch (e) { return ""; } };
  return { register, get, list, newMatch, status, over, play, verify, check, preview, KEEP_MOVES };
})();
if (typeof module !== "undefined" && module.exports) module.exports = GhostGames;
if (typeof window !== "undefined") window.GhostGames = GhostGames; // game modules loaded on their own check window.GhostGames
