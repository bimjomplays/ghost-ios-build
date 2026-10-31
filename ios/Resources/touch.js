// App only: make the page feel like an app under a finger - no tap flash, no long-press menus or text
// selection on the interface, no double-tap zoom delay, no rubber-banding of the whole page, no hover
// styles that stick after a tap, pressed states instead, and chats that slide in.
(() => {
  if (window.top !== window) return;
  const css = `
    html, body { overscroll-behavior: none !important; }
    * { -webkit-tap-highlight-color: transparent !important; -webkit-touch-callout: none !important; }
    body { -webkit-user-select: none !important; user-select: none !important; touch-action: manipulation; }
    input, textarea, [contenteditable="true"], [contenteditable="true"] *,
    html.dg-chat li[data-dg-bubble], html.dg-chat li[data-dg-bubble] * {
      -webkit-user-select: text !important; user-select: text !important;
    }
    a, button, [role="button"], [role="listitem"], [data-dg-fill] { touch-action: manipulation !important; }
    img { -webkit-user-drag: none !important; }
    .ReactVirtualized__Grid, [data-dg-column] ul, [data-dg-column] [role="list"] {
      -webkit-overflow-scrolling: touch; overscroll-behavior: contain !important;
    }
    /* a tap leaves :hover stuck on touch screens: rows only light up while pressed */
    html.dg-glass.dg-list [data-dg-fill]:hover { background-color: #121212 !important; }
    html.dg-glass.dg-list [data-dg-fill]:active { background-color: #232323 !important; }
    /* Pressed look, set by the touch handler below (not :active + :has(): those made every page update slower and
       :active only shows after iOS's tap delay). Pictures, GIFs, stickers, message media and chat rows don't press in. */
    button, [role="button"] { transition: transform 0.12s ease, opacity 0.12s ease !important; }
    [data-dg-pressed] { transform: scale(0.94) !important; opacity: 0.75 !important; transition: transform 0.05s ease, opacity 0.05s ease !important; }
    button[data-dg-pressed][data-dg-newchat] { transform: scale(0.92) !important; }
    /* chats slide in from the right, the list fades back in */
    @keyframes dg-slide-in { from { transform: translateX(28%); opacity: 0; } to { transform: none; opacity: 1; } }
    @keyframes dg-fade-in { from { opacity: 0; } to { opacity: 1; } }
    html.dg-chat [data-dg-column] { animation: dg-slide-in 0.16s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
    /* Opening a chat: the pane (header + message box) slides in at once; only the messages wait until Snapchat has
       loaded them and chat.js has pinned them to the newest one, with placeholder bubbles shimmering meanwhile.
       (Holding back the whole pane hid the jump but made opening feel slow - device report 2026-09-21.) */
    html.dg-chat [data-dg-column] ul[id^="cv-"] { transition: opacity 0.12s ease; }
    html.dg-chat[data-dg-settling] [data-dg-column] ul[id^="cv-"] { opacity: 0 !important; transition: none; }
    html.dg-chat [data-dg-column] { position: relative; }
    html.dg-chat[data-dg-settling] [data-dg-column]::after {
      content: ""; position: absolute; left: 14px; right: 14px; bottom: 96px; height: 320px; pointer-events: none; z-index: 5;
      background:
        linear-gradient(100deg, transparent 30%, rgba(255, 255, 255, 0.06) 50%, transparent 70%) 0 0 / 200% 100% no-repeat,
        linear-gradient(var(--dg-surface, #1e1e1e), var(--dg-surface, #1e1e1e)) 0 0 / 62% 54px no-repeat,
        linear-gradient(var(--dg-surface, #1e1e1e), var(--dg-surface, #1e1e1e)) 0 70px / 44% 40px no-repeat,
        linear-gradient(var(--dg-surface, #1e1e1e), var(--dg-surface, #1e1e1e)) 0 126px / 70% 72px no-repeat,
        linear-gradient(var(--dg-surface, #1e1e1e), var(--dg-surface, #1e1e1e)) 0 214px / 38% 40px no-repeat,
        linear-gradient(var(--dg-surface, #1e1e1e), var(--dg-surface, #1e1e1e)) 0 270px / 56% 50px no-repeat;
      border-radius: 12px; animation: dg-shimmer 1.1s linear infinite;
    }
    @keyframes dg-shimmer { from { background-position: 150% 0, 0 0, 0 70px, 0 126px, 0 214px, 0 270px; } to { background-position: -50% 0, 0 0, 0 70px, 0 126px, 0 214px, 0 270px; } }
    html.dg-list:not(.dg-stories) [data-dg-sidebar] { animation: dg-fade-in 0.18s ease both; }
    @media (prefers-reduced-motion: reduce) {
      html.dg-chat [data-dg-column], html.dg-list [data-dg-sidebar], html.dg-chat [data-dg-column]::after { animation: none !important; }
    }`;
  let pressed = null, px = 0, py = 0;
  const release = () => { if (pressed) { pressed.removeAttribute("data-dg-pressed"); pressed = null; } };
  addEventListener("touchstart", (e) => {
    release();
    const t = e.touches[0], el = e.target.closest && e.target.closest('button, [role="button"]');
    if (!t || !el || e.touches.length > 1) return;
    if (el.closest('.dg-gif-panel, [data-dg-sidebar] .ReactVirtualized__Grid, #portal-container, ul[id^="cv-"]') || el.querySelector("img, video, canvas")) return;
    if (el.tagName !== "BUTTON" && el.closest("[data-dg-column]")) return; // (as before: no press-in on role=button elements in an open chat)
    pressed = el; px = t.clientX; py = t.clientY;
    el.setAttribute("data-dg-pressed", "");
  }, { capture: true, passive: true });
  addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (pressed && t && Math.hypot(t.clientX - px, t.clientY - py) > 10) release(); // a scroll, not a tap
  }, { capture: true, passive: true });
  addEventListener("touchend", () => setTimeout(release, 60), { capture: true, passive: true }); // long enough to be seen on a quick tap
  addEventListener("touchcancel", release, { capture: true, passive: true });
  // a light tap on the phone when a message goes out (the send arrow inside the message field), like the app;
  // the app skips it when haptics are switched off in Settings
  addEventListener("touchend", (e) => {
    const b = e.target.closest && e.target.closest("[data-dg-cmp-field] button");
    if (!b || e.changedTouches.length !== 1) return;
    try { window.webkit.messageHandlers.dg.postMessage({ op: "haptic", style: "light" }).catch(() => {}); } catch (err) {}
  }, { capture: true, passive: true });

  (function start() {
    if (!document.documentElement) return void setTimeout(start, 10);
    const style = document.createElement("style");
    style.textContent = css;
    document.documentElement.appendChild(style);
  })();
  // no pinch zoom (iOS ignores user-scalable=no for accessibility) and no long-press context menu
  for (const type of ["gesturestart", "gesturechange"]) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  document.addEventListener("contextmenu", (e) => {
    if (!e.target.closest("input, textarea, [contenteditable='true']")) e.preventDefault();
  });
  // app back gesture (edge swipe, from App.swift): leave stories, else close the open chat
  window.__dgBack = () => {
    if ((document.documentElement.classList.contains("dg-stories") || document.documentElement.classList.contains("dg-camera")) && window.__dgCloseStories) return window.__dgCloseStories();
    if (document.querySelector('[data-dg-column] form [role="searchbox"]') && !document.documentElement.classList.contains("dg-chat")) {
      document.querySelector("button[data-dg-newchat]")?.click(); // the New Chat sheet
      return "ok";
    }
    const close = document.querySelector('button[title="Close Chat"]');
    if (close) close.click();
    return close ? "ok" : "none";
  };
})();
