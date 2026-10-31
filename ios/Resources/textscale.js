// App only: bigger text and chat-list Bitmojis without zooming the rest (Snapchat Web's are small on a
// phone next to the real app). Every element that sets its own font size gets it multiplied by FACTOR as
// an inline style; elements that only inherit a size are left alone so nothing is scaled twice. Bitmojis
// and the camera icons in the chat list get a transform (AVATAR, CAMERA), which keeps the rows' layout.
//
// Perf (rig measurement, list2.html, 30 freshly-rendered rows, 2026-09-23): the old single TreeWalker pass
// called avatar()/camera() (getBoundingClientRect - needs layout) and scale() (writes font-size - dirties
// layout) interleaved in document order, so almost every row forced a synchronous reflow for the next
// row's rect read. Split into two passes per flush: geometry first (avatar/camera - read rect, write only
// a non-layout `transform`, so nothing after them needs a fresh layout), then text (scale() - never reads
// geometry, only writes font-size/line-height). ~1.97ms -> see DEV_NOTES/report for the after number;
// verified with the same computed-style diff as the smoothness pass (identical output, just reordered).
//
// Text size (Look setting "textSize", 0.85-1.3, default 1): multiplies the *text* factors only (not the
// avatar/camera image scaling, which isn't "text"). Re-applied live via dgOnSettings without re-scanning
// the DOM: every scaled element keeps its pre-scale size (and line-height) in the MARK attribute, so a
// setting change just re-computes from that.
(() => {
  if (window.top !== window) return;
  const FACTOR_BASE = 1.42;
  const AVATAR = 1.1;
  const CAMERA = 1.65;
  const BADGE = 0.85; // friend emoji on the Bitmojis
  const SUBTEXT_BASE = 1.34; // chat list: the small Opened / Delivered line under the names
  const HEADER_BASE = 1.7; // chat header name: bigger
  const MARK = "data-dg-fs";
  const LIST = ".ReactVirtualized__Grid__innerScrollContainer";

  const dgSetting_ = (key, fallback) => (typeof window.dgSetting === "function" ? window.dgSetting(key, fallback) : fallback);
  let userScale = +dgSetting_("textSize", 1) || 1;
  if (typeof window.dgOnSettings === "function") {
    window.dgOnSettings((changed, values) => {
      if (!changed.includes("textSize")) return;
      userScale = +values.textSize || 1;
      reapplyTextSize();
    });
  }

  // the box around a chat-list Bitmoji (not the small emoji badges), grown in place
  function avatar(img) {
    if (img.hasAttribute("data-dg-avatar") || !img.closest(LIST)) return;
    const w = img.getBoundingClientRect().width;
    if (!w) return void img.addEventListener("load", () => avatar(img), { once: true });
    if (w < 30) {
      img.setAttribute("data-dg-avatar", "");
      img.style.setProperty("transform", `scale(${BADGE})`, "important");
      return;
    }
    let box = img;
    while (box.parentElement && box.parentElement.getBoundingClientRect().width <= w + 8) box = box.parentElement;
    img.setAttribute("data-dg-avatar", "");
    box.style.setProperty("transform", `scale(${AVATAR})`, "important");
  }

  function scaledAncestor(el) {
    for (let p = el.parentElement; p; p = p.parentElement) if (p.hasAttribute(MARK)) return p;
    return null;
  }

  // the camera button icon at the right end of each chat row (not the small status icons by the text)
  function camera(svg) {
    if (svg.hasAttribute("data-dg-cam")) return;
    const list = svg.closest(LIST);
    if (!list) return;
    const r = svg.getBoundingClientRect(), l = list.getBoundingClientRect();
    if (!r.width || r.width < 14 || r.left < l.left + l.width * 0.7) return;
    svg.setAttribute("data-dg-cam", "");
    svg.style.setProperty("transform", `scale(${CAMERA})`, "important");
    svg.style.setProperty("overflow", "visible", "important");
  }

  function textFactor(size, inList, inHeader) {
    return (size < 15 && inList ? SUBTEXT_BASE : inHeader ? HEADER_BASE : FACTOR_BASE) * userScale;
  }

  function scale(el) {
    if (el.hasAttribute(MARK) || el.closest("svg")) return;
    // the story viewer's header has its own sizes (stories.css); scaling those again made the name huge
    if (el.closest('div:has(~ [aria-label="media content"])')) return;
    if (el.closest('[data-dg-apphead] [role="listbox"]')) return; // settings menu: sized by header.css
    if (el.closest('div:has(> [role="textbox"]) > div:has(header)')) return; // "replying to" quote in the message box: sized by chat.css
    if (el.closest('[data-dg-actionmenu]')) return; // long-press menu: sized by gestures.css
    // friend emoji badge on a Bitmoji (a text emoji in a small circle next to the <img>): smaller, not
    // bigger, and centred in its circle - scaled up it hung out of the bottom of the circle
    const badge = el.parentElement;
    if (badge && badge.previousElementSibling && badge.previousElementSibling.tagName === "IMG" && el.closest(LIST)) {
      el.setAttribute(MARK, "badge");
      el.style.setProperty("font-size", "12.5px", "important");
      el.style.setProperty("line-height", "1", "important");
      el.style.setProperty("display", "block", "important");
      badge.style.setProperty("display", "flex", "important");
      badge.style.setProperty("align-items", "center", "important");
      badge.style.setProperty("justify-content", "center", "important");
      return;
    }
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    if (!size) return;
    const anc = scaledAncestor(el);
    if (anc && parseFloat(getComputedStyle(anc).fontSize) === size) return; // inherited, already scaled
    const inList = !!el.closest(LIST);
    const inHeader = !!el.closest("[data-dg-header]");
    const inChat = !!el.closest('[data-dg-column] ul[id^="cv-"]');
    const lh = parseFloat(cs.lineHeight);
    const f = textFactor(size, inList, inHeader);
    el.setAttribute(MARK, size + (lh ? "," + lh : "")); // base size (and line-height) kept for text-size setting changes
    el.style.setProperty("font-size", (size * f).toFixed(2) + "px", "important");
    // chat messages: Snapchat Web's airy desktop line spacing becomes the app's tighter one
    if (inChat) el.style.setProperty("line-height", (size * f * 1.28).toFixed(2) + "px", "important");
    else if (lh) el.style.setProperty("line-height", (lh * f).toFixed(2) + "px", "important");
  }

  function reapplyTextSize() {
    for (const el of document.querySelectorAll("[" + MARK + "]")) {
      const raw = el.getAttribute(MARK);
      if (raw === "badge") continue; // badge sizing isn't part of the text-size setting
      const [sizeStr, lhStr] = raw.split(",");
      const size = parseFloat(sizeStr);
      if (!size) continue;
      const inList = !!el.closest(LIST);
      const inHeader = !!el.closest("[data-dg-header]");
      const inChat = !!el.closest('[data-dg-column] ul[id^="cv-"]');
      const f = textFactor(size, inList, inHeader);
      el.style.setProperty("font-size", (size * f).toFixed(2) + "px", "important");
      if (inChat) el.style.setProperty("line-height", (size * f * 1.28).toFixed(2) + "px", "important");
      else if (lhStr) el.style.setProperty("line-height", (parseFloat(lhStr) * f).toFixed(2) + "px", "important");
    }
  }

  const hasText = (el) => {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.data.trim()) return true;
    return /^(INPUT|TEXTAREA|BUTTON)$/.test(el.tagName) || el.isContentEditable;
  };

  // One TreeWalker pass per newly-added root sorts every element into two buckets (a single walk is
  // cheaper than two); then geometry (avatar/camera - needs a fresh layout to read rects, but only ever
  // writes a non-layout `transform`) runs fully before text (scale() - never reads geometry, only writes
  // font-size/line-height, which would otherwise dirty layout for the NEXT rect read above). See the perf
  // note at the top of the file.
  function collect(root, imgs, svgs, texts) {
    if (root.nodeType !== 1) return;
    const bucket = (el) => {
      if (el.tagName === "IMG") imgs.push(el);
      else if (el.tagName.toLowerCase() === "svg") svgs.push(el);
      else if (hasText(el)) texts.push(el);
    };
    bucket(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) bucket(el);
  }

  let pending = new Set(), queued = false;
  const flush = () => {
    queued = false;
    const roots = [...pending].filter((r) => r.isConnected);
    pending = new Set();
    const imgs = [], svgs = [], texts = [];
    for (const r of roots) collect(r, imgs, svgs, texts);
    for (const el of imgs) avatar(el);
    for (const el of svgs) camera(el);
    for (const el of texts) scale(el);
  };
  (function start() {
    if (!document.body) return void setTimeout(start, 50);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "characterData") { if (r.target.parentElement) pending.add(r.target.parentElement); }
        else for (const n of r.addedNodes) pending.add(n.nodeType === 1 ? n : n.parentElement);
      }
      pending.delete(null);
      if (!queued) { queued = true; requestAnimationFrame(flush); }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    const imgs = [], svgs = [], texts = [];
    collect(document.body, imgs, svgs, texts);
    for (const el of imgs) avatar(el);
    for (const el of svgs) camera(el);
    for (const el of texts) scale(el);
  })();
})();
