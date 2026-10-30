// Mobile fork: solid dark styling in Safari tabs and app wrappers.
(function () {
  if (window.top !== window) return;
  document.documentElement.classList.add("dg-glass");
  const keepDark = () => {
    if (document.documentElement.getAttribute("theme") !== "dark")
      document.documentElement.setAttribute("theme", "dark");
  };
  keepDark();
  new MutationObserver(keepDark).observe(document.documentElement, {
    attributes: true, attributeFilter: ["theme"],
  });

  // Declutter: hide the "Keep up with your friends" / "Install the Desktop App" banners (the empty camera pane
  // is gone via the single-pane layout below). Snapchat's class names are hashed and change, so find by text.
  const HIDDEN = "data-dg-hidden";
  const leaves = (re) =>
    [...document.querySelectorAll("body span, body a, body div, body p, body h1, body h2, body h3")].filter(
      (e) => e.children.length === 0 && re.test(e.textContent.trim())
    );
  const opaque = (e) => {
    const bg = getComputedStyle(e).backgroundColor;
    return bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg);
  };

  // The banner search walks every span/div on the page; with a long chat open that is thousands of elements on
  // every page update (new message, typing, timestamps). The banners only change on the chat list, so it runs
  // at most every 700ms there and not at all while a chat is open.
  let lastBannerScan = -1e9, bannerTimer = 0;
  function declutter() {
    const now = performance.now();
    const inChat = document.documentElement.classList.contains("dg-chat");
    if (inChat || now - lastBannerScan < 700) {
      if (!inChat && !bannerTimer) bannerTimer = setTimeout(() => { bannerTimer = 0; declutter(); }, 720);
      disableCompactMode();
      layout();
      // layout() may just have closed the chat (dg-chat -> dg-list): then scan now instead of waiting for another update
      if (!inChat || document.documentElement.classList.contains("dg-chat")) return;
    }
    lastBannerScan = now;
    const hide = new Set();
    // banners at the top of the chat list: the first painted ancestor, as long as it's banner-sized
    // "My AI" shortcut button inside the search field (only the button - the field itself stays)
    for (const t of leaves(/^My AI$/i)) {
      const btn = t.closest("button, [role='button'], a");
      if (btn && btn.getBoundingClientRect().width < 200) hide.add(btn);
    }
    for (const t of leaves(/^(Keep up with your friends|Click to install the Desktop App)/i)) {
      let e = t.parentElement;
      while (e && e !== document.body && !opaque(e)) e = e.parentElement;
      if (e && e !== document.body && e.getBoundingClientRect().height < 180) hide.add(e);
    }
    for (const e of document.querySelectorAll("[" + HIDDEN + "]")) if (!hide.has(e)) e.removeAttribute(HIDDEN);
    disableCompactMode();
    layout();
    for (const e of hide) if (!e.hasAttribute(HIDDEN)) e.setAttribute(HIDDEN, "");
  }

  // Phone-style single pane: the chat list alone fills the window; opening a chat (URL /web/<id>) swaps to the
  // conversation full-width, and its "Close Chat" button (URL back to /web) returns to the list. Snapchat's
  // grid is two columns (list | conversation) - collapse it to one and show one child at a time.
  let sidebar = null, column = null, storiesHeight = 0;
  function layout() {
    if (!sidebar || !sidebar.isConnected || !column || !column.isConnected) {
      sidebar = column = null;
      // Anchor on the chat list's own "My AI" search button, climb to the full-height child of the page grid,
      // and only accept it if it comes before / left of the other pane. Anything unexpected -> leave Snapchat's
      // layout alone.
      const anchor = leaves(/^My AI$/i)[0];
      const otherPane = (el) =>
        [...el.parentElement.children].find((k) => k !== el && k.children.length && getComputedStyle(k).position !== "fixed");
      let e = anchor;
      while (e && e.parentElement && e.parentElement !== document.body) {
        if (getComputedStyle(e.parentElement).display === "grid" && e.getBoundingClientRect().height > innerHeight * 0.5 && otherPane(e)) break;
        e = e.parentElement;
      }
      if (!e || !e.parentElement || e.parentElement === document.body) return clearLayout();
      const root = e.parentElement;
      const col = otherPane(e);
      const kids = [...root.children];
      const er = e.getBoundingClientRect(), cr = col.getBoundingClientRect();
      if (kids.indexOf(e) > kids.indexOf(col) || er.width <= 0 || (cr.width > 0 && er.left > cr.left)) return clearLayout();
      sidebar = e;
      column = col;
      root.setAttribute("data-dg-root", "");
      sidebar.setAttribute("data-dg-sidebar", "");
      column.setAttribute("data-dg-column", "");
    }
    const chatOpen = location.pathname.replace(/\/+$/, "") !== "/web";
    const html = document.documentElement;
    const prev = html.classList.contains("dg-chat") ? "chat" : html.classList.contains("dg-list") ? "list" : "";
    const changed = prev !== (chatOpen ? "chat" : "list");
    html.classList.toggle("dg-chat", chatOpen);
    html.classList.toggle("dg-list", !chatOpen);
    // the chat list is react-virtualized: a resize event makes it re-measure its (now wider) container
    if (changed) setTimeout(() => dispatchEvent(new Event("resize")), 0);
    // Coming back from a chat, Snapchat restores the list slightly scrolled (the removed stories strip's height plus a
    // bit), which cut off the top chat. Snap back to the top if it's only that small offset.
    if (changed && !chatOpen && prev === "chat") {
      const snapTop = () => {
        const g = sidebar && sidebar.querySelector(".ReactVirtualized__Grid");
        if (g && g.scrollTop > 0 && g.scrollTop <= 260) g.scrollTop = 0;
      };
      for (const ms of [60, 250, 600]) setTimeout(snapTop, ms);
    }
    if (!chatOpen) {
      fillRows();
      glassifyList();
    }
    else {
      flattenChat();
      markBubbles();
    }
  }

  // Conversation view: Snapchat draws a solid header strip and an inset, rounded card (10px margin, 20px radius)
  // - inside our rounded glass window that gave doubled, mismatched edges. Make the card full-bleed and flat
  // and let the header sit directly on the glass with a hairline divider.
  function flattenChat() {
    if (!column) return;
    const cr = column.getBoundingClientRect();
    if (cr.width <= 0) return;
    const pane = [...column.querySelectorAll("div")].find((d) => {
      const r = d.getBoundingClientRect();
      return r.width >= cr.width * 0.9 && r.height >= cr.height * 0.6 && parseFloat(getComputedStyle(d).borderTopLeftRadius) >= 12;
    });
    if (pane && !pane.hasAttribute("data-dg-flat")) {
      pane.setAttribute("data-dg-flat", "");
      for (let p = pane.parentElement; p && p !== column.parentElement; p = p.parentElement) p.setAttribute("data-dg-nopad", "");
    }
    // Photo/video viewer: Snapchat splits the conversation grid into two rows (grid areas "main" = chat,
    // "secondary" = viewer), which squeezes the media into the top half. Stack both in one full-height cell with
    // the viewer on top.
    // (viewer is 2 levels below the column: column > conversation grid > viewer - only scan shallow levels, this
    // runs on every DOM change and long chats have thousands of nodes)
    for (const k of column.querySelectorAll(":scope > * > *, :scope > * > * > *")) {
      const area = getComputedStyle(k).gridRowStart;
      if (area === "secondary" && !k.hasAttribute("data-dg-viewer")) {
        k.setAttribute("data-dg-viewer", "");
        if (k.parentElement) k.parentElement.setAttribute("data-dg-chatgrid", "");
      }
    }
    const close = column.querySelector('button[title="Close Chat"]');
    if (close) {
      let h = close.parentElement;
      while (h && h !== column && !(h.getBoundingClientRect().width >= cr.width * 0.9 && opaque(h))) h = h.parentElement;
      if (h && h !== column && !h.hasAttribute("data-dg-header")) h.setAttribute("data-dg-header", "");
    }
  }

  // Chat rows and the stories strip have a fixed 340px width (the old list column) - stretch them. Rows are
  // recreated while scrolling, so this runs on every DOM change (cheap: skips already-marked elements).
  function fillRows() {
    if (!sidebar) return; // (rows only qualify when their parent is wider, so narrow windows are fine)
    watchResize();
    // Only the list items themselves: direct children of the virtualized list's absolutely positioned item wrappers.
    // (Checking any ~340px element also caught the text column mid-resize and drew a card inside the card.)
    for (const k of sidebar.querySelectorAll(".ReactVirtualized__Grid__innerScrollContainer > div > div")) {
      if (k.hasAttribute("data-dg-fill")) continue;
      const w = k.getBoundingClientRect().width;
      if (w >= 336 && w <= 344 && k.parentElement.getBoundingClientRect().width >= w + 30) k.setAttribute("data-dg-fill", "");
    }
    // Stories strip: hidden, and the list pulled up by its height. Snapchat only includes the strip at some window
    // sizes, so work out on every update whether it is part of the list right now (a remembered height kept
    // shifting the list after a resize removed the strip, cutting off the top chats):
    //  - an item at top 0 that is taller than a chat row -> that's the strip, shift by its height
    //  - an item at top 0 that is a normal row -> no strip, no shift
    //  - scrolled (nothing at top 0): chat rows sit at stripHeight + n*rowHeight, so a row offset of 0 means no strip
    const inner = sidebar.querySelector(".ReactVirtualized__Grid__innerScrollContainer");
    if (inner) {
      const wraps = [...inner.children];
      const heights = wraps.map((w) => parseFloat(w.style.height)).filter((h) => h > 0);
      const rowH = heights.length ? Math.min(...heights) : 0;
      let strip = storiesHeight;
      const first = wraps.find((w) => w.style.top === "0px");
      if (first) {
        const h = parseFloat(first.style.height);
        strip = rowH && h > rowH + 10 ? h : 0;
      } else if (rowH) {
        const row = wraps.find((w) => Math.abs(parseFloat(w.style.height) - rowH) < 1);
        if (row && Math.round(parseFloat(row.style.top)) % Math.round(rowH) === 0) strip = 0;
      }
      storiesHeight = strip;
      for (const w of wraps) {
        const isStrip = strip > 0 && w.style.top === "0px";
        if (isStrip !== w.hasAttribute("data-dg-stories")) w.toggleAttribute("data-dg-stories", isStrip);
      }
      const shift = -strip + "px";
      if (inner.style.getPropertyValue("--dg-stories-shift") !== shift) inner.style.setProperty("--dg-stories-shift", shift);
    }
  }
  // Below 850px wide Snapchat switches to a compact avatar-only list (@media (max-width: 850px) rules). The app
  // window is meant to be narrow with the full list, so switch those rules off (also in sheets loaded later).
  const seenSheets = new WeakSet();
  function disableCompactMode() {
    for (const sheet of document.styleSheets) {
      if (seenSheets.has(sheet)) continue;
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (err) {
        continue;
      }
      seenSheets.add(sheet);
      for (const r of rules)
        if (r instanceof CSSMediaRule && /^\s*(screen and )?\(max-width:\s*850px\)\s*$/.test(r.conditionText)) r.media.mediaText = "not all";
    }
  }

  // List view: Snapchat paints its top bar and search field in solid greys (#191919 / #303030), which render as
  // opaque strips on the glass. Wide solid-grey blocks become clear glass with a hairline; wide rounded pills
  // (search) become frosted glass with a glossy rim. Throttled - the virtualized list mutates while scrolling.
  let lastGlassify = 0, glassifyTimer = 0;
  function glassifyList() {
    const now = performance.now();
    if (!sidebar) return;
    if (now - lastGlassify < 400) {
      if (!glassifyTimer) glassifyTimer = setTimeout(() => ((glassifyTimer = 0), glassifyList()), 450);
      return;
    }
    lastGlassify = now;
    const sw = sidebar.getBoundingClientRect().width;
    if (sw <= 0) return;
    // divider line directly above the chat list (the first card sat on it): drop borders that end where the list starts
    const grid = sidebar.querySelector(".ReactVirtualized__Grid");
    if (grid) {
      const top = grid.getBoundingClientRect().top;
      for (const el of sidebar.querySelectorAll("div, nav, section")) {
        if (el.hasAttribute("data-dg-noline")) continue;
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        if (r.width < sw * 0.8) continue;
        // (a Snapchat border, or the hairline our own data-dg-clear style adds)
        const bottomLine = (parseFloat(cs.borderBottomWidth) > 0 || el.hasAttribute("data-dg-clear")) && Math.abs(r.bottom - top) <= 4;
        const topLine = parseFloat(cs.borderTopWidth) > 0 && Math.abs(r.top - top) <= 4;
        if (bottomLine || topLine) el.setAttribute("data-dg-noline", "");
      }
    }
    for (const el of sidebar.querySelectorAll("div, header, nav, form, label, button")) {
      if (el.hasAttribute("data-dg-clear") || el.hasAttribute("data-dg-pill") || el.hasAttribute("data-dg-faint") || el.hasAttribute(HIDDEN)) continue;
      const r = el.getBoundingClientRect();
      // small solid-grey discs/bars (empty story placeholders, grey round icon buttons) -> faint glass
      if (r.width > 0 && r.width <= 64 && r.height <= 64) {
        const sm = getComputedStyle(el).backgroundColor.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
        if (sm) {
          const lo = Math.min(+sm[1], +sm[2], +sm[3]), hi = Math.max(+sm[1], +sm[2], +sm[3]);
          if (hi - lo < 10 && hi >= 21 && hi <= 70 && (parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0) >= 4)
            el.setAttribute("data-dg-faint", "");
        }
        continue;
      }
      if (r.width < sw * 0.6 || r.height < 28 || r.height > 140) continue;
      const m = getComputedStyle(el).backgroundColor.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
      if (!m) continue;
      const [rr, gg, bb] = [+m[1], +m[2], +m[3]];
      const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
      const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
      const pillShape = radius >= 10 && r.height <= 64;
      // faint white overlays (e.g. the search field's 10% white) are just past the glass threshold -> frosted pill
      if (alpha < 0.9) {
        if (pillShape && Math.min(rr, gg, bb) >= 200 && alpha >= 0.05 && alpha <= 0.3) el.setAttribute("data-dg-pill", "");
        continue;
      }
      const grey = Math.max(rr, gg, bb) - Math.min(rr, gg, bb) < 10;
      const lum = Math.max(rr, gg, bb);
      if (!grey || lum < 21 || lum > 80) continue; // leave glass (<8%), coloured and light surfaces alone
      el.setAttribute(pillShape ? "data-dg-pill" : "data-dg-clear", "");
    }
  }

  // Conversation: each run of messages from one person is an <li> with a grey fill, 1px border and grouped rounded
  // corners. Mark them so CSS can render them as dark glass bubbles. Throttled with a trailing run (the message
  // list keeps mutating while it loads/scrolls).
  let lastBubbles = 0, bubblesTimer = 0;
  function markBubbles() {
    if (!column) return;
    const now = performance.now();
    if (now - lastBubbles < 400) {
      if (!bubblesTimer) bubblesTimer = setTimeout(() => ((bubblesTimer = 0), markBubbles()), 450);
      return;
    }
    lastBubbles = now;
    for (const li of column.querySelectorAll("li:not([data-dg-bubble])")) {
      const cs = getComputedStyle(li);
      const m = cs.backgroundColor.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
      if (!m) continue;
      const hi = Math.max(+m[1], +m[2], +m[3]), lo = Math.min(+m[1], +m[2], +m[3]);
      const rounded = ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"].some(
        (k) => parseFloat(cs[k]) >= 6
      );
      if (hi - lo < 12 && hi >= 5 && hi <= 70 && rounded && parseFloat(cs.borderTopWidth) >= 1 && li.textContent.trim())
        li.setAttribute("data-dg-bubble", "");
    }
  }

  // The chat list (react-virtualized AutoSizer) measures its container through hidden scroll "resize triggers"
  // and lagged behind window resizes (cut off / not filling). Watch the pane with a ResizeObserver and poke those
  // triggers on every size change so it re-measures right away.
  let resizeObs = null, observed = null;
  function watchResize() {
    if (!sidebar || observed === sidebar) return;
    if (resizeObs) resizeObs.disconnect();
    observed = sidebar;
    resizeObs = new ResizeObserver(() => {
      if (!sidebar) return;
      for (const t of sidebar.querySelectorAll(".expand-trigger, .contract-trigger")) t.dispatchEvent(new Event("scroll"));
      fillRows();
    });
    resizeObs.observe(sidebar);
  }

  function clearLayout() {
    sidebar = column = null;
    document.documentElement.classList.remove("dg-chat", "dg-list");
    for (const a of ["data-dg-root", "data-dg-sidebar", "data-dg-column"])
      for (const el of document.querySelectorAll("[" + a + "]")) el.removeAttribute(a);
  }
  addEventListener("popstate", () => schedule());

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      declutter();
    });
  };
  (function observe() {
    if (!document.body) return void setTimeout(observe, 50);
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
    schedule();
  })();
})();
