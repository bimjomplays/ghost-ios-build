// Ghost 8 Ball: the game screen (GamePigeon-style) on top of pool8-engine.js.
// Registers { id: "pool8", ... } with the Ghost games framework (GhostGames.register). The engine does the physics and
// the rules deterministically; this file only draws the table, takes aim / power / spin / ball-in-hand / called-pocket
// input, and replays shots (yours right away, your friend's when their move arrives) at 60 fps.
(function (root) {
  "use strict";
  const E = root.GhostPool8Engine || (typeof require === "function" ? require("./pool8-engine.js") : null);
  if (!E) return;
  const { W, H, R, POCKETS } = E;

  const BALL_COLORS = { 0: "#f8f5ec", 1: "#f5c400", 2: "#1f53d6", 3: "#d7261e", 4: "#6c2a96", 5: "#f36b1c", 6: "#0d8a44", 7: "#7b1c24", 8: "#141414" };
  const colorOf = (n) => BALL_COLORS[n > 8 ? n - 8 : n];
  const RAIL = 0.075;                  // cushion + wood around the playing surface (table units)
  const ICON = '<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#141414"/><circle cx="12" cy="12" r="4.6" fill="#fff"/><text x="12" y="14.6" font-size="7" font-weight="700" text-anchor="middle" fill="#141414" font-family="-apple-system,system-ui,sans-serif">8</text></svg>';

  const CSS = `
  .gp8 { position: relative; width: 100%; height: 100%; display: flex; flex-direction: column; user-select: none; -webkit-user-select: none;
    background: var(--gp8-bg); color: var(--gp8-text); font-family: -apple-system, system-ui, "SF Pro Text", sans-serif; touch-action: none; overflow: hidden; }
  .gp8-top { flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 12px 6px; }
  .gp8-close { flex: none; width: 34px; height: 34px; border-radius: 17px; border: 0; background: var(--gp8-panel); color: var(--gp8-text); font-size: 18px; }
  .gp8-players { flex: 1; display: flex; gap: 8px; min-width: 0; }
  .gp8-pl { flex: 1; min-width: 0; padding: 6px 8px; border-radius: 12px; background: var(--gp8-panel); border: 1.5px solid transparent; }
  .gp8-pl[data-turn="1"] { border-color: var(--gp8-accent); }
  .gp8-pl-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .gp8-pl-balls { display: flex; gap: 2px; margin-top: 4px; height: 14px; align-items: center; }
  .gp8-pl-balls canvas { width: 14px; height: 14px; }
  .gp8-pl-open { font-size: 11px; color: var(--gp8-muted); }
  .gp8-status { flex: none; text-align: center; font-size: 14px; font-weight: 600; padding: 2px 12px 6px; min-height: 20px; }
  .gp8-status[data-foul="1"] { color: #ff6b6b; }
  .gp8-mid { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0 8px 10px; }
  .gp8-power { flex: none; width: 34px; align-self: stretch; margin: 16px 0; border-radius: 17px; background: var(--gp8-panel); position: relative; overflow: hidden; }
  .gp8-power-fill { position: absolute; left: 0; right: 0; top: 0; height: 0; background: linear-gradient(180deg, #ffd23f, #ff5a36); border-radius: 17px; }
  .gp8-power-cue { position: absolute; left: 50%; width: 8px; margin-left: -4px; top: 6px; bottom: 6px; border-radius: 4px;
    background: linear-gradient(180deg, #f1d9a8 0%, #c79a55 70%, #3a2a1a 100%); pointer-events: none; }
  .gp8-power-hint { position: absolute; left: 0; right: 0; bottom: 8px; text-align: center; font-size: 9px; color: var(--gp8-muted); pointer-events: none; }
  .gp8-table { position: relative; flex: none; }
  .gp8-table canvas { display: block; width: 100%; height: 100%; }
  .gp8-spin { position: relative; flex: none; width: 34px; height: 34px; border-radius: 20px; border: 0; padding: 0;
    background: radial-gradient(circle at 35% 30%, #fff, #e8e4d8 60%, #b9b4a4); box-shadow: 0 2px 6px rgba(0,0,0,0.45); }
  .gp8-spin i { position: absolute; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 4px; background: #d7261e; left: 50%; top: 50%; }
  .gp8-sheet { position: absolute; inset: 0; background: rgba(0,0,0,0.55); display: none; align-items: center; justify-content: center; flex-direction: column; gap: 14px; z-index: 5; }
  .gp8-sheet[data-open="1"] { display: flex; }
  .gp8-sheet-ball { width: 190px; height: 190px; border-radius: 95px; position: relative; background: radial-gradient(circle at 35% 30%, #fff, #ece8dc 60%, #b7b1a0);
    box-shadow: 0 10px 30px rgba(0,0,0,0.5); touch-action: none; }
  .gp8-sheet-ball::before, .gp8-sheet-ball::after { content: ""; position: absolute; background: rgba(0,0,0,0.12); }
  .gp8-sheet-ball::before { left: 50%; top: 10px; bottom: 10px; width: 1px; } .gp8-sheet-ball::after { top: 50%; left: 10px; right: 10px; height: 1px; }
  .gp8-sheet-ball i { position: absolute; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 11px; background: #d7261e; box-shadow: 0 0 0 3px rgba(255,255,255,0.8); }
  .gp8-sheet-row { display: flex; gap: 10px; }
  .gp8-btn { border: 0; border-radius: 16px; padding: 9px 16px; font-size: 15px; font-weight: 600; background: var(--gp8-panel); color: var(--gp8-text); }
  .gp8-btn-accent { background: var(--gp8-accent); color: #fff; }
  .gp8-sheet-note { color: #fff; font-size: 13px; opacity: 0.85; }
  .gp8-banner { position: absolute; left: 50%; top: 42%; transform: translate(-50%, -50%); padding: 14px 22px; border-radius: 18px; background: rgba(0,0,0,0.72);
    color: #fff; font-size: 20px; font-weight: 800; text-align: center; display: none; z-index: 4; }
  .gp8-banner[data-show="1"] { display: block; }
  /* embedded (inside Ghost's game view, which has its own header, turn line and Close): a slim rail, no title/close */
  .gp8[data-embedded="1"] .gp8-close { display: none; }
  .gp8[data-embedded="1"] .gp8-top { padding: 2px 12px 4px; }
  .gp8[data-embedded="1"] .gp8-pl { padding: 4px 8px; display: flex; align-items: center; gap: 8px; }
  .gp8[data-embedded="1"] .gp8-pl-balls { margin-top: 0; flex: 1; min-width: 0; overflow: hidden; }
  .gp8[data-embedded="1"] .gp8-status { font-size: 13px; padding: 0 12px 4px; min-height: 18px; }`;

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  // ---- drawing -------------------------------------------------------------------------------------------
  function drawBall(g, n, x, y, r, alpha) {
    g.save();
    if (alpha != null) g.globalAlpha = alpha;
    // shadow
    g.fillStyle = "rgba(0,0,0,0.28)";
    g.beginPath(); g.ellipse(x + r * 0.18, y + r * 0.26, r * 0.95, r * 0.8, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.closePath();
    g.save(); g.clip();
    if (n > 8) {
      g.fillStyle = "#f6f2e6"; g.fillRect(x - r, y - r, 2 * r, 2 * r);
      g.fillStyle = colorOf(n); g.fillRect(x - r, y - r * 0.55, 2 * r, r * 1.1);
    } else { g.fillStyle = colorOf(n); g.fillRect(x - r, y - r, 2 * r, 2 * r); }
    if (n > 0) {
      g.fillStyle = "#fbfaf5"; g.beginPath(); g.arc(x, y, r * 0.47, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#151515"; g.font = `700 ${r * (n > 9 ? 0.52 : 0.6)}px -apple-system, system-ui, sans-serif`;
      g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(String(n), x, y + r * 0.04);
    }
    // shading: light from the top-left, dark rim bottom-right
    const sh = g.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.05, x, y, r * 1.05);
    sh.addColorStop(0, "rgba(255,255,255,0.55)"); sh.addColorStop(0.25, "rgba(255,255,255,0.12)");
    sh.addColorStop(0.7, "rgba(0,0,0,0)"); sh.addColorStop(1, "rgba(0,0,0,0.38)");
    g.fillStyle = sh; g.fillRect(x - r, y - r, 2 * r, 2 * r);
    g.restore();
    g.restore();
  }

  function view(container, opts) {
    const me = opts.me;
    const onMove = opts.onMove || (() => {});
    const onClose = opts.onClose || (() => {});
    const theme = opts.theme || {};
    let state = opts.state;
    let shownSeq = state.last ? state.last.seq : 0;
    let replays = 0; // (friend's shots played back - for tests)

    const rootEl = el("div", "gp8");
    const embedded = !!opts.embedded; // Ghost's game view shows the title, whose turn it is and Close itself
    if (embedded) rootEl.dataset.embedded = "1";
    rootEl.style.setProperty("--gp8-bg", theme.bg || "var(--gh-bg-app, #0f141c)");
    rootEl.style.setProperty("--gp8-panel", theme.panel || "var(--gh-bg-panel, #1c2430)");
    rootEl.style.setProperty("--gp8-text", theme.text || "var(--gh-text, #eef1f6)");
    rootEl.style.setProperty("--gp8-muted", theme.muted || "var(--gh-text-secondary, #8d97a8)");
    rootEl.style.setProperty("--gp8-accent", theme.accent || "var(--gh-accent, #3e88f7)");
    const style = el("style"); style.textContent = CSS; rootEl.appendChild(style);
    const top = el("div", "gp8-top");
    const closeBtn = el("button", "gp8-close", "✕"); closeBtn.setAttribute("aria-label", "Close");
    const players = el("div", "gp8-players");
    top.append(closeBtn, players);
    const statusEl = el("div", "gp8-status");
    const mid = el("div", "gp8-mid");
    const power = el("div", "gp8-power");
    const powerFill = el("div", "gp8-power-fill"); const powerCue = el("div", "gp8-power-cue"); const powerHint = el("div", "gp8-power-hint", "PULL");
    power.append(powerFill, powerCue, powerHint);
    const tableEl = el("div", "gp8-table");
    const canvas = el("canvas");
    const spinBtn = el("button", "gp8-spin"); spinBtn.setAttribute("aria-label", "Spin"); const spinDot = el("i"); spinBtn.appendChild(spinDot);
    tableEl.append(canvas);
    top.appendChild(spinBtn);
    mid.append(power, tableEl);
    const banner = el("div", "gp8-banner");
    const sheet = el("div", "gp8-sheet");
    const sheetBall = el("div", "gp8-sheet-ball"); const sheetDot = el("i"); sheetBall.appendChild(sheetDot);
    const sheetNote = el("div", "gp8-sheet-note", "Top = follow · bottom = draw · sides = english");
    const sheetRow = el("div", "gp8-sheet-row");
    const resetBtn = el("button", "gp8-btn", "Center"); const doneBtn = el("button", "gp8-btn gp8-btn-accent", "Done");
    sheetRow.append(resetBtn, doneBtn);
    sheet.append(sheetBall, sheetNote, sheetRow);
    rootEl.append(top, statusEl, mid, banner, sheet);
    container.appendChild(rootEl);

    const g = canvas.getContext("2d");
    let scale = 1, ox = 0, oy = 0, cssW = 0, cssH = 0, dpr = 1;
    const aim = { x: 0, y: -1 };
    let spin = [0, 0];
    let powerNow = 0, pulling = false;
    let call = null;                   // called pocket for the 8
    let cuePlace = null;               // [x,y] while placing the ball in hand
    let draggingCue = false;
    let anim = null;                   // {frames, start, onDone}
    let raf = 0;
    let dead = false;
    let msg = null;                    // local error message (e.g. "the cue ball can't go there")

    const myIdx = () => state.players.indexOf(me);
    const myTurn = () => state.winner == null && state.players[state.turn] === me;
    const needCall = () => myTurn() && E.onEight(state, state.turn);
    const toX = (x) => ox + x * scale, toY = (y) => oy + y * scale;
    const fromPx = (px, py) => [(px - ox) / scale, (py - oy) / scale];
    const cuePos = () => (cuePlace ? cuePlace : state.balls[0].on ? [state.balls[0].x, state.balls[0].y] : [W / 2, E.HEAD_Y]);

    function layout() {
      const box = { width: mid.clientWidth, height: mid.clientHeight }; // local px (Ghost zooms the page on the phone)
      const availW = Math.max(100, box.width - 16 - 34 - 8), availH = Math.max(100, box.height - 10);
      const tw = W + 2 * RAIL, th = H + 2 * RAIL;
      const s = Math.min(availW / tw, availH / th);
      cssW = Math.floor(tw * s); cssH = Math.floor(th * s);
      tableEl.style.width = cssW + "px"; tableEl.style.height = cssH + "px";
      dpr = Math.min(3, window.devicePixelRatio || 1);
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      scale = s; ox = RAIL * s; oy = RAIL * s;
      draw();
    }

    function paintHud() {
      players.innerHTML = "";
      state.players.forEach((p, i) => {
        const box = el("div", "gp8-pl");
        box.dataset.turn = state.winner == null && state.turn === i ? "1" : "0";
        const nm = el("div", "gp8-pl-name"); nm.textContent = (p === me ? "You" : (opts.names && opts.names[p]) || p) + (state.winner === p ? " 🏆" : "");
        const balls = el("div", "gp8-pl-balls");
        const grp = state.groups[i];
        if (!grp) balls.appendChild(Object.assign(el("span", "gp8-pl-open"), { textContent: state.isBreak ? "Break" : "Open table" }));
        else {
          const nums = grp === "solids" ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15];
          for (const n of nums) {
            const c = el("canvas"); c.width = 28; c.height = 28;
            const cg = c.getContext("2d"); drawBall(cg, n, 14, 13, 11, state.balls[n].on ? 1 : 0.22);
            balls.appendChild(c);
          }
          if (nums.every((n) => !state.balls[n].on)) { const c = el("canvas"); c.width = 28; c.height = 28; drawBall(c.getContext("2d"), 8, 14, 13, 11); balls.appendChild(c); }
        }
        box.append(nm, balls); players.appendChild(box);
      });
      const st = E.status(state);
      const named = (t) => { let x = String(t || ""); for (const p of state.players) x = x.split(p).join(p === me ? "You" : (opts.names && opts.names[p]) || p); return x.replace(/^You's turn/, "Your turn").replace(/You is /, "You're ").replace(/You shoots/, "You shoot").replace(/and wins!$/, (m) => (x.startsWith("You ") ? "and win!" : m)).replace(/: You wins$/, ": you win").replace(/^You wins$/, "You win"); };
      const foul = state.last && state.last.foul && !anim;
      statusEl.dataset.foul = foul ? "1" : "0";
      const turnText = myTurn() ? "Your turn" + (state.isBreak ? " · break" : needCall() ? " · call a pocket for the 8" : state.ballInHand ? " · ball in hand" : "") : named(st.text);
      // embedded: only what the header doesn't say (a foul, ball in hand, call the 8); the result shows in the banner
      const hint = myTurn() ? (state.isBreak ? "Break" : needCall() ? "Call a pocket for the 8" : state.ballInHand ? "Ball in hand" : "") : "";
      const foulText = state.last && state.last.foul ? state.last.foul : "";
      statusEl.textContent = msg || (anim ? "" : embedded ? (state.winner != null ? "" : [foulText, hint].filter(Boolean).join(" · ")) : state.winner != null ? named(st.text) : (foulText ? foulText + " · " : "") + turnText);
      power.style.opacity = myTurn() && !anim ? "1" : "0.35";
      spinBtn.style.visibility = myTurn() && !anim ? "visible" : "hidden";
      spinDot.style.left = 50 + spin[1] * 36 + "%"; spinDot.style.top = 50 - spin[0] * 36 + "%";
      banner.dataset.show = state.winner != null && !anim ? "1" : "0";
      banner.textContent = state.winner === me ? "You win! 🎱" : state.winner != null ? "You lose" : "";
    }

    function draw(frame) {
      if (dead) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, cssW, cssH);
      // wood / frame
      const rr = RAIL * scale;
      g.fillStyle = "#3b2618";
      roundRect(g, 0, 0, cssW, cssH, rr * 0.9); g.fill();
      const wood = g.createLinearGradient(0, 0, cssW, 0);
      wood.addColorStop(0, "rgba(255,255,255,0.10)"); wood.addColorStop(0.5, "rgba(255,255,255,0)"); wood.addColorStop(1, "rgba(0,0,0,0.18)");
      g.fillStyle = wood; roundRect(g, 0, 0, cssW, cssH, rr * 0.9); g.fill();
      // cushions (slightly darker felt)
      g.fillStyle = "#0b5a3a";
      roundRect(g, rr * 0.45, rr * 0.45, cssW - rr * 0.9, cssH - rr * 0.9, rr * 0.4); g.fill();
      // felt
      const felt = g.createRadialGradient(cssW / 2, cssH / 2, cssW * 0.1, cssW / 2, cssH / 2, cssH * 0.62);
      felt.addColorStop(0, "#1c8f5c"); felt.addColorStop(1, "#0f6a43");
      g.fillStyle = felt; g.fillRect(toX(0), toY(0), W * scale, H * scale);
      // diamonds on the rails
      g.fillStyle = "#e8d7b0";
      for (let i = 1; i < 4; i++) { const x = toX((W * i) / 4); dia(g, x, rr * 0.22); dia(g, x, cssH - rr * 0.22); }
      for (let i = 1; i < 8; i++) { if (i === 4) continue; const y = toY((H * i) / 8); dia(g, rr * 0.22, y); dia(g, cssW - rr * 0.22, y); }
      // head string + foot spot
      g.strokeStyle = "rgba(255,255,255,0.10)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(toX(0), toY(E.KITCHEN_Y)); g.lineTo(toX(W), toY(E.KITCHEN_Y)); g.stroke();
      g.fillStyle = "rgba(255,255,255,0.18)"; g.beginPath(); g.arc(toX(W / 2), toY(E.FOOT_Y), 2, 0, Math.PI * 2); g.fill();
      // pockets
      POCKETS.forEach((p, i) => {
        const pr = (i === 2 || i === 3 ? 0.055 : 0.06) * scale;
        const pg = g.createRadialGradient(toX(p.x), toY(p.y), pr * 0.2, toX(p.x), toY(p.y), pr);
        pg.addColorStop(0, "#000"); pg.addColorStop(1, "#111");
        g.fillStyle = pg; g.beginPath(); g.arc(toX(p.x), toY(p.y), pr, 0, Math.PI * 2); g.fill();
        if (call === i || (anim == null && needCall() && call == null)) {
          g.strokeStyle = call === i ? "#ffd23f" : "rgba(255,210,63,0.45)"; g.lineWidth = call === i ? 3 : 2;
          g.beginPath(); g.arc(toX(p.x), toY(p.y), pr + 3, 0, Math.PI * 2); g.stroke();
        }
      });
      // balls
      const pos = frame || state.balls.map((b) => (b.on ? [b.x, b.y] : null));
      const cp = cuePos();
      for (let n = 1; n < 16; n++) if (pos[n]) drawBall(g, n, toX(pos[n][0]), toY(pos[n][1]), R * scale);
      const showCue = frame ? pos[0] : (state.balls[0].on || cuePlace || (myTurn() && state.ballInHand)) ? cp : null;
      if (showCue) {
        if (!frame && myTurn() && state.ballInHand) {
          g.strokeStyle = "rgba(255,255,255,0.55)"; g.setLineDash([4, 4]); g.lineWidth = 1.5;
          g.beginPath(); g.arc(toX(showCue[0]), toY(showCue[1]), R * scale + 6, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
        }
        drawBall(g, 0, toX(showCue[0]), toY(showCue[1]), R * scale);
      }
      if (!frame && myTurn() && state.winner == null) drawAim(showCue || cp);
    }

    // aim guide: line to the first thing the cue ball meets, ghost ball, object ball path; the cue stick behind
    function drawAim(c) {
      const dx = aim.x, dy = aim.y;
      let tMin = Infinity, hit = null;
      for (let n = 1; n < 16; n++) {
        const b = state.balls[n]; if (!b.on) continue;
        const fx = c[0] - b.x, fy = c[1] - b.y;
        const bq = fx * dx + fy * dy, cq = fx * fx + fy * fy - 4 * R * R;
        const disc = bq * bq - cq;
        if (disc < 0) continue;
        const t = -bq - Math.sqrt(disc);
        if (t > 0 && t < tMin) { tMin = t; hit = b; }
      }
      // walls (the cushion line one radius in)
      const wallT = (v, lo, hi, p) => (v > 0 ? (hi - p) / v : v < 0 ? (lo - p) / v : Infinity);
      const tx = wallT(dx, R, W - R, c[0]), ty = wallT(dy, R, H - R, c[1]);
      const tw = Math.min(tx, ty);
      let wall = false;
      if (tw < tMin) { tMin = tw; hit = null; wall = true; }
      const ex = c[0] + dx * tMin, ey = c[1] + dy * tMin;
      g.strokeStyle = "rgba(255,255,255,0.85)"; g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(toX(c[0]), toY(c[1])); g.lineTo(toX(ex), toY(ey)); g.stroke();
      g.strokeStyle = "rgba(255,255,255,0.9)"; g.lineWidth = 1.4;
      g.beginPath(); g.arc(toX(ex), toY(ey), R * scale, 0, Math.PI * 2); g.stroke();
      if (hit) {
        let nx = hit.x - ex, ny = hit.y - ey; const nl = Math.sqrt(nx * nx + ny * ny) || 1; nx /= nl; ny /= nl;
        const L = 0.32 * (1 - Math.abs(nx * dy - ny * dx) * 0.5);
        g.strokeStyle = "rgba(255,255,255,0.75)"; g.lineWidth = 1.6;
        g.beginPath(); g.moveTo(toX(hit.x), toY(hit.y)); g.lineTo(toX(hit.x + nx * L), toY(hit.y + ny * L)); g.stroke();
        // cue ball tangent line
        const dot = dx * nx + dy * ny; let txv = dx - dot * nx, tyv = dy - dot * ny; const tl = Math.sqrt(txv * txv + tyv * tyv);
        if (tl > 0.05) { txv /= tl; tyv /= tl; g.strokeStyle = "rgba(255,255,255,0.35)"; g.beginPath(); g.moveTo(toX(ex), toY(ey)); g.lineTo(toX(ex + txv * 0.12 * tl), toY(ey + tyv * 0.12 * tl)); g.stroke(); }
        // wrong ball? tint the ghost ball red
        const grp = state.groups[state.turn];
        const bad = hit.n === 8 ? !(E.onEight(state, state.turn) || (!grp && state.isBreak)) : grp && E.groupOf(hit.n) !== grp;
        if (bad) { g.strokeStyle = "rgba(255,90,90,0.95)"; g.lineWidth = 2; g.beginPath(); g.arc(toX(ex), toY(ey), R * scale, 0, Math.PI * 2); g.stroke(); }
      } else if (wall) {
        const rx = tx < ty ? -dx : dx, ry = tx < ty ? dy : -dy;
        g.strokeStyle = "rgba(255,255,255,0.35)"; g.beginPath(); g.moveTo(toX(ex), toY(ey)); g.lineTo(toX(ex + rx * 0.14), toY(ey + ry * 0.14)); g.stroke();
      }
      // cue stick
      const back = (0.05 + pullNow * 0.28) * scale;
      const sx = toX(c[0]) - dx * (R * scale + back), sy = toY(c[1]) - dy * (R * scale + back);
      const len = 1.05 * scale;
      const exs = sx - dx * len, eys = sy - dy * len;
      const cue = g.createLinearGradient(sx, sy, exs, eys);
      cue.addColorStop(0, "#f7f7f7"); cue.addColorStop(0.02, "#2b64c9"); cue.addColorStop(0.04, "#f1dcad"); cue.addColorStop(0.7, "#c89a58"); cue.addColorStop(0.72, "#1b1b1b"); cue.addColorStop(1, "#1b1b1b");
      g.strokeStyle = cue; g.lineCap = "round"; g.lineWidth = Math.max(3, R * scale * 0.42);
      g.beginPath(); g.moveTo(sx, sy); g.lineTo(exs, eys); g.stroke(); g.lineCap = "butt";
    }

    function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
    function dia(c, x, y) { c.beginPath(); c.moveTo(x, y - 3); c.lineTo(x + 2.2, y); c.lineTo(x, y + 3); c.lineTo(x - 2.2, y); c.closePath(); c.fill(); }

    // ---- animation ---------------------------------------------------------------------------------------
    function play(before, move, done) {
      const sim = E.simulate(before, E.clean(move), { record: true, every: 4 });
      anim = { frames: sim.frames, start: 0, done };
      paintHud();
      const tick = (t) => {
        if (dead || !anim) return;
        if (!anim.start) anim.start = t;
        const i = Math.floor(((t - anim.start) / 1000) * 60);
        if (i >= anim.frames.length - 1) { draw(anim.frames[anim.frames.length - 1]); const d = anim.done; anim = null; d && d(); return; }
        draw(anim.frames[i]);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    // ---- input -------------------------------------------------------------------------------------------
    const local = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * (cssW / r.width), (e.clientY - r.top) * (cssH / r.height)]; };
    function setAimTo(px, py) {
      const [x, y] = fromPx(px, py); const c = cuePos();
      const dx = x - c[0], dy = y - c[1], l = Math.sqrt(dx * dx + dy * dy);
      if (l > R * 0.5) { aim.x = dx / l; aim.y = dy / l; }
    }
    canvas.addEventListener("pointerdown", (e) => {
      if (!myTurn() || anim) return;
      canvas.setPointerCapture(e.pointerId);
      const [px, py] = local(e); const [x, y] = fromPx(px, py); const c = cuePos();
      msg = null;
      if (state.ballInHand && (x - c[0]) * (x - c[0]) + (y - c[1]) * (y - c[1]) < (R * 2.2) * (R * 2.2)) { draggingCue = true; return; }
      if (needCall()) {
        for (let i = 0; i < 6; i++) { const p = POCKETS[i]; if ((x - p.x) * (x - p.x) + (y - p.y) * (y - p.y) < 0.11 * 0.11) { call = i; draw(); paintHud(); return; } }
      }
      setAimTo(px, py); draw();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!myTurn() || anim || !e.buttons) return;
      const [px, py] = local(e);
      if (draggingCue) {
        let [x, y] = fromPx(px, py);
        x = Math.min(W - R, Math.max(R, x)); y = Math.min(H - R, Math.max(state.kitchen ? E.KITCHEN_Y : R, y));
        if (E.freeSpot(state.balls, x, y, 0)) cuePlace = [x, y];
        draw(); return;
      }
      setAimTo(px, py); draw();
    });
    canvas.addEventListener("pointerup", () => { draggingCue = false; });

    // power follows how far the finger has pulled down from where it first touched the bar (not where on the bar
    // it touched: a light touch low on the bar used to be a hard shot), on a curve so short pulls give soft shots
    let pullY0 = 0, pullNow = 0;
    function setPower(e) {
      const r = power.getBoundingClientRect();
      pullNow = Math.min(1, Math.max(0, (e.clientY - pullY0) / (r.height * 0.85)));
      powerNow = pullNow * pullNow;
      powerFill.style.height = pullNow * 100 + "%";
      powerCue.style.transform = `translateY(${pullNow * (power.clientHeight * 0.6)}px)`;
      draw();
    }
    power.addEventListener("pointerdown", (e) => { if (!myTurn() || anim) return; try { power.setPointerCapture(e.pointerId); } catch (x) {} pulling = true; pullY0 = e.clientY; setPower(e); });
    power.addEventListener("pointermove", (e) => { if (pulling) setPower(e); });
    const release = () => {
      if (!pulling) return;
      pulling = false;
      const p = powerNow;
      powerNow = 0; pullNow = 0; powerFill.style.height = "0"; powerCue.style.transform = "";
      if (p >= 0.01) shoot(p); else draw();
    };
    power.addEventListener("pointerup", release);
    power.addEventListener("pointercancel", release);

    function shoot(p) {
      const move = { aim: [aim.x, aim.y], power: p, spin: spin.slice() };
      if (state.ballInHand) move.cuePos = cuePos();
      if (needCall()) { if (call == null) { msg = "Tap a pocket to call it for the 8"; paintHud(); draw(); return; } move.call = call; }
      let next;
      try { next = E.apply(state, move, me); } catch (err) { msg = String(err.message || err); paintHud(); draw(); return; }
      const before = next.last.before || E.tableBefore(state, next.last.move);
      shownSeq = next.last.seq;
      const clean = next.last.move;
      play(before, clean, () => { state = next; cuePlace = null; call = null; spin = [0, 0]; paintHud(); draw(); });
      try { onMove(clean); } catch (e) {}
    }

    // spin picker
    function setSpinFrom(e) {
      const r = sheetBall.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2, rad = r.width / 2;
      let sx = (e.clientX - cx) / rad, sy = (e.clientY - cy) / rad; const l = Math.sqrt(sx * sx + sy * sy);
      if (l > 0.8) { sx *= 0.8 / l; sy *= 0.8 / l; }
      spin = [Math.round(-sy / 0.8 * 1000) / 1000, Math.round(sx / 0.8 * 1000) / 1000];
      paintSpin();
    }
    function paintSpin() { sheetDot.style.left = 50 + spin[1] * 40 + "%"; sheetDot.style.top = 50 - spin[0] * 40 + "%"; }
    spinBtn.addEventListener("click", () => { paintSpin(); sheet.dataset.open = "1"; });
    sheetBall.addEventListener("pointerdown", (e) => { sheetBall.setPointerCapture(e.pointerId); setSpinFrom(e); });
    sheetBall.addEventListener("pointermove", (e) => { if (e.buttons) setSpinFrom(e); });
    resetBtn.addEventListener("click", () => { spin = [0, 0]; paintSpin(); });
    doneBtn.addEventListener("click", () => { sheet.dataset.open = "0"; paintHud(); });
    sheet.addEventListener("click", (e) => { if (e.target === sheet) { sheet.dataset.open = "0"; paintHud(); } });
    closeBtn.addEventListener("click", () => onClose());

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => layout()) : null;
    if (ro) ro.observe(rootEl);
    requestAnimationFrame(() => { layout(); paintHud(); });
    layout(); paintHud();

    const api = {
      // a new state from the framework: replay the friend's shot if it's one we haven't shown
      update(next) {
        if (dead || !next) return;
        const L = next.last;
        // the table the shot started from: carried by a v1 match, else rebuilt from the state shown now (when that's the
        // one right before it - a shot we missed in between just shows the new table)
        const before = L && (L.before || (!anim && state && state.shots === L.seq - 1 ? E.tableBefore(state, L.move) : null));
        if (L && L.seq > shownSeq && L.by !== me && before) {
          shownSeq = L.seq; replays++;
          play(before, L.move, () => { state = next; paintHud(); draw(); });
          return;
        }
        if (!anim) { state = next; if (next.last) shownSeq = Math.max(shownSeq, next.last.seq); paintHud(); draw(); }
        // a shot still playing: show this one after it (a v2 match rebuilds its table from the state that shot ends on)
        else { const d = anim.done; anim.done = () => { d && d(); api.update(next); }; }
      },
      destroy() { dead = true; cancelAnimationFrame(raf); if (ro) ro.disconnect(); rootEl.remove(); },
      // Ghost desktop's keyboard (ui.js "Desktop screens 2"; the phone never calls these): turn the aim, pull the cue
      // back while a key is held, let go to shoot - the same steps as dragging on the table and pulling the power bar
      keys: {
        aim(rad) {
          if (dead || !myTurn() || anim || !(rad === rad)) return false;
          const a = Math.atan2(aim.y, aim.x) + rad;
          aim.x = Math.cos(a); aim.y = Math.sin(a); msg = null;
          draw();
          return true;
        },
        power(p) {
          if (dead || !myTurn() || anim) return false;
          pullNow = Math.min(1, Math.max(0, Number(p) || 0)); powerNow = pullNow * pullNow;
          powerFill.style.height = pullNow * 100 + "%";
          powerCue.style.transform = `translateY(${pullNow * (power.clientHeight * 0.6)}px)`;
          draw();
          return true;
        },
        shoot() {
          const p = powerNow;
          powerNow = 0; pullNow = 0; powerFill.style.height = "0"; powerCue.style.transform = "";
          if (dead || !myTurn() || anim) { if (!dead) draw(); return false; }
          if (p >= 0.01) shoot(p); else draw();
          return true;
        },
      },
      // tests
      _debug: { get state() { return state; }, aim, setSpin: (s) => { spin = s; }, shoot, get animating() { return !!anim; }, get replays() { return replays; }, get msg() { return msg; }, get power() { return powerNow; }, setCall: (i) => { call = i; }, setCuePlace: (p) => { cuePlace = p; } },
    };
    return api;
  }

  const game = {
    id: "pool8", name: "8 Ball", icon: ICON, minPlayers: 2, maxPlayers: 2,
    playerIds: true, // players, turn, winner and `me` are Ghost ids here (GhostGames maps them to 0|1)
    sizeLimit: 2450, // a whole match (v2: 2312 at most in 400 random matches); one ntfy message fits ~2540 (network.test #203)
    preview: (s) => (s.shots ? "Shot " + s.shots : ""),
    newGame: (o) => E.newGame(o),
    view,
    apply: (s, m, by) => E.apply(s, m, by),
    status: (s) => E.status(s),
  };
  if (root.GhostGames && typeof root.GhostGames.register === "function") root.GhostGames.register(game);
  root.GhostPool8 = game;
  if (typeof module !== "undefined" && module.exports) module.exports = game;
})(typeof window !== "undefined" ? window : globalThis);
