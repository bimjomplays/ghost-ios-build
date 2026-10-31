// GIFs, part 2 (extension world): draw the GIF over cards gifs-find.js tagged with data-dg-giphy.
//
// The media is fetched by background.js, not the page: Snapchat's CSP only allows its own image hosts and
// reports blocked loads to Snapchat, so a direct Giphy <img> would both fail and get reported. The
// background hands back a data: URL, which the CSP allows (img-src and media-src both list data: and blob:).
//
// Mobile: iOS Safari often shows animated webp as a still frame, so received GIFs play as Giphy's mp4 in a
// muted, looping, inline <video> (what Giphy's own site does). If the video can't load, the webp is used;
// if autoplay is refused (Low Power Mode), tapping the GIF starts it.
(() => {
  if (window.top !== window) return;
  const MARK = "data-dg-giphy";
  const DONE = "data-dg-gif";

  function toBlobUrl(dataUrl) {
    const comma = dataUrl.indexOf(",");
    const type = dataUrl.slice(5, dataUrl.indexOf(";"));
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type }));
  }

  function place(card, id, el) {
    if (card.getAttribute(MARK) !== id) return false;
    card.querySelector(":scope > .dg-gif")?.remove();
    el.classList.add("dg-gif");
    card.appendChild(el);
    return true;
  }

  function showImage(card, id) {
    chrome.runtime.sendMessage({ giphy: id }, (res) => {
      if (chrome.runtime.lastError || !res || !res.dataUrl) return;
      const img = document.createElement("img");
      img.src = res.dataUrl;
      img.alt = "GIF";
      place(card, id, img);
    });
  }

  function show(card) {
    const id = card.getAttribute(MARK);
    if (card.getAttribute(DONE) === id) return;
    card.setAttribute(DONE, id);
    chrome.runtime.sendMessage({ giphyVideo: id }, (res) => {
      if (chrome.runtime.lastError || !res || !res.dataUrl) return showImage(card, id);
      const video = document.createElement("video");
      video.muted = video.defaultMuted = true;
      video.loop = video.autoplay = video.playsInline = true;
      video.setAttribute("muted", "");
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      let src;
      try { src = toBlobUrl(res.dataUrl); } catch { src = res.dataUrl; }
      video.addEventListener("error", () => {
        if (src.startsWith("blob:")) URL.revokeObjectURL(src);
        if (video.isConnected) showImage(card, id);
      }, { once: true });
      video.addEventListener("click", (e) => {
        if (!video.paused) return;
        e.stopPropagation();
        video.play().catch(() => {});
      });
      video.src = src;
      if (place(card, id, video)) video.play().catch(() => {});
    });
  }

  const scan = () => document.querySelectorAll(`[${MARK}]`).forEach(show);
  (function observe() {
    if (!document.body) return void setTimeout(observe, 50);
    new MutationObserver(scan).observe(document.body, { subtree: true, attributes: true, attributeFilter: [MARK] });
    scan();
  })();
})();
