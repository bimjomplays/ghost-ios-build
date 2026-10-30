// App only: the camera. Snapchat Web's camera lives in the right-hand pane (the "Click the Camera to send
// Snaps" box), which the phone layout hides on the chat list. The bottom bar's Camera button clicks that
// box's camera button; and whenever a live camera preview (<video>) shows up in the pane while the chat
// list is up - also from the camera icons on the chat rows - html.dg-camera shows the pane full screen
// until the preview is gone again.
(() => {
  if (window.top !== window) return;
  const html = document.documentElement;
  const css = `
    html.dg-glass.dg-list.dg-camera [data-dg-sidebar] { display: none !important; }
    html.dg-glass.dg-list.dg-camera [data-dg-column] { display: grid !important; }
    html.dg-camera button[data-dg-newchat] { display: none !important; }
    html.dg-glass.dg-list.dg-camera [data-dg-column] { padding: 0 !important; }
    html.dg-camera [data-dg-column] div:has(> div > [title="View stories"]) { display: none !important; }`;

  function cameraButton() {
    const column = document.querySelector("[data-dg-column]");
    if (!column) return null;
    for (const span of column.querySelectorAll("p span"))
      if (/Click the Camera/i.test(span.textContent)) {
        const p = span.closest("p");
        const box = p && p.previousElementSibling;
        return (box && (box.matches("button") ? box : box.querySelector("button"))) || null;
      }
    return null;
  }
  // opened from the Camera button: stays up (so the camera button in the pane can be tapped by hand if the
  // automatic click isn't accepted) until it is closed, or until a preview that was seen is gone again
  let manual = false, seen = false;
  window.__dgOpenCamera = () => {
    const button = cameraButton();
    if (!button) return document.querySelector("[data-dg-column] video") ? "ok" : "no camera button";
    window.dispatchEvent(new Event("focus"));
    html.classList.add("dg-camera");
    manual = true; seen = false;
    button.click();
    return "ok";
  };
  let closedAt = 0;
  window.__dgCloseCamera = () => {
    const off = document.querySelector('[data-dg-column] button[title="Turn off camera"]');
    if (off) off.click();
    window.dispatchEvent(new Event("dg-camera-stop")); // camhook.js releases the real camera either way
    manual = seen = false;
    closedAt = Date.now();
    html.classList.remove("dg-camera");
    return "ok";
  };

  // Snapchat's "Heads Up! We're about to ask for permission" sheet shows before every camera start (it
  // can't tell the app already has permission): press its "Got It!" for the user
  setInterval(() => {
    const portal = document.getElementById("portal-container");
    if (!portal || !/Heads Up/i.test(portal.textContent)) return;
    const ok = [...portal.querySelectorAll("button")].find((b) => /^\s*Got It!?\s*$/i.test(b.textContent));
    if (ok) ok.click();
  }, 150);

  // Camera mode follows Snapchat's camera flow, not just the live preview: after the shutter the preview
  // <video> is replaced by the taken snap and the "send to" steps, all in the same pane. The flow is over
  // when the pane is back to its "Click the Camera to send Snaps" landing box.
  const landing = () => {
    const column = document.querySelector("[data-dg-column]");
    if (!column || !column.firstElementChild) return true;
    for (const span of column.querySelectorAll("p span")) if (/Click the Camera/i.test(span.textContent)) return true;
    return false;
  };
  let dumped = false, probed = false;
  const probe = () => {
    if (probed || !document.querySelector("[data-dg-column] #local-video")) return;
    probed = true;
    setTimeout(() => {
      window.dispatchEvent(new Event("dg-camera-probe"));
      setTimeout(() => window.webkit.messageHandlers.dg.postMessage({ op: "dump", name: "camprobe",
        note: html.getAttribute("data-dg-probe") || "no probe" }).catch(() => {}), 1500);
    }, 2500);
  };
  setInterval(() => {
    const on = html.classList.contains("dg-camera");
    if (!html.classList.contains("dg-list") || html.classList.contains("dg-stories")) {
      if (on && !html.classList.contains("dg-list")) { manual = seen = false; html.classList.remove("dg-camera"); }
      return;
    }
    // only a live preview starts camera mode (opening a chat also replaces the landing box for a moment);
    // once started it lasts until the landing box is back
    const live = !!document.querySelector("[data-dg-column] #local-video, [data-dg-column] video");
    if (!landing() && (on ? true : live) && location.pathname.replace(/\/+$/, "") === "/web") {
      if (Date.now() - closedAt < 1500) return;
      seen = true;
      html.classList.add("dg-camera");
      probe();
      if (!dumped && !document.querySelector("[data-dg-column] video")) { // the taken-snap step, once, for layout work
        dumped = true;
        setTimeout(() => window.webkit.messageHandlers.dg.postMessage({ op: "dump", name: "snap" }).catch(() => {}), 1200);
      }
    } else if (on && (seen || !manual)) { manual = seen = false; html.classList.remove("dg-camera"); }
  }, 300);

  // Lens carousel: swipe it like the app. Snapchat Web's row didn't follow a finger in the app, so the drag
  // is done here: the row scrolls with the finger and, on release, the lens nearest the shutter is chosen.
  let drag = null;
  const carousel = (el) => el && el.closest && el.closest("[data-dg-column] div:has(> button > img)");
  document.addEventListener("touchstart", (e) => {
    const row = html.classList.contains("dg-camera") && e.touches.length === 1 && carousel(e.target);
    drag = row ? { row, x: e.touches[0].clientX, left: row.scrollLeft, moved: false } : null;
    if (row) row.style.setProperty("scroll-behavior", "auto", "important");
  }, { capture: true, passive: true });
  document.addEventListener("touchmove", (e) => {
    if (!drag || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - drag.x;
    if (Math.abs(dx) > 6) drag.moved = true;
    if (!drag.moved) return;
    e.preventDefault();
    const scale = drag.row.getBoundingClientRect().width / drag.row.offsetWidth || 1; // the strip is scaled up
    drag.row.scrollLeft = drag.left - dx / scale;
  }, { capture: true, passive: false });
  document.addEventListener("touchend", (e) => {
    const d = drag;
    drag = null;
    if (!d) return;
    d.row.style.removeProperty("scroll-behavior");
    if (!d.moved) return; // a plain tap: Snapchat's own click picks that lens
    e.preventDefault();
    const box = d.row.getBoundingClientRect(), mid = box.left + box.width / 2;
    let best = null, gap = Infinity;
    for (const b of d.row.querySelectorAll(":scope > button")) {
      const r = b.getBoundingClientRect(), g = Math.abs(r.left + r.width / 2 - mid);
      if (g < gap) { gap = g; best = b; }
    }
    if (best) best.click();
  }, { capture: true, passive: false });

  (function start() {
    if (!document.head) return void setTimeout(start, 50);
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  })();
})();
