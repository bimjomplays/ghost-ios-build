// Giphy access for the content scripts; everything comes back as data: URLs, because Snapchat's CSP only
// allows its own image hosts and reports blocked loads to Snapchat (see gifs-show.js).
// Only talks to Giphy; nothing goes to Snapchat.
//   { giphy: id }                  -> { dataUrl }  animated webp, for showing received GIFs
//   { giphyVideo: id }             -> { dataUrl }  mp4 of the same GIF, preferred on iPhone
//   { giphyPreview: id }           -> { dataUrl }  small animated webp, for the picker grid
//   { giphyFile: id }              -> { dataUrl }  real .gif file, for sending
//   { giphyImage: url }            -> { dataUrl }  an exact rendition URL from a Giphy API response (category
//                                                   tile stills: those come with their own fixed_width_still
//                                                   URL, no filename to guess)
//   { giphySearch: q, offset,
//     rating }                     -> { results: [{ id, w, h }], next, total } | { needKey: true } | { error, retryable }
//   { giphyCategories: true }      -> { results: [{ name, id, w, h, stillUrl }] } | { needKey: true } | { error, retryable }
//   { giphyKey: "..." }            -> { ok }       saves the user's Giphy API key
const ID = /^[A-Za-z0-9]{1,64}$/;
const RATING = /^(g|pg|pg-13|r)$/;
const cache = new Map(); // url -> Promise<dataUrl>, kept small

function toDataUrl(bytes, type) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

function load(url) {
  if (!cache.has(url)) {
    if (cache.size >= 120) cache.delete(cache.keys().next().value);
    cache.set(url, (async () => {
      const r = await fetch(url, { credentials: "omit" });
      if (!r.ok) throw new Error(`giphy ${r.status}`);
      const type = (r.headers.get("content-type") || "image/webp").split(";")[0];
      return toDataUrl(new Uint8Array(await r.arrayBuffer()), type);
    })().catch((e) => { cache.delete(url); throw e; }));
  }
  return cache.get(url);
}

const media = (id, file) => `https://media.giphy.com/media/${id}/${file}`;

// Giphy calls (search/trending/categories) share the same failure shapes: no key, a bad key, a rate limit, a
// dropped connection (airplane mode / weak signal), or anything else Giphy returns. One place decides how each
// looks to the picker, so every caller gets the same friendly, retryable message.
async function giphyGet(url) {
  let r;
  try {
    r = await fetch(url, { credentials: "omit" });
  } catch (e) {
    return { error: "No connection to Giphy", retryable: true };
  }
  if (r.status === 401 || r.status === 403) return { needKey: true, error: "Giphy rejected that API key" };
  if (r.status === 429) return { error: "Giphy is rate-limiting this key right now", retryable: true };
  if (!r.ok) return { error: `Giphy error ${r.status}`, retryable: true };
  try {
    return { json: await r.json() };
  } catch (e) {
    return { error: "Giphy sent back something unreadable", retryable: true };
  }
}

async function search(q, offset, rating) {
  const { giphyKey } = await chrome.storage.local.get("giphyKey");
  if (!giphyKey) return { needKey: true };
  const params = new URLSearchParams({ api_key: giphyKey, limit: "24", offset: String(offset || 0) });
  if (q) params.set("q", q);
  if (RATING.test(rating || "")) params.set("rating", rating);
  const r = await giphyGet(`https://api.giphy.com/v1/gifs/${q ? "search" : "trending"}?${params}`);
  if (!r.json) return r;
  const results = (r.json.data || []).filter((g) => ID.test(g.id)).map((g) => {
    const f = (g.images && g.images.fixed_width) || {};
    return { id: g.id, w: +f.width || 200, h: +f.height || 200 };
  });
  const p = r.json.pagination || {};
  return { results, next: (p.offset || 0) + (p.count || results.length), total: p.total_count };
}

async function categories() {
  const { giphyKey } = await chrome.storage.local.get("giphyKey");
  if (!giphyKey) return { needKey: true };
  const params = new URLSearchParams({ api_key: giphyKey });
  const r = await giphyGet(`https://api.giphy.com/v1/gifs/categories?${params}`);
  if (!r.json) return r;
  const results = (r.json.data || [])
    .filter((c) => c && c.gif && ID.test(c.gif.id) && c.name)
    .map((c) => {
      const imgs = c.gif.images || {};
      const f = imgs.fixed_width || {};
      const still = (imgs.fixed_width_still || imgs.fixed_width_small_still || f || {}).url;
      return { name: c.name, id: c.gif.id, w: +f.width || 200, h: +f.height || 200, stillUrl: still || null };
    });
  return { results };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || typeof msg !== "object") return;
  let job;
  if (typeof msg.giphy === "string" && ID.test(msg.giphy))
    job = load(media(msg.giphy, "giphy.webp")).then((dataUrl) => ({ dataUrl }));
  else if (typeof msg.giphyVideo === "string" && ID.test(msg.giphyVideo))
    // mobile: received GIFs play as mp4 (iOS Safari may not animate webp)
    job = load(media(msg.giphyVideo, "giphy.mp4")).then((dataUrl) => ({ dataUrl }));
  else if (typeof msg.giphyPreview === "string" && ID.test(msg.giphyPreview))
    job = load(media(msg.giphyPreview, "200w.webp")).then((dataUrl) => ({ dataUrl }));
  else if (typeof msg.giphyFile === "string" && ID.test(msg.giphyFile))
    // downsized keeps GIFs under ~2 MB; fall back to the original if a GIF has no downsized version
    job = load(media(msg.giphyFile, "giphy-downsized.gif"))
      .catch(() => load(media(msg.giphyFile, "giphy.gif")))
      .then((dataUrl) => ({ dataUrl }));
  else if (typeof msg.giphyImage === "string" && msg.giphyImage.startsWith("https://media.giphy.com/"))
    // exact rendition URL from a Giphy API response (category tile stills) - no filename to guess here
    job = load(msg.giphyImage).then((dataUrl) => ({ dataUrl })).catch((e) => ({ error: String(e && e.message || e) }));
  else if (typeof msg.giphySearch === "string")
    job = search(msg.giphySearch.trim().slice(0, 100), msg.offset, msg.rating);
  else if (msg.giphyCategories === true)
    job = categories();
  else if (typeof msg.giphyKey === "string")
    job = chrome.storage.local.set({ giphyKey: msg.giphyKey.trim() }).then(() => ({ ok: true }));
  else return;
  job.then(reply, (e) => reply({ error: String(e && e.message || e) }));
  return true; // reply is async
});
