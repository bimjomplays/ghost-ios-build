// GIF picker: Discord-style bottom sheet opened from a "GIF" button next to the emoji and photo buttons in the
// chat box. Picking a GIF hands the real .gif file to Snapchat Web's own photo-upload input (name="uploadImages",
// which accepts image/gif and sends it as a GIF-type media message, not resized). So sending is exactly what
// Snapchat's own upload button does: the GIF shows up in the chat box's media preview, and we press the send
// arrow for the user (see pick() below). Search results and files come from Giphy through background.js.
(() => {
  if (window.top !== window) return;
  const ask = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? {} : r || {})));
  const make = (cls) => Object.assign(document.createElement("div"), { className: cls });

  function haptic(style) {
    if (typeof dgSetting === "function" && dgSetting("haptics", true) === false) return;
    try { window.webkit.messageHandlers.dg.postMessage({ op: "haptic", style: style || "light" }); } catch (e) {}
  }

  // ---- favourites / recents (same GM-backed storage the picker already used) ----
  let favs = null, recents = null;
  const loadFavs = async () => (favs ??= (await chrome.storage.local.get("giphyFavs")).giphyFavs || []);
  const loadRecents = async () => (recents ??= (await chrome.storage.local.get("giphyRecents")).giphyRecents || []);
  const isFav = (id) => (favs || []).some((f) => f.id === id); // favs may not be loaded yet: a search/trending
  // tile paints its star before renderFavorites() ever runs loadFavs(), so null must read as "not favourited"
  async function toggleFav(g) {
    await loadFavs();
    favs = isFav(g.id) ? favs.filter((f) => f.id !== g.id) : [{ id: g.id, w: g.w, h: g.h }, ...favs];
    await chrome.storage.local.set({ giphyFavs: favs });
    panel.querySelectorAll(`[data-fav-id="${g.id}"]`).forEach(paintStar);
    if (state.tab === "favorites" && !state.query) render();
  }
  function paintStar(star) {
    const on = isFav(star.dataset.favId);
    star.textContent = on ? "★" : "☆";
    star.classList.toggle("dg-on", on);
    star.title = on ? "Remove from favorites" : "Add to favorites";
  }
  async function addRecent(g) {
    await loadRecents();
    recents = [{ id: g.id, w: g.w, h: g.h }, ...recents.filter((r) => r.id !== g.id)].slice(0, 40);
    await chrome.storage.local.set({ giphyRecents: recents });
  }

  const uploadInput = () => document.querySelector('input[type="file"][name="uploadImages"]');

  // ---- the "GIF" trigger next to the photo button ----
  let button;
  function addButton() {
    const input = uploadInput();
    const photo = input && input.closest("button");
    if (!photo || photo.nextElementSibling === button) return;
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "dg-gif-button";
      button.textContent = "GIF";
      button.title = "Send a GIF";
      button.addEventListener("click", (e) => { e.stopPropagation(); panel && panel.isConnected ? closeSheet() : openSheet(); });
    }
    button.className = `${photo.className} dg-gif-button`; // same size/shape as the photo button
    photo.after(button);
  }

  // ---- sheet chrome: backdrop + draggable bottom sheet ----
  let panel, backdrop, sheet, draghandle, search, searchWrap, clearBtn, tabsEl = {}, body;
  const state = { tab: "home", query: "" };
  let seq = 0; // bumped whenever the body is about to show something new; async loads check against it

  function build() {
    panel = make("dg-gif-root");
    backdrop = make("dg-gif-backdrop");
    sheet = make("dg-gif-sheet");
    draghandle = make("dg-gif-draghandle");
    draghandle.appendChild(make("dg-gif-grabber"));

    const searchRow = make("dg-gif-search-row");
    searchWrap = make("dg-gif-search-wrap");
    search = document.createElement("input");
    search.className = "dg-gif-search";
    search.placeholder = "Search GIPHY";
    search.autocapitalize = "off";
    search.autocomplete = "off";
    search.spellcheck = false;
    clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "dg-gif-clear";
    clearBtn.textContent = "✕";
    clearBtn.title = "Clear";
    searchWrap.append(search, clearBtn);
    searchRow.append(searchWrap);

    const tabsRow = make("dg-gif-tabs");
    for (const [name, label] of [["trending", "Trending"], ["favorites", "Favourites"], ["recents", "Recents"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", () => selectTab(name));
      tabsEl[name] = b;
      tabsRow.appendChild(b);
    }

    body = make("dg-gif-body");

    const credit = make("dg-gif-credit");
    credit.textContent = "Powered by GIPHY";

    sheet.append(draghandle, searchRow, tabsRow, body, credit);
    panel.append(backdrop, sheet);

    let t;
    search.addEventListener("input", () => {
      toggleClear();
      clearTimeout(t);
      t = setTimeout(() => applyQuery(search.value), 250);
    });
    search.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); search.blur(); } // Enter just dismisses the keyboard
      else if (e.key === "Escape") closeSheet();
    });
    clearBtn.addEventListener("click", () => {
      search.value = "";
      toggleClear();
      clearTimeout(t);
      applyQuery("");
      search.focus();
    });
    backdrop.addEventListener("click", closeSheet);
    wireDrag();
  }

  function toggleClear() { searchWrap.classList.toggle("dg-has-text", !!search.value); }

  function applyQuery(q) {
    q = q.trim();
    if (q === state.query) return;
    state.query = q;
    render();
  }

  function selectTab(name) {
    haptic();
    state.tab = state.tab === name && !state.query ? "home" : name;
    state.query = "";
    search.value = "";
    toggleClear();
    render();
  }

  // ---- open / close, spring-like transform transitions, drag-to-dismiss ----
  function openSheet() {
    if (!panel) build();
    document.body.appendChild(panel);
    sheet.style.transform = "";
    sheet.classList.remove("dg-dragging");
    requestAnimationFrame(() => { backdrop.classList.add("dg-open"); sheet.classList.add("dg-open"); });
    document.addEventListener("keydown", onEsc);
    haptic();
    state.tab = "home";
    state.query = "";
    search.value = "";
    toggleClear();
    render();
    // kick favourites off in the background so search/trending stars aren't stuck unfavourited forever if the
    // storage read is slow; repaint whatever stars ended up on screen once it resolves
    loadFavs().then(() => panel.querySelectorAll(".dg-gif-fav").forEach(paintStar));
    setTimeout(() => search.focus(), 260); // after the sheet settles, so the keyboard doesn't fight the spring
  }
  function closeSheet() {
    if (!panel || !panel.isConnected) return;
    document.removeEventListener("keydown", onEsc);
    backdrop.classList.remove("dg-open");
    sheet.classList.remove("dg-open");
    sheet.style.transform = "";
    const done = () => panel.remove();
    sheet.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 400); // safety net if transitionend never fires (e.g. app backgrounded mid-close)
  }
  function onEsc(e) { if (e.key === "Escape") closeSheet(); }

  function wireDrag() {
    let dragging = false, startY = 0, sheetH = 0;
    draghandle.addEventListener("pointerdown", (e) => {
      dragging = true;
      startY = e.clientY;
      sheetH = sheet.getBoundingClientRect().height || 1;
      sheet.classList.add("dg-dragging");
      try { draghandle.setPointerCapture(e.pointerId); } catch (err) {}
    });
    const move = (e) => {
      if (!dragging) return;
      const dy = Math.max(0, e.clientY - startY);
      sheet.style.transform = `translateY(${dy}px)`; // transform only, no layout reads mid-drag
    };
    const up = (e) => {
      if (!dragging) return;
      dragging = false;
      sheet.classList.remove("dg-dragging");
      const dy = Math.max(0, e.clientY - startY);
      if (dy > sheetH * 0.28 || dy > 140) closeSheet();
      else sheet.style.transform = ""; // spring back via the .dg-open transform:0 rule + its transition
    };
    draghandle.addEventListener("pointermove", move);
    draghandle.addEventListener("pointerup", up);
    draghandle.addEventListener("pointercancel", up);
  }

  // ---- rendering: home (categories) / trending+search / favourites / recents ----
  let io = null;       // lazy-loads tile images as they scroll near view
  let scrollIO = null; // infinite-scroll sentinel for the results grid
  let categoriesCache = null;

  function observeLazy(el) {
    if (!io) io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); e.target._dgLoad && e.target._dgLoad(); }
    }, { root: body, rootMargin: "200px 0px" });
    io.observe(el);
  }

  function clearBody() {
    ++seq;
    if (io) { io.disconnect(); io = null; }
    if (scrollIO) { scrollIO.disconnect(); scrollIO = null; }
    body.replaceChildren();
    return seq;
  }

  function paintTabs() {
    for (const [name, btn] of Object.entries(tabsEl)) btn.classList.toggle("dg-on", !state.query && state.tab === name);
  }

  function render() {
    paintTabs();
    const mySeq = clearBody();
    if (state.query) return loadResults(state.query, mySeq);
    if (state.tab === "trending") return loadResults("", mySeq);
    if (state.tab === "favorites") return renderFavorites(mySeq);
    if (state.tab === "recents") return renderRecents(mySeq);
    return renderHome(mySeq);
  }

  function showEmptyNote(text) {
    const n = make("dg-gif-note");
    n.textContent = text;
    body.append(n);
  }
  function showInlineError(msg, retryable, retry) {
    const n = make("dg-gif-note");
    n.textContent = msg || "Something went wrong";
    if (retryable) {
      n.appendChild(document.createElement("br"));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dg-gif-retry";
      btn.textContent = "Retry";
      btn.addEventListener("click", () => { n.remove(); retry(); });
      n.appendChild(btn);
    }
    body.append(n);
  }

  // Home: Discord-style category tiles. Tapping one searches its name.
  async function renderHome(mySeq) {
    const grid = make("dg-gif-cats");
    body.append(grid);
    if (categoriesCache) return paintCategories(grid, categoriesCache);
    grid.replaceChildren(...Array.from({ length: 6 }, () => { const c = make("dg-gif-cat"); c.appendChild(make("dg-gif-skel")); return c; }));
    const res = await ask({ giphyCategories: true });
    if (mySeq !== seq) return;
    if (res.needKey) { grid.remove(); return askForKey(res.error); }
    if (res.error) { grid.remove(); return showInlineError(res.error, res.retryable, () => { body.replaceChildren(); renderHome(mySeq); }); }
    categoriesCache = res.results || [];
    paintCategories(grid, categoriesCache);
  }
  function paintCategories(grid, list) {
    if (!list.length) { grid.remove(); return showEmptyNote("No categories right now"); }
    grid.replaceChildren(...list.map(catTile));
  }
  function catTile(c) {
    const el = make("dg-gif-cat");
    const img = document.createElement("img");
    img.alt = c.name;
    const label = document.createElement("span");
    label.textContent = c.name;
    el.append(img, label);
    el._dgLoad = () => {
      if (!c.stillUrl) return;
      ask({ giphyImage: c.stillUrl }).then((r) => {
        if (r.dataUrl) { img.src = r.dataUrl; img.onload = () => img.classList.add("dg-loaded"); }
      });
    };
    observeLazy(el);
    el.addEventListener("click", () => {
      haptic();
      search.value = c.name;
      toggleClear();
      applyQuery(c.name);
    });
    return el;
  }

  // Trending (empty query) and text search share paging: offset forward, stop at pagination.total_count.
  async function loadResults(q, mySeq) {
    const cols = [make("dg-gif-col"), make("dg-gif-col")];
    const heights = [0, 0];
    const wrap = make("dg-gif-results");
    wrap.append(...cols);
    const sentinel = make("dg-gif-sentinel");
    body.append(wrap, sentinel);

    let offset = 0, total = Infinity, loading = false;
    const skel = [];
    for (let i = 0; i < 6; i++) {
      const t = make("dg-gif-tile");
      t.style.aspectRatio = i % 2 ? "1 / 1.25" : "1 / 0.85";
      t.appendChild(make("dg-gif-skel"));
      cols[i % 2].appendChild(t);
      skel.push(t);
    }

    function addTile(g) {
      const i = heights[0] <= heights[1] ? 0 : 1;
      heights[i] += g.h / g.w;
      cols[i].appendChild(gifTile(g));
    }

    async function fetchMore() {
      if (mySeq !== seq || loading || offset >= total) return;
      loading = true;
      const rating = typeof dgSetting === "function" ? dgSetting("gifRating", "pg-13") : "pg-13";
      const res = await ask({ giphySearch: q, offset, rating });
      if (mySeq !== seq) return;
      loading = false;
      skel.splice(0).forEach((t) => t.remove());
      if (res.needKey) { sentinel.remove(); return askForKey(res.error); }
      if (res.error) {
        if (offset === 0) { wrap.remove(); sentinel.remove(); return showInlineError(res.error, res.retryable, () => { body.replaceChildren(); loadResults(q, mySeq); }); }
        return showInlineError(res.error, res.retryable, fetchMore); // failed loading more: keep what's already shown
      }
      if (offset === 0 && !(res.results || []).length) { wrap.remove(); sentinel.remove(); return showEmptyNote(q ? "No GIFs found" : "Nothing trending right now"); }
      offset = res.next != null ? res.next : offset + (res.results || []).length;
      if (res.total != null) total = res.total;
      for (const g of res.results || []) addTile(g);
      if (offset >= total && scrollIO) { scrollIO.disconnect(); scrollIO = null; }
    }

    scrollIO = new IntersectionObserver((entries) => { if (entries[0].isIntersecting) fetchMore(); }, { root: body, rootMargin: "400px 0px" });
    scrollIO.observe(sentinel);
    await fetchMore();
  }

  async function renderFavorites(mySeq) {
    await loadFavs();
    if (mySeq !== seq) return;
    if (!favs.length) return showEmptyNote("No favourites yet — tap ☆ on a GIF to save it here");
    paintStaticGrid(favs);
  }
  async function renderRecents(mySeq) {
    await loadRecents();
    if (mySeq !== seq) return;
    if (!recents.length) return showEmptyNote("GIFs you send will show up here");
    paintStaticGrid(recents);
  }
  function paintStaticGrid(list) {
    const cols = [make("dg-gif-col"), make("dg-gif-col")];
    const heights = [0, 0];
    const wrap = make("dg-gif-results");
    wrap.append(...cols);
    for (const g of list) {
      const i = heights[0] <= heights[1] ? 0 : 1;
      heights[i] += g.h / g.w;
      cols[i].appendChild(gifTile(g));
    }
    body.append(wrap);
  }

  function gifTile(g) {
    const item = make("dg-gif-tile");
    item.style.aspectRatio = `${g.w} / ${g.h}`;
    const skel = make("dg-gif-skel");
    const img = document.createElement("img");
    img.alt = "GIF";
    item.append(skel, img);
    item._dgLoad = () => {
      ask({ giphyPreview: g.id }).then((r) => {
        if (r.dataUrl) { img.src = r.dataUrl; img.onload = () => { img.classList.add("dg-loaded"); skel.remove(); }; }
        else skel.remove();
      });
    };
    observeLazy(item);
    img.addEventListener("click", () => pick(g, item));
    const star = document.createElement("button");
    star.type = "button";
    star.className = "dg-gif-fav";
    star.dataset.favId = g.id;
    paintStar(star);
    star.addEventListener("click", (e) => { e.stopPropagation(); toggleFav(g); });
    item.append(star);
    return item;
  }

  // ---- sending: keep the device-proven upload + send-arrow path, made decisive against the "tapped the box
  // first" stall (see finishSend below) ----
  async function pick(g, tileEl) {
    tileEl.classList.add("dg-gif-busy");
    const r = await ask({ giphyFile: g.id });
    tileEl.classList.remove("dg-gif-busy");
    const input = uploadInput();
    if (!r.dataUrl || !input) { showInlineError("Couldn't load that GIF", true, () => pick(g, tileEl)); return; }
    // decode by hand: fetch() of a data: URL here would go through Snapchat's CSP (and its violation reports)
    const bin = atob(r.dataUrl.slice(r.dataUrl.indexOf(",") + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], `${g.id}.gif`, { type: "image/gif" }));
    const box = document.querySelector('[role="textbox"][contenteditable="true"]');
    const pane = box && (box.closest("[data-dg-column]") || document.body);
    // Snapchat's composer: [reply quote?, media preview (.Oli_z > .W7kan per file), textbox, send arrow]. Count
    // preview children before attaching so we can tell "our" file has landed, independent of when/if the send
    // arrow itself renders (falls back to counting any blob media if those class names ever change).
    const previewHost = () => (box && box.parentElement && box.parentElement.querySelector(".Oli_z")) || pane;
    const mediaEls = () => (pane ? pane.querySelectorAll("img[src^='blob:'], video, canvas") : []);
    const previewCount = () => { const host = previewHost(); return host ? host.querySelectorAll(".W7kan, img[src^='blob:'], video, canvas").length : mediaEls().length; };
    const beforeCount = box ? previewCount() : 0;
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    addRecent(g);
    haptic();
    closeSheet();
    if (!box || box.textContent.trim()) return;
    const autoSend = typeof dgSetting !== "function" || dgSetting("gifAutoSend", true) !== false;
    if (!autoSend) return;

    // What happened between the pick and the send, in trail.txt (device report: sometimes a delay with the GIF
    // sitting in the bar first).
    const t0 = performance.now();
    const log = (text) => { try { window.webkit.messageHandlers.dg.postMessage({ op: "trail", text: "GIF " + Math.round(performance.now() - t0) + "ms " + text }).catch(() => {}); } catch (e) {} };
    // Snapchat's composer renders [media preview (with its own "remove" buttons), textbox, send arrow] as
    // siblings, and the send arrow only exists once the composer holds text or files - so "a button AFTER the
    // textbox" is both the ready signal and the thing to press (its onClick is the same send function Enter
    // calls).
    const sendButton = () => [...box.parentElement.querySelectorAll("button")].find((b) =>
      (box.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) && !b.disabled && !/MyAI/i.test(b.getAttribute("aria-label") || ""));
    const enter = () => {
      try { box.focus({ preventScroll: true }); } catch (e) {}
      for (const type of ["keydown", "keypress", "keyup"])
        box.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    };
    const wake = () => {
      try { box.focus({ preventScroll: true }); } catch (e) {}
      const rect = box.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      for (const type of ["mousedown", "mouseup", "click"]) box.dispatchEvent(new MouseEvent(type, o));
    };

    // One press only, ever: Snapchat clears the preview when its own send finishes, which can take seconds.
    let sent = false, mo;
    const finishSend = (why) => {
      if (sent) return;
      sent = true;
      if (mo) mo.disconnect();
      // Device report: picking a GIF after tapping into an already-empty box first made it "sit as an
      // attachment for a while" before sending, while picking as the very first thing in a chat sent fine. The
      // iOS keyboard opens a composition session (compositionstart) on any tap into the box, even with nothing
      // typed; Snapchat's own Enter handler ignores Enter while that's active, and it can hold the send-arrow
      // render back a beat too. Blur ends the composition before we go looking for the arrow, so this path
      // costs the same whether the user tapped the box first or not.
      const wasFocused = document.activeElement === box;
      if (wasFocused) { try { box.blur(); } catch (e) {} }
      log(why + " wasFocused " + wasFocused);
      let tries = 0, woke = 0;
      const press = () => {
        if (!box.isConnected) return log("box gone");
        const b = sendButton();
        if (!b && (tries === 0 || tries === 3 || tries === 10)) { woke++; wake(); }
        if (b) {
          return void setTimeout(() => {
            if (b.isConnected && !b.disabled) { b.click(); log("clicked, tries " + tries + " wakes " + woke); }
            else { enter(); log("enter (arrow gone)"); }
            setTimeout(() => { try { box.blur(); } catch (e) {} }, 250);
          }, 30);
        }
        if (++tries > 60) { enter(); return void log("gave up, enter"); } // ~3s once the preview is confirmed present
        setTimeout(press, 50);
      };
      press();
    };

    // Primary trigger: the new preview child for our file. This fires within a frame or two of the change
    // event - well before any blind poll would - so the arrow search only starts once Snapchat has actually
    // registered the attachment. The poll below is only a fallback for a build where the observer misses it.
    mo = new MutationObserver(() => { if (previewCount() > beforeCount) finishSend("preview observed"); });
    mo.observe(pane || document.body, { childList: true, subtree: true });
    let polls = 0;
    const poll = () => {
      if (sent) return;
      if (previewCount() > beforeCount) return finishSend("preview polled");
      if (++polls > 40) return finishSend("preview poll timeout"); // ~4s: go for it even without visible confirmation
      setTimeout(poll, 100);
    };
    setTimeout(poll, 60);
  }

  function askForKey(error) {
    body.replaceChildren();
    const card = make("dg-gif-keycard");
    const p = document.createElement("p");
    p.textContent = (error ? error + ". " : "") +
      "GIF search needs a free GIPHY API key: developers.giphy.com → Create an App → API. Paste it below.";
    const key = document.createElement("input");
    key.className = "dg-gif-search";
    key.placeholder = "GIPHY API key";
    key.autocapitalize = "off";
    key.autocomplete = "off";
    key.spellcheck = false;
    key.addEventListener("keydown", async (e) => {
      e.stopPropagation();
      if (e.key !== "Enter" || !key.value.trim()) return;
      key.blur();
      await ask({ giphyKey: key.value });
      categoriesCache = null; // let the new key try categories/search again
      render();
    });
    card.append(p, key);
    body.append(card);
    key.focus();
  }

  let queued = false;
  (function observe() {
    if (!document.body) return void setTimeout(observe, 50);
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; addButton(); });
    }).observe(document.body, { childList: true, subtree: true });
    addButton();
  })();
})();
