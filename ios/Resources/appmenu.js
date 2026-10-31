// App only: the chat-list header's decorative "..." button (header.js draws a `.dg-fake-more` div, purely
// for looks) now actually does something - it opens the native settings sheet. Requires settings.js
// (dgOpenSettings) to be loaded first; App.swift's script list adds this file after both header and settings.
(() => {
  if (window.top !== window) return;
  const PRESSED = "dg-fake-pressed";

  const target = (e) => (e.target.closest ? e.target.closest(".dg-fake-more") : null);

  document.addEventListener("touchstart", (e) => {
    const btn = target(e);
    if (btn) btn.classList.add(PRESSED);
  }, { passive: true });

  const clearPressed = () => {
    for (const el of document.querySelectorAll("." + PRESSED)) el.classList.remove(PRESSED);
  };
  document.addEventListener("touchend", clearPressed, { passive: true });
  document.addEventListener("touchcancel", clearPressed, { passive: true });

  document.addEventListener("click", (e) => {
    const btn = target(e);
    if (!btn) return;
    e.preventDefault();
    clearPressed();
    if (window.dgOpenSettings) window.dgOpenSettings();
  });

  const style = document.createElement("style");
  style.textContent = `.dg-fake-more.${PRESSED} { opacity: 0.5; }`;
  const add = () => {
    if (!document.head) return void setTimeout(add, 20);
    document.head.appendChild(style);
  };
  add();
})();
