// Ghost TikTok actions: runs inside a hidden web view that shows ONE TikTok video on TikTok's *desktop* website
// (ios/Sources/TikTokVideo.swift loads https://www.tiktok.com/@<user>/video/<id>). Never in Snapchat's page.
//
// Why a page: liking, saving, following, commenting and "Not interested" are requests TikTok's website makes with
// its own security tokens, and its phone website doesn't have most of them (they send you to the app). So Ghost does
// what a person would do on the desktop site: it presses TikTok's own buttons on that video's page, only when the user
// tapped the same thing in Ghost, and reads back the result from the page. Nothing here builds a TikTok request
// itself or touches TikTok's tokens.
//
// The buttons' data-e2e names (like-icon, favorite-icon, comment-icon, share-icon, feed-follow, more-menu-icon,
// video-desc, like-count, favorite-count, comment-count) were read off a live desktop video page on 2026-09-29.
// The comment panel's inner names couldn't be checked signed out (TikTok shows no comments then), so comments are
// found by their React props (objects with cid + text + user) and their own buttons by role/text, not class names.
(function () {
  "use strict";
  if (window.__ghostVP) return;
  const str = (x, n) => String(x == null ? "" : x).slice(0, n || 200);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel, root) => (root || document).querySelector(sel);
  const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ---- profile / hashtag / sound lists (Ghost 1.5.0) ----------------------------------------------------------
  // /api/post/item_list/ answers an empty body to a fetch Ghost makes itself (checked on the phone 2026-09-29), but
  // TikTok's own desktop profile page fetches it fine. So native opens https://www.tiktok.com/@<user> (or /tag/<name>,
  // /music/<slug>-<id>) in this hidden page, this hook keeps a compact copy of every list answer TikTok's page gets,
  // and scrolling the page makes TikTok fetch the next one. compact() is the TikTok tab's (build-userscripts.py
  // copies it in from tiktok-page.js at the marker below).
  /* @ghost-compact */
  const LIST_RE = /\/api\/(post|challenge|music)\/item_list\//;
  const L = { items: [], ids: new Set(), hasMore: true, answers: 0 };
  function onList(text) {
    let d; try { d = JSON.parse(text); } catch (e) { return; }
    if (!d || typeof d !== "object") return;
    L.answers++;
    for (const it of d.itemList || d.item_list || []) {
      let c = null; try { c = typeof compact === "function" ? compact(it) : null; } catch (e) {}
      if (c && !L.ids.has(c.id)) { L.ids.add(c.id); L.items.push(c); }
    }
    if (d.hasMore === false || d.has_more === false || d.has_more === 0) L.hasMore = false;
  }
  const OF = window.fetch;
  window.fetch = function (input, init) {
    const url = String((input && input.url) || input || "");
    if (!LIST_RE.test(url)) return OF.apply(this, arguments);
    return OF.apply(this, arguments).then((r) => { try { r.clone().text().then(onList, () => {}); } catch (e) {} return r; });
  };
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) { this.__ghL = LIST_RE.test(String(url || "")); return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    if (this.__ghL) this.addEventListener("load", () => { try { if (this.responseType === "" || this.responseType === "text") onList(this.responseText); else if (this.responseType === "json") onList(JSON.stringify(this.response)); } catch (e) {} });
    return XS.apply(this, arguments);
  };
  function pageHeader() {
    try {
      const sc = JSON.parse(document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__").textContent).__DEFAULT_SCOPE__ || {};
      const ud = sc["webapp.user-detail"] && sc["webapp.user-detail"].userInfo;
      if (ud && ud.user) {
        const u = ud.user, st = ud.statsV2 || ud.stats || {};
        return { user: { id: str(u.id, 40), uniqueId: str(u.uniqueId, 60), nickname: str(u.nickname, 80), secUid: str(u.secUid, 120), avatar: str(u.avatarThumb, 600), avatarLarge: str(u.avatarLarger || u.avatarMedium, 600), signature: str(u.signature, 300), verified: !!u.verified, privateAccount: !!u.privateAccount, followers: String(st.followerCount || 0), following: String(st.followingCount || 0), likes: String(st.heartCount || st.heart || 0), videos: String(st.videoCount || 0) } };
      }
    } catch (e) {}
    return {};
  }
  function scrollForMore() {
    window.scrollTo(0, document.documentElement.scrollHeight);
    for (const e of qa("main, div")) { if (e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) { e.scrollTop = e.scrollHeight; e.dispatchEvent(new Event("scroll")); } }
    window.dispatchEvent(new Event("scroll"));
  }
  // from: how many items Ghost already has; more: scroll for the next page first
  window.__ghostVPList = async function (a) {
    a = a || {};
    const from = Math.max(0, Number(a.from) || 0);
    const want = from + 1;
    if (a.more && L.items.length < want && L.hasMore) {
      const before = L.items.length, answers = L.answers;
      for (let i = 0; i < 3 && L.items.length === before && L.hasMore; i++) {
        scrollForMore();
        const end = Date.now() + 3000;
        while (Date.now() < end && L.answers === answers) await sleep(150);
        await sleep(200);
      }
    } else if (!L.items.length) {
      const end = Date.now() + 9000; // the first page arrives with the page itself
      while (Date.now() < end && !L.answers) await sleep(200);
    }
    const out = L.items.slice(from, from + 60);
    return Object.assign({ ok: true, items: out, total: L.items.length, hasMore: L.hasMore || L.items.length > from + out.length, answers: L.answers }, pageHeader());
  };

  function fiberOf(el) {
    if (!el) return null;
    for (const k in el) if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) return el[k];
    return null;
  }
  function propsUp(el, test, depth) {
    let f = fiberOf(el);
    for (let i = 0; f && i < (depth || 25); i++, f = f.return) {
      const p = f.memoizedProps;
      if (p && typeof p === "object") { try { const hit = test(p); if (hit) return hit; } catch (e) {} }
    }
    return null;
  }
  // the item this page shows, from the props of the video's own components
  const isItem = (v) => v && typeof v === "object" && typeof v.id === "string" && v.author && ("digged" in v || "stats" in v || "statsV2" in v);
  function itemFrom(el) {
    return propsUp(el, (p) => { if (isItem(p.item)) return p.item; if (isItem(p.itemInfo)) return p.itemInfo; if (isItem(p.video)) return p.video; if (isItem(p)) return p; for (const k of Object.keys(p)) if (isItem(p[k])) return p[k]; return null; }, 30);
  }
  // TikTok's desktop video page can show more than one video (the one asked for and the next ones), and sometimes
  // not the one asked for at all (phone 2026-09-29: URL + page data said 7663…, the buttons belonged to 7690…/7640…).
  // So everything is matched by the video's id, never "the first like button".
  const ITEM_SELS = ['[data-e2e="like-icon"]', '[data-e2e="browse-like-icon"]', '[data-e2e="favorite-icon"]', '[data-e2e="video-desc"]', '[data-e2e="feed-video"]'];
  function currentItem(id) {
    for (const sel of ITEM_SELS) for (const a of qa(sel)) {
      const it = itemFrom(a);
      if (it && (!id || it.id === id)) return it;
    }
    return null;
  }
  // the button (like / favorite / comment / follow) that belongs to video `id`
  function buttonFor(id, sel) {
    for (const b of qa(sel)) { const it = itemFrom(b); if (it && it.id === id) return b; }
    return null;
  }
  // the page's own data says it's this video but none of its buttons are: reload once (TikTok then shows it)
  function reloadIfMissing(id) {
    if (!id || currentItem(id) || document.readyState !== "complete") return;
    let rh = ""; try { rh = JSON.parse(document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__").textContent).__DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct.id; } catch (e) {}
    const key = "ghReload:" + id;
    if (performance.now() > 5000 && !sessionStorage.getItem(key) && (rh === id || location.pathname.includes(id))) { sessionStorage.setItem(key, "1"); location.reload(); }
  }
  const num = (x) => { const n = Number(x); return isFinite(n) ? n : 0; };
  function state(id) {
    const it = currentItem(id);
    if (!it && id) reloadIfMissing(id);
    const st = (it && (it.statsV2 || it.stats)) || {};
    const followBtn = q('[data-e2e="feed-follow"]') || q('[data-e2e="browse-follow"]');
    const followText = followBtn ? followBtn.textContent.trim().toLowerCase() : "";
    const rel = it && it.author && typeof it.author.relation === "number" ? it.author.relation : null;
    return {
      ok: !!it, id: it ? it.id : "",
      liked: it ? !!it.digged : pressed(q('[data-e2e="like-icon"]')),
      saved: it ? !!it.collected : pressed(q('[data-e2e="favorite-icon"]')),
      following: followBtn ? !/^follow$/.test(followText) : rel != null ? rel > 0 : null,
      likes: num(st.diggCount), comments: num(st.commentCount), saves: num(st.collectCount), shares: num(st.shareCount),
      signedIn: !q('[data-e2e="top-login-button"]'),
    };
  }
  function pressed(el) {
    if (!el) return false;
    const b = el.closest("button") || el;
    const a = b.getAttribute("aria-pressed");
    if (a != null) return a === "true";
    return false;
  }
  // TikTok's buttons react to the whole pointer sequence, not a bare click(): on the phone a click() left the like
  // off, while pointerdown/mousedown/pointerup/mouseup/click at the button's centre liked it (checked 2026-09-29).
  function clickEl(el) {
    const b = (el && (el.closest("button") || el.closest("[role=button]"))) || el;
    if (!b) return false;
    const r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true, view: window };
    try {
      b.dispatchEvent(new PointerEvent("pointerdown", o)); b.dispatchEvent(new MouseEvent("mousedown", o));
      b.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, o, { buttons: 0 }))); b.dispatchEvent(new MouseEvent("mouseup", Object.assign({}, o, { buttons: 0 })));
      b.dispatchEvent(new MouseEvent("click", Object.assign({}, o, { buttons: 0 })));
    } catch (e) { b.click(); }
    return true;
  }
  async function waitFor(test, ms) {
    const end = Date.now() + (ms || 5000);
    while (Date.now() < end) { try { const v = test(); if (v) return v; } catch (e) {} await sleep(150); }
    return null;
  }
  const loginWall = () => !!(q('[data-e2e="login-modal"]') || q('#login-modal') || qa('[role="dialog"]').some((d) => /log in to tiktok|sign up for tiktok/i.test(d.textContent || "")));

  // ---- toggles: like / save / follow. Press only if the page's state differs, then wait for it to change. ----
  async function toggle(id, which, on) {
    const before = state(id);
    if (!before.ok) return { error: "TikTok's page didn't show that video", notDone: true };
    if (!before.signedIn) return { error: "signed out", notDone: true };
    const key = which === "like" ? "liked" : which === "save" ? "saved" : "following";
    if (before[key] === on) return { ok: true, state: before, already: true };
    const sel = which === "like" ? '[data-e2e="like-icon"], [data-e2e="browse-like-icon"]' : which === "save" ? '[data-e2e="favorite-icon"], [data-e2e="browse-favorite-icon"]' : '[data-e2e="feed-follow"], [data-e2e="browse-follow"]';
    // the video's data is on the page a moment before its buttons are (phone 2026-09-29: "no like button"); and the
    // button must be THIS video's (the page can show other videos too)
    const btn = await waitFor(() => (which === "follow" ? buttonFor(id, sel) || q(sel) : buttonFor(id, sel)), 8000);
    if (!btn || !clickEl(btn)) return { error: "no " + which + " button on TikTok's page", notDone: true };
    // if the pointer press didn't take, one plain click (only while the state still hasn't changed)
    if (!(await waitFor(() => state(id)[key] === on, 2500)) && state(id)[key] !== on) { const b2 = btn.closest("button") || btn.closest("[role=button]") || btn; b2.click(); }
    // unfollowing may ask to confirm
    if (which === "follow" && !on) {
      const confirm = await waitFor(() => qa('[role="dialog"] button, [data-e2e*="confirm"]').find((b) => /unfollow/i.test(b.textContent || "")), 1500);
      if (confirm) clickEl(confirm);
    }
    const after = await waitFor(() => { const s = state(id); return s[key] === on ? s : null; }, 5000);
    if (after) return { ok: true, state: after };
    if (loginWall()) return { error: "TikTok wants you to sign in again", notDone: true };
    return { ok: false, unknown: true, state: state(id) };
  }

  // ---- comments: read from the comment panel's React props ----
  const isComment = (v) => v && typeof v === "object" && (typeof v.cid === "string" || typeof v.cid === "number") && typeof v.text === "string" && v.user;
  function commentUser(u) {
    u = u || {};
    const pic = (o) => { if (!o) return ""; if (typeof o === "string") return o; const l = o.url_list || o.urlList || o.UrlList; return Array.isArray(l) ? l[0] || "" : ""; };
    return { nickname: str(u.nickname || u.nickName, 80), uniqueId: str(u.unique_id || u.uniqueId, 60), avatar: str(pic(u.avatar_thumb) || pic(u.avatarThumb) || pic(u.avatar_medium), 600) };
  }
  function compactComment(c) {
    return {
      cid: str(c.cid, 40), text: str(c.text, 2000), time: num(c.create_time || c.createTime),
      likes: num(c.digg_count != null ? c.digg_count : c.diggCount), liked: !!(c.user_digged || c.userDigged || c.is_digged),
      replies: num(c.reply_comment_total != null ? c.reply_comment_total : c.replyCommentTotal),
      replyTo: str(c.reply_id && c.reply_id !== "0" ? c.reply_id : "", 40),
      byAuthor: !!(c.is_author_digged || c.author_pin), user: commentUser(c.user),
      mine: false,
    };
  }
  function panel() {
    return q('[data-e2e="comment-list"]') || q('[class*="CommentListContainer"]') || null;
  }
  // every element whose own props carry a comment object: top-level ones and replies (reply_id set)
  function readComments() {
    const root = panel() || document.body;
    const out = [], seen = new Set();
    for (const el of qa("div, li, p, span", root)) {
      if (out.length > 400) break;
      // the comment object sits on the element's own component or the one just above it (commentItem on the
      // phone's desktop page, 2026-09-29: one level up from the comment-level-1 element)
      let c = null;
      for (let f = fiberOf(el), d = 0; f && d < 3 && !c; f = f.return, d++) {
        const p = f.memoizedProps;
        if (!p || typeof p !== "object") continue;
        for (const k of ["comment", "commentItem", "data", "item", "reply"]) if (isComment(p[k])) { c = p[k]; break; }
        if (!c && isComment(p)) c = p;
      }
      if (!c || seen.has(String(c.cid))) continue;
      seen.add(String(c.cid));
      const cc = compactComment(c);
      cc._el = el;
      out.push(cc);
    }
    return out;
  }
  const strip = (list) => list.map((c) => { const x = Object.assign({}, c); delete x._el; return x; });
  async function openComments(id) {
    if (readComments().length) return true;
    const ic = await waitFor(() => (id ? buttonFor(id, '[data-e2e="comment-icon"], [data-e2e="browse-comment-icon"]') : null) || (!id ? q('[data-e2e="comment-icon"]') : null), 8000);
    if (!ic) return false;
    // a plain click opens the comment panel (1.4.0 did, checked on the phone); the full pointer sequence toggled it
    // open and shut again ("TikTok's comments didn't open" in 1.5.x)
    const b = ic.closest("button") || ic.closest("[role=button]") || ic;
    b.click();
    return !!(await waitFor(() => readComments().length || q('[data-e2e="comment-input"]') || /no comments/i.test((panel() || document.body).textContent || ""), 6000));
  }
  function commentEl(cid) { const c = readComments().find((x) => x.cid === cid); return c ? c._el : null; }
  // the comment's own box: the nearest ancestor that also holds its like button
  function commentBox(el) {
    let b = el;
    for (let i = 0; b && i < 8; i++, b = b.parentElement) if (b.querySelector && (b.querySelector('[data-e2e*="like"]') || b.querySelector('[aria-label*="ike"]'))) return b;
    return el && el.parentElement;
  }
  async function comments(id, more) {
    const s = state(id);
    if (!s.ok) return { error: "TikTok's page didn't show that video" };
    if (!(await openComments(id))) return { error: "TikTok's comments didn't open", comments: [] };
    // the panel (and its input) shows before its comments arrive: on the phone the first open answered "no comments"
    // on a video with hundreds (2026-09-29). When TikTok's count says there are some, wait for them to arrive.
    if (s.comments > 0 && !readComments().length) await waitFor(() => readComments().length > 0, 12000);
    if (more) {
      const before = readComments().length;
      const sc = scroller(); if (sc) { sc.scrollTop = sc.scrollHeight; sc.dispatchEvent(new Event("scroll")); }
      await waitFor(() => readComments().length > before, 4000);
    }
    const all = readComments();
    return { ok: true, comments: strip(all.filter((c) => !c.replyTo)), replies: strip(all.filter((c) => c.replyTo)), total: s.comments, signedIn: s.signedIn };
  }
  function scroller() {
    const p = panel();
    let e = (p || (readComments()[0] || {})._el);
    for (let i = 0; e && i < 12; i++, e = e.parentElement) { const cs = getComputedStyle(e); if (/(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 4) return e; }
    return null;
  }
  async function replies(id, cid) {
    if (!(await openComments(id))) return { error: "TikTok's comments didn't open" };
    const el = commentEl(cid);
    if (!el) return { error: "that comment isn't on TikTok's page" };
    // the comment's own block: the largest ancestor that still holds only this one top-level comment (its replies
    // button sits beside the comment, not inside it)
    let area = el;
    for (let e = el.parentElement, i = 0; e && i < 8; e = e.parentElement, i++) { if (e.querySelectorAll('[data-e2e="comment-level-1"]').length > 1) break; area = e; }
    // TikTok's "View 6 replies" is a <button class="TUXButton"> inside a DivViewRepliesContainer (phone 2026-09-29);
    // clicking the container div never reaches the button's handler, so the button itself is taken first
    // first "View 6 replies", then (once some show) "View 3 more" - no "replies" in that one (phone 2026-09-29)
    const isView = (b) => /^view\s+(\d+\s+)?(more\s+)?(repl|more\b)/i.test((b.textContent || "").trim());
    const btn = qa("button, [role=button]", area).find(isView) || qa("p, span, div", area).find((b) => isView(b) && b.children.length < 3);
    const before = readComments().filter((c) => c.replyTo === cid).length;
    if (btn) {
      // a plain click first (like the comment button), the full pointer press only if nothing happened
      (btn.closest("button") || btn.closest("[role=button]") || btn).click();
      if (!(await waitFor(() => readComments().filter((c) => c.replyTo === cid).length > before, 4000))) {
        clickEl(btn); await waitFor(() => readComments().filter((c) => c.replyTo === cid).length > before, 5000);
      }
    }
    return { ok: true, replies: strip(readComments().filter((c) => c.replyTo === cid)) };
  }
  async function likeComment(id, cid, on) {
    if (!(await openComments(id))) return { error: "TikTok's comments didn't open", notDone: true };
    const cur = readComments().find((c) => c.cid === cid);
    if (!cur) return { error: "that comment isn't on TikTok's page", notDone: true };
    if (cur.liked === on) return { ok: true, already: true };
    const box = commentBox(cur._el);
    const btn = box && (q('[data-e2e="comment-like-icon"]', box) || q('[data-e2e*="like"]', box) || q('[aria-label*="ike"]', box));
    if (!btn) return { error: "no like button on that comment", notDone: true };
    clickEl(btn);
    const ok = await waitFor(() => { const c = readComments().find((x) => x.cid === cid); return c && c.liked === on; }, 4000);
    return ok ? { ok: true } : { ok: false, unknown: true };
  }
  // ---- posting a comment / reply: TikTok's own comment box, once per request id ----
  const posted = new Set();
  let lock = Promise.resolve();
  function commentEditor() {
    // live on the phone (2026-09-29): comment-input holds comment-text, TikTok's Draft editor
    const txt = q('[data-e2e="comment-text"]');
    if (txt) { const ce = txt.isContentEditable ? txt : q('[contenteditable="true"]', txt); if (ce) return ce; }
    const box = q('[data-e2e="comment-input"]') || q('[class*="CommentInputContainer"]') || q('[class*="DivInputEditorContainer"]');
    const root = box || document;
    return q('[contenteditable="true"]', root) || q("textarea", root);
  }
  const edText = (ed) => String((ed && (ed.value != null && ed.tagName === "TEXTAREA" ? ed.value : ed.innerText || ed.textContent)) || "").replace(/​/g, "").trim();
  function typeInto(ed, text) {
    ed.focus();
    if (ed.tagName === "TEXTAREA") {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      set.call(ed, text); ed.dispatchEvent(new Event("input", { bubbles: true })); return;
    }
    try { document.execCommand("selectAll", false, null); document.execCommand("insertText", false, text); } catch (e) {}
  }
  async function postComment(id, text, replyCid, rid) {
    if (!rid || posted.has(rid)) return { ok: true, duplicate: true };
    text = String(text || "").trim();
    if (!text || text.length > 150) return { error: text ? "comments can be up to 150 characters" : "empty", notSent: true };
    const s = state(id);
    if (!s.ok) return { error: "TikTok's page didn't show that video", notSent: true };
    if (!s.signedIn) return { error: "signed out", notSent: true };
    if (!(await openComments(id))) return { error: "TikTok's comments didn't open", notSent: true };
    if (replyCid) {
      const el = commentEl(replyCid);
      if (!el) return { error: "that comment isn't on TikTok's page", notSent: true };
      const box = commentBox(el) || el;
      const rb = qa("span, p, button, div", box).find((b) => /^reply$/i.test((b.textContent || "").trim()));
      if (!rb) return { error: "no reply button on that comment", notSent: true };
      clickEl(rb);
      await sleep(400);
    }
    const ed = await waitFor(() => commentEditor(), 3000);
    if (!ed) return { error: "no comment box", notSent: true };
    typeInto(ed, text);
    await sleep(250);
    if (!edText(ed).includes(text)) { try { ed.focus(); document.execCommand("selectAll", false, null); document.execCommand("delete", false, null); } catch (e) {} return { error: "couldn't type into TikTok's comment box", notSent: true }; }
    const before = readComments().filter((c) => c.text === text).length;
    posted.add(rid); // from here this request never posts again
    const btn = q('[data-e2e="comment-post"]') || qa("div, button, span", (ed.closest('[data-e2e="comment-input"]') || ed.parentElement || document).parentElement || document).find((b) => /^post$/i.test((b.textContent || "").trim()));
    if (btn) clickEl(btn); else ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    const ok = await waitFor(() => readComments().filter((c) => c.text === text).length > before, 7000);
    return { ok: true, confirmed: !!ok };
  }
  // ---- Not interested: the video's "..." menu ----
  async function notInterested(id) {
    const s = state(id);
    if (!s.ok) return { error: "TikTok's page didn't show that video", notDone: true };
    const more = q('[data-e2e="more-menu-icon"]');
    if (!more) return { error: "no menu on TikTok's page", notDone: true };
    clickEl(more);
    const item = await waitFor(() => qa("li, button, div, span, p").find((b) => /^not interested$/i.test((b.textContent || "").trim()) && b.children.length < 3), 3000);
    if (!item) { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return { error: "TikTok's menu has no Not interested here", notDone: true }; }
    clickEl(item);
    return { ok: true };
  }

  // the video's own file address as TikTok's page has it (signed for this session): a TikTok link in a Snapchat
  // chat whose embed-page address TikTok refuses (403, device report 2026-09-30) plays from this instead.
  // Same choice as tiktok-page.js compact(): an H.264 rung around 720p, else playAddr.
  async function playUrl(id) {
    let it = null;
    for (let i = 0; i < 40 && !(it = currentItem(id)); i++) { if (i === 10) reloadIfMissing(id); await new Promise((r) => setTimeout(r, 250)); }
    if (!it || !it.video) return { error: "TikTok's page didn't show that video" };
    const v = it.video;
    const pick = (x) => (Array.isArray(x) ? x[0] : x) || "";
    let play = pick(v.playAddr) || pick(v.PlayAddrStruct && v.PlayAddrStruct.UrlList);
    const h264 = (Array.isArray(v.bitrateInfo) ? v.bitrateInfo : []).filter((b) => b && /h264|avc/i.test(b.CodecType || "") && b.PlayAddr && b.PlayAddr.UrlList && b.PlayAddr.UrlList.length)
      .sort((a, b) => (a.Bitrate || 0) - (b.Bitrate || 0));
    const mid = h264.find((b) => (b.PlayAddr.Height || 0) >= 700) || h264[h264.length - 1];
    if (mid) play = mid.PlayAddr.UrlList[0];
    if (!/^https:\/\//.test(play)) return { error: "no video address on TikTok's page" };
    return { ok: true, play };
  }

  window.__ghostVP = function (action, a) {
    a = a || {};
    const id = str(a.id, 30);
    if (!/^\d{5,30}$/.test(id)) return Promise.resolve({ error: "bad id" });
    const run = () => {
      switch (action) {
        case "state": { const s = state(id); return Promise.resolve(s.ok ? { ok: true, state: s } : { error: "TikTok's page didn't show that video" }); }
        case "like": return toggle(id, "like", !!a.on);
        case "save": return toggle(id, "save", !!a.on);
        case "follow": return toggle(id, "follow", !!a.on);
        case "comments": return comments(id, !!a.more);
        case "replies": return replies(id, str(a.cid, 40));
        case "likeComment": return likeComment(id, str(a.cid, 40), !!a.on);
        case "comment": return postComment(id, String(a.text || ""), str(a.replyTo, 40), str(a.rid, 80));
        case "notInterested": return notInterested(id);
        case "play": return playUrl(id);
        default: return Promise.resolve({ error: "unknown action" });
      }
    };
    // one action at a time: two taps never interleave on TikTok's page
    const p = lock.then(run).catch((e) => ({ error: str(e && e.message, 120) }));
    lock = p.then(() => {}, () => {});
    return p;
  };
  // for Ghost's tests
  window.__ghostVPRead = { state, readComments: () => strip(readComments()), currentItem };
})();
