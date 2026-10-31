// Ghost TikTok messages: runs inside the hidden TikTok *messages* web view (ios/Sources/TikTokMessages.swift), never
// in Snapchat's page. TikTok's phone website has no chats ("Chats on mobile browser are not available"), so that web
// view loads the desktop site's https://www.tiktok.com/messages with a desktop Safari user agent.
//
// Reading: TikTok's own messages page is read as it renders (a MutationObserver), never its network traffic: the
// conversation list ([data-e2e="dm-new-conversation-item"]) and the open chat ([data-e2e="dm-new-chat-item"]). These
// data-e2e names come from TikTok's desktop bundle (messages chunk + its DM chunks, fetched 2026-09-29); the older
// "chat-list-item" / "chat-item" names are kept as a fallback. Each row also carries React's own props (the message
// object: serverId, content JSON, isFromMe, createdAt; the conversation id), read from React's fiber on the element;
// when those aren't there the visible text is used instead.
// Sending: TikTok's own message box is driven (focus, type the text, press its send button), so TikTok's code does
// everything a real send does. Only when Ghost asks (a user tap), once per request id, and only after checking the
// chat on screen is the one asked for. Nothing here ever calls TikTok's messaging servers itself.
(function () {
  "use strict";
  if (window.__ghostTTDM) return;
  window.__ghostTTDM = true;
  const post = (msg) => { try { window.webkit.messageHandlers.ghostttdm.postMessage(msg); } catch (e) {} };
  const str = (x, n) => String(x == null ? "" : x).slice(0, n || 200);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- reader (unit-tested against fixtures: ghost/tests/tiktok-dm-page.test.cjs runs this file on fixture DOMs) ----
  const SEL = {
    convItem: ['[data-e2e="dm-new-conversation-item"]', '[data-e2e="chat-list-item"]'],
    convList: ['[data-e2e="dm-new-conversation-list"]'],
    convName: ['[data-e2e="dm-new-conversation-nickname"]', '[data-e2e="chat-list-nickname"]'],
    convAvatar: ['[data-e2e="dm-new-conversation-avatar"]'],
    convUnread: ['[data-e2e="dm-new-conversation-unread"]'],
    chatBox: ['[data-e2e="dm-new-chatbox"]'],
    chatName: ['[data-e2e="dm-new-chat-nickname"]', '[data-e2e="chat-nickname"]'],
    chatHandle: ['[data-e2e="chat-uniqueid"]'],
    msgList: ['[data-e2e="dm-new-message-list"]'],
    msgItem: ['[data-e2e="dm-new-chat-item"]', '[data-e2e="chat-item"]'],
    msgText: ['[data-e2e="dm-new-message-text"]'],
    msgVideo: ['[data-e2e="dm-new-shared-video"]'],
    editor: ['[data-e2e="dm-new-input-editor"]', '[data-e2e="message-input-area"]'],
    send: ['[data-e2e="dm-new-send-btn"]', '[data-e2e="message-send"]'],
  };
  const q1 = (root, list) => { for (const s of list) { const e = root.querySelector(s); if (e) return e; } return null; };
  const qa = (root, list) => { for (const s of list) { const e = root.querySelectorAll(s); if (e.length) return Array.from(e); } return []; };
  // React keeps each element's fiber on it (__reactFiber$<random>); props of the components around an element are
  // on fiber.return. Walks up at most `depth` components looking for props matching `test`.
  function fiberOf(el) {
    if (!el) return null;
    for (const k in el) if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) return el[k];
    return null;
  }
  function propsUp(el, test, depth) {
    let f = fiberOf(el);
    for (let i = 0; f && i < (depth || 25); i++, f = f.return) {
      const p = f.memoizedProps;
      if (p && typeof p === "object") { try { if (test(p)) return p; } catch (e) {} }
    }
    return null;
  }
  // descendants (bounded) whose own component props match
  function propsDown(root, test, limit) {
    const els = root.querySelectorAll("*");
    for (let i = 0; i < els.length && i < (limit || 400); i++) { const p = propsUp(els[i], test, 3); if (p) return { el: els[i], props: p }; }
    return null;
  }
  const lines = (el) => String((el && (el.innerText || el.textContent)) || "").split("\n").map((s) => s.trim()).filter(Boolean);
  // Images are blocked in this hidden page, so TikTok swaps the <img> for its placeholder <svg> and the picture URL only
  // lives in the avatar component's props (`src`, checked on the phone 2026-09-29). Try the <img> first, then the props.
  const isPicUrl = (v) => typeof v === "string" && /^https:\/\/[^/]+\.(tiktokcdn(-us)?\.com|ibyteimg\.com|byteimg\.com)\//.test(v);
  const imgSrc = (el) => {
    if (!el) return "";
    const i = el.querySelector("img"); const a = i && (i.getAttribute("src") || i.currentSrc);
    if (a) return a;
    for (const e of [el.querySelector("span, div"), el].filter(Boolean)) {
      const p = propsUp(e, (x) => isPicUrl(x.src) || isPicUrl(x.avatar) || isPicUrl(x.url), 8);
      if (p) return isPicUrl(p.src) ? p.src : isPicUrl(p.avatar) ? p.avatar : p.url;
    }
    return "";
  };
  const isConv = (p) => typeof p.id === "string" && p.id && ("shortId" in p);
  const isMsg = (p) => p.message && typeof p.message === "object" && ("content" in p.message || "isFromMe" in p.message);

  const convIdAttr = (it) => { const e = it.hasAttribute("data-conv-id") ? it : it.querySelector("[data-conv-id]"); return e ? String(e.getAttribute("data-conv-id") || "").trim() : ""; };
  function readConversations(doc) {
    const out = [];
    const items = qa(doc, SEL.convItem);
    items.forEach((it, i) => {
      const cp = propsUp(it, isConv, 25);
      const nameEl = q1(it, SEL.convName);
      const name = str(nameEl ? nameEl.textContent.trim() : lines(it)[0], 80);
      const unreadEl = q1(it, SEL.convUnread);
      // the last-message line is the element TikTok gives a hasUnread prop to; its time is the last text line
      const lastP = propsDown(it, (p) => typeof p.hasUnread === "boolean", 120);
      // the unread badge ("2", "99+") comes after the time: leave it out of the text lines
      // (TikTok's other layout draws the badge without a data-e2e: a bare number at the end is that badge, never a time)
      let badge = unreadEl ? unreadEl.textContent.trim() : "";
      let all = lines(it);
      if (!badge && all.length > 2 && /^\d{1,2}\+?$/.test(all[all.length - 1])) badge = all[all.length - 1];
      if (badge && all[all.length - 1] === badge) all = all.slice(0, -1);
      const time = all.length > 1 ? str(all[all.length - 1], 20) : "";
      let last = lastP ? str(lines(lastP.el).join(" "), 160) : "";
      if (!last) { const rest = all.filter((l) => l !== name && l !== time && !/^\d+\+?$/.test(l)); last = str(rest.join(" "), 160); }
      const unreadN = badge ? Number(String(badge).replace(/\D/g, "")) || 1 : 0;
      // TikTok's list items carry the conversation id as a data-conv-id attribute (phone check 2026-09-29); without it
      // Ghost fell back to "i<index>:<name>" keys, which never matched the open chat's id, so every send failed
      const cid = cp ? cp.id : convIdAttr(it);
      out.push({
        id: cid ? str(cid, 120) : "",
        key: cid ? str(cid, 120) : "i" + i + ":" + name,
        name,
        avatar: str(imgSrc(q1(it, SEL.convAvatar) || it), 600),
        last, time,
        unread: !!unreadN || !!(lastP && lastP.props.hasUnread),
        unreadCount: unreadN,
      });
    });
    return out;
  }
  function parseContent(m) {
    let c = null;
    try { c = typeof m.content === "string" ? JSON.parse(m.content) : m.content; } catch (e) { c = null; }
    return c && typeof c === "object" ? c : {};
  }
  // TikTok's current chat items take only a clientId prop; the message object itself lives in a hook of the item's
  // component (memoizedState chain, often under .current) - found on the phone 2026-09-29.
  const isMsgObj = (v) => v && typeof v === "object" && !(v instanceof Node) && "isFromMe" in v && "content" in v && "createdAt" in v;
  function msgFromHooks(el) {
    let f = fiberOf(el);
    for (let i = 0; f && i < 8; i++, f = f.return) {
      let h = f.memoizedState;
      for (let j = 0; h && typeof h === "object" && j < 40; j++, h = h.next) {
        const v = h.memoizedState;
        if (isMsgObj(v)) return v;
        if (v && typeof v === "object" && isMsgObj(v.current)) return v.current;
      }
    }
    return null;
  }
  // a shared TikTok: the card carries itemId / nickname props and draws its cover as a background image
  function sharedVideo(it) {
    const card = it.querySelector('[data-e2e="dm-new-shared-video"]');
    if (!card) return null;
    const p = propsUp(card, (x) => typeof x.itemId === "string" && x.itemId, 6);
    const bg = (card.style && card.style.backgroundImage) || "";
    const m = bg.match(/url\(["']?(.*?)["']?\)/);
    return p ? { itemId: str(p.itemId, 40), cover: str(m ? m[1] : "", 600), name: str(p.nickname || "", 80) } : null;
  }
  function readMessage(it, i, listRect) {
    const hm = msgFromHooks(it);
    const mp = propsUp(it, isMsg, 25) || (hm ? { message: hm } : null);
    if (mp) {
      const m = mp.message, c = parseContent(m);
      const thumb = c.content_thumb && (c.content_thumb.url_list || c.content_thumb.urlList);
      let video = c.itemId || c.item_id ? { itemId: str(c.itemId || c.item_id, 40), cover: str(Array.isArray(thumb) ? thumb[0] : "", 600), name: str(c.content_name, 80) } : null;
      const card = sharedVideo(it);
      // the card's own cover first: content_thumb is often the 100x100 author picture, not the video
      if (card) video = { itemId: (video && video.itemId) || card.itemId, cover: card.cover || (video && video.cover) || "", name: (video && video.name) || card.name };
      let text = typeof c.text === "string" ? str(c.text, 6000) : "";
      if (!text && !video) text = str(lines(it).join(" "), 400); // stickers, photos, cards: what TikTok shows
      return {
        id: str(m.serverId || m.clientId || "m" + i, 60),
        convId: str(m.conversationId || "", 120),
        me: !!m.isFromMe,
        text, video,
        time: Number(m.createdAt) || 0,
        recalled: !!m.isRecalled,
        kind: video ? "video" : typeof c.text === "string" ? "text" : "other",
      };
    }
    // no React props: visible text, and "me" = the bubble sits on the right half of the list
    const t = q1(it, SEL.msgText);
    const bubble = t || it;
    const r = bubble.getBoundingClientRect();
    const me = listRect && r.width ? (r.left + r.width / 2) > (listRect.left + listRect.width / 2) : false;
    return { id: "d" + i + ":" + str(lines(it).join(" "), 40), convId: "", me, text: str(t ? t.textContent : lines(it).join(" "), 6000), video: null, time: 0, recalled: false, kind: t ? "text" : "other" };
  }
  function currentConvId(doc) {
    const box = q1(doc, SEL.chatBox);
    if (box) {
      const up = propsUp(box, (p) => p.conversation && typeof p.conversation.id === "string", 12);
      if (up) return up.conversation.id;
      const down = propsDown(box, (p) => p.conversation && typeof p.conversation.id === "string", 600);
      if (down) return down.props.conversation.id;
    }
    // the messages say which conversation they belong to
    const ids = new Set(readMessages(doc).map((m) => m.convId).filter(Boolean));
    return ids.size === 1 ? [...ids][0] : "";
  }
  function readMessages(doc) {
    const list = q1(doc, SEL.msgList);
    const lr = list ? list.getBoundingClientRect() : null;
    const items = qa(list || doc, SEL.msgItem);
    return items.slice(-120).map((it, i) => readMessage(it, i, lr));
  }
  function readChat(doc) {
    const nameEl = q1(doc, SEL.chatName);
    const list = q1(doc, SEL.msgList);
    if (!nameEl && !list) return null;
    let handle = "";
    const hEl = q1(doc, SEL.chatHandle);
    if (hEl) handle = hEl.textContent.trim();
    else if (nameEl && nameEl.nextElementSibling && /^@/.test(nameEl.nextElementSibling.textContent.trim())) handle = nameEl.nextElementSibling.textContent.trim();
    const box = q1(doc, SEL.chatBox) || (nameEl && nameEl.closest("div"));
    const av = (box && box.querySelector('[data-e2e="top-chat-avatar"]')) || doc.querySelector('[data-e2e="top-chat-avatar"]');
    return {
      id: currentConvId(doc),
      name: str(nameEl ? nameEl.textContent.trim() : "", 80),
      handle: str(handle.replace(/^@/, ""), 60),
      avatar: str(imgSrc(av), 600),
      messages: readMessages(doc),
      canSend: !!q1(doc, SEL.editor),
    };
  }
  const VERIFY_SEL = '#captcha_container, #captcha-verify-container, .captcha_verify_container, [id*="captcha" i], [class*="captcha" i], iframe[src*="captcha" i], iframe[src*="verify" i]';
  const visible = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 20 && r.height > 20; };
  function pageState(doc, loc, sinceLoadMs) {
    const path = (loc && loc.pathname) || "";
    if (/^\/login/.test(path) || doc.querySelector('[data-e2e="login-modal"], [data-e2e="login-title"]')) return "signedOut";
    const v = Array.from(doc.querySelectorAll(VERIFY_SEL)).find(visible);
    if (v) return "verify";
    const hasList = !!(q1(doc, SEL.convList) || qa(doc, SEL.convItem).length);
    if (hasList) return "ok";
    const txt = String((doc.body && doc.body.innerText) || "").slice(0, 4000);
    if (/open (the )?tiktok app|download (the )?(tiktok )?app|continue in (the )?app|chats on mobile browser are not available/i.test(txt)) return "wall";
    if (!/^\/messages/.test(path)) return sinceLoadMs > 12000 ? "unreadable" : "loading";
    return sinceLoadMs > 12000 ? "unreadable" : "loading";
  }
  function snapshot(doc, loc, sinceLoadMs) {
    const state = pageState(doc, loc, sinceLoadMs);
    if (state !== "ok") return { state };
    return { state, convs: readConversations(doc).slice(0, 60), chat: readChat(doc) };
  }
  // ---- end reader ----
  window.__ghostDMRead = { snapshot, readConversations, readChat, pageState, currentConvId };

  // ---- live: post a snapshot whenever the page changes (throttled), and on a timer as a safety net ----
  const loadedAt = Date.now();
  let lastJSON = "", pending = null;
  function report(force) {
    pending = null;
    let snap;
    try { snap = snapshot(document, location, Date.now() - loadedAt); } catch (e) { snap = { state: "unreadable", error: str(e && e.message, 120) }; }
    const json = JSON.stringify(snap);
    if (!force && json === lastJSON) return;
    lastJSON = json;
    post({ type: "dm", snap });
  }
  const soon = () => { if (!pending) pending = setTimeout(() => report(false), 450); };
  function watch() {
    try { new MutationObserver(soon).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-e2e", "src", "aria-selected", "class"] }); } catch (e) {}
    setInterval(() => report(false), 3000);
    report(true);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch); else watch();
  window.__ghostDMReport = () => { report(true); return true; };

  // "Not now" / cookie banners that sit over the page
  const CLOSE_TEXT = /^(not now|maybe later|decline optional cookies|got it)$/i;
  setInterval(() => {
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      const t = (b.textContent || "").trim();
      if (t && t.length < 40 && CLOSE_TEXT.test(t)) { try { b.click(); } catch (e) {} }
    }
  }, 2000);

  // ---- open a conversation / older messages ----
  function findConvItem(id, name) {
    for (const it of qa(document, SEL.convItem)) {
      const p = propsUp(it, isConv, 25);
      const dc = convIdAttr(it);
      if ((p && p.id === id) || (dc && dc === id)) return it;
    }
    // no props ("i<index>:<name>" keys): by name, and only if exactly one chat has it - the list reorders as messages
    // arrive, so an index could point at someone else by now
    if (/^i\d+:/.test(String(id || "")) && name) {
      const hits = qa(document, SEL.convItem).filter((it) => { const n = q1(it, SEL.convName); return (n ? n.textContent.trim() : lines(it)[0]) === name; });
      return hits.length === 1 ? hits[0] : null;
    }
    return null;
  }
  // a conversation is "open" when the chat on screen says so; with no React props, when its name is in the header
  function isOpen(id, name) {
    const cur = currentConvId(document);
    if (cur && !/^i\d+:/.test(String(id || ""))) return cur === id;
    const n = q1(document, SEL.chatName);
    return !!(name && n && n.textContent.trim() === name);
  }
  async function open(id, name) {
    if (isOpen(id, name)) return true;
    const it = findConvItem(id, name);
    if (!it) return false;
    it.click();
    for (let i = 0; i < 40; i++) { await sleep(150); if (isOpen(id, name)) return true; }
    return false;
  }
  // TikTok marks a chat read only while its page has focus; this hidden page never does. While a chat is on screen in
  // Ghost the page reports focus (so opening a chat in Ghost reads it, like on the website); otherwise it doesn't, so
  // messages arriving in the chat TikTok's page still has open aren't marked read behind the user's back.
  let viewing = false;
  try { Object.defineProperty(document, "hasFocus", { configurable: true, value: () => viewing }); } catch (e) {}
  function setViewing(on) {
    if (viewing === !!on) return;
    viewing = !!on;
    try { window.dispatchEvent(new Event(viewing ? "focus" : "blur")); document.dispatchEvent(new Event("visibilitychange")); } catch (e) {}
  }
  window.__ghostDMViewing = (on) => { setViewing(on); return viewing; };
  window.__ghostDMOpen = async function (id, name) {
    const ok = await open(str(id, 120), str(name, 80));
    if (ok) setViewing(true);
    report(true);
    return { ok };
  };
  window.__ghostDMOlder = function () {
    const l = q1(document, SEL.msgList);
    if (!l) return false;
    l.scrollTop = 0;
    try { l.dispatchEvent(new Event("scroll")); } catch (e) {}
    return true;
  };

  // ---- send ----
  const sent = new Set(); // request ids already sent: a retry of the same request never sends twice
  let lock = Promise.resolve();
  const editorText = (ed) => String(ed.innerText || ed.textContent || "").replace(/​/g, "").trim();
  function editable() {
    const box = q1(document, SEL.editor);
    if (!box) return null;
    return box.querySelector('[contenteditable="true"]') || box.querySelector("textarea, input") || (box.isContentEditable ? box : null);
  }
  function typeInto(ed, text) {
    ed.focus();
    if (ed.tagName === "TEXTAREA" || ed.tagName === "INPUT") {
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ed), "value").set;
      set.call(ed, text);
      ed.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    // TikTok's box is a Draft.js editor: the browser's own "insert text" goes through its beforeinput handling
    try { document.execCommand("selectAll", false, null); document.execCommand("delete", false, null); } catch (e) {}
    let ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch (e) {}
    if (!ok || editorText(ed) !== text.trim()) {
      try { ed.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true })); } catch (e) {}
    }
  }
  const myTexts = () => readMessages(document).filter((m) => m.me).map((m) => m.text);
  // every failure before the send button is pressed says notSent: Ghost may offer "try again" only for those
  async function sendNow(id, name, text, rid) {
    if (!rid || sent.has(rid)) return { ok: true, duplicate: true };
    text = String(text || "").replace(/\r\n/g, "\n").trim();
    if (!text || text.length > 6000) return { error: "empty or too long", notSent: true };
    // without React ids a chat is found by its name: only when no other chat in the list has the same name
    if (/^i\d+:/.test(id) && !findConvItem(id, name) && !isOpen(id, name)) return { error: "couldn't tell which chat that is", notSent: true };
    if (/^i\d+:/.test(id) && qa(document, SEL.convItem).filter((it) => { const n = q1(it, SEL.convName); return (n ? n.textContent.trim() : lines(it)[0]) === name; }).length > 1) return { error: "couldn't tell which chat that is", notSent: true };
    if (!(await open(id, name))) return { error: "couldn't open that chat", notSent: true };
    const ed = editable();
    if (!ed) return { error: "no message box", notSent: true };
    typeInto(ed, text);
    await sleep(250);
    if (editorText(ed) !== text) {
      try { ed.focus(); document.execCommand("selectAll", false, null); document.execCommand("delete", false, null); } catch (e) {}
      return { error: "couldn't type into TikTok's message box", notSent: true };
    }
    // still the same chat right before sending (nothing switched it while typing)
    if (!isOpen(id, name)) return { error: "the chat changed", notSent: true };
    const before = myTexts().filter((t) => t === text).length;
    sent.add(rid); // from here on this request never sends again, whatever happens next
    let btn = null;
    for (let i = 0; i < 10 && !btn; i++) { btn = q1(document, SEL.send); if (!btn) await sleep(100); }
    if (btn) btn.click();
    else ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      if (myTexts().filter((t) => t === text).length > before) { report(true); return { ok: true, confirmed: true }; }
    }
    report(true);
    return { ok: true, confirmed: editorText(ed) === "" };
  }
  window.__ghostDMSend = function (id, name, text, rid) {
    const run = lock.then(() => sendNow(str(id, 120), str(name, 80), String(text || ""), str(rid, 80))).catch((e) => ({ error: str(e && e.message, 120) }));
    lock = run.then(() => {}, () => {});
    return run;
  };
})();
