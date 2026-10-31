// Mobile: animate GIFs that Snapchat shows as plain <img> (the GIFs you send yourself).
//
// Received Giphy GIFs are drawn by gifs-show.js; your own GIFs are ordinary GIF media messages, which
// Snapchat decrypts into a blob: URL and shows with an <img>. On iPhone Safari that <img> can stay on the
// first frame, so this reads the same bytes back (blob: is allowed by connect-src), decodes the GIF here and
// plays it on a <canvas> laid over the image. Only multi-frame GIFs are touched; everything else is left
// alone. Frames only run while the GIF is on screen.
(() => {
  if (window.top !== window) return;
  const SEEN = "data-dg-anim";
  const MAX_PIXELS = 2.5e7; // total decoded frame pixels; bigger GIFs are left as they are

  function decode(buf) {
    const b = new Uint8Array(buf);
    if (b.length < 13 || String.fromCharCode(b[0], b[1], b[2]) !== "GIF") return null;
    const W = b[6] | (b[7] << 8), H = b[8] | (b[9] << 8);
    let p = 13, gct = null;
    const table = (flags) => {
      const n = 3 << ((flags & 7) + 1), t = b.subarray(p, p + n);
      p += n;
      return t;
    };
    if (b[10] & 0x80) gct = table(b[10]);
    const frames = [];
    let gce = { delay: 100, disposal: 0, trans: -1 }, pixels = 0;
    const subBlocks = () => {
      const parts = [];
      let len = 0;
      while (p < b.length && b[p]) { parts.push(b.subarray(p + 1, p + 1 + b[p])); len += b[p]; p += b[p] + 1; }
      p++;
      const out = new Uint8Array(len);
      let o = 0;
      for (const part of parts) { out.set(part, o); o += part.length; }
      return out;
    };
    while (p < b.length) {
      const block = b[p++];
      if (block === 0x3b) break;
      if (block === 0x21) {
        const label = b[p++];
        if (label === 0xf9 && b[p] >= 4) {
          const f = b[p + 1];
          const delay = (b[p + 2] | (b[p + 3] << 8)) * 10;
          gce = { delay: delay < 20 ? 100 : delay, disposal: (f >> 2) & 7, trans: f & 1 ? b[p + 4] : -1 };
        }
        subBlocks();
      } else if (block === 0x2c) {
        const x = b[p] | (b[p + 1] << 8), y = b[p + 2] | (b[p + 3] << 8);
        const w = b[p + 4] | (b[p + 5] << 8), h = b[p + 6] | (b[p + 7] << 8), f = b[p + 8];
        p += 9;
        const ct = f & 0x80 ? table(f) : gct;
        const minCode = b[p++];
        const idx = lzw(subBlocks(), minCode, w * h);
        if (f & 0x40) deinterlace(idx, w, h);
        pixels += w * h;
        if (pixels > MAX_PIXELS || !ct) return null;
        frames.push({ x, y, w, h, idx, ct, ...gce });
        gce = { delay: 100, disposal: 0, trans: -1 };
      } else return frames.length ? { W, H, frames } : null; // corrupt: keep what decoded
    }
    return { W, H, frames };
  }

  function lzw(data, minCode, size) {
    const out = new Uint8Array(size);
    const clear = 1 << minCode, eoi = clear + 1;
    const prefix = new Int16Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096);
    const stack = new Uint8Array(4097);
    for (let i = 0; i < clear; i++) { suffix[i] = first[i] = i; prefix[i] = -1; }
    let codeSize = minCode + 1, next = eoi + 1, old = -1, bits = 0, acc = 0, o = 0;
    for (let i = 0; i < data.length && o < size; ) {
      while (bits < codeSize && i < data.length) { acc |= data[i++] << bits; bits += 8; }
      if (bits < codeSize) break;
      const code = acc & ((1 << codeSize) - 1);
      acc >>= codeSize; bits -= codeSize;
      if (code === clear) { codeSize = minCode + 1; next = eoi + 1; old = -1; continue; }
      if (code === eoi) break;
      let c = code, sp = 0;
      if (old === -1) { out[o++] = suffix[code]; old = code; continue; }
      if (code >= next) { stack[sp++] = first[old]; c = old; }
      while (c >= clear) { stack[sp++] = suffix[c]; c = prefix[c]; }
      stack[sp++] = c;
      const head = c;
      while (sp && o < size) out[o++] = stack[--sp];
      if (next < 4096) { prefix[next] = old; suffix[next] = head; first[next] = first[old === -1 ? head : old]; next++; }
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
      old = code;
    }
    return out;
  }

  function deinterlace(idx, w, h) {
    const src = idx.slice();
    let row = 0;
    for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]])
      for (let y = start; y < h; y += step) idx.set(src.subarray(row * w, ++row * w), y * w);
  }

  function play(img, gif) {
    const canvas = document.createElement("canvas");
    canvas.width = gif.W; canvas.height = gif.H;
    canvas.className = "dg-anim";
    const ctx = canvas.getContext("2d");
    const patch = document.createElement("canvas").getContext("2d");
    const place = () => {
      canvas.style.left = img.offsetLeft + "px";
      canvas.style.top = img.offsetTop + "px";
      canvas.style.width = img.offsetWidth + "px";
      canvas.style.height = img.offsetHeight + "px";
      const cs = getComputedStyle(img);
      canvas.style.borderRadius = cs.borderRadius;
      canvas.style.objectFit = cs.objectFit;
    };
    const host = img.offsetParent || img.parentElement;
    if (host !== img.parentElement && getComputedStyle(img.parentElement).position === "static")
      img.parentElement.style.position = "relative";
    img.parentElement.querySelector(":scope > .dg-anim")?.remove();
    img.parentElement.appendChild(canvas);
    place();

    let i = 0, timer = 0, visible = true, saved = null;
    function draw() {
      const f = gif.frames[i];
      if (f.disposal === 3) saved = ctx.getImageData(0, 0, gif.W, gif.H);
      const data = new ImageData(f.w, f.h), px = data.data;
      for (let k = 0, q = 0; k < f.idx.length; k++, q += 4) {
        const c = f.idx[k];
        if (c === f.trans) continue;
        px[q] = f.ct[c * 3]; px[q + 1] = f.ct[c * 3 + 1]; px[q + 2] = f.ct[c * 3 + 2]; px[q + 3] = 255;
      }
      patch.canvas.width = f.w; patch.canvas.height = f.h;
      patch.putImageData(data, 0, 0);
      ctx.drawImage(patch.canvas, f.x, f.y);
      timer = setTimeout(() => {
        if (f.disposal === 2) ctx.clearRect(f.x, f.y, f.w, f.h);
        else if (f.disposal === 3 && saved) ctx.putImageData(saved, 0, 0);
        i = (i + 1) % gif.frames.length;
        if (i === 0) ctx.clearRect(0, 0, gif.W, gif.H);
        tick();
      }, f.delay);
    }
    function tick() {
      timer = 0;
      if (!canvas.isConnected || !img.isConnected) return void canvas.remove();
      if (visible && !document.hidden) { place(); draw(); }
    }
    new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !timer) tick();
    }).observe(img);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && !timer) tick(); });
    tick();
  }

  async function check(img) {
    const src = img.currentSrc || img.src;
    if (img.getAttribute(SEEN) === src) return;
    img.setAttribute(SEEN, src);
    try {
      const r = await window.fetch(src);
      const buf = await r.arrayBuffer();
      const gif = decode(buf);
      if (gif && gif.frames.length > 1 && img.getAttribute(SEEN) === src) play(img, gif);
    } catch {}
  }

  window.__dgAnimateGif = check; // Ghost calls this for GIF photos in its own (shadow DOM) chat
  if (window.__ghostNoGifScan) return; // Ghost: Snapchat's page is hidden, don't decode its images
  const scan = () => {
    for (const img of document.querySelectorAll("img[src^='blob:']")) {
      if (img.closest(".dg-gif-panel") || img.classList.contains("dg-gif")) continue;
      if (img.complete ? img.naturalWidth > 40 : true) check(img);
    }
  };
  let queued = false;
  (function observe() {
    if (!document.body) return void setTimeout(observe, 50);
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      setTimeout(() => { queued = false; scan(); }, 300);
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
    scan();
  })();
})();
