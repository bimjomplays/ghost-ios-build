// App only: open a chat at its newest message. The conversation pane is hidden while the chat list shows and
// the web view changes height as the bottom bar leaves, so Snapchat's own "scroll to the end" sometimes
// measured too early and the chat opened far up. Build #67 fixed that with 5 timed scrollTop resets (60,
// 250, 500, 900, 1500ms) - but those fired on a fixed schedule regardless of whether the message list had
// actually changed size, and landed while the pane was already on screen, which is the "screen shakes up
// and down" jitter: every time a message/avatar/image finished loading and grew scrollHeight, the next
// timer snapped scrollTop back to the (new) bottom, visible as a jump. Now: the conversation is re-pinned to
// the bottom every frame (a scrollTop write + a scrollHeight read - cheap, and only for a bounded window
// right after a chat opens) instead of on a schedule, so any growth is corrected the moment it happens
// rather than in occasional big jumps; it's hidden only for the first ~90ms of that (long enough to cover
// the single frame that would otherwise paint at the top before the first pin lands), then shown and kept
// corrected in the background while content keeps arriving. (A ResizeObserver was considered instead of the
// per-frame check, but it only fires on the observed element's own box size, not on its scrollHeight growing
// while its own height stays fixed - which is exactly what happens here as messages/images load in.)
(() => {
  if (window.top !== window) return;
  const html = document.documentElement;
  let open = false, touched = false;
  let rafId = 0, until = 0, firstPinAt = 0, hiddenEl = null, shown = false, lastH = -1, calm = 0;
  // a finger scrolling the chat ends the pinning - but not a finger dragging the whole chat open (gestures.js peek)
  addEventListener("touchmove", () => { if (html.hasAttribute("data-dg-peek")) return; touched = true; stop(); }, { passive: true, capture: true });
  // dragging the conversation puts the keyboard away, like Messages / the Snapchat app
  let startY = null;
  addEventListener("touchstart", (e) => {
    const inChat = open && e.touches.length === 1 && e.target.closest && e.target.closest('[data-dg-column] ul[id^="cv-"]');
    startY = inChat ? e.touches[0].clientY : null;
  }, { passive: true, capture: true });
  addEventListener("touchmove", (e) => {
    if (startY === null || Math.abs(e.touches[0].clientY - startY) < 18) return;
    startY = null;
    const a = document.activeElement;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA)$/.test(a.tagName))) a.blur();
  }, { passive: true, capture: true });

  let sendDumped = false;
  setInterval(() => {
    if (sendDumped || !open) return;
    const box = document.querySelector('[data-dg-column] [role="textbox"][contenteditable="true"]');
    if (!box || box.textContent.trim().length < 3) return;
    sendDumped = true;
    window.webkit.messageHandlers.dg.postMessage({ op: "dump", name: "typing" }).catch(() => {});
  }, 1000);

  const scroller = () => {
    for (let el = document.querySelector('[data-dg-column] ul[id^="cv-"]'); el && el !== document.body; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 4) return el;
    }
    return null;
  };
  function unhide() {
    if (!hiddenEl) return;
    hiddenEl = null;
    shown = true;
    html.removeAttribute("data-dg-settling"); // the messages fade in, already at the newest one (touch.js)
  }
  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    unhide();
  }
  function tick(now) {
    rafId = 0;
    if (touched || !open) return stop();
    // Device reports 2026-09-21: first a 90ms hide, then keeping only the message list transparent, both
    // still showed "a jumping flash for about a second": the whole pane slides in (touch.js) while the header
    // is restyled, textscale.js enlarges the text, the bottom bar leaves and the web view resizes. So the
    // whole conversation pane is now held back (html[data-dg-settling]: invisible, slide-in not started) until
    // the message list's height and the window height have held still for ~8 frames (700ms at most), and
    // only then slides in, already pinned to the newest message. A data attribute, not a class: bridge.js
    // reports every class change to the app.
    if (!firstPinAt) firstPinAt = now;
    if (!hiddenEl && !shown) { html.setAttribute("data-dg-settling", ""); hiddenEl = html; }
    const list = document.querySelector('[data-dg-column] ul[id^="cv-"]');
    const s = scroller();
    if (s) s.scrollTop = s.scrollHeight;
    const h = (list ? list.scrollHeight : -1) + ":" + innerHeight;
    calm = list && h === lastH ? calm + 1 : 0;
    lastH = h;
    // (8 calm frames was reachable before Snapchat had put any message in the list: wait for real content too)
    // Flight-recorder numbers from the phone (run14): the list is a ~924px skeleton with 1-4 <li> for the first
    // 60-130ms, the real messages land by ~130-420ms, then nothing moves. So "filled" = it scrolls (a long
    // chat) - 5 calm frames are enough then; a short chat never scrolls, so it gets a longer calm wait instead.
    const filled = Boolean(s);
    if (hiddenEl && ((filled && calm >= 5) || (!filled && calm >= 16) || now - firstPinAt > 900)) unhide();
    if (now < until) rafId = requestAnimationFrame(tick); else stop();
  }
  // Flight recorder for the "glitchy flash" on chat open, which three blind fixes haven't removed: for 2s after
  // a chat opens, note every frame in which anything visible changed, then write it to trail.txt as one line
  // (t ms | window height | pane opacity, x, width | list height, scrollTop, messages | settling).
  let recId = 0;
  function record() {
    cancelAnimationFrame(recId);
    const t0 = performance.now(), rows = [];
    let last = "";
    const frame = (now) => {
      const col = document.querySelector("[data-dg-column]");
      const list = document.querySelector('[data-dg-column] ul[id^="cv-"]');
      const s = scroller();
      const r = col ? col.getBoundingClientRect() : null;
      const sig = [innerHeight, col ? (+getComputedStyle(col).opacity).toFixed(2) : "-", r ? Math.round(r.x) : "-", r ? Math.round(r.width) : "-",
        list ? list.scrollHeight : "-", s ? Math.round(s.scrollTop) : "-", list ? list.querySelectorAll("li").length : "-",
        html.hasAttribute("data-dg-settling") ? "hold" : "show"].join(",");
      if (sig !== last && rows.length < 60) { rows.push(Math.round(now - t0) + ":" + sig); last = sig; }
      if (now - t0 < 2000 && open) recId = requestAnimationFrame(frame);
      else window.webkit.messageHandlers.dg.postMessage({ op: "trail", text: "CHATOPEN " + rows.join(" | ") }).catch(() => {});
    };
    recId = requestAnimationFrame(frame);
  }

  // Style markers. chat.css used ~80 `:has()` selectors (composer, header, message groups); WebKit re-checks
  // those on every DOM change, and on a long chat that nearly doubled the style work per new message / keystroke
  // (measured in WebKit, 2026-09-22: 6.2ms -> 4.6ms per new message without them). So the few elements they
  // described are marked here instead - found from the text field, the header and each new message - and
  // chat.css matches plain attributes.
  const COMPOSER = ["data-dg-cmp", "data-dg-cmp-panel", "data-dg-tbwrap", "data-dg-cmp-field", "data-dg-tbanc", "data-dg-replying", "data-dg-quote", "data-dg-sendwrap"];
  let marked = [];
  const mark = (el, a) => { if (!el.hasAttribute(a)) el.setAttribute(a, ""); marked.push([el, a]); };
  function markComposer(column) {
    const prev = marked; marked = [];
    const tb = column.querySelector('[role="textbox"]');
    if (tb) {
      const tbParent = tb.parentElement;
      let cmp = null;
      for (let el = tbParent; el && el !== column; el = el.parentElement) {
        if (el.tagName !== "DIV") continue;
        mark(el, "data-dg-tbanc");
        if (el.matches('div:has(> button + div [role="textbox"])')) { mark(el, "data-dg-cmp"); cmp = cmp || el; }
        if (el.matches('div:has(> div > button + div [role="textbox"])')) mark(el, "data-dg-cmp-panel");
        if (el.matches('div:has(> div > [role="textbox"])')) mark(el, "data-dg-tbwrap");
      }
      if (cmp) {
        for (const field of cmp.children) {
          if (field.tagName !== "DIV" || !field.contains(tb)) continue;
          mark(field, "data-dg-cmp-field");
          for (const d of field.children) if (d.tagName === "DIV")
            for (const x of d.children) if (x !== tb && x.getAttribute("role") !== "textbox" && x.querySelector("button") && !x.querySelector("header")) mark(x, "data-dg-sendwrap");
        }
      }
      if (tbParent && tbParent.tagName === "DIV") {
        if (tbParent.matches(":has(> div > header), :has(> div header)")) mark(tbParent, "data-dg-replying");
        for (const q of tbParent.children) if (q.tagName === "DIV" && q.querySelector("header")) mark(q, "data-dg-quote");
      }
    }
    const keep = new Set(marked.map(([el, a]) => a + "\u0000" + (el.__dgId || (el.__dgId = Math.random()))));
    for (const [el, a] of prev) if (!keep.has(a + "\u0000" + el.__dgId)) el.removeAttribute(a);
  }
  const HEADER_MARKS = { "data-dg-hdr-actions": "div:has(> button + div + button)", "data-dg-hdr-avwrap": "div:has(> button[aria-label])",
    "data-dg-hdr-av2": "div:has(> div > button[aria-label])", "data-dg-hdr-name": "div:has(> div > button[aria-label]) > div:has(> span)" };
  function markHeader() {
    const h = document.querySelector("[data-dg-header]");
    for (const [a, sel] of Object.entries(HEADER_MARKS)) {
      const now = new Set(h ? h.querySelectorAll(sel) : []);
      for (const el of document.querySelectorAll("[" + a + "]")) if (!now.has(el)) el.removeAttribute(a); // stale (header re-used)
      for (const el of now) if (!el.hasAttribute(a)) el.setAttribute(a, "");
    }
  }
  function markMessage(li) {
    const head = li.matches('ul[id^="cv-"] ul > li:has(> header)');
    const follow = !head && li.matches('ul[id^="cv-"] > li > div > ul > li');
    li.toggleAttribute("data-dg-ghead", head); // a message can gain or lose its name line: keep only the current mark
    li.toggleAttribute("data-dg-gfollow", follow);
  }
  let pendingLis = new Set(), fullPass = true, markQueued = false;
  function runMarks() {
    markQueued = false;
    const column = document.querySelector("[data-dg-column]");
    if (!column) { pendingLis.clear(); return; }
    markComposer(column);
    markHeader();
    if (fullPass) { fullPass = false; pendingLis.clear(); for (const li of column.querySelectorAll('ul[id^="cv-"] li')) markMessage(li); }
    else { for (const li of pendingLis) if (li.isConnected) markMessage(li); pendingLis.clear(); }
  }
  window.__dgRunMarks = runMarks; // (for the local WebKit test page)
  const markObserver = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.tagName === "LI") pendingLis.add(n);
      if (n.firstElementChild) for (const li of n.getElementsByTagName("li")) pendingLis.add(li);
      if (n.tagName === "HEADER" && n.parentElement && n.parentElement.tagName === "LI") pendingLis.add(n.parentElement);
    }
    for (const r of records) for (const n of r.removedNodes) // a name line taken away: that message is a follow-up now
      if (n.nodeName === "HEADER" && r.target.tagName === "LI") pendingLis.add(r.target);
    // marked synchronously for new messages would be nicer, but one pass per frame is plenty: the attribute
    // lands before that frame paints (requestAnimationFrame runs before painting)
    if (!markQueued) { markQueued = true; requestAnimationFrame(runMarks); }
  });
  (function startMarks() {
    if (!document.body) return void setTimeout(startMarks, 50);
    markObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-dg-column", "data-dg-header"] });
    runMarks();
  })();
  new MutationObserver(() => {
    const now = html.classList.contains("dg-chat");
    if (now === open) return;
    open = now;
    stop(); // cancel any previous chat's pin loop before starting the next one
    if (!open) return;
    fullPass = true;
    touched = false;
    firstPinAt = 0; shown = false; lastH = -1; calm = 0;
    html.setAttribute("data-dg-settling", ""); hiddenEl = html; // set before the first paint of the opened chat
    until = performance.now() + 1400; // keep correcting for this long in total (covers late-loading content)
    rafId = requestAnimationFrame(tick);
    record();
  }).observe(html, { attributes: true, attributeFilter: ["class"] });
  // a chat dragged open (gestures.js) may take longer than the pinning window: pin once more when the drag ends
  new MutationObserver(() => {
    if (!open || touched || html.hasAttribute("data-dg-peek")) return;
    until = Math.max(until, performance.now() + 500);
    if (!rafId) rafId = requestAnimationFrame(tick);
  }).observe(html, { attributes: true, attributeFilter: ["data-dg-peek"] });
})();
