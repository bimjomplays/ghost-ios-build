// App only, in the app's content world: swipe + long-press gestures for the chat list and open chats, so
// the app feels native (README "more native app like: long press chats, reply swipe and reacts"). New file,
// registered in App.swift; does not touch chat.js/chat.css/gif-picker.js (owned elsewhere for GIF sending +
// chat-open lag/scroll jitter) or recorder.js/camhook.js/snap hooks (owned elsewhere for the camera).
//
// What we found in Snapchat Web's own bundle (the cf-st.sc-cdn.net/dw/<hash>.js scripts on the /web page -
// class names are random and this may drift; re-check the bundle if a gesture stops doing anything):
// - the chat list is a react-virtualized List; each row is the box glass.js marks [data-dg-fill]. We don't
//   know which of its children actually owns the tap handler, so instead of guessing a selector we fire a
//   real tap (pointerdown/up + a native click()) at a point, exactly like a finger would land on it.
// - each message is an <li data-dg-bubble> (glass.js markBubbles). Its row wires a real `onContextMenu`
//   handler that opens a positioned action menu with the same actions Snapchat's hover toolbar has (we
//   found the exact labels in the bundle: "React", "Reply"/"Reply to <name>"/"Reply to Snap", "Copy Text",
//   "Delete") - unlike the hover-only icon toolbar, that's the one a touch long-press can actually reach,
//   so long-press/reply-swipe replicate a right click (a genuine `contextmenu` MouseEvent) rather than
//   trying to fake :hover.
// - react-virtualized's row renderer supports the identical onContextMenu wiring for a whole row
//   (onRowRightClick), so a chat row's long press tries the same trick; Snapchat's own "Mute/Clear
//   Chat/Delete Chat/Leave Group" conversation menu (data-testid "ConversationActionMenu.DropdownMenuItem.*"
//   in the bundle) is the likely result.
// If a given build hasn't wired a context menu for a row, firing one is a silent no-op - nothing breaks,
// the gesture just does nothing that time. UNVERIFIED ON DEVICE - see DEV_NOTES.md for what to check.
(() => {
  if (window.top !== window) return;
  const html = document.documentElement;

  const haptic = (style) => {
    try { window.webkit.messageHandlers.dg.postMessage({ op: "haptic", style: style || "light" }).catch(() => {}); } catch (e) {}
  };
  const trail = (text) => {
    try { window.webkit.messageHandlers.dg.postMessage({ op: "trail", text: "GESTURE " + text }).catch(() => {}); } catch (e) {}
  };
  // On the phone glass.js's desktop markers ([data-dg-fill] rows need a ~340px row, [data-dg-bubble] needs the
  // desktop bubble colours) never get set (checked in chat-*.html dumps, 2026-09-21), so find both structurally.
  // A chat row is the virtualized list's [role=listitem].
  const rowFor = (target) => target.closest("[data-dg-fill]") || (target.closest("[data-dg-sidebar]") && target.closest('[role="listitem"]'));
  // A message is the <div onContextMenu> under a sender group: ul#cv-<id> > li > div > ul > li > (header, div...).
  // Quoted replies nest their own ul > li inside a message, so walk up to the group by depth, not by closest().
  const messageFor = (target) => {
    const cv = target.closest('ul[id^="cv-"]');
    if (!cv) return target.closest("li[data-dg-bubble]");
    for (let el = target; el && el !== cv; el = el.parentElement) {
      const group = el.parentElement;
      if (group && group.tagName === "LI" && group.parentElement?.parentElement?.parentElement?.parentElement === cv) {
        return el.tagName === "HEADER" || el.tagName === "UL" ? null : el;
      }
    }
    return null;
  };
  let dumped = false;
  const dumpOnce = (note) => {
    if (dumped) return;
    dumped = true;
    setTimeout(() => {
      try { window.webkit.messageHandlers.dg.postMessage({ op: "dump", name: "actionmenu", note }).catch(() => {}); } catch (e) {}
    }, 300);
  };

  // ---- simulating a real tap / right click, the same way a finger or mouse would produce one -------
  const tapOpts = (x, y) => ({ bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 });
  const tapSequence = (el, x, y) => {
    const opts = tapOpts(x, y);
    try { el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 1, pointerType: "touch", isPrimary: true })); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    try { el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 1, pointerType: "touch", isPrimary: true })); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.click();
  };
  const fireTapAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (el) tapSequence(el, x, y);
    return el;
  };
  const fireContextMenuAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 2 }));
    return el;
  };

  // Right-clicks at (x, y), waits briefly, and hands back whatever NEW top-level node(s) appeared under
  // <body> (Snapchat's menus are portals) so they can be found again or styled. Marks them
  // [data-dg-actionmenu] so gestures.css can make their buttons touch-sized.
  // Snapchat positions the menu panel for a mouse (inline left/top at the click point, left can go negative):
  // slide it back inside the screen with a transform, again whenever Snapchat rewrites its position.
  const keepOnScreen = (root) => {
    const panel = root.firstElementChild;
    if (!panel) return;
    const M = 12;
    const fit = () => {
      panel.style.transform = "none";
      const r = panel.getBoundingClientRect();
      if (!r.width) return;
      const dx = r.left < M ? M - r.left : r.right > innerWidth - M ? innerWidth - M - r.right : 0;
      const dy = r.top < M ? M - r.top : r.bottom > innerHeight - M ? innerHeight - M - r.bottom : 0;
      panel.style.transform = dx || dy ? "translate(" + Math.round(dx) + "px," + Math.round(dy) + "px)" : "none";
    };
    fit();
    requestAnimationFrame(fit);
    let busy = false;
    new MutationObserver(() => { if (busy) return; busy = true; fit(); requestAnimationFrame(() => { busy = false; }); })
      .observe(panel, { attributes: true, attributeFilter: ["style"] });
  };

  // Mark Snapchat's message menu the moment it is added (MutationObserver callbacks run before the next paint),
  // so gestures.css styles it from its very first frame, whether our long-press or anything else opened it.
  const decorateMenu = (n) => {
    if (n.__dgMenu) return;
    n.__dgMenu = true;
    n.setAttribute("data-dg-actionmenu", "");
    const panel = n.firstElementChild;
    if (panel) for (const k of panel.children) if (!k.querySelector(":scope > ul")) k.setAttribute("data-dg-am-actions", "");
    keepOnScreen(n);
  };
  const markMenu = (n) => {
    if (n.nodeType === 1 && n.querySelector('ul img[alt^="Reaction"]')) decorateMenu(n); // the message menu only, not other popups
  };
  (function watchPortal() {
    const portal = document.getElementById("portal-container");
    if (!portal) return void setTimeout(watchPortal, 500);
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) {
        if (n.parentElement === portal) markMenu(n);
        else if (n.nodeType === 1) { const top = n.closest && n.closest("#portal-container > *"); if (top) markMenu(top); }
      }
    }).observe(portal, { childList: true, subtree: true });
    for (const n of portal.children) markMenu(n);
  })();

  const revealMenu = (x, y, then) => {
    const before = new Set(document.body.querySelectorAll("*"));
    const target = fireContextMenuAt(x, y);
    if (!target) return then(null);
    // look every frame (up to ~200ms) so the menu is nudged on screen the moment it exists, not 140ms later
    let frames = 0;
    const look = () => {
      const added = [...document.body.querySelectorAll("*")].filter((el) => !before.has(el));
      const roots = added.filter((el) => !added.includes(el.parentElement));
      if (!roots.length && ++frames < 12) return requestAnimationFrame(look);
      for (const el of roots) decorateMenu(el);
      trail("contextmenu on " + target.tagName + " -> " + roots.length + " new node(s) after " + frames + " frame(s)");
      dumpOnce(roots.length ? "revealed " + roots.length + " node(s)" : "nothing appeared for a right click");
      then(roots.length ? roots : null);
    };
    requestAnimationFrame(look);
  };
  // Snapchat's own label text (exact strings pulled from the bundle) - "Reply", "Reply to <name>" or
  // "Reply to Snap" depending on who sent the message / whether it's a Snap.
  // The menu's rows are plain <div>s (svg + span "Reply"), not buttons (actionmenu dump, 2026-09-21): take the
  // innermost element with that text and climb to its row (the div that holds the icon).
  const findReplyButton = (roots) => {
    for (const root of roots) {
      for (const el of root.querySelectorAll("button, [role='menuitem'], [role='button'], a, div, span")) {
        const t = el.textContent.trim();
        if (!(t === "Reply" || t.startsWith("Reply to"))) continue;
        if ([...el.children].some((c) => { const ct = c.textContent.trim(); return ct === t; })) continue; // not the innermost yet
        return el.closest("button, [role='menuitem'], [role='button'], a, div:has(> svg)") || el;
      }
    }
    return null;
  };

  // ---- gesture state machine: one active touch at a time -------------------------------------------
  const LOCK_MIN = 8, LOCK_BIAS = 1.2, MOVE_CANCEL = 10, LONG_PRESS_MS = 230;
  const REPLY_THRESHOLD = 55, REPLY_MAX = 70;
  let g = null;

  const clearStyle = (el) => { el.style.transition = ""; el.style.transform = ""; el.style.opacity = ""; };
  const springBack = (el, withOpacity) => {
    el.style.transition = "transform 0.22s cubic-bezier(0.2,0.8,0.2,1)" + (withOpacity ? ", opacity 0.22s ease" : "");
    el.style.transform = "translateX(0)";
    if (withOpacity) el.style.opacity = "1";
    setTimeout(() => clearStyle(el), 260);
  };

  // ---- open / close a chat by dragging it, like the app ----------------------------------------------
  // Both panes live in the same grid cell and glass.css hides one of them (display: none). While a chat is being
  // dragged, html[data-dg-peek] shows both: the chat list stays underneath and the chat follows the finger on top
  // (translateX), so you can move it back and forth and let go: past ~35% of the width or a flick = it finishes,
  // otherwise it springs back. Starting on a chat-list row opens that chat right away (it loads while you drag);
  // in an open chat, dragging it sideways uncovers the list. bridge.js keeps the native tab bar in list mode
  // while an opening drag is undecided (data-dg-peek="open"), so the page isn't resized under your finger.
  const peekW = () => { const r = document.querySelector("[data-dg-root]"); return (r && r.clientWidth) || window.innerWidth || 550; };
  const EASE = "transform 0.3s cubic-bezier(0.22, 1, 0.36, 1)";
  const column = () => document.querySelector("[data-dg-column]");
  // The position lives in CSS variables on <html> (gestures.css applies them to whatever element is the chat pane
  // right now): opening a chat makes Snapchat re-render, and an inline transform on the old pane element was lost -
  // the chat then sat fully open while the finger was still dragging (device report, 2026-09-23).
  let lastCol = null, moves = 0;
  const setX = (x, animate) => {
    html.style.setProperty("--dg-peek-x", Math.round(x) + "px");
    html.style.setProperty("--dg-peek-tr", animate ? EASE : "none");
    const c = column();
    if (c !== lastCol) { trail("PEEK pane " + (lastCol ? "replaced" : "found") + (c ? "" : " (none)")); lastCol = c; }
  };
  const endPeek = () => {
    html.removeAttribute("data-dg-peek");
    html.style.removeProperty("--dg-peek-x");
    html.style.removeProperty("--dg-peek-tr");
    lastCol = null;
  };
  // after an animation: run `then` once the transform has arrived (transitionend, or a timeout as a backstop)
  const settle = (then) => {
    let done = false;
    const go = (e) => {
      if (done || (e && !(e.target && e.target.matches && e.target.matches("[data-dg-column]")))) return;
      done = true; document.removeEventListener("transitionend", go, true); then();
    };
    document.addEventListener("transitionend", go, true);
    setTimeout(() => go(), 380);
  };
  const whenClass = (want, then) => { // wait (max ~0.8s) until glass.js has switched to dg-list / dg-chat
    const t0 = performance.now();
    (function wait() { if (html.classList.contains(want) || performance.now() - t0 > 800) then(); else requestAnimationFrame(wait); })();
  };
  function startOpenPeek(gs) {
    gs.side = gs.dx > 0 ? -1 : 1; // swiping right pulls the chat in from the left, like the app (left: from the right)
    html.setAttribute("data-dg-peek", "open");
    setX(gs.side * peekW() + gs.dx, false);
    const r = gs.el.getBoundingClientRect();
    fireTapAt(r.left + r.width * 0.35, r.top + r.height / 2); // open that chat now; it loads while the finger moves
    haptic("light");
  }
  function startClosePeek(gs) {
    html.setAttribute("data-dg-peek", "close");
    dispatchEvent(new Event("resize")); // the list was display:none - let react-virtualized measure and draw its rows
    setX(gs.dx, false);
  }
  function movePeek(gs) {
    const w = peekW();
    if (++moves % 12 === 0) trail("PEEK move dx " + Math.round(gs.dx) + " w " + w + " class " + (html.classList.contains("dg-chat") ? "chat" : "list"));
    if (gs.kind === "row") setX(gs.side < 0 ? Math.min(0, -w + gs.dx) : Math.max(0, w + gs.dx), false);
    else setX(Math.max(-w, Math.min(w, gs.dx)), false);
  }
  function finishPeek(gs) {
    const w = peekW();
    trail("PEEK let go " + gs.kind + " dx " + Math.round(gs.dx) + " of " + w);
    const now = performance.now();
    const recent = gs.samples.filter((p) => now - p.t < 90);
    const v = recent.length > 1 ? (recent[recent.length - 1].x - recent[0].x) / Math.max(1, recent[recent.length - 1].t - recent[0].t) : 0; // px/ms, last ~90ms
    if (gs.kind === "row") {
      const progress = Math.abs(gs.dx) / w;
      const flick = gs.side < 0 ? v > 0.45 : v < -0.45, flickBack = gs.side < 0 ? v < -0.45 : v > 0.45;
      if ((progress > 0.35 || flick) && !flickBack) { // open it all the way
        haptic("light");
        html.setAttribute("data-dg-peek", "settle"); // the tab bar may leave now, during the slide
        setX(0, true);
        settle(endPeek);
      } else { // put it back and close the chat again
        setX(gs.side * w, true);
        settle(() => { window.__dgBack && window.__dgBack(); whenClass("dg-list", endPeek); });
      }
    } else {
      const progress = Math.abs(gs.dx) / w;
      const flick = Math.abs(v) > 0.45 && Math.sign(v) === Math.sign(gs.dx);
      const flickBack = Math.abs(v) > 0.45 && Math.sign(v) !== Math.sign(gs.dx);
      if ((progress > 0.35 || flick) && !flickBack) { // close: the chat leaves, the list stays
        haptic("light");
        setX(gs.dx < 0 ? -w : w, true);
        settle(() => { window.__dgBack && window.__dgBack(); whenClass("dg-list", endPeek); });
      } else {
        setX(0, true);
        settle(endPeek);
      }
    }
  }

  function applyDrag(gs) {
    if (gs.kind === "row" || gs.kind === "back") {
      if (!gs.peeking) { gs.peeking = true; (gs.kind === "row" ? startOpenPeek : startClosePeek)(gs); }
      movePeek(gs);
    } else if (gs.kind === "bubble") {
      gs.el.style.transition = "none";
      gs.el.style.transform = "translateX(" + Math.min(gs.dx, REPLY_MAX) * 0.7 + "px)";
    }
  }

  function commitReply(gs) {
    springBack(gs.el, false);
    const r = gs.el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    setTimeout(() => {
      revealMenu(cx, cy, (roots) => {
        if (!roots) return;
        const btn = findReplyButton(roots);
        if (btn) { haptic("light"); tapSequence(btn, cx, cy); }
      });
    }, 90);
  }
  // The menu's backdrop closes it on any click, and it appears under the finger during the hold: lifting the
  // finger then closed it at once (device report, run12). preventDefault on that touchend isn't always
  // honoured after a long hold, so everything the lift produces is swallowed until the next fresh touch.
  let swallowLift = false;
  for (const type of ["pointerup", "mouseup", "mousedown", "click"]) {
    document.addEventListener(type, (e) => {
      if (!swallowLift) return;
      e.stopPropagation();
      e.preventDefault();
    }, true);
  }
  document.addEventListener("touchstart", () => { swallowLift = false; }, { capture: true, passive: true });

  function fireLongPress(gs) {
    gs.longFired = true;
    swallowLift = true;
    setTimeout(() => { swallowLift = false; }, 4000); // never leave taps dead if the lift was somehow missed
    haptic("medium");
    trail("long press on " + gs.kind);
    revealMenu(gs.x0, gs.y0, () => {}); // just reveal it, phone-sized via gestures.css; the user taps an action
  }

  document.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { g = null; return; }
    const t = e.touches[0];
    const target = e.target;
    if (!target.closest) { g = null; return; }
    const inChat = html.classList.contains("dg-chat");
    const bubbleEl = inChat && messageFor(target);
    const rowEl = !inChat && rowFor(target);
    const columnEl = inChat && document.querySelector("[data-dg-column]");
    const interactive = target.closest && target.closest('input, textarea, [contenteditable="true"], button, [role="button"], .dg-gif-panel');
    if (bubbleEl && inChat) {
      g = { kind: "bubble", el: bubbleEl, x0: t.clientX, y0: t.clientY, dx: 0, dy: 0, locked: null, longFired: false, t0: performance.now() };
    } else if (rowEl && !inChat) {
      g = { kind: "row", el: rowEl, x0: t.clientX, y0: t.clientY, dx: 0, dy: 0, locked: null, longFired: false, t0: performance.now() };
    } else if (columnEl && !interactive) {
      g = { kind: "back", el: columnEl, x0: t.clientX, y0: t.clientY, dx: 0, dy: 0, locked: null, longFired: false, t0: performance.now() };
    } else {
      g = null;
      return;
    }
    if (g.kind === "bubble") { // (chat rows have no context menu in Snapchat Web, so there is nothing to reveal for them)
      g.longTimer = setTimeout(() => fireLongPress(g), LONG_PRESS_MS);
    }
  }, { passive: true });

  const seen = new WeakSet();
  const once = (fn) => (e) => { if (seen.has(e)) return; seen.add(e); fn(e); };
  const onMove = once((e) => {
    if (!g || e.touches.length !== 1) return;
    const t = e.touches[0];
    g.dx = t.clientX - g.x0;
    g.dy = t.clientY - g.y0;
    (g.samples || (g.samples = [])).push({ x: t.clientX, t: performance.now() });
    if (g.samples.length > 12) g.samples.shift();
    if (g.longTimer && (Math.abs(g.dx) > MOVE_CANCEL || Math.abs(g.dy) > MOVE_CANCEL)) { clearTimeout(g.longTimer); g.longTimer = null; }
    if (!g.locked) {
      if (Math.abs(g.dx) < LOCK_MIN && Math.abs(g.dy) < LOCK_MIN) return;
      g.locked = Math.abs(g.dx) > Math.abs(g.dy) * LOCK_BIAS ? "x" : "y";
      // a leftward swipe that started on a message closes the chat, like one started beside it
      if (g.locked === "x" && g.kind === "bubble" && g.dx < 0) {
        const column = document.querySelector("[data-dg-column]");
        if (column) { g.kind = "back"; g.el = column; }
      }
    }
    // rows and the open chat follow the finger both ways; a message only slides right (reply). Vertical scroll passes through untouched
    if (g.locked !== "x" || (g.kind === "bubble" && g.dx <= 0)) return;
    e.preventDefault();
    applyDrag(g);
  });
  document.addEventListener("touchmove", onMove, { passive: false });

  function finish(e) {
    if (!g) return;
    const gs = g;
    g = null;
    if (gs.longTimer) clearTimeout(gs.longTimer);
    if (gs.longFired) { e.preventDefault(); return; } // already handled; suppress the trailing synthetic click
    if (gs.locked !== "x" || (gs.kind === "bubble" && gs.dx <= 0)) return; // plain tap or vertical scroll: let the page handle it natively
    const v = Math.abs(gs.dx) / Math.max(1, performance.now() - gs.t0); // px/ms, for a fast flick under the distance threshold
    if (gs.peeking) {
      e.preventDefault();
      if (e.type === "touchcancel") gs.dx = 0; // the system took the touch: treat it as "let go where it started"
      finishPeek(gs);
    } else if (gs.kind === "bubble" && (gs.dx > REPLY_THRESHOLD || (gs.dx > 30 && v > 0.5))) {
      e.preventDefault();
      commitReply(gs);
    } else {
      e.preventDefault();
      springBack(gs.el, gs.kind === "back");
    }
  }
  const onEnd = once(finish);
  document.addEventListener("touchend", onEnd, { passive: false });
  document.addEventListener("touchcancel", onEnd, { passive: false });
  // iOS keeps sending a touch's events to the element it started on, even after that element has been taken out of
  // the page (which Snapchat's list does when a chat opens): listen there too, so the drag keeps following the finger
  document.addEventListener("touchstart", (e) => {
    const t = e.target;
    if (!g || !t || !t.addEventListener) return;
    for (const [type, fn] of [["touchmove", onMove], ["touchend", onEnd], ["touchcancel", onEnd]]) t.addEventListener(type, fn, { passive: false });
    const drop = () => { for (const [type, fn] of [["touchmove", onMove], ["touchend", onEnd], ["touchcancel", onEnd]]) t.removeEventListener(type, fn); };
    t.addEventListener("touchend", drop, { once: true }); t.addEventListener("touchcancel", drop, { once: true });
  }, { passive: true });
})();
