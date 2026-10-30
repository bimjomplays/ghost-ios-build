// App only. Logged out, Snapchat's pages swap the login form for "Download Snapchat" below ~700px, so
// they are laid out 820px wide (App.swift also sizes the web view to 820pt and scales it down). Snapchat
// Web itself (/web) runs at the phone's real width, without pinch or double-tap zoom, like the app.
(() => {
  if (window.top !== window) return;
  const WIDE = "width=820";
  const APP = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no";
  let want = location.pathname.startsWith("/web") ? APP : WIDE;
  let meta = null;
  const watchMeta = new MutationObserver(() => { if (meta.content !== want) meta.content = want; });
  function fix() {
    const m = document.head && document.head.querySelector('meta[name="viewport"]');
    if (!m) {
      if (!document.head) return false;
      const made = document.createElement("meta");
      made.name = "viewport"; made.content = want;
      document.head.prepend(made);
      return fix();
    }
    if (m.content !== want) m.content = want;
    if (m !== meta) { watchMeta.disconnect(); meta = m; watchMeta.observe(m, { attributes: true, attributeFilter: ["content"] }); }
    return true;
  }
  // App.swift calls this when the page moves between /web and the rest without a reload
  window.__dgViewport = (inApp) => { want = inApp ? APP : WIDE; fix(); };
  const early = new MutationObserver(() => { if (fix() && document.body) { early.disconnect(); headWatch(); } });
  early.observe(document, { childList: true, subtree: true });
  function headWatch() { new MutationObserver(fix).observe(document.head, { childList: true }); fix(); }
  fix();
})();
