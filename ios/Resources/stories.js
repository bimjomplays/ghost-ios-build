// App only: the bottom bar's Stories button. Snapchat Web's stories start from the "View stories" tile in
// the right-hand pane (its round button plays new stories, or replays them), which the phone layout
// hides. The Stories button clicks that round button and html.dg-stories shows the pane full screen
// while they play; the tile's thumbnail is sent to the app as the button's preview.
(() => {
  if (window.top !== window) return;
  const html = document.documentElement;
  const post = (msg) => window.webkit.messageHandlers.dg.postMessage(msg).catch(() => {});
  const css = `
    html.dg-glass.dg-list.dg-stories [data-dg-sidebar] { display: none !important; }
    html.dg-glass.dg-list.dg-stories [data-dg-column] { display: grid !important; }
    html.dg-stories button[data-dg-newchat] { display: none !important; }
    html.dg-stories [data-dg-camhint], html.dg-stories [data-dg-storytile] { display: none !important; }`;
  const tileButton = () => document.querySelector('[title="View stories"] button');

  // the landing pane's camera hint and the stories tile itself are hidden while stories play
  function markPane() {
    const tile = document.querySelector('[title="View stories"]');
    const column = document.querySelector("[data-dg-column]");
    if (!tile || !column) return;
    let t = tile;
    while (t.parentElement && t.parentElement.parentElement !== column && t.parentElement !== column) t = t.parentElement;
    t.setAttribute("data-dg-storytile", "");
    for (const span of column.querySelectorAll("p span"))
      if (/Click the Camera/i.test(span.textContent)) {
        // only the hint text and the camera button above it: the box around them is also the story player
        const hint = span.closest("p") || span;
        hint.setAttribute("data-dg-camhint", "");
        if (hint.previousElementSibling) hint.previousElementSibling.setAttribute("data-dg-camhint", "");
      }
  }

  let watch = 0;
  function close() {
    clearInterval(watch);
    watch = 0;
    html.classList.remove("dg-stories");
  }
  window.__dgOpenStories = () => {
    const button = tileButton();
    if (!button) return "none";
    markPane();
    html.classList.add("dg-stories");
    window.dispatchEvent(new Event("focus"));
    button.click();
    setTimeout(() => post({ op: "dump", name: "stories" }), 2500);
    // leave stories mode when the viewer is gone: nothing big (video / image / canvas) left in the pane
    let seen = false, idle = 0;
    clearInterval(watch);
    watch = setInterval(() => {
      const column = document.querySelector("[data-dg-column]");
      const big = column && [...column.querySelectorAll("video, img, canvas")].some((m) => {
        const r = m.getBoundingClientRect();
        return r.height > innerHeight * 0.45 && r.width > innerWidth * 0.45;
      });
      if (big) { seen = true; idle = 0; }
      else if (++idle >= (seen ? 3 : 12)) close();
    }, 500);
    return "ok";
  };
  window.__dgCloseStories = () => {
    if (html.classList.contains("dg-camera") && window.__dgCloseCamera) return window.__dgCloseCamera();
    for (const type of ["keydown", "keyup"])
      document.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    close();
    return "ok";
  };

  // Tap zones, like the app: the left third of the picture goes back, the rest goes forward. They press
  // Snapchat's own previous / next arrow buttons (kept in the page, hidden by stories.css).
  document.addEventListener("click", (e) => {
    if (!html.classList.contains("dg-stories")) return;
    const media = e.target.closest && e.target.closest('[aria-label="media content"]');
    if (!media || e.target.closest("button, a, input, [contenteditable='true']")) return;
    const r = media.getBoundingClientRect();
    const back = e.clientX < r.left + r.width / 3;
    const sides = [...media.children].filter((c) => c.querySelector(":scope > button"));
    const next = media.querySelector('[aria-label="next"] button');
    const prev = (sides.find((c) => c.getAttribute("aria-label") !== "next") || {}).firstElementChild
      || media.querySelector('[aria-label="previous"] button, [aria-label="prev"] button, [aria-label="back"] button');
    const button = back ? prev : next;
    e.preventDefault();
    e.stopPropagation();
    if (button) button.click();
    else if (!back) window.__dgCloseStories(); // nothing after the last story
  }, true);

  // preview for the app's Stories button: the tile's thumbnail, redrawn small
  let sent = "";
  function preview() {
    const img = document.querySelector('[title="View stories"] button img');
    const src = img && img.complete && img.naturalWidth ? img.currentSrc || img.src : "";
    if (src === sent) return;
    sent = src;
    if (!src) return void post({ op: "storyThumb", data: "" });
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 96;
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      c.getContext("2d").drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 96, 96);
      post({ op: "storyThumb", data: c.toDataURL("image/jpeg", 0.85).split(",")[1] });
    } catch { sent = ""; }
  }

  (function start() {
    if (!document.head) return void setTimeout(start, 50);
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    setInterval(preview, 2000);
  })();
})();
