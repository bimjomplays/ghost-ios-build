// App only: performance overlay (Settings > Troubleshooting > Performance overlay). A small badge shows the frame
// rate and the slowest frame of the last second; every 10s one "PERF ..." line goes to trail.txt with the number
// of dropped frames (>34ms) and freezes (>100ms) and what screen was open, so jank reported on the phone can be
// matched to a place and a moment. Costs nothing while switched off (no loop runs).
(() => {
  if (window.top !== window) return;
  const html = document.documentElement;
  const post = (msg) => { try { window.webkit.messageHandlers.dg.postMessage(msg).catch(() => {}); } catch (e) {} };
  let badge = null, raf = 0, last = 0, frames = 0, worst = 0, secStart = 0, drops = 0, freezes = 0, worstLong = 0, logStart = 0;
  const screen = () => (html.classList.contains("dg-camera") ? "camera" : html.classList.contains("dg-stories") ? "stories"
    : html.classList.contains("dg-chat") ? "chat" : "list") + (html.hasAttribute("data-dg-settling") ? "+opening" : "");
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (last) {
      const dt = now - last;
      if (dt > worst) worst = dt;
      if (dt > 34) drops++;
      if (dt > 100) { freezes++; post({ op: "trail", text: "PERF freeze " + Math.round(dt) + "ms on " + screen() }); }
      if (dt > worstLong) worstLong = dt;
    }
    last = now; frames++;
    if (now - secStart >= 1000) {
      const fps = Math.round(frames * 1000 / (now - secStart));
      if (badge) badge.textContent = fps + " fps · worst " + Math.round(worst) + "ms";
      badge && badge.classList.toggle("dg-perf-bad", worst > 34);
      frames = 0; worst = 0; secStart = now;
    }
    if (now - logStart >= 10000) {
      post({ op: "trail", text: "PERF 10s on " + screen() + ": drops " + drops + ", freezes " + freezes + ", worst " + Math.round(worstLong) + "ms" });
      drops = 0; freezes = 0; worstLong = 0; logStart = now;
    }
  }
  function start() {
    if (raf) return;
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "dg-perf-badge";
      const st = document.createElement("style");
      st.textContent = ".dg-perf-badge{position:fixed;top:6px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;"
        + "font:600 12px/1 -apple-system,system-ui,sans-serif;color:#9fe29f;background:rgba(0,0,0,.72);padding:5px 9px;border-radius:9px}"
        + ".dg-perf-badge.dg-perf-bad{color:#ff8a80}";
      badge.appendChild(st);
    }
    (document.body || html).appendChild(badge);
    last = 0; frames = 0; secStart = logStart = performance.now();
    raf = requestAnimationFrame(tick);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (badge) badge.remove();
  }
  const apply = () => (window.dgSetting && window.dgSetting("perfOverlay", false) ? start() : stop());
  if (window.dgOnSettings) window.dgOnSettings((changed) => { if (changed.includes("perfOverlay")) apply(); });
  (function wait() { if (!document.body) return void setTimeout(wait, 100); apply(); })();
})();
