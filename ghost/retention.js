// Local archive. Metadata and blobs live separately so pruning never reads 500 MB into memory.
// No network or Snapchat actions here; bridge.js supplies only messages this account received.
(function (root) {
  "use strict";
  const DAY = 86400000;
  const KINDS = new Set(["text", "chat-media", "audio", "gif", "sticker"]);
  class GhostRetention {
    constructor(options = {}) {
      this.limit = options.limit || 500 * 1024 * 1024;
      this.days = options.days || 30;
      this.maxRecords = options.maxRecords || 20000;
      this.name = options.name || "ghost-retention-v1";
      this.account = ""; this.enabled = false; this.generation = 0;
      this.error = ""; this.tail = Promise.resolve(); this.dbPromise = null;
      this.now = options.now || Date.now;
    }
    serial(fn) {
      const p = this.tail.then(fn);
      this.tail = p.catch((e) => { this.error = e && e.name === "QuotaExceededError" ? "Device storage is full. Some messages could not be retained." : "Archive unavailable. Some messages could not be retained."; });
      return p;
    }
    open() {
      if (!this.dbPromise) this.dbPromise = new Promise((resolve, reject) => {
        const r = indexedDB.open(this.name, 1);
        r.onupgradeneeded = () => {
          const s = r.result.createObjectStore("messages", { keyPath: "key" });
          s.createIndex("account", "account"); s.createIndex("chat", ["account", "conversationId"]);
          s.createIndex("expires", "expiresAt");
          r.result.createObjectStore("media"); r.result.createObjectStore("settings");
        };
        r.onsuccess = () => { const db = r.result; db.onversionchange = () => { db.close(); this.dbPromise = null; }; resolve(db); };
        r.onerror = () => { this.dbPromise = null; reject(r.error); };
        r.onblocked = () => { this.error = "Close other Ghost windows to open the archive."; };
      });
      return this.dbPromise;
    }
    async transaction(names, mode, fn) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(names, mode); let result;
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = (event) => reject(tx.error || (event.target && event.target.error) || new Error("Archive transaction failed"));
        fn(tx, (value) => { result = value; });
      });
    }
    async rows(account, cid) {
      return this.transaction(["messages"], "readonly", (tx, done) => {
        const s = tx.objectStore("messages");
        const r = cid !== undefined ? s.index("chat").getAll([account, cid]) : account ? s.index("account").getAll(account) : s.getAll();
        r.onsuccess = () => done(r.result);
      });
    }
    useAccount(account) {
      if (account === this.account) return this.tail;
      this.account = account || ""; this.enabled = false;
      const gen = ++this.generation;
      return this.serial(async () => {
        if (!account) return;
        const value = await this.transaction(["settings"], "readonly", (tx, done) => {
          const r = tx.objectStore("settings").get(account); r.onsuccess = () => done(r.result);
        });
        if (gen === this.generation) this.enabled = value !== false;
        await this.prune();
      });
    }
    setEnabled(on) {
      const account = this.account;
      this.enabled = !!on; ++this.generation;
      return this.serial(async () => {
        if (!account) throw new Error("Sign in before changing retention");
        await this.transaction(["settings"], "readwrite", (tx) => tx.objectStore("settings").put(!!on, account));
        return this.summary();
      });
    }
    capture(messages) {
      const account = this.account, gen = this.generation;
      if (!account || !this.enabled) return Promise.resolve([]);
      // Snapshot immediately, before a store mutation can erase the original content.
      // Only friends' messages are kept: your own showed up as dashed "deleted" duplicates next to the real message
      // although you never deleted them (device report 2026-09-27), and there is nothing to recover from yourself.
      const mine = (m) => !!(m && m.from && m.from.id && m.from.id === account);
      const snapshots = messages.filter((m) => m && m.id && !mine(m) && (m.deleted || KINDS.has(m.kind))).map((m) => ({ ...m, media: undefined, reactions: undefined }));
      return this.serial(async () => {
        if (gen !== this.generation || !this.enabled) return [];
        const candidates = [];
        await this.transaction(["messages"], "readwrite", (tx) => {
          const s = tx.objectStore("messages");
          for (const m of snapshots) {
            const key = [account, m.conversationId, m.id];
            const r = s.get(key);
            r.onsuccess = () => {
              if (gen !== this.generation || !this.enabled) return;
              const old = r.result;
              if (m.deleted) { if (old && !old.deleted) s.put({ ...old, deleted: true }); return; }
              // Never overwrite a retained original with a late stale response after deletion.
              if (old && old.deleted) return;
              const expiresAt = (old ? old.expiresAt : Math.min(Number(m.ts) || this.now(), this.now()) + this.days * DAY);
              if (expiresAt <= this.now()) return;
              const metaBytes = new TextEncoder().encode(JSON.stringify(m)).byteLength;
              s.put({ key, account, conversationId: m.conversationId, message: m, expiresAt,
                deleted: false, bytes: metaBytes + (old ? old.mediaBytes || 0 : 0), mediaBytes: old ? old.mediaBytes || 0 : 0,
                mediaCount: old ? old.mediaCount || 0 : 0 });
              if (m.kind !== "text" && !(old && old.mediaCount)) candidates.push(m);
            };
          }
        });
        await this.prune();
        return candidates;
      });
    }
    putMedia(cid, id, items, generation) {
      const account = this.account;
      return this.serial(async () => {
        if (generation !== this.generation || !this.enabled || !items.length) return false;
        const key = [account, cid, id];
        const bytes = items.reduce((n, x) => n + x.blob.size + (x.overlayBlob ? x.overlayBlob.size : 0), 0);
        if (bytes > this.limit) return false;
        // WebKit's temporary Blob backing files can fail IndexedDB writes after a process/session change.
        // Store binary buffers, then create short-lived display Blobs only when the user views a copy.
        const stored = [];
        for (const item of items) stored.push({ type: item.type, width: item.width, height: item.height,
          durationSec: item.durationSec, mime: item.blob.type, bytes: await item.blob.arrayBuffer(),
          overlayMime: item.overlayBlob && item.overlayBlob.type,
          overlayBytes: item.overlayBlob ? await item.overlayBlob.arrayBuffer() : undefined });
        if (generation !== this.generation || !this.enabled) return false;
        let saved = false;
        await this.transaction(["messages", "media"], "readwrite", (tx) => {
          const s = tx.objectStore("messages"), r = s.get(key);
          r.onsuccess = () => {
            const row = r.result;
            if (!row || row.expiresAt <= this.now()) return;
            tx.objectStore("media").put(stored, key);
            s.put({ ...row, bytes: row.bytes - row.mediaBytes + bytes, mediaBytes: bytes, mediaCount: items.length });
            saved = true;
          };
        });
        await this.prune();
        return saved;
      });
    }
    merge(cid, live) {
      const account = this.account, gen = this.generation;
      // a read, so it doesn't queue behind capture writes (a large media bundle being stored made opening a chat
      // and loading older messages wait many seconds); the generation check still drops it after a clear/disable
      return (async () => {
        if (!account || !this.enabled || gen !== this.generation) return live;
        const rows = await this.rows(account, cid);
        if (gen !== this.generation) return live;
        const out = new Map(live.map((m) => [m.id, m]));
        // the same content still visible under another id (e.g. a sent message's local copy and its server copy)
        // is not a deletion: never show a retained twin next to it
        const sameContent = (a, b) => a && b && !b.deleted && a.kind === b.kind && (a.from && a.from.id) === (b.from && b.from.id)
          && (a.text || "") === (b.text || "") && Math.abs((Number(a.ts) || 0) - (Number(b.ts) || 0)) < 10 * 60 * 1000;
        for (const r of rows) {
          if (!r.deleted || r.expiresAt <= this.now()) continue;
          if (r.message.from && r.message.from.id === account) continue; // rows saved before own messages were excluded
          if (live.some((m) => m.id !== r.message.id && sameContent(r.message, m))) continue;
          const current = out.get(r.message.id);
          // An explicit tombstone was recorded; it may later disappear from Snapchat's window.
          if (current && !current.deleted) continue;
          out.set(r.message.id, { ...r.message, deleted: true, retained: true, saved: false, seenBy: [], reactions: [],
            pending: false, failed: false, media: undefined, retainedMedia: r.mediaCount > 0,
            mediaUnavailable: r.message.kind !== "text" && !r.mediaCount });
        }
        return [...out.values()].sort((a, b) => a.ts - b.ts);
      })();
    }
    getMedia(cid, id) {
      const account = this.account, gen = this.generation;
      return this.serial(async () => {
        if (!account || !this.enabled) return [];
        const key = [account, cid, id];
        return this.transaction(["messages", "media"], "readonly", (tx, done) => {
          const r = tx.objectStore("messages").get(key);
          r.onsuccess = () => {
            if (gen !== this.generation || !r.result || !r.result.deleted || r.result.expiresAt <= this.now()) { done([]); return; }
            const m = tx.objectStore("media").get(key); m.onsuccess = () => done((gen === this.generation && this.enabled ? m.result || [] : []).map((item) => ({
              type: item.type, width: item.width, height: item.height, durationSec: item.durationSec,
              blob: new Blob([item.bytes], { type: item.mime }),
              overlayBlob: item.overlayBytes ? new Blob([item.overlayBytes], { type: item.overlayMime }) : undefined,
            })));
          };
        });
      });
    }
    async prune() {
      const rows = await this.rows(); // metadata only, across accounts: limit applies to the device
      rows.sort((a, b) => a.expiresAt - b.expiresAt);
      let bytes = rows.reduce((n, r) => n + r.bytes, 0), count = rows.length;
      const remove = [];
      for (const r of rows) {
        if (r.expiresAt <= this.now() || bytes > this.limit || count > this.maxRecords) { remove.push(r.key); bytes -= r.bytes; count--; }
      }
      if (remove.length) await this.transaction(["messages", "media"], "readwrite", (tx) => {
        for (const key of remove) { tx.objectStore("messages").delete(key); tx.objectStore("media").delete(key); }
      });
    }
    clear() {
      const account = this.account; ++this.generation;
      return this.serial(async () => {
        const rows = account ? await this.rows(account) : [];
        await this.transaction(["messages", "media"], "readwrite", (tx) => {
          for (const r of rows) { tx.objectStore("messages").delete(r.key); tx.objectStore("media").delete(r.key); }
        });
        this.error = "";
        return this.summary();
      });
    }
    async summary() {
      const rows = this.account ? await this.rows(this.account) : [];
      return { enabled: this.enabled, accountReady: !!this.account, count: rows.length,
        bytes: rows.reduce((n, r) => n + r.bytes, 0), days: this.days, limit: this.limit, error: this.error };
    }
    status() { return this.serial(async () => { await this.prune(); return this.summary(); }); }
  }
  root.GhostRetention = GhostRetention;
})(typeof window !== "undefined" ? window : globalThis);
