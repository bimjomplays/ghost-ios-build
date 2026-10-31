// Ghost TikTok tab: runs inside the hidden TikTok web view (ios/Sources/TikTokFeed.swift), never in Snapchat's page.
// TikTok's own website fetches the For You feed (/api/recommend/item_list/, /api/preload/item_list/ - signed by its
// own code); this script only listens to those answers and hands a compact copy of each video to Ghost's player.
// It also keeps TikTok's page quiet: its videos never load or play (Ghost plays them), app banners are dismissed.
// Ghost asks for more with window.__ghostTTMore() (scrolls TikTok's feed, which makes it fetch the next page).
(function () {
  "use strict";
  if (window.__ghostTT) return;
  window.__ghostTT = true;
  const post = (msg) => { try { window.webkit.messageHandlers.ghosttt.postMessage(msg); } catch (e) {} };
  const FEED_RE = /\/api\/(recommend|preload)\/item_list\//;
  // ---- compact (unit-tested: ghost/tests/tiktok-page.test.cjs extracts this block) ----
  const pick = (a) => (Array.isArray(a) ? a.find((x) => typeof x === "string" && x) : typeof a === "string" ? a : "") || "";
  const urlOf = (o) => pick(o && (o.url_list || o.urlList || o.UrlList)) || pick(o);
  const num = (x) => { const n = Number(x); return isFinite(n) ? n : 0; };
  const str = (x, n) => String(x == null ? "" : x).slice(0, n || 200);

  // one TikTok item -> what Ghost's player and grids need (photo posts and ads are skipped for now)
  function compact(it) {
    if (!it || !it.id || !it.video || it.isAd || it.imagePost) return null;
    const v = it.video;
    // prefer an H.264 file (plays everywhere); playAddr is H.264 on the mobile site, bitrateInfo may add HEVC
    let play = pick(v.playAddr) || pick(v.PlayAddrStruct && v.PlayAddrStruct.UrlList);
    let size = 0;
    const brs = Array.isArray(v.bitrateInfo) ? v.bitrateInfo : [];
    const h264 = brs.filter((b) => b && /h264|avc/i.test(b.CodecType || "") && b.PlayAddr && b.PlayAddr.UrlList && b.PlayAddr.UrlList.length)
      .sort((a, b) => (a.Bitrate || 0) - (b.Bitrate || 0));
    // a mid rung: sharp enough at phone size, small enough for memory (720p-ish)
    const mid = h264.find((b) => (b.PlayAddr.Height || 0) >= 700) || h264[h264.length - 1];
    if (mid) { play = mid.PlayAddr.UrlList[0]; size = mid.PlayAddr.DataSize || 0; }
    if (!play) return null;
    const a = it.author || {};
    const st = it.statsV2 || it.stats || {};
    const as = it.authorStatsV2 || it.authorStats || null;
    const m = it.music || null;
    // hashtags: TikTok marks them in textExtra (with ids); challenges carries the rest
    const tags = [];
    const addTag = (id, name) => { name = str(name, 80); if (name && !tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) tags.push({ id: str(id, 40), name }); };
    for (const t of it.textExtra || []) if (t && t.hashtagName) addTag(t.hashtagId, t.hashtagName);
    for (const c of it.challenges || []) if (c && c.title) addTag(c.id, c.title);
    return {
      id: String(it.id),
      desc: str(it.desc, 400),
      play, size,
      cover: pick(v.cover) || pick(v.originCover) || "",
      duration: num(v.duration),
      w: num(v.width), h: num(v.height),
      author: { id: str(a.id, 40), uniqueId: str(a.uniqueId, 60), nickname: str(a.nickname, 80), avatar: pick(a.avatarThumb) || pick(a.avatarMedium) || "", verified: !!a.verified, secUid: str(a.secUid, 120), signature: str(a.signature, 200) },
      authorStats: as ? { followers: String(as.followerCount || 0), following: String(as.followingCount || 0), likes: String(as.heartCount || as.heart || 0), videos: String(as.videoCount || 0) } : null,
      music: m ? str(m.title, 120) + (m.authorName ? " - " + str(m.authorName, 80) : "") : "",
      musicInfo: m && m.id ? { id: str(m.id, 40), title: str(m.title, 120), author: str(m.authorName, 80), cover: pick(m.coverMedium) || pick(m.coverThumb) || "", duration: num(m.duration), original: !!m.original } : null,
      tags: tags.slice(0, 12),
      stats: { likes: String(st.diggCount || 0), comments: String(st.commentCount || 0), shares: String(st.shareCount || 0), plays: String(st.playCount || 0), saves: String(st.collectCount || 0) },
      liked: !!it.digged, saved: !!it.collected, following: !!(a.relation && a.relation > 0),
      commentsOff: it.itemCommentStatus != null && it.itemCommentStatus !== 0,
      created: num(it.createTime),
    };
  }
  // a search/user result (snake_case "user_info") or a web user (camelCase) -> one shape
  function compactUser(u, stats) {
    if (!u) return null;
    const x = u.user_info || u.userInfo || u.user || u;
    const uniqueId = x.unique_id || x.uniqueId;
    if (!uniqueId) return null;
    const s = stats || x.stats || {};
    return {
      id: str(x.uid || x.id, 40), uniqueId: str(uniqueId, 60), nickname: str(x.nickname, 80), secUid: str(x.sec_uid || x.secUid, 120),
      avatar: urlOf(x.avatar_thumb) || urlOf(x.avatar_medium) || pick(x.avatarThumb) || pick(x.avatarMedium) || "",
      avatarLarge: urlOf(x.avatar_larger) || urlOf(x.avatar_medium) || pick(x.avatarMedium) || pick(x.avatarLarger) || "",
      signature: str(x.signature, 300), verified: !!(x.verified || x.custom_verify || x.enterprise_verify_reason),
      followers: String(x.follower_count != null ? x.follower_count : (s.followerCount || 0)),
      following: String(x.following_count != null ? x.following_count : (s.followingCount || 0)),
      likes: String(x.total_favorited != null ? x.total_favorited : (s.heartCount || s.heart || 0)),
      videos: String(x.aweme_count != null ? x.aweme_count : (s.videoCount || 0)),
      privateAccount: !!(x.secret || x.privateAccount),
    };
  }
  // a Sounds search result ("music_info", snake_case) or an item's music (camelCase) -> one shape
  function compactSound(mi) {
    if (!mi) return null;
    const m = mi.music_info || mi.musicInfo || mi.music || mi;
    const id = m.id_str || (m.id != null ? String(m.id) : "");
    if (!id) return null;
    return { id: str(id, 40), title: str(m.title, 120), author: str(m.author || m.authorName || m.owner_nickname, 80),
      cover: urlOf(m.cover_medium) || urlOf(m.cover_thumb) || pick(m.coverMedium) || pick(m.coverThumb) || "",
      duration: num(m.duration), uses: String(m.user_count || (mi.stats && mi.stats.videoCount) || 0), original: !!(m.is_original || m.original) };
  }
  function parseVideos(d) {
    const list = (d && (d.itemList || d.item_list || d.items)) || [];
    const items = []; for (const it of list) { const c = compact(it); if (c) items.push(c); }
    return items;
  }
  // /api/search/general/full/: data[] mixes type 1 = video ({item}) and user cards ({user_list})
  function parseGeneral(d) {
    const items = [], users = [];
    for (const x of (d && d.data) || []) {
      if (!x) continue;
      if (x.item) { const c = compact(x.item); if (c) items.push(c); }
      for (const u of x.user_list || x.users || []) { const cu = compactUser(u); if (cu && !users.some((y) => y.uniqueId === cu.uniqueId)) users.push(cu); }
      if (x.user_info) { const cu = compactUser(x); if (cu && !users.some((y) => y.uniqueId === cu.uniqueId)) users.push(cu); }
    }
    return { items, users, cursor: num(d && d.cursor), hasMore: !!(d && d.has_more), searchId: str(d && ((d.log_pb && d.log_pb.impr_id) || (d.extra && d.extra.logid)), 80) };
  }
  function parseUsers(d) {
    const users = [];
    for (const u of (d && (d.user_list || d.userList)) || []) { const cu = compactUser(u); if (cu) users.push(cu); }
    return { users, cursor: num(d && d.cursor), hasMore: !!(d && d.has_more) };
  }
  function parseSounds(d) {
    const sounds = [];
    for (const x of (d && (d.data || d.music_list || d.musicList)) || []) { const c = compactSound(x); if (c) sounds.push(c); }
    return { sounds, cursor: num(d && d.cursor), hasMore: !!(d && d.has_more) };
  }
  function parseItemList(d) {
    return { items: parseVideos(d), cursor: str(d && d.cursor, 40), hasMore: !!(d && (d.hasMore || d.has_more)) };
  }
  function parseSug(d) { return { words: ((d && d.sug_list) || []).map((x) => str(x && (x.content || (x.word_record && x.word_record.words_content)), 100)).filter(Boolean).slice(0, 12) }; }
  function parseGuide(d) { return { words: ((d && d.data) || []).map((x) => ({ word: str(x && x.word, 100), hot: String(x && x.word_type) === "2" })).filter((x) => x.word).slice(0, 12) }; }
  // TikTok page HTML -> its rehydration data (profile / hashtag / sound pages carry their header there)
  function rehydrate(html) {
    const m = /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/.exec(String(html || ""));
    if (!m) return null;
    try { const d = JSON.parse(m[1]); return (d && d.__DEFAULT_SCOPE__) || null; } catch (e) { return null; }
  }
  function parseUserPage(html) {
    const sc = rehydrate(html), ud = sc && sc["webapp.user-detail"], ui = ud && ud.userInfo;
    if (!ui || !ui.user || !ui.user.uniqueId) return { user: null };
    return { user: compactUser(ui.user, ui.statsV2 || ui.stats) };
  }
  function parseCreatorEmbed(html) {
    const m = String(html).match(/<script[^>]*id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/);
    let st = null; try { st = m && JSON.parse(m[1]); } catch (e) {}
    const data = (st && st.source && st.source.data) || {};
    const key = Object.keys(data).find((k) => k.indexOf("/embed/@") === 0);
    const d = key && data[key];
    const ui = (d && d.userInfo) || {};
    const items = [];
    for (const v of (d && d.videoList) || []) {
      if (!v || !v.id || !v.playAddr || v.privateItem) continue;
      const c = compact({ id: v.id, desc: v.desc, video: { playAddr: v.playAddr, cover: v.coverUrl, originCover: v.originCoverUrl, width: v.width, height: v.height },
        author: { id: ui.id, uniqueId: v.authorUniqueId || ui.uniqueId, nickname: ui.nickname, avatarThumb: ui.avatarThumbUrl, verified: ui.verified },
        stats: { playCount: v.playCount } });
      if (c) { c.nostats = true; items.push(c); } // the embed has plays only: Ghost fills likes/comments later
    }
    return { items };
  }
  function parseEmbedPage(html) {
    const m = String(html).match(/<script[^>]*id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/);
    let st = null; try { st = m && JSON.parse(m[1]); } catch (e) {}
    const data = (st && st.source && st.source.data) || {};
    const key = Object.keys(data).find((k) => k.indexOf("/embed/v2/") === 0);
    const vd = key && data[key] && data[key].videoData;
    const ii = vd && vd.itemInfos, ai = (vd && vd.authorInfos) || {}, mi = vd && vd.musicInfos, as = vd && vd.authorStats;
    if (!ii || !ii.video) return { items: [] };
    const meta = ii.video.videoMeta || {};
    const it = {
      id: ii.id, desc: ii.text, createTime: ii.createTime,
      video: { playAddr: ii.video.urls, cover: ii.covers, originCover: ii.coversOrigin, duration: meta.duration, width: meta.width, height: meta.height },
      author: { id: ai.userId, uniqueId: ai.uniqueId, nickname: ai.nickName, avatarThumb: ai.covers, avatarMedium: ai.coversMedium, verified: ai.verified, secUid: ai.secUid, signature: ai.signature },
      authorStats: as || null,
      music: mi && mi.musicId ? { id: mi.musicId, title: mi.musicName, authorName: mi.authorName, coverMedium: mi.coversMedium, original: mi.original } : null,
      stats: { diggCount: ii.diggCount, commentCount: ii.commentCount, shareCount: ii.shareCount, playCount: ii.playCount },
    };
    const c = compact(it);
    return { items: c ? [c] : [] };
  }
  function parseTagPage(html) {
    const sc = rehydrate(html), cd = sc && sc["webapp.challenge-detail"], ci = cd && cd.challengeInfo;
    if (!ci || !ci.challenge) return { tag: null };
    const c = ci.challenge, s = ci.statsV2 || ci.stats || {};
    return { tag: { id: str(c.id, 40), name: str(c.title, 80), desc: str(c.desc, 300), cover: pick(c.coverMedium) || pick(c.profileMedium) || "", videos: String(s.videoCount || 0), views: String(s.viewCount || 0) } };
  }
  function parseMusicPage(html) {
    const sc = rehydrate(html), md = sc && sc["webapp.music-detail"], mi = md && md.musicInfo;
    if (!mi || !mi.music) return { sound: null };
    const c = compactSound(mi.music); if (c && mi.stats) c.uses = String(mi.stats.videoCount || c.uses);
    return { sound: c };
  }
  // ---- end compact ----
  const seen = new Set();
  function onFeed(text, url) {
    try { noteRec(String(url || "")); } catch (e) {}
    let d; try { d = JSON.parse(text); } catch (e) { return; }
    const list = (d && d.itemList) || [];
    const items = [];
    for (const it of list) { const c = compact(it); if (c && !seen.has(c.id)) { seen.add(c.id); items.push(c); } }
    post({ type: "items", items, hasMore: d.hasMore !== false, source: /preload/.test(url) ? "preload" : "recommend", refresh: refreshing && /\/api\/recommend\//.test(url) && /[?&]pullType=1(&|$)/.test(url) });
  }

  // The query params TikTok's own /api/ calls carry (aid, app_name, device_platform, screen size, region...), minus
  // signatures and per-call keys: Ghost's own search calls reuse them so they look like the page's own requests.
  const PER_CALL = /^(msToken|X-Bogus|X-Gnarly|_signature|verifyFp|count|cursor|offset|keyword|secUid|uniqueId|musicID|challengeID|itemID|itemId|id|coverFormat|post_item_list_request_type|needPinnedItemIds|search_id|from_page|web_search_code|clientABVersions|user_is_login|WebIdLastTime)$/;
  let common = null;
  function noteParams(url) {
    try {
      const x = new URL(url, location.href);
      if (!/(^|\.)tiktok\.com$/.test(x.hostname) || !/^\/api\//.test(x.pathname) || !x.searchParams.get("aid")) return;
      const c = {};
      for (const [k, v] of x.searchParams) if (!PER_CALL.test(k)) c[k] = v;
      common = c;
    } catch (e) {}
  }

  // listen to TikTok's own requests (both fetch and XHR; the site has used each)
  const origFetch = window.fetch;
  const ghostFetch = window.fetch = function (input, init) {
    let url = "";
    try { url = typeof input === "string" ? input : input instanceof URL ? input.href : (input && input.url) || ""; } catch (e) {}
    noteParams(url);
    if (!FEED_RE.test(url)) return origFetch.apply(this, arguments);
    // TikTok aborts its feed request right after reading it, which also killed a clone() we were still reading
    // (seen 2026-09-29: "The user aborted a request"). Read the answer once here, without its abort signal, and hand
    // TikTok an identical Response.
    const quiet = new AbortController().signal;
    const req = input instanceof Request ? new Request(input, { signal: quiet }) : input;
    return origFetch.call(this, req, Object.assign({}, init || {}, { signal: quiet })).then((r) => r.text().then((t) => {
      try { onFeed(t, url); } catch (e) {}
      return new Response(t, { status: r.status, statusText: r.statusText, headers: r.headers });
    }));
  };
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) { this.__ghURL = String(url || ""); noteParams(this.__ghURL); return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    if (FEED_RE.test(this.__ghURL || "")) {
      this.addEventListener("load", () => { try { const t = this.responseType === "" || this.responseType === "text" ? this.responseText : this.responseType === "json" ? JSON.stringify(this.response) : ""; if (t) onFeed(t, this.__ghURL); } catch (e) {} });
    }
    return XS.apply(this, arguments);
  };

  // TikTok's own videos: never fetch or play them in this hidden page (Ghost plays its own copy)
  // TikTok's player waits for its video to be ready before it lets the feed move on, so each element pretends to
  // have loaded (events + readyState) without downloading anything.
  try {
    const MP = HTMLMediaElement.prototype;
    const fake = (m) => {
      if (m.__ghFaked) return; m.__ghFaked = true;
      setTimeout(() => { for (const t of ["loadstart", "durationchange", "loadedmetadata", "loadeddata", "canplay", "canplaythrough"]) { try { m.dispatchEvent(new Event(t)); } catch (e) {} } }, 30);
    };
    MP.play = function () { this.__ghPaused = false; try { this.dispatchEvent(new Event("play")); this.dispatchEvent(new Event("playing")); } catch (e) {} return Promise.resolve(); };
    MP.pause = function () { this.__ghPaused = true; try { this.dispatchEvent(new Event("pause")); } catch (e) {} };
    MP.load = function () { this.__ghFaked = false; fake(this); };
    const def = (name, get) => { try { Object.defineProperty(MP, name, { configurable: true, get }); } catch (e) {} };
    def("readyState", function () { return this.__ghSrc ? 4 : 0; });
    def("duration", function () { return this.__ghSrc ? 15 : NaN; });
    def("paused", function () { return this.__ghPaused !== false; });
    def("networkState", function () { return 1; });
    Object.defineProperty(MP, "src", { configurable: true, get() { return this.__ghSrc || ""; }, set(v) { this.__ghSrc = String(v || ""); this.__ghFaked = false; if (this.__ghSrc) fake(this); } });
    Object.defineProperty(MP, "currentSrc", { configurable: true, get() { return this.__ghSrc || ""; } });
    const SA = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (n, v) {
      if ((this instanceof HTMLMediaElement || this instanceof HTMLSourceElement) && String(n).toLowerCase() === "src") {
        const m = this instanceof HTMLSourceElement ? this.parentElement : this;
        if (m) { m.__ghSrc = String(v || ""); m.__ghFaked = false; if (m instanceof HTMLMediaElement && m.__ghSrc) fake(m); }
        return;
      }
      return SA.apply(this, arguments);
    };
  } catch (e) {}

  // "Open app" / cookie / login walls: close them so the feed keeps scrolling
  const CLOSE_TEXT = /^(not now|maybe later|decline optional cookies|got it)$/i;
  function sweep() {
    for (const b of document.querySelectorAll('button, [role="button"], div[class*="close" i]')) {
      const t = (b.textContent || "").trim();
      if (t && t.length < 40 && CLOSE_TEXT.test(t)) { try { b.click(); } catch (e) {} }
    }
  }
  setInterval(sweep, 1500);

  // Ghost asks for more: swipe TikTok's own feed forward (its mobile feed is a touch-driven slider, not a scroll box;
  // a synthetic swipe moves it - checked in WebKit 2026-09-29), and TikTok fetches the next page as it nears the end.
  // Also scrolls/keys for the desktop layout. Native reloads the page if nothing new arrives (TikTokFeed.swift).
  function swipeOnce() {
    const x = innerWidth / 2;
    const target = document.querySelector('[data-e2e="video-slide-active"]') || document.elementFromPoint(x, innerHeight / 2) || document.body;
    const fire = (type, y) => {
      const t = { identifier: 7, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y, radiusX: 1, radiusY: 1, force: 1 };
      let ev;
      try { ev = new TouchEvent("touch" + type, { bubbles: true, cancelable: true, touches: type === "end" ? [] : [new Touch(t)], changedTouches: [new Touch(t)] }); }
      catch (e) {
        ev = new Event("touch" + type, { bubbles: true, cancelable: true });
        const list = type === "end" ? [] : [t];
        Object.defineProperty(ev, "touches", { value: list }); Object.defineProperty(ev, "targetTouches", { value: list }); Object.defineProperty(ev, "changedTouches", { value: [t] });
      }
      target.dispatchEvent(ev);
    };
    const y0 = innerHeight * 0.75, y1 = innerHeight * 0.2;
    fire("start", y0);
    let y = y0; const tick = () => { y -= (y0 - y1) / 10; if (y > y1) { fire("move", y); setTimeout(tick, 16); } else fire("end", y1); };
    setTimeout(tick, 16);
  }
  // Asking TikTok's own signed fetch for the next For You page, with the same parameters its first request used
  // (checked on the phone 2026-09-29, signed in: 8 new videos each call; the slider swipes below never made TikTok's
  // page fetch more, so the feed ran out after the first batch). The answer goes through the hook above -> onFeed.
  let lastRec = "", moreBusy = false, moreAt = 0;
  function noteRec(url) { if (/\/api\/recommend\/item_list\//.test(url)) lastRec = url; }
  async function fetchMore() {
    if (!lastRec || moreBusy || Date.now() - moreAt < 2500) return false;
    moreBusy = true; moreAt = Date.now();
    try {
      const u = new URL(lastRec, location.href);
      ["X-Bogus", "X-Gnarly", "msToken", "_signature"].forEach((k) => u.searchParams.delete(k));
      u.searchParams.set("pullType", "2"); u.searchParams.set("count", "8");
      const r = await window.fetch(u.pathname + u.search, { credentials: "include" });
      return r.ok;
    } catch (e) { return false; } finally { moreBusy = false; }
  }
  // TikTok's refresh (tapping For You again): a new first page, pullType 1 like the page's own first request; the
  // answer is marked refresh so Ghost puts it at the top. Already-shown videos are still left out (seen).
  let refreshing = false;
  window.__ghostTTRefresh = async function () {
    if (!lastRec || refreshing) return false;
    refreshing = true;
    try {
      const u = new URL(lastRec, location.href);
      ["X-Bogus", "X-Gnarly", "msToken", "_signature"].forEach((k) => u.searchParams.delete(k));
      u.searchParams.set("pullType", "1"); u.searchParams.set("count", "8");
      const r = await window.fetch(u.pathname + u.search, { credentials: "include" });
      await r.text().catch(() => "");
      return r.ok;
    } catch (e) { return false; } finally { setTimeout(() => { refreshing = false; }, 0); }
  };
  window.__ghostTTMore = function (n) {
    sweep();
    fetchMore();
    const count = Math.max(1, Math.min(6, Number(n) || 3));
    for (let i = 0; i < count; i++) setTimeout(() => {
      swipeOnce();
      window.scrollBy(0, innerHeight);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, bubbles: true }));
    }, i * 900);
    return count;
  };

  // ---- Ghost's search / profile / sound / hashtag requests (window.__ghostTTApi, called by native "tt" api) ----
  // TikTok's page wraps window.fetch with its own request signer (msToken, X-Bogus, X-Gnarly) after it loads, so a
  // call through window.fetch *at call time* goes out exactly like the page's own (checked 2026-09-29; the saved
  // origFetch would skip the signer). Only the paths below, a small queue (2 at a time, spaced out), and a pause
  // when TikTok asks for a captcha.
  const Q = { running: 0, waiting: [], lastStart: 0, blockedUntil: 0 };
  const GAP_MS = 350, MAX_RUNNING = 2, CAPTCHA_PAUSE_MS = 60000;
  const minimal = { aid: "1988" };
  const withCommon = () => Object.assign({ aid: "1988", app_name: "tiktok_web", device_platform: "web_mobile", channel: "tiktok_web" }, common || {});
  const enc = (o) => Object.keys(o).filter((k) => o[k] != null && o[k] !== "").map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(o[k]))).join("&");
  const clean = (x, n) => String(x == null ? "" : x).slice(0, n || 120);
  const idOk = (x) => /^[0-9]{1,30}$/.test(String(x || ""));
  const handleOk = (x) => /^[A-Za-z0-9._]{1,40}$/.test(String(x || ""));
  // kind -> [url, how to read the answer]; anything else is refused
  const KINDS = {
    guide: () => ["/api/search/suggest/guide/?" + enc(minimal), "json", parseGuide],
    sug: (p) => ["/api/search/general/preview/?" + enc(Object.assign({ keyword: clean(p.q, 100) }, minimal)), "json", parseSug],
    top: (p) => ["/api/search/general/full/?" + enc(Object.assign({ keyword: clean(p.q, 100), offset: Number(p.cursor) || 0, search_id: clean(p.searchId, 80) }, minimal)), "json", parseGeneral],
    videos: (p) => ["/api/search/item/full/?" + enc(Object.assign(withCommon(), { keyword: clean(p.q, 100), offset: Number(p.cursor) || 0, count: 12, search_id: clean(p.searchId, 80), from_page: "search" })), "json", (d) => Object.assign(parseGeneral({ data: ((d && (d.item_list || d.itemList)) || []).map((item) => ({ item })) }), { cursor: Number(d && d.cursor) || 0, hasMore: !!(d && d.has_more) })],
    users: (p) => ["/api/search/user/full/?" + enc(Object.assign(withCommon(), { keyword: clean(p.q, 100), cursor: Number(p.cursor) || 0, search_id: clean(p.searchId, 80), from_page: "search" })), "json", parseUsers],
    sounds: (p) => ["/api/search/music/full/?" + enc(Object.assign(withCommon(), { keyword: clean(p.q, 100), offset: Number(p.cursor) || 0, count: 12, search_id: clean(p.searchId, 80), from_page: "search" })), "json", parseSounds],
    user: (p) => handleOk(p.uniqueId) ? ["/@" + p.uniqueId, "html", parseUserPage] : null,
    userVideos: (p) => p.secUid && /^[A-Za-z0-9_-]{10,120}$/.test(p.secUid) ? ["/api/post/item_list/?" + enc(Object.assign(withCommon(), { secUid: p.secUid, count: 30, cursor: clean(p.cursor || 0, 40), coverFormat: 2, from_page: "user" })), "json", parseItemList] : null,
    tag: (p) => /^[\p{L}\p{N}_]{1,80}$/u.test(String(p.name || "")) ? ["/tag/" + encodeURIComponent(p.name), "html", parseTagPage] : null,
    tagVideos: (p) => idOk(p.id) ? ["/api/challenge/item_list/?" + enc(Object.assign(withCommon(), { challengeID: p.id, count: 30, cursor: clean(p.cursor || 0, 40), coverFormat: 2 })), "json", parseItemList] : null,
    sound: (p) => idOk(p.id) ? ["/music/" + (clean(p.slug, 80).replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "original-sound") + "-" + p.id, "html", parseMusicPage] : null,
    // one video by id (a TikTok shared in a message): /api/item/detail/ -> itemInfo.itemStruct
    // /api/item/detail/ answers an empty body on the website now (checked on the phone 2026-09-29), so a single video
    // (a TikTok shared in a DM) comes from TikTok's own embed page, whose state carries the play URL
    item: (p) => idOk(p.id) ? ["/embed/v2/" + p.id, "html", parseEmbedPage] : null,
    // a creator's latest ~10 videos, instantly, from TikTok's creator embed (the full list comes from the desktop page)
    userEmbed: (p) => handleOk(p.uniqueId) ? ["/embed/@" + p.uniqueId, "html", parseCreatorEmbed] : null,
    soundVideos: (p) => idOk(p.id) ? ["/api/music/item_list/?" + enc(Object.assign(withCommon(), { musicID: p.id, count: 30, cursor: clean(p.cursor || 0, 40), coverFormat: 2 })), "json", parseItemList] : null,
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // TikTok's signer is in place once window.fetch isn't ours any more (it wraps it after its scripts load)
  async function signerReady() {
    for (let i = 0; i < 60 && window.fetch === ghostFetch; i++) await sleep(250);
    return window.fetch !== ghostFetch;
  }
  // TikTok's verify answers are small JSON ({"code":"10000","type":"verify",...}) or carry a bdturing header; real
  // results are large and never say "type":"verify", so only short bodies are read for it
  function looksLikeCaptcha(res, text) {
    try { for (const h of ["bdturing-verify", "x-vc-bdturing-parameters"]) if (res.headers.get(h)) return true; } catch (e) {}
    const t = String(text || "");
    if (t.length > 4000) return false;
    return /"type"\s*:\s*"verify"/.test(t) || (/"code"\s*:\s*"?10000"?/.test(t) && /verify|captcha/i.test(t));
  }
  async function runOne(kind, params, signal) {
    const make = KINDS[kind];
    const spec = make && make(params || {});
    if (!spec) return { error: "unsupported" };
    if (Date.now() < Q.blockedUntil) return { captcha: true };
    await signerReady();
    const [path, how, parse] = spec;
    let res, text;
    try {
      res = await window.fetch(path, { credentials: "include", signal, headers: how === "html" ? { Accept: "text/html" } : { Accept: "application/json" } });
      text = await res.text();
    } catch (e) { return { error: String((e && e.message) || e).slice(0, 120) }; }
    if (looksLikeCaptcha(res, text)) { Q.blockedUntil = Date.now() + CAPTCHA_PAUSE_MS; return { captcha: true }; }
    if (!res.ok) return { error: "status " + res.status, status: res.status };
    if (!text) return { empty: true };
    if (how === "html") return Object.assign({ ok: true }, parse(text));
    let d; try { d = JSON.parse(text); } catch (e) { return { error: "not json" }; }
    return Object.assign({ ok: true }, parse(d));
  }
  window.__ghostTTApi = function (kind, params) {
    return new Promise((resolve) => {
      const go = async () => {
        Q.running++;
        Q.lastStart = Date.now();
        let out;
        // a stalled request is really cancelled, so no more than MAX_RUNNING are ever in flight
        const ac = typeof AbortController === "function" ? new AbortController() : null;
        let tm;
        const timer = new Promise((r) => { tm = setTimeout(() => { try { ac && ac.abort(); } catch (e) {} r({ error: "timeout" }); }, 25000); });
        try { out = await Promise.race([runOne(kind, params, ac && ac.signal), timer]); } catch (e) { out = { error: String(e).slice(0, 120) }; }
        clearTimeout(tm);
        Q.running--;
        pump();
        resolve(out);
      };
      Q.waiting.push(go);
      pump();
    });
  };
  function pump() {
    if (Q.running >= MAX_RUNNING || !Q.waiting.length) return;
    const wait = Math.max(0, Q.lastStart + GAP_MS - Date.now());
    if (wait) { clearTimeout(Q.t); Q.t = setTimeout(pump, wait); return; }
    Q.waiting.shift()();
    pump();
  }

  // signed-in state for Ghost's Settings (TikTok marks the logged-in user in its page data)
  function reportUser() {
    let user = null;
    try {
      const s = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
      const d = s && JSON.parse(s.textContent);
      const u = d && d.__DEFAULT_SCOPE__ && d.__DEFAULT_SCOPE__["webapp.app-context"] && d.__DEFAULT_SCOPE__["webapp.app-context"].user;
      if (u && u.uniqueId) user = { uniqueId: String(u.uniqueId), nickname: String(u.nickName || u.nickname || "") };
    } catch (e) {}
    post({ type: "page", user, url: location.href });
  }
  document.addEventListener("DOMContentLoaded", reportUser);
})();
