// App only: streak warning. Snapchat puts an hourglass (⌛) next to a streak that is about to end; in the small web
// list that is easy to miss, so such a row gets an amber edge
// (Settings > Chats > "Highlight ending streaks"). Rows are recycled while the list scrolls, so only added
// nodes are looked at, and each row's mark is re-checked when its text changes.
(() => {
  if (window.top !== window) return;
  const HOURGLASS = /[⌛⏳]/; // ⌛ ⏳
  const on = () => !(window.dgSetting && window.dgSetting("streakWarn", true) === false);
  const check = (row) => {
    const risk = on() && HOURGLASS.test(row.textContent || "");
    if (risk !== row.hasAttribute("data-dg-streak-risk")) row.toggleAttribute("data-dg-streak-risk", risk);
  };
  const rowOf = (n) => n && n.nodeType === 1 ? (n.matches('[data-dg-sidebar] [role="listitem"]') ? n : n.closest('[data-dg-sidebar] [role="listitem"]')) : n && n.parentElement && rowOf(n.parentElement);
  const all = () => document.querySelectorAll('[data-dg-sidebar] [role="listitem"]').forEach(check);
  let pending = new Set(), queued = false;
  const flush = () => { queued = false; for (const r of pending) if (r.isConnected) check(r); pending = new Set(); };
  (function start() {
    if (!document.body) return void setTimeout(start, 100);
    new MutationObserver((records) => {
      if (!document.documentElement.classList.contains("dg-list")) return;
      for (const rec of records) {
        const r = rowOf(rec.target);
        if (r) pending.add(r);
        for (const n of rec.addedNodes) {
          if (n.nodeType !== 1) continue;
          const own = rowOf(n);
          if (own) pending.add(own);
          else if (n.querySelectorAll) n.querySelectorAll('[role="listitem"]').forEach((x) => pending.add(x));
        }
      }
      if (pending.size && !queued) { queued = true; requestAnimationFrame(flush); }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    all();
    const st = document.createElement("style");
    st.textContent = `
      html.dg-list [data-dg-streak-risk] { box-shadow: inset 3px 0 0 #ffb300 !important; }`;
    document.head.appendChild(st);
  })();
  if (window.dgOnSettings) window.dgOnSettings((changed) => { if (changed.includes("streakWarn")) all(); });
})();
