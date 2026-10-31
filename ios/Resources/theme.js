// App only: the "Look" settings (theme colour, accent, message style, hide-clutter toggles, reduce motion).
// Colours are pushed as CSS custom properties on :root (--dg-bg/--dg-surface/--dg-surface-2/--dg-surface-3/
// --dg-text/--dg-text-secondary/--dg-accent) that chat.css/header.css/newchat.css/snap.css read with
// `var(--dg-token, <original hex>)`, so with the default settings (theme "dark", accent "blue") every one of
// those files renders with the exact same literal colours as before this file existed - only a non-default
// choice changes anything. Message style / hide-clutter / reduce-motion are plain attribute/class flags that
// chat.css, header.css and theme.css itself key off; none of them touch an existing element unless its
// setting is turned on, for the same pixel-identical-by-default reason.
//
// Defensive note: this only does anything once settings.js (dgSetting/dgOnSettings) is wired into the page -
// see the report for what still needs adding to App.swift. Until then every dgSetting() call below falls
// back to its default, so nothing changes from today's look.
(() => {
  if (window.top !== window) return;

  const setting = (key, fallback) => (typeof window.dgSetting === "function" ? window.dgSetting(key, fallback) : fallback);
  const onSettings = (fn) => { if (typeof window.dgOnSettings === "function") window.dgOnSettings(fn); };

  const PALETTES = {
    dark: { bg: "#121212", surface: "#1e1e1e", surface2: "#1c1c1e", surface3: "#2c2c2e", text: "#ffffff", textSecondary: "#999999" },
    "true-black": { bg: "#000000", surface: "#0a0a0a", surface2: "#0a0a0a", surface3: "#141414", text: "#ffffff", textSecondary: "#9a9a9a" },
    midnight: { bg: "#0d1117", surface: "#161b22", surface2: "#141a21", surface3: "#1c232c", text: "#e6e8eb", textSecondary: "#9aa4af" },
  };
  const ACCENTS = { blue: "#0fadff", yellow: "#ffd60a", purple: "#a259ff", green: "#34c759", pink: "#ff2d78" };

  const root = document.documentElement;

  // The "dark" theme / "blue" accent are the current look, and its various files each spell that same look
  // with their own slightly different literal (chat.css's header is #1b1b1b, its bubbles are #1e1e1e, its
  // date pill text is #bbb, header.css's is #999, ...). Rather than pick one of those as "the" default and
  // force every var() user to that single value (which would visibly flatten those subtle differences even
  // with nothing changed in settings), the default case leaves every --dg-* custom property UNSET, so each
  // var(--dg-x, <its own original literal>) falls back to exactly what it always was. Only a non-default
  // theme/accent actually writes the properties.
  function applyTheme() {
    const themeKey = setting("theme", "dark");
    const accentKey = setting("accent", "blue");
    const s = root.style;
    const TOKENS = ["--dg-bg", "--dg-surface", "--dg-surface-2", "--dg-surface-3", "--dg-text", "--dg-text-secondary"];
    if (themeKey === "dark" || !PALETTES[themeKey]) {
      for (const t of TOKENS) s.removeProperty(t);
    } else {
      const pal = PALETTES[themeKey];
      s.setProperty("--dg-bg", pal.bg);
      s.setProperty("--dg-surface", pal.surface);
      s.setProperty("--dg-surface-2", pal.surface2);
      s.setProperty("--dg-surface-3", pal.surface3);
      s.setProperty("--dg-text", pal.text);
      s.setProperty("--dg-text-secondary", pal.textSecondary);
    }
    if (accentKey === "blue" || !ACCENTS[accentKey]) s.removeProperty("--dg-accent");
    else s.setProperty("--dg-accent", ACCENTS[accentKey]);
  }

  function applyMessageStyle() {
    root.toggleAttribute("data-dg-compact", setting("messageStyle", "blocks") === "compact");
  }

  function applyReduceMotion() {
    root.classList.toggle("dg-reduce-motion", !!setting("reduceMotion", false));
  }

  function applyHideFlags() {
    root.toggleAttribute("data-dg-hide-bell", !!setting("hideHeaderIcons", false));
    root.toggleAttribute("data-dg-hide-myai", !!setting("hideMyAI", false));
    root.toggleAttribute("data-dg-hide-banners", setting("hideBanners", true) !== false);
  }

  // ---- clutter detection (independent of glass.js, which already unconditionally hides the "My AI" search
  // shortcut and both promo banners - see report for what that means for these two toggles) ----
  function leaves(re) {
    const out = [];
    for (const e of document.querySelectorAll("body span, body a, body div, body p, body h1, body h2, body h3"))
      if (e.children.length === 0 && re.test(e.textContent.trim())) out.push(e);
    return out;
  }
  function markMyAIRow() {
    for (const t of leaves(/^My AI$/)) {
      const row = t.closest('[data-dg-sidebar] [role="listitem"]');
      if (row && !row.hasAttribute("data-dg-myai-row")) row.setAttribute("data-dg-myai-row", "");
    }
  }
  function markBanners() {
    for (const t of leaves(/^(Keep up with your friends|Click to install the Desktop App)/i)) {
      let e = t.parentElement, steps = 0;
      while (e && e !== document.body && steps++ < 8) {
        const r = e.getBoundingClientRect();
        if (r.height > 0 && r.height < 180) break;
        e = e.parentElement;
      }
      if (e && e !== document.body && !e.hasAttribute("data-dg-banner")) e.setAttribute("data-dg-banner", "");
    }
  }
  let lastScan = -1e9, scanTimer = 0;
  function scanClutter() {
    const now = performance.now();
    if (document.documentElement.classList.contains("dg-chat") || now - lastScan < 700) {
      if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = 0; scanClutter(); }, 720);
      return;
    }
    lastScan = now;
    markMyAIRow();
    markBanners();
  }

  function applyAll() {
    applyTheme();
    applyMessageStyle();
    applyReduceMotion();
    applyHideFlags();
  }
  applyAll();
  onSettings((changed) => {
    if (changed.some((k) => k === "theme" || k === "accent")) applyTheme();
    if (changed.includes("messageStyle")) applyMessageStyle();
    if (changed.includes("reduceMotion")) applyReduceMotion();
    if (changed.some((k) => k === "hideHeaderIcons" || k === "hideMyAI" || k === "hideBanners")) applyHideFlags();
  });

  let queued = false;
  const schedule = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; scanClutter(); }); };
  (function start() {
    if (!document.body) return void setTimeout(start, 50);
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
  })();
})();
