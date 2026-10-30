// GIFs, part 1 (page world): find the Giphy ID behind "Not Supported on Web".
//
// A GIF in chat is a creativeToolItem with a "giphy" entity; Snapchat Web has no renderer for it and shows
// the "Not Supported on Web" card (its messageType prop is "ctitem_giphy"). The message row above that card
// still holds the raw message bytes, which include the GIF's Giphy URLs
// (https://ct-giphy.sc-cdn.net/media/v1.<token>/<giphyId>/200w.webp), so the ID is read from there and the
// card is tagged data-dg-giphy. gifs-show.js (extension world) does the fetching and drawing.
// Read-only: nothing is sent anywhere and Snapchat's own code isn't touched.
(() => {
  if (window.top !== window) return;
  const TEXT = "Not Supported on Web";
  const MARK = "data-dg-giphy";
  const GIPHY_URL = /\/media\/(?:v1\.[^/]+\/)?([A-Za-z0-9]{6,64})\/[\w.]+\.(?:webp|gif|mp4)/;

  // from a node inside the card: the card's root element and the GIF's Giphy ID, or null
  function giphyFor(el) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    let fiber = key && el[key], host = null, type = null;
    for (let i = 0; fiber && i < 20; i++, fiber = fiber.return) {
      const p = fiber.memoizedProps;
      if (type === null && p && typeof p.messageType === "string") {
        type = p.messageType;
        if (!/giphy/i.test(type)) return null;
        continue;
      }
      if (type === null && typeof fiber.type === "string") host = fiber.stateNode; // outermost element of the card
      const bytes = p && p.message && p.message.messageContent && p.message.messageContent.content;
      if (bytes instanceof Uint8Array) {
        const m = GIPHY_URL.exec(new TextDecoder("latin1").decode(bytes));
        return m && host ? { card: host, id: m[1] } : null;
      }
    }
    return null;
  }

  function scan() {
    for (const leaf of document.querySelectorAll("body span, body div")) {
      if (leaf.children.length || leaf.textContent !== TEXT) continue;
      const hit = giphyFor(leaf);
      if (hit && hit.card.getAttribute(MARK) !== hit.id) hit.card.setAttribute(MARK, hit.id);
    }
  }

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; scan(); }, 150);
  };
  (function observe() {
    if (!document.body) return void setTimeout(observe, 50);
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    scan();
  })();
})();
