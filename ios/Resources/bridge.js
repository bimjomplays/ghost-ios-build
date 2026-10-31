// App only, in the app's content world: tell App.swift whether a chat or stories are open (glass.js sets
// html.dg-chat / html.dg-list, stories.js html.dg-stories), so the tab bar hides like in the real app.
(() => {
  if (window.top !== window) return;
  let last = "";
  const report = () => {
    const c = document.documentElement.classList;
    // (a chat still being dragged open is not "open" for the native side yet: no tab-bar / resize mid-drag)
    const chat = c.contains("dg-chat") && document.documentElement.getAttribute("data-dg-peek") !== "open", stories = c.contains("dg-stories") || c.contains("dg-camera");
    // opening a chat ends stories / camera mode. Only touch the class list when there is something to
    // remove: WebKit reports a class mutation even for a no-op remove(), and this runs from a class
    // observer - unconditional, it looped forever and hung the page the moment a chat opened.
    if (chat && (c.contains("dg-stories") || c.contains("dg-camera"))) c.remove("dg-stories", "dg-camera");
    const camera = c.contains("dg-camera") && !chat;
    // the taken-snap screen has its own "back to camera" button top left, exactly where the app's close-camera X sits
    const preview = camera && !!document.querySelector('button[title^="Close snap preview"]');
    const key = `${chat}/${stories}/${camera}/${preview}`;
    if (key === last) return;
    last = key;
    if (chat && !window.__dgChatDumped) { // once per launch: the open-chat page, for troubleshooting from the PC
      window.__dgChatDumped = true;
      setTimeout(() => window.webkit.messageHandlers.dg.postMessage({ op: "dump", name: "chat" }).catch(() => {}), 2500);
    }
    window.webkit.messageHandlers.dg.postMessage({ op: "mode", chat, stories: stories && !chat, camera, preview }).catch(() => {});
  };
  // troubleshooting: what the page did after a chat row was tapped (read from the PC)
  const trail = (window.__dgTrail = []);
  let lastNote = "", repeats = 0;
  const note = (text) => {
    if (text === lastNote) { repeats++; return; } // identical lines in a row (error storms) are counted, not repeated
    if (repeats) { const n = repeats; repeats = 0; lastNote = ""; note("(previous line x" + (n + 1) + ")"); }
    lastNote = text;
    trail.push(Math.round(performance.now()) + " " + text); if (trail.length > 40) trail.shift();
    // kept by the app too (Documents/trail.txt): a page navigation would wipe this list
    window.webkit.messageHandlers.dg.postMessage({ op: "trail", text }).catch(() => {});
  };
  addEventListener("error", (e) => note("ERROR " + e.message + " @ " + String(e.filename || "").split("/").pop() + ":" + e.lineno
    + (e.error && e.error.stack ? " STACK " + String(e.error.stack).split("\n").slice(0, 4).join(" < ").slice(0, 500) : "")));
  addEventListener("unhandledrejection", (e) => note("REJECTION " + (e.reason && (e.reason.message || e.reason))));
  let lastPath = location.pathname;
  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; note("path " + lastPath); } }, 100);
  const where = (el) => {
    const parts = [];
    for (let e = el, i = 0; e && e.tagName && i < 5; e = e.parentElement, i++)
      parts.push(e.tagName.toLowerCase() + (e.getAttribute("role") ? "[" + e.getAttribute("role") + "]" : "") + (e.title ? "{" + e.title + "}" : ""));
    return parts.join("<");
  };
  let dumpTimer = 0;
  for (const type of ["touchend", "click"]) document.addEventListener(type, (e) => {
    const inList = !!(e.target.closest && e.target.closest("[data-dg-sidebar] .ReactVirtualized__Grid"));
    note(type + " " + where(e.target) + (inList ? " (chat list)" : "") + (e.defaultPrevented ? " PREVENTED" : ""));
    if (!inList) return;
    clearTimeout(dumpTimer);
    dumpTimer = setTimeout(() => window.webkit.messageHandlers.dg.postMessage({ op: "dump", name: "chattap",
      note: trail.join(" | ") + " | class " + document.documentElement.className + " | errors " + JSON.stringify(window.__dgErrorsCopy || []) }).catch(() => {}), 2500);
  }, true);
  let lastClass = "";
  new MutationObserver(() => {
    const now = document.documentElement.className;
    if (now !== lastClass) { lastClass = now; note("class " + now); }
  })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(() => note("REC " + document.documentElement.getAttribute("data-dg-rec")))
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-dg-rec"] });
  new MutationObserver(() => note("SNAPCLEAN " + document.documentElement.getAttribute("data-dg-snapclean")))
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-dg-snapclean"] });
  // does the just-filmed video really play with sound? (device report: silent on rewatch) - logged once per preview
  let lastPreview = "";
  setInterval(() => {
    const v = document.querySelector('video[loop][src^="blob:"]');
    if (!v || v.src === lastPreview || v.currentTime < 1) return;
    lastPreview = v.src;
    note("PREVIEW muted " + v.muted + " volume " + v.volume + " paused " + v.paused + " audioBytes " + v.webkitAudioDecodedByteCount
      + " videoBytes " + v.webkitVideoDecodedByteCount + " duration " + (v.duration || 0).toFixed(1));
  }, 700);
  note("start " + location.pathname);
  new MutationObserver(report).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-dg-peek"] });
  setInterval(report, 500);
  report();
})();
