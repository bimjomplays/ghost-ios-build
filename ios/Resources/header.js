// App only: chat list header like the real app. The Snapchat ghost in the middle becomes a "Chat" title,
// the add-friend button turns yellow, and "New Chat" becomes the yellow round button floating in the
// bottom-right corner. Everything is found from the "New Chat" button, so nothing depends on
// Snapchat's generated class names.
(() => {
  if (window.top !== window) return;
  const css = `
    html.dg-list button[data-dg-newchat] {
      position: fixed !important; right: 20px !important; bottom: 20px !important; z-index: 50 !important;
      width: 76px !important; height: 76px !important; border-radius: 50% !important;
      background: #fffc00 !important; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35) !important;
      display: flex !important; align-items: center !important; justify-content: center !important;
    }
    html.dg-list button[data-dg-newchat] svg { transform: scale(1.7) !important; overflow: visible !important; }
    html.dg-list button[data-dg-newchat] svg :is(path, circle, rect) { fill: #000 !important; }
    html.dg-chat button[data-dg-newchat] { display: none !important; }
    /* New Chat: Snapchat renders its "To:" sheet inside the conversation pane, which the phone layout hides
       on the chat list. While it is open, show just that sheet, full screen, and turn the yellow button
       into its close button (top right). */
    html.dg-list:has([data-dg-column] form [role="searchbox"]) [data-dg-column] {
      display: grid !important; visibility: hidden !important; z-index: 4 !important;
    }
    html.dg-list [data-dg-column] div:has(> div > form [role="searchbox"]) {
      visibility: visible !important; position: fixed !important; inset: 0 !important;
      /* Snapchat gives it align-self: flex-start, which in WebKit shrinks it to its content (58px) */
      align-self: stretch !important; justify-self: stretch !important;
      width: 100% !important; height: 100% !important; max-width: none !important; max-height: none !important;
      background: var(--dg-bg, #121212) !important; z-index: 102 !important;
    }
    html.dg-list [data-dg-column] div:has(> form [role="searchbox"]) {
      width: 100% !important; height: 100% !important; max-width: none !important; max-height: none !important;
      border-radius: 0 !important; box-shadow: none !important; box-sizing: border-box !important;
      display: flex !important; flex-direction: column !important;
    }
    html.dg-list [data-dg-column] form:has([role="searchbox"]) {
      width: 100% !important; height: 100% !important; flex: 1 1 auto !important; min-height: 0 !important;
      max-width: none !important; max-height: none !important; box-sizing: border-box !important;
      border: 0 !important; border-radius: 0 !important; box-shadow: none !important;
    }
    html.dg-list:has([data-dg-column] form [role="searchbox"]) [data-dg-sidebar] {
      visibility: hidden !important; z-index: 5 !important; animation: none !important;
    }
    html.dg-list:has([data-dg-column] form [role="searchbox"]) button[data-dg-newchat] {
      visibility: visible !important; top: 8px !important; right: 12px !important; bottom: auto !important;
      width: 42px !important; height: 42px !important; background: #2b2b2b !important; box-shadow: none !important;
    }
    html.dg-list:has([data-dg-column] form [role="searchbox"]) button[data-dg-newchat] svg { transform: none !important; }
    html.dg-list:has([data-dg-column] form [role="searchbox"]) button[data-dg-newchat] svg :is(path, circle, rect) { fill: #fff !important; }
    /* search: a round button next to your Bitmoji (like the app); tapping it opens the full-width field */
    html.dg-list [data-dg-sidebar] { position: relative !important; }
    html.dg-list [data-dg-sidebar] :has(> [data-dg-pill]) {
      position: absolute !important; top: 8px !important; left: 72px !important; z-index: 6 !important;
      width: 44px !important; height: 44px !important; min-height: 0 !important;
      padding: 0 !important; margin: 0 !important; border: 0 !important; background: none !important;
    }
    html.dg-list [data-dg-sidebar] :has(> [data-dg-pill]) > :not([data-dg-pill]) { display: none !important; }
    html.dg-list [data-dg-pill] {
      width: 44px !important; height: 44px !important; min-height: 0 !important; border-radius: 22px !important;
      padding: 0 !important; margin: 0 !important; overflow: hidden !important; box-sizing: border-box !important;
      display: flex !important; align-items: center !important; position: relative !important;
    }
    html.dg-list [data-dg-pill] > :first-child {
      flex: 0 0 44px !important; width: 44px !important; margin: 0 !important; padding: 0 !important;
      display: flex !important; align-items: center !important; justify-content: center !important;
    }
    html.dg-list [data-dg-pill] > :first-child svg { transform: scale(1.35) !important; }
    html.dg-list [data-dg-pill]:not(:focus-within) input {
      position: absolute !important; inset: 0 !important; width: 44px !important; height: 44px !important;
      opacity: 0 !important; padding: 0 !important;
    }
    html.dg-list [data-dg-sidebar] :has(> [data-dg-pill]:focus-within) {
      left: 8px !important; right: 8px !important; width: auto !important; background: var(--dg-bg, #121212) !important;
    }
    html.dg-list [data-dg-pill]:focus-within { width: 100% !important; }
    html.dg-list [data-dg-pill]:focus-within > :nth-child(2) { flex: 1 1 auto !important; min-width: 0 !important; }
    [data-dg-apphead] { position: relative !important; }
    [data-dg-apphead]::after {
      content: "Chat"; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
      color: #fff; font: 700 27px/1 -apple-system, BlinkMacSystemFont, sans-serif; pointer-events: none;
    }`;

  let sheetOpen = false;
  function sheet() {
    const open = !!document.querySelector('html.dg-list [data-dg-column] form [role="searchbox"]');
    if (open && !sheetOpen) for (const ms of [0, 120, 350]) setTimeout(() => {
      const a = document.activeElement;
      if (a && a.tagName === "INPUT" && a.closest("[data-dg-column]")) a.blur();
    }, ms);
    sheetOpen = open;
  }

  let menuDumped = false;
  function mark() {
    sheet();
    const menu = document.querySelector('[data-dg-apphead] [role="listbox"]:not(:empty)');
    if (menu && !menuDumped) {
      menuDumped = true;
      setTimeout(() => window.webkit.messageHandlers.dg.postMessage({ op: "dump", name: "menu" }).catch(() => {}), 600);
    }
    const newChat = document.querySelector('button[title="New Chat"]');
    if (!newChat) return;
    newChat.setAttribute("data-dg-newchat", "");
    // header = the chat list pane's own child that holds the New Chat button. (Found by width before, which
    // picked the whole page grid when it ran while the pane was still narrow - and header.css then wrecked
    // the layout.)
    const sidebar = newChat.closest("[data-dg-sidebar]");
    for (const o of document.querySelectorAll("[data-dg-apphead]"))
      if (!sidebar || o.parentElement !== sidebar) o.removeAttribute("data-dg-apphead");
    if (!sidebar) return;
    let head = newChat;
    while (head.parentElement && head.parentElement !== sidebar) head = head.parentElement;
    if (head.parentElement !== sidebar) return;
    head.setAttribute("data-dg-apphead", "");
    for (const o of document.querySelectorAll("[data-dg-ghost]")) o.removeAttribute("data-dg-ghost");
  }

  // decoration only, to match the app: a bell and a "more" button (header.css places them)
  function fakes() {
    if (document.querySelector(".dg-fake")) return;
    const make = (cls, svg) => { const d = document.createElement("div"); d.className = "dg-fake " + cls; d.innerHTML = svg; document.body.appendChild(d); };
    make("dg-fake-bell", '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 1 1 12 0c0 4.5 1.6 6.2 2.2 7H3.8C4.4 15.2 6 13.5 6 9Z"/><path d="M10 19.5a2.2 2.2 0 0 0 4 0"/></svg>');
    const close = document.createElement("div");
    close.className = "dg-search-close";
    close.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    const leave = (e) => {
      e.preventDefault();
      const input = document.querySelector("[data-dg-pill] input");
      if (input && input.value) { // clear what was typed, the way React notices
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (document.activeElement) document.activeElement.blur();
    };
    close.addEventListener("touchstart", leave, { passive: false });
    close.addEventListener("mousedown", leave);
    document.body.appendChild(close);
    make("dg-fake-more", '<svg width="28" height="28" viewBox="0 0 24 24" fill="#fff"><circle cx="5.5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="18.5" cy="12" r="2"/></svg>');
  }

  (function start() {
    if (!document.head || !document.body) return void setTimeout(start, 50);
    fakes();
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      setTimeout(() => { queued = false; mark(); }, 250);
    }).observe(document.body, { childList: true, subtree: true });
    mark();
  })();
})();
