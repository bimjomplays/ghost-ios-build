// App only: keep Snapchat's page grid as tall as the window. It is `position: absolute; inset: 0`, and on
// some launches the web view's layout viewport came out about half the screen tall (window.innerHeight
// was right), which left Snapchat in its two-pane desktop layout until a reload.
(() => {
  if (window.top !== window) return;
  let root = null;
  function fit() {
    if (!root || !root.isConnected) {
      root = null;
      const main = document.querySelector("main");
      for (const el of main ? main.children : []) {
        const cs = getComputedStyle(el);
        if (cs.position === "absolute" && cs.display === "grid") { root = el; break; }
      }
      if (!root) return;
    }
    const short = root.getBoundingClientRect().height < innerHeight - 2;
    if (short || root.style.height) {
      root.style.setProperty("height", innerHeight + "px", "important");
      root.style.setProperty("bottom", "auto", "important");
    }
  }
  addEventListener("resize", fit);
  setInterval(fit, 400);
  // check every frame while the page starts up, so a short grid is fixed before it is seen
  const until = performance.now() + 8000;
  (function early() { fit(); if (performance.now() < until) requestAnimationFrame(early); })();

  // and don't show Snapchat Web at all until glass.js has switched it to the one-pane phone layout
  // (html.dg-list / dg-chat): no flash of the desktop two-pane view. Gives up after 6s so nothing can
  // stay hidden.
  if (location.pathname.startsWith("/web")) {
    const style = document.createElement("style");
    style.textContent = "body { transition: opacity 0.18s ease; } "
      + "html:not(.dg-list):not(.dg-chat):not(.dg-show) body { opacity: 0 !important; transition: none; }";
    (function add() {
      if (!document.documentElement) return void setTimeout(add, 10);
      document.documentElement.appendChild(style);
    })();
    setTimeout(() => document.documentElement.classList.add("dg-show"), 6000);
  }
})();
