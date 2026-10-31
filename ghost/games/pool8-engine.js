// Ghost 8 Ball: deterministic pool physics + 8-ball rules. No DOM here (pool8.js draws it).
//
// Both phones run the same shot through this engine and must land on the exact same table, so the simulation only
// uses +, -, *, / and Math.sqrt on doubles (all correctly rounded by IEEE 754, identical in JavaScriptCore and V8),
// always in the same order: no Math.random, no sin/cos/atan2/hypot, no clocks, a fixed time step and a hard step cap.
// Every number that comes in from a move is rounded to a fixed grid first, and positions are snapped to a 1e-7 grid
// when the balls stop, so the stored state is canonical JSON. The mover's result is still authoritative: the games
// framework compares the state both sides compute.
(function (root) {
  "use strict";

  // ---- table geometry (portrait: the break comes from the bottom) ------------------------------------------
  // playing surface 1 x 2 (a 2:1 table), origin top-left, y down
  const W = 1, H = 2;
  const R = 0.031;                     // ball radius (bigger than a real table, like phone pool games)
  const CORNER_MOUTH = 0.085;          // rail starts this far from a corner (corner pocket mouth ~ 2.1 balls)
  const SIDE_MOUTH = 0.064;            // half the side pocket mouth (~ 2.3 balls)
  const POCKETS = [                    // capture circles, just outside the playing surface
    { x: -0.012, y: -0.012, r: 0.07 }, { x: W + 0.012, y: -0.012, r: 0.07 },
    { x: -0.03, y: H / 2, r: 0.062 }, { x: W + 0.03, y: H / 2, r: 0.062 },
    { x: -0.012, y: H + 0.012, r: 0.07 }, { x: W + 0.012, y: H + 0.012, r: 0.07 },
  ];
  // cushions: straight segments with gaps at the pockets; their end points are the jaws (balls bounce off them too)
  const RAILS = [
    [CORNER_MOUTH, 0, W - CORNER_MOUTH, 0],                                  // top
    [CORNER_MOUTH, H, W - CORNER_MOUTH, H],                                  // bottom
    [0, CORNER_MOUTH, 0, H / 2 - SIDE_MOUTH], [0, H / 2 + SIDE_MOUTH, 0, H - CORNER_MOUTH],       // left
    [W, CORNER_MOUTH, W, H / 2 - SIDE_MOUTH], [W, H / 2 + SIDE_MOUTH, W, H - CORNER_MOUTH],       // right
    // the pocket throats: short angled walls from the jaw into the pocket, so a ball in the mouth drops or rattles
    [CORNER_MOUTH, 0, 0.03, -0.045], [W - CORNER_MOUTH, 0, W - 0.03, -0.045],
    [0, CORNER_MOUTH, -0.045, 0.03], [W, CORNER_MOUTH, W + 0.045, 0.03],
    [CORNER_MOUTH, H, 0.03, H + 0.045], [W - CORNER_MOUTH, H, W - 0.03, H + 0.045],
    [0, H - CORNER_MOUTH, -0.045, H - 0.03], [W, H - CORNER_MOUTH, W + 0.045, H - 0.03],
    [0, H / 2 - SIDE_MOUTH, -0.05, H / 2 - SIDE_MOUTH + 0.018], [0, H / 2 + SIDE_MOUTH, -0.05, H / 2 + SIDE_MOUTH - 0.018],
    [W, H / 2 - SIDE_MOUTH, W + 0.05, H / 2 - SIDE_MOUTH + 0.018], [W, H / 2 + SIDE_MOUTH, W + 0.05, H / 2 + SIDE_MOUTH - 0.018],
  ];
  const MAIN_RAILS = 6;                // RAILS[0..5] are real cushions ("a ball hit a rail" for the rules)
  const HEAD_Y = H * 0.75;             // head spot (cue ball on the break)
  const FOOT_Y = H * 0.25;             // foot spot (rack apex)
  const KITCHEN_Y = H * 0.75;          // behind the head string (cue ball placement on the break)

  // ---- physics constants ---------------------------------------------------------------------------------
  const DT = 1 / 240;                  // fixed step
  const MAX_STEPS = 240 * 25;          // a shot never runs longer than 25 s of table time
  const VMAX = 7.2;                    // cue ball speed at full power (table units / s)
  const DECEL = 0.36;                  // rolling friction (units / s^2), constant deceleration
  const STOP = 0.004;                  // below this speed a ball stops
  const E_BALL = 0.95;                 // ball-ball restitution
  const E_RAIL = 0.78;                 // cushion restitution
  const FOLLOW = 0.9;                  // how much top/back spin turns into follow/draw after the first hit
  const ENGLISH = 0.45;                // how much side spin bends the cue ball off a cushion
  const SPIN_DECAY = 0.35;             // spin fades per second

  // ---- small helpers (deterministic) ---------------------------------------------------------------------
  const round = (x, q) => Math.round(x / q) * q;
  const snap = (x) => Math.round(x * 1e7) / 1e7;
  const fin = (x) => typeof x === "number" && isFinite(x);
  // mulberry32: integer-only PRNG for the rack order (Math.imul is exact 32-bit integer math everywhere)
  function prng(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const isSolid = (n) => n >= 1 && n <= 7;
  const isStripe = (n) => n >= 9 && n <= 15;
  const groupOf = (n) => (isSolid(n) ? "solids" : isStripe(n) ? "stripes" : null);

  // ---- the rack ------------------------------------------------------------------------------------------
  // apex on the foot spot pointing at the cue ball; 8 in the middle of the third row; a solid and a stripe in the two
  // back corners; the rest shuffled by the seed
  function rack(seed) {
    const rnd = prng(seed);
    const rest = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15];
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = rest[i]; rest[i] = rest[j]; rest[j] = t; }
    // back corners: one solid, one stripe (swap them to the front of the list)
    const s = rest.findIndex(isSolid), st = rest.findIndex(isStripe);
    const corners = rnd() < 0.5 ? [rest[s], rest[st]] : [rest[st], rest[s]];
    const others = rest.filter((n) => n !== corners[0] && n !== corners[1]);
    const gap = 0.0006, d = 2 * R + gap, rowH = d * Math.sqrt(3) / 2;
    const balls = [{ n: 0, x: W / 2, y: HEAD_Y, on: true }];
    let k = 0;
    for (let row = 0; row < 5; row++) {
      for (let c = 0; c <= row; c++) {
        let n;
        if (row === 2 && c === 1) n = 8;
        else if (row === 4 && c === 0) n = corners[0];
        else if (row === 4 && c === 4) n = corners[1];
        else n = others[k++];
        balls.push({ n, x: snap(W / 2 + (c - row / 2) * d), y: snap(FOOT_Y - row * rowH), on: true });
      }
    }
    balls.sort((a, b) => a.n - b.n);
    return balls;
  }

  // ---- simulation ----------------------------------------------------------------------------------------
  // balls: [{n,x,y,on}] (index = number, 0 = cue); shot: {aim:[x,y] unit, power 0..1, spin:[follow, side] -1..1}
  // returns { balls, events: {first, rails, railAfterContact, pocketed:[{n,p}], steps}, frames? }
  function simulate(balls0, shot, opts) {
    opts = opts || {};
    const every = opts.every || 4;               // record every 4th step (60 fps from 240 steps/s)
    const B = balls0.map((b) => ({ n: b.n, x: b.x, y: b.y, vx: 0, vy: 0, on: !!b.on, moving: false }));
    const cue = B[0];
    const speed = shot.power * VMAX;
    cue.vx = shot.aim[0] * speed; cue.vy = shot.aim[1] * speed; cue.moving = true;
    let follow = shot.spin[0], side = shot.spin[1];
    let hitBall = false, railHits = 0, railAfterContact = false, first = null, cueSpeedAtHit = 0;
    const pocketed = [];
    const frames = opts.record ? [] : null;
    const rec = () => frames.push(B.map((b) => (b.on ? [b.x, b.y] : null)));
    if (frames) rec();
    let step = 0;
    for (; step < MAX_STEPS; step++) {
      // move
      let any = false;
      for (let i = 0; i < 16; i++) {
        const b = B[i];
        if (!b.on || !b.moving) continue;
        b.x += b.vx * DT; b.y += b.vy * DT;
        const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        const ns = sp - DECEL * DT;
        if (ns <= STOP) { b.vx = 0; b.vy = 0; b.moving = false; }
        else { const f = ns / sp; b.vx *= f; b.vy *= f; any = true; }
      }
      if (i0Spin(cue)) { const k = 1 - SPIN_DECAY * DT; follow *= k; side *= k; }
      // ball-ball collisions (fixed pair order)
      for (let i = 0; i < 16; i++) {
        const a = B[i];
        if (!a.on) continue;
        for (let j = i + 1; j < 16; j++) {
          const b = B[j];
          if (!b.on || (!a.moving && !b.moving)) continue;
          const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy, min = 2 * R;
          if (d2 >= min * min || d2 === 0) continue;
          const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
          // separate
          const push = (min - d) / 2;
          a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
          const rv = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
          if (rv <= 0) continue;
          const imp = rv * (1 + E_BALL) / 2;
          a.vx -= imp * nx; a.vy -= imp * ny; b.vx += imp * nx; b.vy += imp * ny;
          a.moving = true; b.moving = true;
          if (i === 0 && !hitBall) {
            hitBall = true; first = b.n; cueSpeedAtHit = rv;
            // follow / draw: after the first contact the cue ball keeps (or reverses) some of its speed along the shot
            if (follow !== 0) { const k = follow * FOLLOW * rv; a.vx += shot.aim[0] * k; a.vy += shot.aim[1] * k; }
            follow = 0;
          }
        }
      }
      // cushions and jaws
      for (let i = 0; i < 16; i++) {
        const b = B[i];
        if (!b.on || !b.moving) continue;
        for (let s = 0; s < RAILS.length; s++) {
          const r = RAILS[s];
          const ex = r[2] - r[0], ey = r[3] - r[1];
          const L2 = ex * ex + ey * ey;
          let t = ((b.x - r[0]) * ex + (b.y - r[1]) * ey) / L2;
          if (t < 0) t = 0; else if (t > 1) t = 1;
          const cx = r[0] + ex * t, cy = r[1] + ey * t;
          const dx = b.x - cx, dy = b.y - cy, d2 = dx * dx + dy * dy;
          if (d2 >= R * R || d2 === 0) continue;
          const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
          b.x += nx * (R - d); b.y += ny * (R - d);
          const vn = b.vx * nx + b.vy * ny;
          if (vn >= 0) continue;
          b.vx -= (1 + E_RAIL) * vn * nx; b.vy -= (1 + E_RAIL) * vn * ny;
          if (s < MAIN_RAILS) { railHits++; if (hitBall) railAfterContact = true; }
          // english: side spin bends the cue ball along the cushion
          if (i === 0 && side !== 0) {
            const tx = -ny, ty = nx, k = side * ENGLISH * (-vn);
            b.vx += tx * k; b.vy += ty * k; side *= 0.5;
          }
        }
      }
      // pockets (and a safety net: anything that somehow leaves the table drops in the nearest pocket)
      for (let i = 0; i < 16; i++) {
        const b = B[i];
        if (!b.on) continue;
        let p = -1;
        for (let k = 0; k < 6; k++) { const P = POCKETS[k], dx = b.x - P.x, dy = b.y - P.y; if (dx * dx + dy * dy < P.r * P.r) { p = k; break; } }
        if (p < 0 && (b.x < -0.09 || b.x > W + 0.09 || b.y < -0.09 || b.y > H + 0.09)) {
          let best = 0, bd = Infinity;
          for (let k = 0; k < 6; k++) { const P = POCKETS[k], dx = b.x - P.x, dy = b.y - P.y, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = k; } }
          p = best;
        }
        if (p >= 0) { b.on = false; b.moving = false; b.vx = 0; b.vy = 0; pocketed.push({ n: b.n, p }); }
      }
      if (frames && step % every === every - 1) rec();
      let moving = false;
      for (let i = 0; i < 16; i++) if (B[i].on && B[i].moving) { moving = true; break; }
      if (!moving && !any) break;
    }
    if (frames) rec();
    const out = B.map((b) => ({ n: b.n, x: snap(b.x), y: snap(b.y), on: b.on }));
    void cueSpeedAtHit;
    return { balls: out, events: { first, rails: railHits, railAfterContact, pocketed, steps: step + 1 }, frames };
  }
  function i0Spin(cue) { return cue.moving; }

  // ---- placement -----------------------------------------------------------------------------------------
  function freeSpot(balls, x, y, skip) {
    if (!(x >= R && x <= W - R && y >= R && y <= H - R)) return false;
    for (const b of balls) { if (!b.on || b.n === skip) continue; const dx = b.x - x, dy = b.y - y; if (dx * dx + dy * dy < 4 * R * R) return false; }
    return true;
  }
  // put a ball back on the foot spot (or the nearest free place straight up from it)
  function respot(balls, n) {
    const b = balls[n];
    for (let k = 0; k < 400; k++) {
      const y = snap(FOOT_Y - k * 0.005);
      if (freeSpot(balls, W / 2, y, n)) { b.x = W / 2; b.y = y; b.on = true; return; }
    }
    b.x = W / 2; b.y = FOOT_Y; b.on = true;
  }

  // ---- rules ---------------------------------------------------------------------------------------------
  // state format v2 (Ghost 1.19.2): `last` no longer carries the whole table before the shot (`before`, ~740 chars)
  // nor a second copy of the text - the view rebuilds the table from the state it already shows (tableBefore). A v1
  // match (started on an older Ghost) keeps v1, so both Ghosts still replay it to the same JSON.
  function newGame(opts) {
    const players = opts.players.slice(0, 2);
    const seed = (opts.seed >>> 0) || 1;
    return {
      v: opts.v === 1 ? 1 : 2, game: "pool8", players, seed,
      turn: 0,                         // index into players
      groups: [null, null],            // "solids" / "stripes" per player once decided
      balls: rack(seed),
      ballInHand: true, kitchen: true, // the breaker places the cue ball behind the head string
      isBreak: true, shots: 0,
      winner: null, text: "",
      last: null,                      // {seq, by, move, pocketed, first, foul} (+ before, text in v1) (the view replays it)
    };
  }

  function clean(move) {
    if (!move || typeof move !== "object") throw new Error("bad move");
    const a = move.aim, s = move.spin || [0, 0];
    if (!Array.isArray(a) || !fin(a[0]) || !fin(a[1])) throw new Error("bad aim");
    let ax = round(a[0], 1e-6), ay = round(a[1], 1e-6);
    const len = Math.sqrt(ax * ax + ay * ay);
    if (!(len > 0.5 && len < 1.5)) throw new Error("aim must be a unit vector");
    ax = round(ax / len, 1e-6); ay = round(ay / len, 1e-6);
    if (!fin(move.power)) throw new Error("bad power");
    const power = round(Math.min(1, Math.max(0.02, move.power)), 1e-4);
    const clamp1 = (x) => (fin(x) ? round(Math.min(1, Math.max(-1, x)), 1e-3) : 0);
    const out = { aim: [ax, ay], power, spin: [clamp1(s[0]), clamp1(s[1])] };
    if (move.cuePos) {
      const c = move.cuePos;
      if (!Array.isArray(c) || !fin(c[0]) || !fin(c[1])) throw new Error("bad cue position");
      out.cuePos = [round(c[0], 1e-5), round(c[1], 1e-5)];
    }
    if (move.call != null) {
      if (!Number.isInteger(move.call) || move.call < 0 || move.call > 5) throw new Error("bad called pocket");
      out.call = move.call;
    }
    return out;
  }

  const groupLeft = (balls, g) => balls.filter((b) => b.on && groupOf(b.n) === g).length;
  // does the player now shooting need to call a pocket for the 8?
  function onEight(state, idx) {
    const g = state.groups[idx];
    return !!g && groupLeft(state.balls, g) === 0;
  }

  // the table the shot `move` (a clean() move) starts from: the state's balls, the cue ball where ball in hand put it
  function tableBefore(state, move) {
    const before = state.balls.map((b) => ({ n: b.n, x: b.x, y: b.y, on: b.on }));
    if (state.ballInHand) {
      const pos = (move && move.cuePos) || (before[0].on ? [before[0].x, before[0].y] : null);
      if (pos) before[0] = { n: 0, x: pos[0], y: pos[1], on: true };
    }
    return before;
  }

  // apply one shot; returns the new state (never mutates the old one)
  function apply(state0, move0, by) {
    if (state0.winner != null) throw new Error("the game is over");
    const me = state0.turn;
    if (by !== state0.players[me]) throw new Error("not your turn");
    const move = clean(move0);
    const st = JSON.parse(JSON.stringify(state0));
    // ball in hand: place the cue ball
    if (st.ballInHand) {
      const pos = move.cuePos || (st.balls[0].on ? [st.balls[0].x, st.balls[0].y] : null);
      if (!pos) throw new Error("place the cue ball first");
      if (st.kitchen && pos[1] < KITCHEN_Y - 1e-9) throw new Error("on the break the cue ball goes behind the line");
      if (!freeSpot(st.balls, pos[0], pos[1], 0)) throw new Error("the cue ball can't go there");
      st.balls[0].x = pos[0]; st.balls[0].y = pos[1]; st.balls[0].on = true;
    } else if (move.cuePos) throw new Error("no ball in hand");
    const needCall = onEight(st, me);
    if (needCall && move.call == null) throw new Error("call a pocket for the 8");

    const sim = simulate(st.balls, move);
    st.balls = sim.balls;
    const ev = sim.events;
    const potted = ev.pocketed.map((p) => p.n);
    const scratch = potted.includes(0);
    const eight = ev.pocketed.find((p) => p.n === 8);
    const myGroup = st.groups[me];
    const other = 1 - me;
    let foul = null;
    if (ev.first == null) foul = "No ball was hit";
    else if (scratch) foul = "Scratch";
    else if (myGroup) {
      const legalFirst = onEight(state0, me) ? 8 : null;
      if (legalFirst === 8 ? ev.first !== 8 : groupOf(ev.first) !== myGroup) foul = "Wrong ball hit first";
    } else if (ev.first === 8 && !st.isBreak) foul = "Hit the 8 first";
    if (!foul && !potted.length && !ev.railAfterContact && !st.isBreak) foul = "No rail after contact";

    let text = "", winner = null, keepTurn = false;
    const name = (i) => st.players[i];
    if (eight) {
      if (st.isBreak) {
        respot(st.balls, 8);
        text = "8 on the break: it goes back on the spot";
      } else if (needCall && !foul && eight.p === move.call) {
        winner = me; text = name(me) + " sank the 8 and wins!";
      } else {
        winner = other;
        text = needCall ? (foul ? "Sank the 8 on a foul: " + name(other) + " wins" : "The 8 went in the wrong pocket: " + name(other) + " wins")
          : "Sank the 8 too early: " + name(other) + " wins";
      }
    }
    if (winner == null) {
      // groups: the first legal shot after the break that pockets balls decides them (the table stays open after
      // the break itself); both kinds in: the first ball that dropped decides
      if (!myGroup && !st.isBreak && !foul) {
        const firstBall = ev.pocketed.find((p) => groupOf(p.n));
        if (firstBall) {
          st.groups[me] = groupOf(firstBall.n);
          st.groups[other] = st.groups[me] === "solids" ? "stripes" : "solids";
          text = name(me) + " is " + st.groups[me];
        }
      }
      const g = st.groups[me];
      const mine = potted.filter((n) => (g ? groupOf(n) === g : groupOf(n)));
      keepTurn = !foul && mine.length > 0;
      if (foul) text = foul + (text ? " · " + text : "") + ": ball in hand for " + name(other);
      else if (!text) text = keepTurn ? name(me) + " shoots again" : name(other) + "'s turn";
      if (scratch) st.balls[0].on = false;
    }
    st.winner = winner == null ? null : st.players[winner];
    st.turn = winner != null ? me : keepTurn ? me : other;
    st.ballInHand = winner == null && !!foul;
    st.kitchen = false;
    st.isBreak = false;
    st.shots += 1;
    st.text = text;
    st.last = state0.v === 1 ? { seq: st.shots, by, move, before: tableBefore(state0, move), pocketed: ev.pocketed, first: ev.first, foul, text }
      : { seq: st.shots, by, move, pocketed: ev.pocketed, first: ev.first, foul };
    return st;
  }

  function status(state) {
    if (state.winner != null) return { turn: null, winner: state.winner, draw: false, text: state.text || state.winner + " wins" };
    const who = state.players[state.turn];
    const g = state.groups[state.turn];
    const need = onEight(state, state.turn);
    let text = who + "'s turn";
    if (state.isBreak) text = who + " breaks";
    else if (need) text = who + " is on the 8";
    else if (g) text = who + " (" + g + ")";
    if (state.ballInHand && !state.isBreak) text += " · ball in hand";
    return { turn: who, winner: null, draw: false, text };
  }

  // for the aim guide in the view (not part of the deterministic path)
  const api = {
    W, H, R, POCKETS, RAILS, MAIN_RAILS, HEAD_Y, FOOT_Y, KITCHEN_Y, VMAX,
    rack, simulate, newGame, apply, status, clean, freeSpot, onEight, groupOf, isSolid, isStripe, tableBefore,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GhostPool8Engine = api;
})(typeof window !== "undefined" ? window : globalThis);
