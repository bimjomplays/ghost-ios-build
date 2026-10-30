// App only: Chats/QoL features (quick replies, private nicknames, chat-row long-press, scroll-to-bottom,
// voice-note playback speed). New file - doesn't touch chat.js/gestures.js/touch.js (owned elsewhere).
// Everything here is either off by default (quickRepliesShow) or only ever shows something when there is
// real data to show it for (a nickname, a scrolled-up chat, a voice note) - so with the default settings and
// on the rig's dumps (none of which have any of that data) this adds/changes nothing visible.
//
// React-prop reading (convIdForRow): same technique as gifs-find.js (__reactFiber$ + walking .return reading
// .memoizedProps) - UNVERIFIED ON DEVICE, since the rig's dumps are static HTML with no live React attached
// to them (stripped <script> tags), so this can only be exercised for real on the phone. If Snapchat's prop
// shape differs from the `feedItem.conversationId` guess below, the nickname/long-press-title lookups simply
// find no id and do nothing - no crash, no visible regression.
(() => {
  if (window.top !== window) return;

  const setting = (key, fallback) => (typeof window.dgSetting === "function" ? window.dgSetting(key, fallback) : fallback);
  const onSettings = (fn) => { if (typeof window.dgOnSettings === "function") window.dgOnSettings(fn); };
  const post = (msg) => { try { window.webkit.messageHandlers.dg.postMessage(msg).catch(() => {}); } catch (e) {} };
  const haptic = (style) => post({ op: "haptic", style: style || "light" });

  // ---- shared: find a conversation id from a row's/element's React fiber, like gifs-find.js does for a message ----
  function convIdFor(el) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    let fiber = key && el[key];
    for (let i = 0; fiber && i < 30; i++, fiber = fiber.return) {
      const p = fiber.memoizedProps;
      if (!p || typeof p !== "object") continue;
      if (p.feedItem && p.feedItem.conversationId) return p.feedItem.conversationId;
      if (p.conversationId) return p.conversationId;
      if (p.item && p.item.conversationId) return p.item.conversationId;
    }
    return null;
  }
  function convIdFromPath() {
    const m = location.pathname.match(/^\/web\/([^/?#]+)/);
    return m ? m[1] : null;
  }
  // same tap-simulation technique as gestures.js, kept local since gestures.js isn't ours to import from
  const fireTapAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    try { el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 1, pointerType: "touch", isPrimary: true })); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    try { el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 1, pointerType: "touch", isPrimary: true })); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.click();
    return el;
  };

  // ============================================================================================
  // 1) Quick replies: a chip row above the composer in an open chat. Off by default (quickRepliesShow).
  // ============================================================================================
  let qrRow = null, qrComposer = null, qrObserver = null;
  function qrRemove() {
    if (qrRow) { qrRow.remove(); qrRow = null; }
    if (qrObserver) { qrObserver.disconnect(); qrObserver = null; }
    qrComposer = null;
  }
  function qrReposition() {
    if (!qrRow || !qrComposer) return;
    const r = qrComposer.getBoundingClientRect();
    qrRow.style.left = r.left + "px";
    qrRow.style.width = r.width + "px";
    qrRow.style.bottom = Math.max(0, innerHeight - r.top) + "px";
  }
  function qrInsertReply(text, send) {
    const box = document.querySelector('[data-dg-column] [role="textbox"][contenteditable="true"]');
    if (!box) return;
    box.focus();
    document.execCommand("insertText", false, text);
    if (send) {
      setTimeout(() => {
        const btn = document.querySelector('[data-dg-cmp] [data-dg-tbanc] button');
        if (btn) { haptic("light"); btn.click(); }
      }, 60); // one tick for React to render the send arrow now the composer isn't empty
    }
  }
  function qrRender() {
    if (!qrRow) return;
    qrRow.innerHTML = "";
    const list = setting("quickReplies", ["On my way!", "lol", "\u{1F602}", "ok", "❤️"]);
    if (!Array.isArray(list)) return;
    for (const text of list) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "dg-qr-chip";
      chip.textContent = text;
      let lastTap = 0;
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        const now = Date.now();
        const isDouble = now - lastTap < 350;
        lastTap = isDouble ? 0 : now;
        qrInsertReply(text, isDouble);
      });
      qrRow.appendChild(chip);
    }
  }
  // chat.js holds the freshly-opened chat at opacity 0 (html[data-dg-settling]) while it pins the message
  // list to the bottom; reading/measuring anything chat-shaped before that clears risks catching the
  // scroller mid-pin (briefly "scrolled up" before its own settle finishes) or the composer mid-layout.
  const settling = () => document.documentElement.hasAttribute("data-dg-settling");

  function qrEnsure() {
    const wantShow = !!setting("quickRepliesShow", false);
    const inChat = document.documentElement.classList.contains("dg-chat") && !settling();
    const panel = wantShow && inChat ? document.querySelector("[data-dg-cmp-panel]") : null;
    if (!panel) return void qrRemove();
    if (!qrRow) {
      qrRow = document.createElement("div");
      qrRow.className = "dg-qr-row";
      document.body.appendChild(qrRow);
      qrRender();
    }
    if (qrComposer !== panel) {
      qrComposer = panel;
      if (qrObserver) qrObserver.disconnect();
      qrObserver = new ResizeObserver(qrReposition);
      qrObserver.observe(panel);
    }
    qrReposition();
  }

  // ============================================================================================
  // 2) Private nicknames: shown instead of the real name (which stays underneath, in the DOM, so its box
  //    size/measurements are untouched - only visually swapped via a ::before + hidden-children rule in
  //    qol.css, which also supplies the fallback font-size read off the real (already textscale.js-scaled)
  //    text so the nickname renders at the same size).
  // ============================================================================================
  function nickLeaf(container) {
    return (container.querySelector && container.querySelector("[data-dg-fs]")) || container;
  }
  function applyNick(container, nick) {
    const leaf = nickLeaf(container);
    if (nick) {
      const cs = getComputedStyle(leaf);
      container.style.setProperty("--dg-nick-fs", cs.fontSize);
      container.style.setProperty("--dg-nick-lh", cs.lineHeight);
      if (container.getAttribute("data-dg-nick") !== nick) container.setAttribute("data-dg-nick", nick);
    } else if (container.hasAttribute("data-dg-nick")) {
      container.removeAttribute("data-dg-nick");
    }
  }
  function nicksMap() {
    const m = setting("x_nicknames", {});
    return m && typeof m === "object" ? m : {};
  }
  function scanNicknameRows() {
    const nicks = nicksMap();
    for (const row of document.querySelectorAll("[data-dg-fill]")) {
      const alb = row.getAttribute("aria-labelledby");
      const titleId = alb && alb.split(" ")[0];
      const nameEl = titleId && document.getElementById(titleId);
      if (!nameEl) continue;
      const id = convIdFor(row);
      applyNick(nameEl, id ? nicks[id] : null);
    }
  }
  // Independent of chat.js's own [data-dg-hdr-name] marker (HEADER_MARKS requires the avatar button to have
  // an aria-label; on at least one real conversation it only had aria-labelledby, so the marker never
  // matched there - rig-confirmed, 2026-09-23). The header's Bitmoji + name live in one dropdown-toggle
  // element (aria-haspopup="listbox"); the name is whichever of its direct children holds a
  // textscale.js-marked text leaf that isn't inside the avatar's own image wrapper.
  function headerNameWrap() {
    const header = document.querySelector("[data-dg-header]");
    const toggle = header && header.querySelector('[aria-haspopup="listbox"]');
    if (!toggle) return null;
    return [...toggle.children].find((c) => c.querySelector && c.querySelector("[data-dg-fs]")) || null;
  }
  function applyNicknameHeader() {
    const wrap = headerNameWrap();
    if (!wrap) return;
    const id = convIdFromPath();
    applyNick(wrap, id ? nicksMap()[id] : null);
  }

  // ============================================================================================
  // 3) Chat-row long-press -> native rowMenu action sheet (open / copyName / nickname).
  // ============================================================================================
  let pressTimer = 0, pressStart = null, pressRow = null, suppressClickUntil = 0;
  function rowDisplayName(row) {
    const alb = row.getAttribute("aria-labelledby");
    const titleId = alb && alb.split(" ")[0];
    const nameEl = titleId && document.getElementById(titleId);
    if (!nameEl) return "";
    return nameEl.getAttribute("data-dg-nick") || nameEl.textContent.trim();
  }
  function findRowByConvId(id) {
    for (const row of document.querySelectorAll("[data-dg-fill]")) if (convIdFor(row) === id) return row;
    return null;
  }
  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;left:-9999px;";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    ta.remove();
  }
  document.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || document.documentElement.classList.contains("dg-chat")) return;
    const row = e.target.closest && e.target.closest('[data-dg-sidebar] [role="listitem"]');
    if (!row) return;
    const t = e.touches[0];
    pressStart = { x: t.clientX, y: t.clientY };
    pressRow = row;
    pressTimer = setTimeout(() => {
      pressTimer = 0;
      haptic("medium");
      suppressClickUntil = Date.now() + 600;
      post({ op: "rowMenu", title: rowDisplayName(row), convId: convIdFor(row), x: pressStart.x, y: pressStart.y });
    }, 350);
  }, { capture: true, passive: true });
  document.addEventListener("touchmove", (e) => {
    if (!pressTimer || !pressStart || !e.touches[0]) return;
    if (Math.hypot(e.touches[0].clientX - pressStart.x, e.touches[0].clientY - pressStart.y) > 10) { clearTimeout(pressTimer); pressTimer = 0; }
  }, { capture: true, passive: true });
  for (const type of ["touchend", "touchcancel"]) document.addEventListener(type, () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = 0; }
  }, { capture: true, passive: true });
  // suppress the synthetic click a lifted long-press finger produces, so the row doesn't also open
  document.addEventListener("click", (e) => {
    if (Date.now() < suppressClickUntil) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  window.__dgRowMenuResult = ({ convId, action, value } = {}) => {
    if (action === "open") {
      const row = findRowByConvId(convId) || pressRow;
      if (row) { const r = row.getBoundingClientRect(); fireTapAt(r.left + r.width / 2, r.top + r.height / 2); }
    } else if (action === "copyName") {
      const text = value || (pressRow && rowDisplayName(pressRow)) || "";
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      else fallbackCopy(text);
    } else if (action === "nickname") {
      // native already saved x_nicknames; __dgApplySettings will fire dgOnSettings and re-render below
    }
  };

  // ============================================================================================
  // 4) Scroll-to-bottom button in an open chat, with a "new message" dot while scrolled up.
  // ============================================================================================
  let sbBtn = null, sbScroller = null, sbMsgObserver = null;
  function messageScroller() {
    const col = document.querySelector("[data-dg-column]");
    if (!col) return null;
    for (let el = col.querySelector('ul[id^="cv-"]'); el && el !== document.body; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 4) return el;
    }
    return null;
  }
  function sbUpdate() {
    if (!sbBtn || !sbScroller) return;
    const dist = sbScroller.scrollHeight - sbScroller.scrollTop - sbScroller.clientHeight;
    const show = dist > innerHeight * 1.5;
    sbBtn.classList.toggle("dg-scrollbtn-show", show);
    if (!show) sbBtn.classList.remove("dg-scrollbtn-dot");
    const panel = document.querySelector("[data-dg-cmp-panel]");
    if (panel) { const r = panel.getBoundingClientRect(); sbBtn.style.bottom = Math.max(0, innerHeight - r.top) + 14 + "px"; }
  }
  function sbRemove() {
    if (sbBtn) { sbBtn.remove(); sbBtn = null; }
    if (sbScroller) { sbScroller.removeEventListener("scroll", sbUpdate); sbScroller = null; }
    if (sbMsgObserver) { sbMsgObserver.disconnect(); sbMsgObserver = null; }
  }
  function sbEnsure() {
    const inChat = document.documentElement.classList.contains("dg-chat") && !settling();
    const scroller = inChat ? messageScroller() : null;
    if (!scroller) return void sbRemove();
    if (!sbBtn) {
      sbBtn = document.createElement("button");
      sbBtn.type = "button";
      sbBtn.className = "dg-scrollbtn";
      sbBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg><span class="dg-scrollbtn-dotel"></span>';
      sbBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (sbScroller) sbScroller.scrollTop = sbScroller.scrollHeight;
        sbBtn.classList.remove("dg-scrollbtn-dot");
      });
      document.body.appendChild(sbBtn);
    }
    if (sbScroller !== scroller) {
      if (sbScroller) sbScroller.removeEventListener("scroll", sbUpdate);
      sbScroller = scroller;
      sbScroller.addEventListener("scroll", sbUpdate, { passive: true });
      const list = document.querySelector('[data-dg-column] ul[id^="cv-"]');
      if (sbMsgObserver) sbMsgObserver.disconnect();
      if (list) {
        sbMsgObserver = new MutationObserver(() => {
          if (sbBtn && sbBtn.classList.contains("dg-scrollbtn-show")) sbBtn.classList.add("dg-scrollbtn-dot");
        });
        sbMsgObserver.observe(list, { childList: true, subtree: true });
      }
    }
    sbUpdate();
  }

  // ============================================================================================
  // 5) Voice-note playback speed. Snapchat Web's own bundle renders a real <audio controls
  //    controlslist="nodownload noplaybackrate" ...> for a voice note (confirmed in the bundle, 2026-09-23) -
  //    it deliberately hides the browser's own speed menu item, so this restores exactly that as a pill.
  // ============================================================================================
  const VN_SPEEDS = [1, 1.5, 2];
  const vnLabel = (v) => (v === 1 ? "1" : v === 1.5 ? "1.5" : "2") + "×";
  let vnSpeed = +setting("voiceNoteSpeed", 1) || 1;
  function vnApplyAll() {
    for (const audio of document.querySelectorAll("audio[data-dg-voicenote]")) audio.playbackRate = vnSpeed;
    for (const pill of document.querySelectorAll(".dg-vn-pill")) pill.textContent = vnLabel(vnSpeed);
  }
  function vnMark(root) {
    const els = root.matches && root.matches('audio[controlslist*="noplaybackrate"]')
      ? [root]
      : root.querySelectorAll ? [...root.querySelectorAll('audio[controlslist*="noplaybackrate"]')] : [];
    for (const audio of els) {
      if (audio.hasAttribute("data-dg-voicenote")) continue;
      audio.setAttribute("data-dg-voicenote", "");
      audio.playbackRate = vnSpeed;
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "dg-vn-pill";
      pill.textContent = vnLabel(vnSpeed);
      pill.addEventListener("click", (e) => {
        e.stopPropagation();
        vnSpeed = VN_SPEEDS[(VN_SPEEDS.indexOf(vnSpeed) + 1) % VN_SPEEDS.length];
        if (typeof window.dgSetSetting === "function") window.dgSetSetting("voiceNoteSpeed", vnSpeed);
        vnApplyAll();
      });
      audio.insertAdjacentElement("afterend", pill);
    }
  }

  // ============================================================================================
  // shared scan, throttled like the rest of the codebase's DOM-driven features
  // ============================================================================================
  let lastScan = -1e9, scanTimer = 0;
  function scan() {
    scanNicknameRows();
    applyNicknameHeader();
    qrEnsure();
    sbEnsure();
    vnMark(document.body);
  }
  function scheduleScan() {
    const now = performance.now();
    if (now - lastScan < 250) {
      if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = 0; scan(); }, 260);
      return;
    }
    lastScan = now;
    scan();
  }

  onSettings((changed) => {
    if (changed.includes("quickRepliesShow") || changed.includes("quickReplies")) { qrEnsure(); if (changed.includes("quickReplies")) qrRender(); }
    if (changed.includes("x_nicknames")) { scanNicknameRows(); applyNicknameHeader(); }
    if (changed.includes("voiceNoteSpeed")) { vnSpeed = +setting("voiceNoteSpeed", 1) || 1; vnApplyAll(); }
  });

  (function start() {
    if (!document.body) return void setTimeout(start, 50);
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
    new MutationObserver(scheduleScan).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-dg-settling"] }); // settle end = chat ready for the chip row
    scan();
  })();
})();
