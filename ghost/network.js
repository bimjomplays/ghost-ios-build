// Ghost network core: a Ghost identity, the private line between two Ghost apps, visible invite codes and
// Ghost profiles. No DOM in here: ui.js's "Ghost network" section draws it and hands in the platform pieces.
// Plan and decisions: ghost/ACCOUNTS_PLAN.md.
//
// Built into ios/Resources/ghost-ui.js right before ui.js (same script, so ui.js sees GhostNetCore). Also runs in
// Node (ghost/tests/network.test.cjs) - only WebCrypto, TextEncoder and JSON are used.
//
// Wire format (all over ntfy.sh, which only ever sees ciphertext):
//   - Ghost ID  = base32(SHA-256(ECDH public || ECDSA public))[0..26]; inbox topic = "gh-in-" + base32(SHA-256("ghost-inbox|" + id)).
//   - Envelope  = {g:1, f:fromId, t:toId, e:ephemeral ECDH key, i:iv, c:AES-GCM ciphertext, s:ECDSA signature}; the key is
//     HKDF-SHA256(ECDH(ephemeral, recipient)); the signature covers "ghost-net-v1|f>t|" + e + i + c. Inside: {type, ts, n, ...}.
//   - v2 (build 81): {g:2, e, i, c, s} with {f, t, o:{type, ...}} INSIDE the ciphertext, posted to the recipient's private
//     inbox ("gh-pi-" + random, told only to connected friends in accept/welcome/profile/sync as `pi`). ntfy then sees
//     neither who sends nor who receives. The public inbox (derived from the Ghost ID) only carries accept/welcome/declined
//     and messages to/from builds 79-80, which don't know `pi` (they ignore unknown fields and message types).
//   - Invite    = the visible chat text "ghost:connect XXXX-XXXX-XXXX" (60 random bits). The inviter posts its signed card
//     (Ghost ID + public keys + Snapchat user id), AES-GCM encrypted with a key from the code, to a rendezvous topic derived
//     from the code. The friend's Ghost reads it, checks the card belongs to whoever sent the chat message, and sends an
//     "accept" (its own card + an HMAC proof of the code) to the inviter's inbox. The inviter checks the proof, that the
//     acceptor's Snapchat id is the person the invite was sent to, and that the code is unused and < 24 h old; then both
//     are connected ("welcome" back). Codes work once.
//   - Chat extras (1.10): pins, polls, votes and stickers in a 1:1 chat between two connected Ghosts are SHARED STATE:
//     items {k, v, by, d} (last writer wins by v, then by id; d null = removed, kept as a tombstone), sent as {type:"xs",
//     items} when they change, and every sync carries {xc, xm} = how many items (and the newest v) I hold that the friend
//     wrote; a mismatch makes the friend send all of its items again. So nothing depends on ntfy.sh's 12 h storage.
//     Sticker pictures go as encrypted attachments (like profile pictures); a Ghost that can't fetch one (ntfy.sh keeps
//     files 3 h) asks with {type:"xneed", k} and the author uploads it again.
//   - Report inbox (1.16): a Ghost whose PC relay takes bug reports (ghost-notify `reports enable`) tells its connected
//     friends where to send them: {type:"rx", rv, rx:{t, k, n} | null} (t = the relay's ntfy inbox "gh-rp-...", k = the
//     relay's ECDH public key, n = a label). Kept like the status line: every sync carries rxh (the rv I hold from you)
//     and rxv (mine), a mismatch re-sends it. A report is ONE encrypted file PUT to that inbox: "GRPT1" || ephemeral
//     ECDH public (65) || iv (12) || AES-GCM(HKDF(ECDH(eph, relay), salt = eph, "ghost-report-v1"), AAD
//     "ghost-report-v1|" + t) of {x, s (my public keys), r (the report JSON, a string), sig, img:[base64...]}, sig =
//     ECDSA over "ghost-report-v1|" + t + "|" + r. The relay works out the Ghost ID from x+s, so a report can't claim
//     to be from someone else. Contract and limits: ghost-notify/README.md "Bug reports and feature requests".
const GhostNetCore = (() => {
  "use strict";
  const subtle = crypto.subtle;
  const te = new TextEncoder(), td = new TextDecoder();
  const NTFY = "https://ntfy.sh";
  const B32 = "abcdefghijkmnpqrstuvwxyz23456789"; // lowercase so it's a valid ntfy topic
  const CODE_ALPHA = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I - read aloud and typed safely
  const INVITE_TTL = 24 * 3600e3;
  const RV_REPOST = 10 * 3600e3; // ntfy.sh keeps messages 12 h: repost the rendezvous card before it drops out
  const PIC_REUPLOAD = 150 * 60e3; // ntfy.sh keeps attachments 3 h
  const SYNC_EVERY = 6 * 3600e3;
  const MAX_ENVELOPE = 3900; // ntfy turns messages over 4096 bytes into attachments
  const SYNC_FORCED = 3600e3; // a forced sync (every time Ghost comes to the front) still only runs hourly per friend: ntfy.sh allows 250 messages a day
  const GONE_KEEP = 7 * 24 * 3600e3; // how long a disconnected friend is remembered, to answer their Ghost with "bye"
  const PI_RE = /^gh-pi-[a-z2-9]{26}$/;
  const RX_RE = /^gh-rp-[a-z2-9]{26}$/;       // a relay's report inbox
  const REPORT_MAX = 8 * 1024 * 1024;          // the relay refuses bigger report files
  const NTFY_FILE_MAX = 2 * 1024 * 1024;       // ntfy.sh's limit for one file (anonymous: /v1/account attachment_file_size)
  const PUB_EVERY = 15 * 60e3; // the public inbox (invites, Ghosts before build 81) is read this often when nothing waits there
  const PI_SEEN_WINDOW = 3600e3; // a new friend that hasn't written to my private inbox yet: the public one is read every round for this long
  const SLOW_MIN = 30e3, SLOW_MAX = 10 * 60e3; // after a 429: no requests for 30 s, doubling to 10 min while it lasts
  const MAX_PIC = 3 * 1024 * 1024;
  const LIMITS = { name: 40, bio: 300, status: 60 };
  // Shared items (games; later anything two Ghosts keep in sync): small JSON state, versioned, re-sent until the friend
  // confirms it, so ntfy.sh's 12 h message life never loses the latest version. key = "<kind>:<random id>".
  const ITEM_KEY_RE = /^[a-z]{2,12}:[A-Za-z0-9_-]{6,40}$/;
  const ITEM_KIND_RE = /^[a-z]{2,12}$/;
  const ITEM_PER_FRIEND = 40;         // items kept per friend (oldest go first), so a friend's Ghost can't fill storage
  const ITEM_MAX = 3200;              // JSON chars of an item's data a friend's Ghost takes. What can be SENT is less: the
                                      // sealed message must fit MAX_ENVELOPE (~2500 chars of data), putItem checks that
  const ITEM_RESEND = 10 * 60e3;      // an unconfirmed item goes again after this long (a minute when forced)
  const ITEM_BATCH = 2400;            // plain JSON chars of one "items" message (sealed it must stay under MAX_ENVELOPE)
  const ITEM_BATCH_COUNT = 12;        // items in one "items" message (the receiver reads up to 20)
  const ACCENTS = ["blue", "purple", "pink", "red", "orange", "yellow", "green", "teal"];
  const INVITE_RE = /^\s*ghost:connect\s+([2-9A-HJ-NP-Z]{4})-([2-9A-HJ-NP-Z]{4})-([2-9A-HJ-NP-Z]{4})\s*$/i;

  // ---- bytes -------------------------------------------------------------------------------------------
  const u8 = (x) => x instanceof Uint8Array ? x : new Uint8Array(x);
  function concat(...parts) {
    const all = parts.map((p) => typeof p === "string" ? te.encode(p) : u8(p));
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of all) { out.set(p, o); o += p.length; }
    return out;
  }
  function b64(bytes) {
    const b = u8(bytes); let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(str) {
    const s = atob(String(str || "")); const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function b32(bytes) {
    const b = u8(bytes); let bits = 0, val = 0, out = "";
    for (const x of b) { val = (val << 8) | x; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
    if (bits > 0) out += B32[(val << (5 - bits)) & 31];
    return out;
  }
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const sha256 = async (x) => u8(await subtle.digest("SHA-256", typeof x === "string" ? te.encode(x) : x));
  const nonce = () => b64(rand(12));

  // ---- keys --------------------------------------------------------------------------------------------
  const EC = { name: "ECDH", namedCurve: "P-256" }, DSA = { name: "ECDSA", namedCurve: "P-256" }, SIG = { name: "ECDSA", hash: "SHA-256" };
  const pubJwk = (j) => ({ kty: "EC", crv: "P-256", x: j.x, y: j.y });
  function validJwk(j) { return !!(j && typeof j.x === "string" && typeof j.y === "string" && j.x.length <= 64 && j.y.length <= 64); }
  const importEcdhPub = (j) => subtle.importKey("jwk", pubJwk(j), EC, true, []);
  const importDsaPub = (j) => subtle.importKey("jwk", pubJwk(j), DSA, true, ["verify"]);
  async function rawOf(key) { return u8(await subtle.exportKey("raw", key)); }
  async function idFor(xJwk, sJwk) {
    const [x, s] = await Promise.all([importEcdhPub(xJwk).then(rawOf), importDsaPub(sJwk).then(rawOf)]);
    return b32(await sha256(concat(x, s))).slice(0, 26);
  }
  const inboxOf = async (id) => "gh-in-" + b32(await sha256("ghost-inbox|" + id)).slice(0, 26);
  async function newKeyFile(now) {
    const x = await subtle.generateKey(EC, true, ["deriveBits"]);
    const s = await subtle.generateKey(DSA, true, ["sign", "verify"]);
    return JSON.stringify({ v: 1, created: now, x: await subtle.exportKey("jwk", x.privateKey), s: await subtle.exportKey("jwk", s.privateKey) });
  }
  async function loadIdentity(text) {
    const k = JSON.parse(text);
    if (!k || k.v !== 1 || !validJwk(k.x) || !validJwk(k.s) || !k.x.d || !k.s.d) throw new Error("bad key file");
    const xPriv = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: k.x.x, y: k.x.y, d: k.x.d }, EC, false, ["deriveBits"]);
    const sPriv = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: k.s.x, y: k.s.y, d: k.s.d }, DSA, false, ["sign"]);
    const x = pubJwk(k.x), s = pubJwk(k.s);
    const id = await idFor(x, s);
    return { id, x, s, xPriv, sPriv, inbox: await inboxOf(id), created: k.created || 0 };
  }
  async function hkdfKey(secret, salt, info) {
    const base = await subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: te.encode(info) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  // ---- cards (signed "this is my Ghost") ---------------------------------------------------------------
  async function makeCard(me, snap, now) {
    const c = JSON.stringify({ id: me.id, x: me.x, s: me.s, snap: String(snap || ""), ts: now });
    const sig = u8(await subtle.sign(SIG, me.sPriv, te.encode("ghost-card-v1|" + c)));
    return { c, s: b64(sig) };
  }
  async function readCard(card) {
    if (!card || typeof card.c !== "string" || typeof card.s !== "string" || card.c.length > 1500) throw new Error("bad card");
    const c = JSON.parse(card.c);
    if (!c || typeof c.id !== "string" || !validJwk(c.x) || !validJwk(c.s) || typeof c.snap !== "string" || !c.snap) throw new Error("bad card");
    const key = await importDsaPub(c.s);
    if (!(await subtle.verify(SIG, key, unb64(card.s), te.encode("ghost-card-v1|" + card.c)))) throw new Error("card signature");
    if ((await idFor(c.x, c.s)) !== c.id) throw new Error("card id");
    return { id: c.id, x: pubJwk(c.x), s: pubJwk(c.s), snap: c.snap, ts: Number(c.ts) || 0 };
  }

  // ---- envelopes ----------------------------------------------------------------------------------------
  async function seal(me, peer, obj) {
    const eph = await subtle.generateKey(EC, true, ["deriveBits"]);
    const e = await rawOf(eph.publicKey);
    const shared = u8(await subtle.deriveBits({ name: "ECDH", public: await importEcdhPub(peer.x) }, eph.privateKey, 256));
    const key = await hkdfKey(shared, e, "ghost-net-v1|" + peer.id);
    const iv = rand(12), route = me.id + ">" + peer.id;
    const c = u8(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(route) }, key, te.encode(JSON.stringify(obj))));
    const s = u8(await subtle.sign(SIG, me.sPriv, concat("ghost-net-v1|" + route + "|", e, iv, c)));
    const text = JSON.stringify({ g: 1, f: me.id, t: peer.id, e: b64(e), i: b64(iv), c: b64(c), s: b64(s) });
    if (text.length > MAX_ENVELOPE) throw new Error("message too big");
    return text;
  }
  // senderKey(id) -> the sender's signing JWK if we know them; an "accept" carries its own card instead
  async function unseal(me, text, senderKey) {
    const env = JSON.parse(text);
    if (!env || env.g !== 1 || env.t !== me.id || typeof env.f !== "string") return null;
    const e = unb64(env.e), iv = unb64(env.i), c = unb64(env.c);
    const shared = u8(await subtle.deriveBits({ name: "ECDH", public: await subtle.importKey("raw", e, EC, true, []) }, me.xPriv, 256));
    const key = await hkdfKey(shared, e, "ghost-net-v1|" + me.id);
    const route = env.f + ">" + me.id;
    const obj = JSON.parse(td.decode(await subtle.decrypt({ name: "AES-GCM", iv, additionalData: te.encode(route) }, key, c)));
    if (!obj || typeof obj.type !== "string") return null;
    let sKey = senderKey(env.f), card = null;
    if (obj.type === "accept") { card = await readCard(obj.card); if (card.id !== env.f) return null; sKey = sKey || card.s; }
    if (!sKey) return null;
    if (!(await subtle.verify(SIG, await importDsaPub(sKey), unb64(env.s), concat("ghost-net-v1|" + route + "|", e, iv, c)))) return null;
    return { from: env.f, obj, card };
  }
  // v2: sender and recipient inside the ciphertext
  async function seal2(me, peer, obj) {
    const eph = await subtle.generateKey(EC, true, ["deriveBits"]);
    const e = await rawOf(eph.publicKey);
    const shared = u8(await subtle.deriveBits({ name: "ECDH", public: await importEcdhPub(peer.x) }, eph.privateKey, 256));
    const key = await hkdfKey(shared, e, "ghost-net-v2|" + peer.id);
    const iv = rand(12);
    const c = u8(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode("ghost-net-v2") }, key, te.encode(JSON.stringify({ f: me.id, t: peer.id, o: obj }))));
    const s = u8(await subtle.sign(SIG, me.sPriv, concat("ghost-net-v2|", e, iv, c)));
    const text = JSON.stringify({ g: 2, e: b64(e), i: b64(iv), c: b64(c), s: b64(s) });
    if (text.length > MAX_ENVELOPE) throw new Error("message too big");
    return text;
  }
  async function unseal2(me, text, senderKey) {
    const env = JSON.parse(text);
    // junk is dropped before any key work
    if (!env || env.g !== 2 || typeof env.e !== "string" || env.e.length > 100 || typeof env.i !== "string" || env.i.length > 24 || typeof env.c !== "string" || typeof env.s !== "string" || env.s.length > 120) return null;
    const e = unb64(env.e), iv = unb64(env.i), c = unb64(env.c);
    const shared = u8(await subtle.deriveBits({ name: "ECDH", public: await subtle.importKey("raw", e, EC, true, []) }, me.xPriv, 256));
    const key = await hkdfKey(shared, e, "ghost-net-v2|" + me.id);
    const inner = JSON.parse(td.decode(await subtle.decrypt({ name: "AES-GCM", iv, additionalData: te.encode("ghost-net-v2") }, key, c)));
    if (!inner || inner.t !== me.id || typeof inner.f !== "string" || !inner.o || typeof inner.o.type !== "string") return null;
    const obj = inner.o;
    let sKey = senderKey(inner.f), card = null;
    if (obj.type === "accept") { card = await readCard(obj.card); if (card.id !== inner.f) return null; sKey = sKey || card.s; }
    if (!sKey) return null;
    if (!(await subtle.verify(SIG, await importDsaPub(sKey), unb64(env.s), concat("ghost-net-v2|", e, iv, c)))) return null;
    return { from: inner.f, obj, card };
  }

  // ---- reports to a relay (see "Report inbox" above) ---------------------------------------------------
  // a friend's report inbox, cleaned; null when it isn't one
  function rxValid(d) {
    if (!d || typeof d !== "object" || !RX_RE.test(d.t || "") || !d.k || !validJwk(d.k)) return null;
    const n = Array.from(String(d.n == null ? "" : d.n).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").trim()).slice(0, 40).join("");
    return { t: d.t, k: { x: d.k.x, y: d.k.y }, n };
  }
  async function sealReport(me, inbox, r, imgs) {
    const aad = "ghost-report-v1|" + inbox.t;
    const sig = u8(await subtle.sign(SIG, me.sPriv, te.encode(aad + "|" + r)));
    const plain = te.encode(JSON.stringify({ x: me.x, s: me.s, r, sig: b64(sig), img: imgs.map((b) => b64(b)) }));
    const eph = await subtle.generateKey(EC, true, ["deriveBits"]);
    const e = await rawOf(eph.publicKey);
    const shared = u8(await subtle.deriveBits({ name: "ECDH", public: await importEcdhPub(inbox.k) }, eph.privateKey, 256));
    const key = await hkdfKey(shared, e, "ghost-report-v1");
    const iv = rand(12);
    const c = u8(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, key, plain));
    return concat("GRPT1", e, iv, c);
  }

  // ---- invite codes -------------------------------------------------------------------------------------
  function newCode() {
    const r = rand(12); let s = "";
    for (let i = 0; i < 12; i++) { s += CODE_ALPHA[r[i] & 31]; if (i === 3 || i === 7) s += "-"; }
    return s;
  }
  function parseInvite(text) {
    const m = INVITE_RE.exec(String(text || ""));
    return m ? (m[1] + "-" + m[2] + "-" + m[3]).toUpperCase() : null;
  }
  const inviteText = (code) => "ghost:connect " + code;
  const rvTopic = async (code) => "gh-rv-" + b32(await sha256("ghost-rv|" + code)).slice(0, 26);
  const rvKey = async (code) => hkdfKey(await sha256("ghost-code|" + code), te.encode("ghost-rv"), "ghost-rv-v1");
  async function proof(code, purpose, id) {
    const k = await subtle.importKey("raw", await sha256("ghost-proof|" + code), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return b64(await subtle.sign("HMAC", k, te.encode(purpose + "|" + id)));
  }

  // ---- Link desktop (#250, format v2 #255): this Ghost's identity to Ghost desktop, once ---------------------
  // Ghost desktop must be the SAME Ghost as the phone (its own keys would show friends "new keys"), so the phone hands it
  // the key file and the network state once. The format, with every KDF string, is desktop/LINK_FORMAT.md; in short:
  //   - the PC shows a link code: 24 characters of CODE_ALPHA (120 random bits), shown as 6 groups of 4; the owner types
  //     it on the phone. HKDF-SHA256 over the code gives the ntfy topic ("gh-lk-…", derived with v1's strings in every
  //     version, so a phone and a PC of different versions meet there and can tell the owner to update), the beacon key
  //     and a 32-byte secret (this version's strings, "ghost-link-v2"), each with its own info string.
  //   - the PC first posts a BEACON to that topic: AES-GCM with the beacon key of {v, e: its one-time ECDH public key, at}.
  //     The phone sends nothing unless it finds exactly one beacon, under 5 minutes old by ntfy.sh's clock, and no file
  //     there yet (a typo finds no beacon; a used code has a file; a beacon of another version = "update Ghost").
  //   - the FILE: "GLK2" || the phone's one-time ECDH public key (65) || iv (12) || AES-GCM(key, iv, AAD
  //     "ghost-link-v2 file|" + topic) of the JSON payload; key = HKDF(ECDH(phone one-time, PC one-time) || secret,
  //     salt = phone public || PC public, "ghost-link-v2 file"). So the file needs the code AND the PC's one-time private
  //     key, which never leaves the PC and is gone after 5 minutes: a code seen later (a photo of the screen) opens nothing.
  //   - someone ELSE with the code in time could seal their own identity for the PC. So the phone looks again right before
  //     it sends and, if anything else answered, sends nothing and posts an ALARM (beacon key, "GLA2.") that makes the PC
  //     refuse; the PC keeps reading the topic until it is done and refuses two different identities; and the PC imports
  //     only after the owner OKs the Ghost ID it shows against the one the phone shows: the WHOLE Ghost ID (26
  //     characters, 130 bits, link.showId) since v2. v1 showed 8 characters (40 bits): an identity whose Ghost ID starts
  //     the same can be ground out ahead of time (a Ghost ID is no secret), 130 bits can't.
  // Nothing of it (code, topic, keys, beacon, file) is ever written to the trail, a report or the console.
  const LINK_TTL = 5 * 60e3;               // a code works for 5 minutes after the PC posted its beacon (ntfy.sh's clock)
  const LINK_SEND_BY = LINK_TTL - 30e3;    // the phone doesn't start sending this close to the end (the upload takes time)
  const LINK_LEN = 24;                     // code characters: 24 x 5 bits = 120 bits
  const LINK_TOPIC_RE = /^gh-lk-[a-z2-9]{26}$/;
  const LINK_V = 2;                        // the format version (v1, #250, never released, compared 8 Ghost ID characters)
  const LINK_BEACON = "GLB2.", LINK_ALARM = "GLA2.", LINK_MAGIC = "GLK2", LINK_FILE_NAME = "link.bin";
  const LINK_BEACON_ANY = /^GLB(\d{1,3})\./, LINK_MAGIC_ANY = /^GLK(\d)$/; // (any version's, to say "update Ghost")
  const LINK_BEACON_OLD = "GLB1.";         // what a pre-v2 Ghost desktop's session posts (link.start without wholeId)
  const GHOST_ID_RE = /^[a-km-np-z2-9]{26}$/; // (B32: no l, no o)
  const LINK_FILE_MAX = NTFY_FILE_MAX;     // one ntfy.sh file
  const LINK_KEEP_PICS = 1400 * 1024;      // base64 characters of friends' pictures in the file at most (yours always go)
  const linkErr = (kind, text) => Object.assign(new Error(text), { link: kind });
  function linkNetErr(e, sending) {
    const m = String((e && e.message) || "");
    if (/busy|429/.test(m)) return linkErr("busy", "ntfy.sh (the free server Ghost uses) is busy for your internet connection. Wait a minute and try again: the code lasts 5 minutes.");
    if (/413/.test(m)) return linkErr("big", "Your Ghost data is too big to send in one go (over 2 MB).");
    return linkErr("offline", "Couldn't reach ntfy.sh (no connection?)." + (sending ? " If your PC doesn't say Linked, start Link with Phone on the PC again for a new code." : ""));
  }
  function newLinkCode() {
    const r = rand(LINK_LEN); let s = "";
    for (let i = 0; i < LINK_LEN; i++) { s += CODE_ALPHA[r[i] & 31]; if (i % 4 === 3 && i < LINK_LEN - 1) s += "-"; }
    return s;
  }
  // what the owner typed -> the 24 code characters (upper case, no separators), or null. Case, spaces and dashes don't count.
  function linkCodeOf(text) {
    const s = String(text == null ? "" : text).toUpperCase().replace(/[\s\-_.·]/g, "");
    return s.length === LINK_LEN && /^[2-9A-HJ-NP-Z]+$/.test(s) ? s : null;
  }
  // the code -> {topic, beaconKey, secret}. The topic comes from v1's strings in EVERY version (frozen): a phone and a PC
  // of different versions meet on it and see each other's beacon / file prefix, so each can say "update Ghost" instead
  // of "no PC is waiting". Everything that seals or opens comes from this version's strings.
  async function linkSecrets(code) {
    const kdf = (v) => subtle.importKey("raw", te.encode("ghost-link-" + v + "|" + code), "HKDF", false, ["deriveBits", "deriveKey"]);
    const p = (v, info) => ({ name: "HKDF", hash: "SHA-256", salt: te.encode("ghost-link-" + v), info: te.encode("ghost-link-" + v + " " + info) });
    const meet = await kdf("v1"), base = await kdf("v2");
    const topic = "gh-lk-" + b32(u8(await subtle.deriveBits(p("v1", "topic"), meet, 160))).slice(0, 26);
    const beaconKey = await subtle.deriveKey(p("v2", "beacon"), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const secret = u8(await subtle.deriveBits(p("v2", "secret"), base, 256));
    return { topic, beaconKey, secret };
  }
  // the Ghost ID as BOTH screens show it for the owner's check: all 26 characters, upper case, groups of 4
  // ("ABCD EFGH JKMN PQRS TUVW XYZ2 34"); "" for anything that isn't a Ghost ID
  function linkShowId(id) {
    const s = String(id == null ? "" : id);
    return GHOST_ID_RE.test(s) ? s.toUpperCase().match(/.{1,4}/g).join(" ") : "";
  }
  // a beacon (text) / file (bytes) of ANY version -> its version number, or 0 when it isn't one
  function linkBeaconVersion(text) { const m = typeof text === "string" ? LINK_BEACON_ANY.exec(text) : null; return m ? Number(m[1]) : 0; }
  function linkFileVersion(bytes) {
    try { const b = u8(bytes); const m = b.length >= 4 ? LINK_MAGIC_ANY.exec(td.decode(b.subarray(0, 4))) : null; return m ? Number(m[1]) : 0; } catch (e) { return 0; }
  }
  const linkBeaconAad = (topic) => te.encode("ghost-link-v2 beacon|" + topic);
  async function sealLinkBeacon(sec, e, at) {
    const iv = rand(12);
    const c = u8(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: linkBeaconAad(sec.topic) }, sec.beaconKey, te.encode(JSON.stringify({ v: LINK_V, e: b64(e), at }))));
    return LINK_BEACON + b64(concat(iv, c));
  }
  // a beacon from the PC -> {e: its one-time public key (65 bytes), at}, or null (not one, another code's, junk)
  async function openLinkBeacon(sec, text) {
    if (typeof text !== "string" || !text.startsWith(LINK_BEACON) || text.length > 400) return null;
    try {
      const raw = unb64(text.slice(LINK_BEACON.length));
      if (raw.length < 12 + 16) return null;
      const plain = await subtle.decrypt({ name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: linkBeaconAad(sec.topic) }, sec.beaconKey, raw.subarray(12));
      const b = JSON.parse(td.decode(plain));
      const e = b && b.v === LINK_V && typeof b.e === "string" ? unb64(b.e) : null;
      if (!e || e.length !== 65 || e[0] !== 4 || typeof b.at !== "number") return null;
      await subtle.importKey("raw", e, EC, true, []); // (a point on the curve)
      return { e, at: b.at };
    } catch (e) { return null; }
  }
  // the phone's alarm (something else answered this code): the PC that reads one refuses, whatever it got
  const linkAlarmAad = (topic) => te.encode("ghost-link-v2 alarm|" + topic);
  async function sealLinkAlarm(sec, at, why) {
    const iv = rand(12);
    const c = u8(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: linkAlarmAad(sec.topic) }, sec.beaconKey, te.encode(JSON.stringify({ v: LINK_V, at, why: String(why || "") }))));
    return LINK_ALARM + b64(concat(iv, c));
  }
  // an alarm -> {at, why}, or null
  async function openLinkAlarm(sec, text) {
    if (typeof text !== "string" || !text.startsWith(LINK_ALARM) || text.length > 400 || !sec.beaconKey) return null;
    try {
      const raw = unb64(text.slice(LINK_ALARM.length));
      if (raw.length < 12 + 16) return null;
      const a = JSON.parse(td.decode(await subtle.decrypt({ name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: linkAlarmAad(sec.topic) }, sec.beaconKey, raw.subarray(12))));
      return a && a.v === LINK_V && typeof a.at === "number" ? { at: a.at, why: String(a.why || "") } : null;
    } catch (e) { return null; }
  }
  async function linkFileKey(sec, shared, ePhone, ePc) {
    const base = await subtle.importKey("raw", concat(shared, sec.secret), "HKDF", false, ["deriveKey"]);
    return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: concat(ePhone, ePc), info: te.encode("ghost-link-v2 file") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  const linkFileAad = (topic) => te.encode("ghost-link-v2 file|" + topic);
  // the phone: the payload sealed for the PC whose beacon this is
  async function sealLinkFile(sec, ePc, payload) {
    const eph = await subtle.generateKey(EC, false, ["deriveBits"]);
    const ePhone = await rawOf(eph.publicKey);
    const shared = u8(await subtle.deriveBits({ name: "ECDH", public: await subtle.importKey("raw", ePc, EC, true, []) }, eph.privateKey, 256));
    const key = await linkFileKey(sec, shared, ePhone, ePc), iv = rand(12);
    const c = u8(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: linkFileAad(sec.topic) }, key, te.encode(JSON.stringify(payload))));
    return concat(LINK_MAGIC, ePhone, iv, c);
  }
  // the PC: a file -> the checked payload, or null (wrong code, not for this PC's key, damaged, not a Ghost identity).
  // Throws nothing, so nothing of it can end up in a log by way of an error message.
  async function openLinkFile(sec, pcPriv, ePc, bytes) {
    try {
      const b = u8(bytes);
      if (b.length < 4 + 65 + 12 + 16 || b.length > LINK_FILE_MAX || td.decode(b.subarray(0, 4)) !== LINK_MAGIC) return null;
      const ePhone = b.slice(4, 69), iv = b.slice(69, 81);
      const shared = u8(await subtle.deriveBits({ name: "ECDH", public: await subtle.importKey("raw", ePhone, EC, true, []) }, pcPriv, 256));
      const key = await linkFileKey(sec, shared, ePhone, ePc);
      const p = JSON.parse(td.decode(await subtle.decrypt({ name: "AES-GCM", iv, additionalData: linkFileAad(sec.topic) }, key, b.subarray(81))));
      if (!p || p.v !== LINK_V || p.kind !== "ghost-link" || typeof p.keys !== "string" || typeof p.id !== "string" || !GHOST_ID_RE.test(p.id) || !p.net || p.net.v !== 1) return null;
      const ident = await loadIdentity(p.keys); // a real key file, and the Ghost ID it claims
      if (ident.id !== p.id) return null; // (the WHOLE Ghost ID: it is what the owner compares)
      if (!(await linkKeysMatch(ident))) return null; // (the owner's PUBLIC keys with someone else's private ones)
      return p;
    } catch (e) { return null; }
  }
  // A Ghost ID is made of the PUBLIC keys only, which every friend has: a key file with the owner's public keys and
  // someone else's private ones would show the owner's Ghost ID. So each private key must really be its public key's,
  // checked by using it (whatever the engine's JWK import checks): an ECDSA signature the public key verifies, and ECDH
  // with a fresh key that agrees both ways.
  async function linkKeysMatch(ident) {
    try {
      const msg = rand(32);
      if (!(await subtle.verify(SIG, await importDsaPub(ident.s), await subtle.sign(SIG, ident.sPriv, msg), msg))) return false;
      const t = await subtle.generateKey(EC, false, ["deriveBits"]);
      const a = u8(await subtle.deriveBits({ name: "ECDH", public: await importEcdhPub(ident.x) }, t.privateKey, 256));
      const b = u8(await subtle.deriveBits({ name: "ECDH", public: t.publicKey }, ident.xPriv, 256));
      return a.length === 32 && b.length === 32 && a.every((v, i) => v === b[i]);
    } catch (e) { return false; }
  }
  // Ghost desktop's half (desktop/LINK_FORMAT.md "Steps"; the phone never runs this). One session per code shown:
  //   const s = await GhostNetCore.link.start(Date.now(), { wholeId: true });
  //   (wholeId: the caller promises to show the WHOLE Ghost ID, showId(link.id), and to import only on a whole match.
  //   Without it, the caller is a Ghost desktop from before v2 that shows 8 characters: its session posts only v1's
  //   beacon prefix with nothing in it, so a v2 phone says "update Ghost desktop" and sends nothing, and it never links.)
  //   POST s.beacon to https://ntfy.sh/<s.topic> (header Firebase: no), then s.posted(<ntfy's JSON answer>), then show
  //   s.code. Every few seconds: GET https://ntfy.sh/<s.topic>/json?poll=1&since=<s.since()> and hand the messages (and
  //   the answer's Date header, ntfy.sh's clock) to s.take(msgs, date, download) -> {state: "waiting" | "linked" |
  //   "expired" | "refused", link?, why?}; download(url) -> the file's bytes (only https://ntfy.sh/file/… is asked for).
  //   "linked": link = the payload; show its WHOLE Ghost ID (GhostNetCore.link.showId(link.id), the same 7 groups the
  //   phone shows) and ask the owner to compare it with the phone's, KEEP polling while asking (a later file or the
  //   phone's alarm turns it "refused"), and import only if it is still "linked" with that Ghost ID when the owner says
  //   OK. s.forget() when imported or cancelled. "refused" says why: "two" (two identities), "phone" (the phone's
  //   alarm), "old" / "new" (a file of an older / newer format: the phone's Ghost is older / newer than this PC's).
  async function linkStart(nowMs, opts) {
    const whole = !!(opts && opts.wholeId === true);
    const code = newLinkCode();
    const sec = await linkSecrets(linkCodeOf(code));
    const at = Number(nowMs) || Date.now();
    let priv = null, ePc = null, beacon;
    if (whole) {
      const eph = await subtle.generateKey(EC, false, ["deriveBits"]); // the private half can't be exported, even by the PC
      ePc = await rawOf(eph.publicKey); priv = eph.privateKey;
      beacon = await sealLinkBeacon(sec, ePc, at);
    } else beacon = LINK_BEACON_OLD + b64(rand(60)); // (an 8-character checker: no key, nothing to seal a file for)
    let postedAt = 0, postedId = "", done = null, got = null;
    const seen = new Set(); // ntfy message ids already looked at (a file is downloaded once)
    const s = {
      code, topic: sec.topic, beacon, at, ttl: LINK_TTL, v: whole ? LINK_V : 1,
      // ntfy.sh's answer to the beacon POST ({id, time}): the 5 minutes count from its time
      posted(res) {
        const t = Number(res && res.time) || 0;
        if (!t) throw new Error("ntfy.sh's answer has no time");
        postedAt = t * 1000; postedId = String((res && res.id) || "");
      },
      since() { return postedId || "all"; },
      // past the 5 minutes (ntfy.sh's clock; the PC's own clock from `at` if the beacon never got posted)
      expired(serverNow) {
        if (done || !sec.beaconKey) return true;
        const t = Number(serverNow) || Date.now();
        return postedAt > 0 ? t > postedAt + LINK_TTL : t > at + LINK_TTL;
      },
      async take(msgs, date, download) {
        if (done) return done;
        if (!sec.beaconKey) return (done = { state: "expired" });
        const serverNow = Date.parse(String(date || "")) || Date.now();
        for (const m of msgs || []) {
          if (!m) continue;
          const mid = String(m.id || "");
          if (mid && seen.has(mid)) continue;
          const al = await openLinkAlarm(sec, m.message);
          if (al) { if (al.at === at) { s.forget(); return (done = { state: "refused", why: "phone" }); } continue; }
          const a = m.attachment;
          if (!priv || !a || typeof a.url !== "string" || !a.url.startsWith(NTFY + "/file/")) continue;
          const t = (Number(m.time) || 0) * 1000;
          if (!postedAt || t < postedAt || t > postedAt + LINK_TTL) continue; // (a file sent after the 5 minutes is ignored)
          if (Number(a.size) > LINK_FILE_MAX) continue;
          let bytes = null; try { bytes = await download(a.url); } catch (e) {}
          if (!bytes) continue; // (not marked seen: the next poll tries again)
          if (mid) seen.add(mid);
          // another format's file: that phone can't be checked the way this PC asks the owner to (v1 sent 8 characters'
          // worth of check): nothing is imported, and the PC tells the owner which side to update
          const fv = linkFileVersion(bytes);
          if (fv && fv !== LINK_V) { const why = got ? "two" : fv < LINK_V ? "old" : "new"; s.forget(); return (done = { state: "refused", why }); }
          const p = await openLinkFile(sec, priv, ePc, bytes);
          if (!p || p.at !== at) continue;
          // the phone sends once: a second identity means someone else had the code too
          if (got && p.id !== got.id) { s.forget(); return (done = { state: "refused", why: "two" }); }
          got = got || p;
        }
        if (s.expired(serverNow)) {
          if (!got) { s.forget(); return (done = { state: "expired" }); }
          priv = null; // (no more files after the 5 minutes; an alarm still counts until forget)
        }
        return got ? { state: "linked", link: got } : { state: "waiting" };
      },
      forget() {
        priv = null; got = null; sec.secret.fill(0); sec.beaconKey = null;
        delete s.code; delete s.topic; delete s.beacon;
        if (!done) done = { state: "expired" };
      },
    };
    return s;
  }

  // ---- one long-lived ntfy.sh stream (1.19.0) ------------------------------------------------------------
  // While Ghost is in front it holds ONE subscription to all of its topics (the private and public inbox, the relay's
  // control topic, the answer topics of open bug reports) instead of reading each one every round:
  // GET /<t1>,<t2>,.../json?since=<…> is one request for as long as it stays open (ntfy.sh sends a keepalive every 45 s).
  // Native (GhostNet.swift "gnStream") only carries the lines; this decides when it's open and what was seen already.
  //   - a cursor per topic = the ntfy.sh time (s) up to which that topic has been read completely: a keepalive moves
  //     every topic of the stream, a message its own topic, a poll its topic (by the answer's Date header). since =
  //     the oldest cursor minus a margin (a message id can't be used across topics read at different times; a time
  //     can), and messages that come again inside the margin are dropped by id.
  //   - a topic with no cursor yet (never read on this phone, e.g. right after the update) is read by its own poll
  //     first and joins the stream after that; a consumer may give a start time instead (`at`, a report just sent).
  //   - covers(topic): the stream is open (or opening) with that topic, so its poll is skipped. While it's down
  //     (backoff, 429) the polls run like before 1.19.0, so a network that can't hold a stream open still works.
  //   - reopened when a wanted topic isn't in it (a first invite, the relay paired, a report sent); topics no longer
  //     wanted stay until the next open (every open is a request against ntfy.sh's per-IP limit).
  // deps: open(url, sid) -> "ok" | "unsupported" | "error", close(sid), want() -> [{topic, at?}], take(msg),
  //       gate() -> ms until requests may go out (the shared 429 wait), limited(code) (a 429: close that gate),
  //       counted(status) (one line in the request trail), hidden() -> bool, onState(phase), load(), save(s), log(t),
  //       now() -> ms, tune {…} (the rigs' shorter waits)
  // feed(ev) takes native's events: {sid, ev:"status", status} | {sid, ev:"lines", lines:[String]} | {sid, ev:"end", status, error, body}
  const STREAM_TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;
  function createStream(deps) {
    const C = Object.assign({ margin: 60, seen: 400, healthy: 60e3, backoffMin: 5e3, backoffMax: 5 * 60e3, again: 1000, openFor: 15e3,
      firstLine: 10e3, idle: 70e3, settle: 500, settleMax: 8e3, refresh: 1500, topics: 12, hintFor: 15 * 60e3, keep: 30, refusedFor: 60e3 }, deps.tune || {});
    const now = () => (deps.now ? deps.now() : Date.now());
    const log = (t) => { try { deps.log && deps.log(t); } catch (e) {} };
    const call = (fn, ...a) => { try { return fn ? fn(...a) : undefined; } catch (e) { log("dep " + (e && e.message)); return undefined; } };
    let cur = null;                  // saved: {v:1, t:{topic: ntfy time s}, seen:[ids], off: phone clock - ntfy clock (s)}
    let loading = null;
    let running = false, phase = "idle"; // idle | opening | open | wait | off (no native op: polls only)
    // sid: which stream native's events are about (random start: a reloaded page never takes an old stream's events)
    let sid = Math.floor(Math.random() * 1e9), topics = [], since = 0, openedAt = 0, liveAt = 0, backoff = 0, connecting = false;
    let timer = 0, openTimer = 0, idleTimer = 0, refreshTimer = 0, saveTimer = 0;
    let queue = Promise.resolve(), queued = 0;
    let seenSet = new Set();
    const refusedAt = new Map(); // topic -> when a message on it was taken by nobody (no reopen for it for a while)
    async function load() {
      if (cur) return cur;
      if (!loading) loading = (async () => {
        let s = null; try { s = await deps.load(); } catch (e) {}
        const c = { v: 1, t: {}, seen: [], off: 0 };
        if (s && s.v === 1) {
          if (s.t && typeof s.t === "object") {
            const keep = Object.entries(s.t).filter(([k, v]) => STREAM_TOPIC_RE.test(k) && Number.isFinite(v) && v > 0).sort((a, b) => b[1] - a[1]).slice(0, C.keep);
            for (const [k, v] of keep) c.t[k] = v;
          }
          if (Array.isArray(s.seen)) c.seen = s.seen.filter((x) => typeof x === "string" && x.length <= 40).slice(-C.seen);
          if (Number.isFinite(s.off) && Math.abs(s.off) < 7 * 86400) c.off = s.off;
        }
        if (!cur) { cur = c; for (const id of cur.seen) seenSet.add(id); }
        return cur;
      })();
      return loading;
    }
    const nowSec = () => now() / 1000;
    function setPhase(p) {
      if (p === phase) return;
      phase = p;
      call(deps.onState, p);
    }
    function saveNow() { clearTimeout(saveTimer); saveTimer = 0; if (cur) Promise.resolve(call(deps.save, JSON.parse(JSON.stringify(cur)))).catch(() => {}); }
    function saveSoon() { if (!saveTimer) saveTimer = setTimeout(saveNow, 1000); }
    function moveCursor(topic, time) {
      if (!cur || !STREAM_TOPIC_RE.test(topic || "") || !(time > 0)) return;
      if (!(cur.t[topic] >= time)) { cur.t[topic] = time; saveSoon(); }
    }
    function remember(id) { // handled (by the stream or a poll): a later copy is dropped
      if (typeof id !== "string" || id.length > 40 || !cur) return;
      seenSet.add(id);
      if (cur.seen.includes(id)) return;
      cur.seen.push(id);
      if (cur.seen.length > C.seen) cur.seen.splice(0, cur.seen.length - C.seen);
      if (seenSet.size > 10 * C.seen) seenSet = new Set(cur.seen);
      saveSoon();
    }
    // the topics to subscribe to, each with the time to read it from (topics with neither cursor nor start time left out)
    async function wantList() {
      await load();
      let list = [];
      try { list = (await deps.want()) || []; } catch (e) { log("want " + (e && e.message)); }
      const out = [], have = new Set();
      for (const w of list) {
        if (!w || !STREAM_TOPIC_RE.test(w.topic || "") || have.has(w.topic)) continue;
        let t = cur.t[w.topic];
        if (!(t > 0) && Number.isFinite(w.at) && w.at > 0 && now() - w.at < C.hintFor) t = Math.floor(w.at / 1000 - cur.off) - C.margin;
        if (!(t > 0)) continue;
        have.add(w.topic); out.push({ topic: w.topic, t });
        if (out.length >= C.topics) break;
      }
      return out;
    }
    function waitThen(ms) {
      clearTimeout(timer); timer = 0;
      if (!running) { setPhase("idle"); return; }
      setPhase("wait");
      timer = setTimeout(() => { timer = 0; connect(); }, Math.max(50, ms));
    }
    async function connect() {
      clearTimeout(timer); timer = 0;
      if (!running || phase === "off" || connecting) return;
      if (call(deps.hidden)) { setPhase("idle"); return; }
      connecting = true;
      let again = false;
      try {
        const list = await wantList();
        if (!running || phase === "off") return;
        if (!list.length) { setPhase("idle"); return; }
        const g = Number(call(deps.gate)) || 0;
        if (g > 0) { waitThen(g + 500); return; }
        const my = ++sid;
        topics = list.map((w) => w.topic);
        since = Math.max(1, Math.floor(Math.min(...list.map((w) => w.t)) - C.margin));
        openedAt = now(); liveAt = 0;
        setPhase("opening");
        let r = "error";
        try { r = await deps.open(NTFY + "/" + topics.join(",") + "/json?since=" + since, my); } catch (e) { r = "error"; }
        if (my !== sid) { again = true; return; } // stopped or replaced meanwhile (back in front already: open again below)
        if (r === "unsupported") { setPhase("off"); log("no native stream in this build: polls"); return; }
        if (r !== "ok") { ended("not opened"); return; }
        clearTimeout(openTimer);
        openTimer = setTimeout(() => { if (my === sid && phase === "opening") { call(deps.counted, "err"); call(deps.close, my); ended("no answer"); } }, C.openFor);
      } finally {
        connecting = false;
        if (again && running && phase === "idle") connect();
      }
    }
    // a stream that says 200 but brings nothing (a proxy holding the answer back, a dead connection) is closed: the
    // first line (ntfy's "open") must come soon, then something (at least a keepalive every 45 s) all the time
    function watch(ms) {
      clearTimeout(idleTimer);
      const my = sid;
      idleTimer = setTimeout(() => { if (my === sid && phase === "open") { call(deps.close, my); ended("silent"); } }, ms);
    }
    // the current stream is over (dropped, refused, closed by ntfy.sh, silent): try again soon after a stream that kept
    // bringing lines for a while, else after a growing wait; never inside the shared 429 wait
    function ended(why) {
      clearTimeout(openTimer); clearTimeout(idleTimer); openTimer = idleTimer = 0;
      const healthy = phase === "open" && liveAt > 0 && now() - openedAt >= C.healthy && now() - liveAt < C.idle;
      sid++; // (late events from it are ignored)
      let wait;
      if (healthy) { backoff = 0; wait = C.again; }
      else { backoff = Math.min(Math.max(backoff * 2, C.backoffMin), C.backoffMax); wait = backoff * (0.8 + 0.4 * Math.random()); }
      wait = Math.max(wait, (Number(call(deps.gate)) || 0) + 500);
      log("ended (" + why + "), again in " + Math.round(wait / 1000) + " s");
      waitThen(wait);
    }
    // a topic this stream carries but nobody wants now: not covered (its poll, if any, reads it) and not read past
    function drop(list) {
      const before = topics.length;
      topics = topics.filter((t) => !list.includes(t));
      if (topics.length !== before) call(deps.onState, phase);
    }
    // one line from ntfy: true when it was one of ntfy's events (anything else, e.g. a portal's page, isn't "alive")
    function line(text) {
      let m = null; try { m = JSON.parse(text); } catch (e) { return false; }
      if (!m || typeof m !== "object" || typeof m.event !== "string") return false;
      const time = Number(m.time) || 0;
      if (m.event === "open") { if (time > 0) cur.off = Math.round(nowSec() - time); return true; }
      if (m.event === "keepalive") {
        // every topic of the stream is read up to here, once what came before is handled
        const my = sid;
        if (time > 0) queue = queue.then(() => { if (my === sid) for (const t of topics) moveCursor(t, time); });
        return true;
      }
      if (m.event !== "message" || typeof m.id !== "string" || m.id.length > 40 || !topics.includes(m.topic)) return true;
      if (seenSet.has(m.id)) return true;
      seenSet.add(m.id);
      queued++;
      const my = sid;
      queue = queue.then(async () => {
        let took = true;
        try { took = (await deps.take(m)) !== false; } catch (e) { log("take " + (e && e.message)); }
        // nobody took it (its topic isn't wanted now): neither remembered nor read past (the topic leaves this stream
        // at once, so no keepalive moves its cursor either); it comes again once the topic is wanted
        if (!took) { seenSet.delete(m.id); refusedAt.set(m.topic, now()); if (my === sid) { drop([m.topic]); self.refresh(); } return; }
        // (remembered for good only once handled: a message cut off by the app closing comes again)
        remember(m.id);
        moveCursor(m.topic, time);
      }).finally(() => { queued--; });
      return true;
    }
    const self = {
      // Ghost came to the front / went to the background
      start() { running = true; if (phase === "idle") connect(); },
      stop() {
        running = false;
        clearTimeout(timer); clearTimeout(openTimer); clearTimeout(idleTimer); clearTimeout(refreshTimer); timer = openTimer = idleTimer = refreshTimer = 0;
        if (phase === "opening" || phase === "open") { call(deps.close, sid); sid++; }
        if (phase !== "off") setPhase("idle");
        saveNow();
      },
      feed(ev) {
        if (!ev || ev.sid !== sid || (phase !== "opening" && phase !== "open")) return;
        if (ev.ev === "status") {
          if (ev.status === 200 && phase === "opening") {
            clearTimeout(openTimer); openTimer = 0;
            setPhase("open"); call(deps.counted, 200); watch(C.firstLine);
            log("open: " + topics.length + " topics since " + since);
          }
          return;
        }
        if (ev.ev === "lines") {
          if (phase !== "open") return;
          let alive = false;
          for (const l of Array.isArray(ev.lines) ? ev.lines : []) if (typeof l === "string" && l.length < 65536 && line(l)) alive = true;
          if (alive) { liveAt = now(); watch(C.idle); }
          return;
        }
        if (ev.ev === "end") {
          const status = Number(ev.status) || 0;
          if (phase === "opening") call(deps.counted, status || "err"); // (an open stream was counted when it opened)
          if (status === 429) { let code = 0; try { code = Number(JSON.parse(String(ev.body || "{}")).code) || 0; } catch (e) {} call(deps.limited, code); }
          ended(status === 429 ? "429" : status && status !== 200 ? "HTTP " + status : String(ev.error || "closed").slice(0, 80));
        }
      },
      // the topics wanted may have changed: open the stream if one is missing (a little later, so changes come together);
      // one no longer wanted stops being covered at once (its messages are left alone, it's read again from its cursor
      // if it's wanted again)
      refresh() {
        if (!running || phase === "off" || refreshTimer) return;
        refreshTimer = setTimeout(async () => {
          refreshTimer = 0;
          if (!running || phase === "off") return;
          if (connecting) { self.refresh(); return; } // (an open still on its way: look again after it)
          if (phase === "idle") return connect();
          if (phase !== "opening" && phase !== "open") return; // (the next try reads the list again)
          const list = await wantList();
          if (!running || connecting || (phase !== "opening" && phase !== "open")) return;
          drop(topics.filter((t) => !list.some((w) => w.topic === t)));
          // (a topic whose message nobody took a moment ago doesn't make it reopen: no request loop if that keeps happening)
          const missing = list.filter((w) => !topics.includes(w.topic) && !(now() - (refusedAt.get(w.topic) || 0) < C.refusedFor));
          if (!missing.length) return;
          log("reopen for " + missing.length + " more topic" + (missing.length > 1 ? "s" : ""));
          call(deps.close, sid); sid++;
          setPhase("idle");
          connect();
        }, C.refresh);
      },
      covers(topic) { return (phase === "opening" || phase === "open") && topics.includes(topic); },
      // open (not only on its way) with that topic: what the open game's own look for moves waits for
      live(topic) { return phase === "open" && topics.includes(topic); },
      // resolves true once the stream is open and what it brought first is handled (a moment without new lines), false
      // when it isn't open (then read with a poll)
      settled() {
        return new Promise((resolve) => {
          const t0 = now();
          const check = () => {
            if (phase !== "opening" && phase !== "open") return resolve(false);
            if (phase === "open" && liveAt > 0 && queued === 0 && now() - liveAt >= C.settle) return resolve(true);
            if (now() - t0 >= C.settleMax) return resolve(phase === "open" && liveAt > 0);
            setTimeout(check, Math.min(100, C.settle));
          };
          check();
        });
      },
      // a poll read `topic` completely (and handled what it brought); date = that answer's Date header (ntfy.sh's clock)
      readAt(topic, date) {
        const ms = Date.parse(String(date || ""));
        if (!Number.isFinite(ms)) return;
        load().then(() => { moveCursor(topic, Math.floor(ms / 1000)); self.refresh(); });
      },
      // a poll handled this message: the stream drops it if it comes again inside the margin
      seen(id) { load().then(() => remember(id)); },
      // any answer's Date header: how far the phone's clock is from ntfy.sh's (turns a report's send time into ntfy time)
      clock(date) {
        const ms = Date.parse(String(date || ""));
        if (Number.isFinite(ms) && cur) cur.off = Math.round(nowSec() - ms / 1000);
      },
      info() { return { phase, topics: topics.slice(), since, sid, backoff, queued, cursors: cur ? Object.assign({}, cur.t) : {}, off: cur ? cur.off : 0 }; },
    };
    return self;
  }

  // ---- the network --------------------------------------------------------------------------------------
  // deps: gnet(args) -> {status, body(base64), date?} | null   (native "gnet": ntfy.sh only; date = the answer's Date header)
  //       keysGet() -> string|null, keysSet(string), keysDelete()
  //       farewellKeys: {get, set, del} - a second Keychain slot for the old keys, only while "bye"s owed after Leave
  //       load() -> state|null, save(state)
  //       picGet(key) -> Blob|null, picPut(key, Blob), picDel(key)
  //       me() -> {id, name} (the Snapchat account), now() -> ms, onChange(what, detail), log(text)
  function create(deps) {
    const now = () => (deps.now ? deps.now() : Date.now());
    const log = (t) => { try { deps.log && deps.log(t); } catch (e) {} };
    let st = null, ident = null, identP = null, busy = null, leaving = false, slowUntil = 0, slowWait = 0, pubAt = 0;
    const linkTickets = new WeakMap(); // linkCheck's tickets -> their secrets (never on the ticket itself)
    let linkLive = null, linkBusy = false; // the one ticket that can still send; a check or send running
    const blank = () => ({ v: 1, on: true, friends: {}, invites: {}, joined: {}, since: {}, seen: [], share: "all", shareWith: [],
      profile: { v: 0, name: "", bio: "", accent: "", pic: false, banner: false }, uploads: {},
      status: { v: 0, text: "", until: 0 }, gone: {}, pi: "", items: {}, rx: { v: 0, inbox: null } });
    async function state() {
      if (st) return st;
      let s = null; try { s = await deps.load(); } catch (e) {}
      st = Object.assign(blank(), s && s.v === 1 ? s : {});
      if (!PI_RE.test(st.pi || "")) { st.pi = "gh-pi-" + b32(rand(17)).slice(0, 26); await save(); } // my private inbox
      return st;
    }
    const save = () => deps.save(JSON.parse(JSON.stringify(st)));
    const changed = (what, detail) => { try { deps.onChange && deps.onChange(what, detail); } catch (e) { log("onChange " + e.message); } };

    async function identity(create) {
      if (ident) return ident;
      if (identP) return identP;
      identP = (async () => {
        // a Keychain error is not "no keys": making new ones would silently replace your Ghost ID
        let text = null; try { text = await deps.keysGet(); } catch (e) { log("keys: " + (e && e.message || e)); throw new Error("Couldn't read your Ghost keys. Try again in a moment."); }
        if (text) { try { ident = await loadIdentity(text); return ident; } catch (e) { log("keys unreadable: " + e.message); throw new Error("Your Ghost keys are unreadable"); } }
        if (!create) return null;
        text = await newKeyFile(now());
        await deps.keysSet(text);
        ident = await loadIdentity(text);
        log("new Ghost identity " + ident.id);
        return ident;
      })().finally(() => { identP = null; });
      return identP;
    }

    // ---- Link desktop (#250): the phone's half (network.js "Link desktop" above; api.linkCheck / linkSend) ----
    const LINK_USED = "That code was answered already, and not by this phone just now. Ghost told your PC to refuse it: if your PC asks you to check a Ghost ID, cancel there. Start Link with Phone again for a new code.";
    const LINK_OLD_PC = "Your PC has an older Ghost desktop that can't check your whole Ghost ID, so Ghost sent nothing. Update Ghost desktop on your PC, then start Link with Phone again for a new code.";
    const LINK_NEW_PC = "Your PC has a newer Ghost desktop than this Ghost, so Ghost sent nothing. Update Ghost on this phone, then start Link with Phone on your PC again for a new code.";
    // the code's topic as ntfy.sh has it now: {beacons, files, older, newer, serverNow}; older / newer = beacons of
    // another format version (the topic is the same in every version). No Date header = the age can't be told: refused.
    async function linkLook(sec, sending) {
      const meta = {};
      let msgs;
      try { msgs = await poll(sec.topic, "all", meta); } catch (e) { throw linkNetErr(e, sending); }
      const serverNow = Date.parse(String(meta.date || ""));
      if (!serverNow) throw linkErr("time", "Couldn't check how old the code is with ntfy.sh. Try again in a moment.");
      const beacons = [];
      let files = 0, older = 0, newer = 0;
      for (const m of msgs) {
        if (m.attachment) { files++; continue; }
        const v = linkBeaconVersion(m.message);
        if (v && v !== LINK_V) { if (v < LINK_V) older++; else newer++; continue; }
        const b = await openLinkBeacon(sec, m.message);
        if (b) beacons.push(Object.assign(b, { time: (Number(m.time) || 0) * 1000 }));
      }
      return { beacons, files, older, newer, serverNow };
    }
    const linkLookLog = (l) => log("link check: " + l.beacons.length + " pc, " + l.files + " file" + (l.older + l.newer ? ", " + l.older + " older pc, " + l.newer + " newer pc" : ""));
    // tell the PC that answered this code to refuse what it got (best effort: the PC's ID check is the last line)
    async function linkAlarm(sec, at, why) {
      try { await post(sec.topic, await sealLinkAlarm(sec, at, why)); log("link alarm: " + why); } catch (e) { log("link alarm: not sent"); }
    }
    async function linkCheckNow(text) {
      await state();
      if (!st.on) throw linkErr("off", "Turn on Ghost Network first (Settings > Privacy).");
      const code = linkCodeOf(text);
      if (!code) throw linkErr("code", /[01OI]/i.test(String(text || "")) ? "Link codes have no 0, O, 1 or I. Check the code on your PC." : "A link code is 24 letters and numbers (6 groups of 4). Check the code on your PC.");
      if (leaving) throw linkErr("off", "Ghost Network is busy. Try again in a moment.");
      const me = await identity(true);
      const sec = await linkSecrets(code);
      try {
        const look = await linkLook(sec), { beacons, files, older, newer, serverNow } = look;
        linkLookLog(look);
        if (!beacons.length) {
          // (a PC of another version waits on this code: it can't take this phone's identity, say which side to update)
          if (older) throw linkErr("oldpc", LINK_OLD_PC);
          if (newer) throw linkErr("newpc", LINK_NEW_PC);
          throw linkErr("nopc", "No PC is waiting for that code. Check it against the code Ghost desktop shows right now.");
        }
        if (files) { for (const b of beacons) await linkAlarm(sec, b.at, "used"); throw linkErr("used", LINK_USED); }
        if (beacons.length + older + newer > 1) throw linkErr("twice", "Something else answered that code too, so Ghost won't use it. On your PC, start Link with Phone again for a new code.");
        const age = Math.max(0, serverNow - beacons[0].time);
        if (age > LINK_SEND_BY) throw linkErr("expired", "That code has expired (codes last 5 minutes). On your PC, start Link with Phone again for a new code.");
        // the WHOLE Ghost ID, as the PC shows it (v2): what the owner compares, and what linkSend must still be
        const ghostId = linkShowId(me && me.id);
        if (!ghostId) throw linkErr("keys", "Couldn't read your Ghost keys. Try again in a moment.");
        if (linkLive) api.linkDrop(linkLive); // (one live check at a time)
        const ticket = Object.freeze({ expiresIn: LINK_TTL - age, ghostId });
        linkTickets.set(ticket, { sec, beacon: beacons[0], age, checkedAt: now(), id: me.id });
        linkLive = ticket;
        return ticket;
      } catch (e) { sec.secret.fill(0); throw e; }
    }
    async function linkSendNow(t, extra) {
      await state();
      if (!st.on || leaving) throw linkErr("off", "Turn on Ghost Network first (Settings > Privacy).");
      // look again (the confirm may have sat a while): still exactly this one beacon, nothing answered it, still in time
      const look = await linkLook(t.sec, true);
      const answers = look.beacons.length + look.older + look.newer;
      if (look.files || answers !== 1 || !look.beacons.some((b) => b.at === t.beacon.at)) {
        linkLookLog(look);
        for (const b of look.beacons) await linkAlarm(t.sec, b.at, "raced");
        if (look.files || answers > 1) throw linkErr("raced", "Something else answered that code while you were confirming, so Ghost sent nothing and told your PC to refuse it. On your PC, start Link with Phone again for a new code.");
        throw linkErr("nopc", "Your PC stopped waiting for that code. On your PC, start Link with Phone again for a new code.");
      }
      const age = Math.max(look.serverNow - t.beacon.time, t.age + (now() - t.checkedAt));
      if (age > LINK_SEND_BY) throw linkErr("expired", "That code has expired (codes last 5 minutes). On your PC, start Link with Phone again for a new code.");
      const me = await identity(false);
      let keys = null; try { keys = await deps.keysGet(); } catch (e) {}
      if (!me || typeof keys !== "string" || !keys) throw linkErr("keys", "Couldn't read your Ghost keys. Try again in a moment.");
      if ((await loadIdentity(keys)).id !== me.id) throw linkErr("keys", "Couldn't read your Ghost keys. Try again in a moment.");
      // the identity the owner saw at the confirm, nothing else (Leave + a new Ghost ID in between: start again)
      if (me.id !== t.id) throw linkErr("keys", "Your Ghost ID changed since you checked the code, so Ghost sent nothing. On your PC, start Link with Phone again for a new code.");
      const copy = JSON.parse(JSON.stringify(st)); // (one synchronous copy: a consistent state)
      delete copy.farewell;
      const x = extra || {};
      const payload = { v: LINK_V, kind: "ghost-link", at: t.beacon.at, created: now(), id: me.id, keys, net: copy,
        stream: x.stream && typeof x.stream === "object" ? x.stream : null, snap: String((deps.me() && deps.me().id) || ""),
        app: x.app && typeof x.app === "object" ? { version: String(x.app.version || ""), platform: String(x.app.platform || "") } : null,
        pics: {}, missing: [] };
      // pictures: yours always (the PC sends your profile from now on too: without them friends would lose them),
      // friends' while they fit; a friend's that doesn't is asked for again by the PC's first sync (haveV 0, no ref)
      const picB64 = async (k) => { const blob = await Promise.resolve(deps.picGet(k)).catch(() => null); return blob ? { t: /^image\/(jpeg|png|webp)$/.test(blob.type) ? blob.type : "image/jpeg", b: b64(u8(await blob.arrayBuffer())) } : null; };
      for (const kind of ["pic", "banner"]) { if (!st.profile[kind]) continue; const p = await picB64("me:" + kind); if (p) payload.pics["me:" + kind] = p; }
      let room = LINK_KEEP_PICS;
      for (const f of Object.values(copy.friends)) {
        for (const kind of ["pic", "banner"]) {
          if (!(f.profile && f.profile[kind])) continue;
          const p = await picB64(f.id + ":" + kind);
          if (p && p.b.length <= room) { payload.pics[f.id + ":" + kind] = p; room -= p.b.length; continue; }
          payload.missing.push(f.id + ":" + kind);
          f.haveV = 0; if (f.picRefs) delete f.picRefs[kind];
        }
      }
      const file = await sealLinkFile(t.sec, t.beacon.e, payload);
      if (file.length > LINK_FILE_MAX) throw linkErr("big", "Your Ghost data is too big to send in one go (over 2 MB).");
      let res = null;
      try { res = JSON.parse(td.decode(await net({ url: NTFY + "/" + t.sec.topic, method: "PUT", body: b64(file), headers: { Filename: LINK_FILE_NAME, Firebase: "no" } }))); }
      catch (e) { throw linkNetErr(e, true); }
      if (!res || !res.attachment) throw linkErr("offline", "ntfy.sh didn't take it. On your PC, start Link with Phone again for a new code and try once more.");
      st.linkedAt = now(); await save();
      log("link sent: " + Math.round(file.length / 1024) + " KB, " + Object.keys(payload.pics).length + " pictures, " + payload.missing.length + " left out");
      return { id: me.id, ghostId: linkShowId(me.id), bytes: file.length, pics: Object.keys(payload.pics).length, missing: payload.missing.length };
    }

    // ---- ntfy.sh ----
    // ntfy.sh limits requests per IP (a bucket of 60, one more every 5 s), shared with the PC relay on the same wifi. A
    // 429 means it's empty: nothing goes out for a while (SLOW_MIN, doubling while it lasts; any answer resets it)
    async function net(args, meta) {
      if (now() < slowUntil) throw new Error("ntfy busy");
      const r = await deps.gnet(args);
      if (!r || typeof r.status !== "number") throw new Error("Ghost network isn't reachable");
      if (meta) meta.date = r.date;
      if (r.status === 429) { slowWait = Math.min(Math.max(slowWait * 2, SLOW_MIN), SLOW_MAX); slowUntil = now() + slowWait; throw new Error("ntfy 429"); }
      slowWait = 0;
      if (r.status === 413) throw new Error("ntfy 413 too big");
      if (r.status < 200 || r.status >= 300) throw new Error("ntfy " + r.status);
      return unb64(r.body || "");
    }
    const post = (topic, text) => net({ url: NTFY + "/" + topic, method: "POST", body: b64(te.encode(text)), headers: { Firebase: "no" } });
    async function poll(topic, since, meta) {
      const body = td.decode(await net({ url: NTFY + "/" + topic + "/json?poll=1&since=" + encodeURIComponent(since || "all") }, meta));
      const out = [];
      for (const line of body.split("\n")) { if (!line.trim()) continue; try { const m = JSON.parse(line); if (m && m.event === "message") out.push(m); } catch (e) {} }
      return out;
    }
    // messages are handled one at a time, whether a poll read them or the stream (1.19.0) brought them
    let lock = Promise.resolve(), takes = 0, takeDirty = false;
    function serial(fn) { const p = lock.then(fn); lock = p.catch(() => {}); return p; }
    async function upload(bytes) {
      const topic = "gh-f-" + b32(rand(16)).slice(0, 26);
      const res = JSON.parse(td.decode(await net({ url: NTFY + "/" + topic, method: "PUT", body: b64(bytes), headers: { Filename: "g.bin", Firebase: "no" } })));
      const url = res && res.attachment && res.attachment.url;
      if (typeof url !== "string" || !url.startsWith(NTFY + "/file/")) throw new Error("upload failed");
      return url;
    }
    async function download(url) {
      if (typeof url !== "string" || !url.startsWith(NTFY + "/file/")) throw new Error("bad picture link");
      return net({ url });
    }

    // ---- pictures: encrypted once per profile version with a fresh key, sent inside each friend's sealed profile ----
    async function uploadPic(kind) {
      const up = st.uploads[kind];
      if (up && now() - up.at < PIC_REUPLOAD) return up.ref; // (dropped whenever the picture itself changes)
      const blob = await deps.picGet("me:" + kind);
      if (!blob) return null;
      const bytes = u8(await blob.arrayBuffer());
      const keyBytes = rand(32), iv = rand(12);
      const key = await subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
      const ct = u8(await subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
      const ref = { u: await upload(ct), k: b64(keyBytes), i: b64(iv), t: blob.type || "image/jpeg" };
      st.uploads[kind] = { at: now(), ref };
      await save();
      return ref;
    }
    async function fetchPic(ref) {
      if (!ref || typeof ref.k !== "string" || typeof ref.i !== "string") throw new Error("bad picture");
      const ct = await download(ref.u);
      if (ct.length > MAX_PIC) throw new Error("picture too big");
      const key = await subtle.importKey("raw", unb64(ref.k), "AES-GCM", false, ["decrypt"]);
      const bytes = u8(await subtle.decrypt({ name: "AES-GCM", iv: unb64(ref.i) }, key, ct));
      const type = /^image\/(jpeg|png|webp)$/.test(ref.t) ? ref.t : "image/jpeg";
      return new Blob([bytes], { type });
    }

    // ---- sending ----
    async function send(friend, obj) {
      const me = await identity(false);
      if (!me) throw new Error("no Ghost identity");
      await sendAs(me, friend, obj);
    }
    async function sendAs(me, friend, obj) {
      const env = await envelope(me, friend, obj);
      await post(env.topic, env.text);
    }
    // the sealed message and where it goes (throws "message too big" when it can't go as one ntfy message)
    async function envelope(me, friend, obj) {
      const body = Object.assign({ ts: now(), n: nonce() }, obj);
      if (friend.cap >= 2 && PI_RE.test(friend.pi || "")) return { topic: friend.pi, text: await seal2(me, friend, body) };
      return { topic: friend.inbox, text: await seal(me, friend, body) };
    }
    const tooBig = (e) => /message too big/.test((e && e.message) || "");
    // make room for one more item shared with this friend (drops their oldest)
    function itemRoom(fid) {
      const theirs = Object.values(st.items || {}).filter((i) => i.with === fid).sort((a, b) => (a.at || 0) - (b.at || 0));
      while (theirs.length >= ITEM_PER_FRIEND) delete st.items[theirs.shift().key];
    }
    const itemMsg = (it) => ({ type: "item", key: it.key, kind: it.kind, v: it.v, data: it.data, bi: 1 });
    // unconfirmed items go to a friend in as few messages as fit (one request each against ntfy.sh's limit), to friends
    // whose Ghost said it reads "items" (bi); an older Ghost gets them one by one. Returns false when a send failed.
    // An item that can't go even on its own (too big for one ntfy message: stored by an older Ghost, 1.19.1 and before
    // let 8 Ball matches grow past it) is marked tooBig for that version and skipped, so it isn't re-sent every round
    // ("item resend: message too big" every 20 s, #203) and doesn't hold back the items after it.
    async function sendItems(f, list) {
      const groups = [];
      if (f.bi === 1) {
        let cur = [], size = 0;
        for (const it of list) {
          const len = JSON.stringify(it.data).length + 60;
          if (cur.length && (size + len > ITEM_BATCH || cur.length >= ITEM_BATCH_COUNT)) { groups.push(cur); cur = []; size = 0; }
          cur.push(it); size += len;
        }
        if (cur.length) groups.push(cur);
      } else for (const it of list) groups.push([it]);
      while (groups.length) {
        const g = groups.shift();
        try {
          if (g.length === 1) await send(f, itemMsg(g[0]));
          else await send(f, { type: "items", list: g.map((it) => ({ key: it.key, kind: it.kind, v: it.v, data: it.data })), bi: 1 });
        } catch (e) {
          if (!tooBig(e)) { log("item resend: " + e.message); return false; }
          if (g.length > 1) { groups.unshift(...g.map((it) => [it])); continue; } // (a batch with wide characters: one by one)
          g[0].tooBig = g[0].v; g[0].sentAt = now();
          log("item too big to send: " + g[0].key.slice(0, 12) + " v" + g[0].v);
          continue;
        }
        for (const it of g) it.sentAt = now();
      }
      return true;
    }
    // what every message that sets up or keeps a connection carries: where to reach me privately
    const piInfo = () => ({ pi: st.pi, cap: 2, bi: 1 });
    function learnPi(f, obj) { if (f && obj && obj.cap >= 2 && PI_RE.test(obj.pi || "") && (f.pi !== obj.pi || f.cap !== 2)) { f.pi = obj.pi; f.cap = 2; return true; } return false; }
    const canShare = (f) => st.share === "all" || (st.shareWith || []).includes(f.id);
    async function sendProfile(f) {
      if (!canShare(f)) { await send(f, Object.assign({ type: "profile", v: st.profile.v, private: true }, piInfo())); f.sentV = st.profile.v; return; }
      const p = st.profile;
      // a picture that didn't upload is NOT sent as "no picture" (their Ghost would delete yours): the whole profile
      // waits and goes again at the next sync
      const [pic, banner] = await Promise.all([p.pic ? uploadPic("pic") : null, p.banner ? uploadPic("banner") : null]);
      if ((p.pic && !pic) || (p.banner && !banner)) throw new Error("picture missing");
      await send(f, Object.assign({ type: "profile", v: p.v, name: p.name, bio: p.bio, accent: p.accent, pic, banner }, piInfo()));
      f.sentV = p.v;
    }
    // the status line travels on its own (a new status never re-sends pictures). Friends you don't share with get an
    // empty one, so a status they saw earlier goes away.
    const statusLive = () => !!(st.status && st.status.text && (!st.status.until || st.status.until > now()));
    async function sendStatus(f) {
      const s = st.status || blank().status;
      const show = canShare(f) && statusLive();
      await send(f, { type: "status", sv: s.v, text: show ? s.text : "", until: show ? s.until : 0 });
      f.sentSV = s.v;
    }
    async function pushStatusToAll() {
      for (const f of Object.values(st.friends)) {
        if (f.state !== "connected" || f.sentSV === st.status.v || !(f.cap >= 2)) continue; // (builds 79-80 ignore it anyway: save ntfy's daily budget)
        try { await sendStatus(f); } catch (e) { log("status to " + f.id + ": " + e.message); }
      }
      await save();
    }
    // my report inbox (my PC relay takes bug reports), like the status line: its own message, re-sent on a sync mismatch
    async function sendRx(f) {
      await send(f, { type: "rx", rv: st.rx.v, rx: st.rx.inbox });
      f.sentRV = st.rx.v;
    }
    async function pushRxToAll() {
      for (const f of Object.values(st.friends)) {
        if (f.state !== "connected" || f.sentRV === st.rx.v || !(f.cap >= 2)) continue;
        try { await sendRx(f); } catch (e) { log("rx to " + f.id + ": " + e.message); }
      }
      await save();
    }
    // what every sync carries about report inboxes (builds before 1.16 send neither and ignore both)
    const rxInfo = (f) => ({ rxh: f.rxV || 0, rxv: st.rx.v || 0 });
    // after connecting: the profile, and the status if there is one
    async function sendAll(f) {
      await sendProfile(f);
      try { const me = await identity(false); if (me) await xsend(f, xmine(f.id, me.id, false).concat(xmine(f.id, me.id, true))); } catch (e) { log("extras: " + e.message); }
      if (st.status && st.status.v && statusLive() && f.cap >= 2) { try { await sendStatus(f); } catch (e) { log("status: " + e.message); } }
      if (st.rx && st.rx.v && f.cap >= 2) { try { await sendRx(f); } catch (e) { log("rx: " + e.message); } }
    }
    async function pushProfileToAll() {
      for (const f of Object.values(st.friends)) {
        if (f.state !== "connected" || f.sentV === st.profile.v) continue;
        try { await sendProfile(f); } catch (e) { log("profile to " + f.id + ": " + e.message); }
      }
      await save();
    }

    // ---- chat extras (pins, polls, votes, stickers) ----
    const XKEY_RE = /^(pin:[A-Za-z0-9_.-]{1,96}|poll:[a-z0-9]{8,24}|vote:[a-z0-9]{8,24}:[a-z2-9]{26}|stk:[A-Za-z0-9_.-]{1,96}:[a-z0-9]{8,24})$/;
    // 1.14: pins and stickers in a GROUP chat carry the group's Snapchat conversation id as a prefix
    // ("g.<conversation id>.pin:<msg>"), and go to every group member you're connected with on Ghost. Builds before
    // 1.14 refuse these keys, so they're counted apart in the sync summary (xg/xgm) and never trigger a resend there.
    const XGROUP_RE = /^g\.[A-Za-z0-9-]{1,40}\./;
    const xbase = (k) => String(k).replace(XGROUP_RE, "");
    const xgroup = (k) => XGROUP_RE.test(String(k));
    const xkeyOk = (k) => typeof k === "string" && XKEY_RE.test(xbase(k)) && (!xgroup(k) || /^(pin|stk):/.test(xbase(k)));
    const XMAX_ITEM = 1500, XCHUNK = 1700, XMAX_ITEMS = 3000;
    const num = (x, lo, hi) => typeof x === "number" && isFinite(x) && x >= lo && x <= hi;
    const txt = (x, n) => typeof x === "string" && x.length <= n;
    function xbox(fid) { st.extras = st.extras || {}; return st.extras[fid] || (st.extras[fid] = { items: {} }); }
    function refOk(r) { return !!(r && typeof r === "object" && typeof r.u === "string" && r.u.startsWith(NTFY + "/file/") && r.u.length < 200 && txt(r.k, 64) && txt(r.i, 32) && txt(r.t, 20)); }
    // what each kind of item may hold (anything else is refused, so a friend's Ghost can't smuggle odd data in)
    function dataOk(k, d) {
      if (d === null) return true;
      if (!d || typeof d !== "object" || Array.isArray(d) || JSON.stringify(d).length > XMAX_ITEM) return false;
      const b = xbase(k), kind = b.slice(0, b.indexOf(":"));
      if (kind === "pin") return num(d.t, 0, 1e14) && txt(d.p, 160) && txt(d.f || "", 80) && txt(d.kd || "", 20);
      if (kind === "poll") return txt(d.q, 300) && d.q.trim().length > 0 && Array.isArray(d.o) && d.o.length >= 2 && d.o.length <= 10 && d.o.every((o) => txt(o, 120))
        && typeof d.m === "boolean" && typeof d.x === "boolean" && num(d.c || 0, 0, 1e14) && num(d.at, 0, 1e14) && txt(d.cr, 40);
      if (kind === "vote") return Array.isArray(d.s) && d.s.length <= 10 && d.s.every((i) => Number.isInteger(i) && i >= 0 && i < 10);
      if (kind === "stk") return ["e", "b", "i"].includes(d.kd) && txt(d.r || "", 64) && txt(d.a || "", 64) && (d.kd !== "i" || refOk(d.ref))
        && num(d.x, -1, 2) && num(d.y, -1, 2) && num(d.s, 0.2, 4) && num(d.rot, -7, 7);
      return false;
    }
    function xvalid(it) { return !!(it && typeof it === "object" && xkeyOk(it.k) && num(it.v, 1, now() + 10 * 60e3) && txt(it.by, 40) && dataOk(it.k, it.d === undefined ? null : it.d)); }
    const xnewer = (a, b) => !b || a.v > b.v || (a.v === b.v && String(a.by) > String(b.by));
    // one item into the chat's state; who may write what: votes only their voter, a poll only its creator, a sticker
    // only whoever placed it; pins either of you
    function xapply(fid, it) {
      if (!xvalid(it)) return false;
      const box = xbox(fid), cur = box.items[it.k];
      if (!cur && Object.keys(box.items).length >= XMAX_ITEMS) {
        // full: make room by forgetting the oldest removed item (a tombstone); only live items refuse new ones
        let old = null;
        for (const i of Object.values(box.items)) if (!i.d && (!old || i.v < old.v)) old = i;
        if (!old) return false;
        delete box.items[old.k];
      }
      const bk = xbase(it.k);
      if (bk.startsWith("vote:") && bk.split(":")[2] !== it.by) return false;
      if (bk.startsWith("poll:") && ((cur && cur.d && cur.d.cr && cur.d.cr !== it.by) || (it.d && it.d.cr !== it.by) || (cur && !cur.d && cur.by !== it.by))) return false;
      if (bk.startsWith("stk:") && cur && cur.by !== it.by) return false;
      if (!xnewer(it, cur)) return false;
      box.items[it.k] = { k: it.k, v: it.v, by: it.by, d: it.d == null ? null : it.d };
      return true;
    }
    const xsyncInfo = (f) => { const h = xsummary(f.id, f.id, false), g = xsummary(f.id, f.id, true); return { xc: h.c, xm: h.m, xg: g.c, xgm: g.m }; };
    const xmine = (fid, myId, group) => Object.values(xbox(fid).items).filter((i) => i.by === myId && xgroup(i.k) === group);
    function xsummary(fid, who, group) { let c = 0, m = 0; for (const i of Object.values(xbox(fid).items)) if (i.by === who && xgroup(i.k) === group) { c++; if (i.v > m) m = i.v; } return { c, m }; }
    async function xsend(f, items) {
      if (!items.length || f.state !== "connected") return;
      let chunk = [], size = 0;
      const flush = async () => { if (chunk.length) await send(f, { type: "xs", items: chunk }); chunk = []; size = 0; };
      for (const it of items.slice().sort((a, b) => a.v - b.v)) {
        const n = JSON.stringify(it).length;
        if (size + n > XCHUNK) await flush();
        chunk.push(it); size += n;
      }
      await flush();
    }

    // ---- receiving ----
    // every message nonce is kept for as long as its timestamp is accepted (48 h + drift), not a fixed count: busy
    // friends used to push old nonces out of a 500-entry list while their messages could still be replayed
    function remember(n, ts) {
      if (typeof n !== "string" || n.length > 40) return false;
      if (!st.seenAt || typeof st.seenAt !== "object") st.seenAt = {};
      if (st.seenAt[n] || (st.seen || []).includes(n)) return false;
      st.seenAt[n] = ts;
      const keys = Object.keys(st.seenAt);
      if (keys.length > 3000) { const cut = now() - 50 * 3600e3; for (const k of keys) if (st.seenAt[k] < cut) delete st.seenAt[k]; }
      return true;
    }
    async function dropFriend(id) {
      const f = st.friends[id];
      if (!f) return;
      delete st.friends[id];
      for (const [k, it] of Object.entries(st.items || {})) if (it.with === id) delete st.items[k];
      if (st.extras) delete st.extras[id]; // (their pins, polls and stickers go with them)
      await Promise.all([deps.picDel(id + ":pic"), deps.picDel(id + ":banner")].map((p) => Promise.resolve(p).catch(() => {})));
      return f;
    }
    // a friend you disconnected from is remembered for a week (keys + inboxes only), so a "bye" that didn't get through
    // is sent again, and anything their Ghost still sends is answered with another "bye"
    function tombstone(f, sent) { st.gone[f.id] = { id: f.id, x: f.x, s: f.s, inbox: f.inbox, pi: f.pi, cap: f.cap, snap: f.snap, at: now(), sent: !!sent }; }
    async function sayBye(g) {
      g.lastBye = now();
      try { await send(g, { type: "bye" }); g.sent = true; } catch (e) { log("bye: " + e.message); }
    }
    async function farewells() {
      const fw = st.farewell;
      if (!fw) return;
      const done = async () => { delete st.farewell; await save(); try { await deps.farewellKeys.del(); } catch (e) {} };
      if (now() > fw.until || !fw.to || !fw.to.length || !deps.farewellKeys) return done();
      let me = null;
      try { const t = await deps.farewellKeys.get(); if (!t) return done(); me = await loadIdentity(t); } catch (e) { log("farewell keys: " + e.message); return; }
      for (const f of fw.to.slice()) {
        try { await sendAs(me, f, { type: "bye" }); fw.to = fw.to.filter((x) => x !== f); } catch (e) { log("farewell: " + e.message); break; }
      }
      if (!fw.to.length) return done();
      await save();
    }
    function friendBySnap(snap) { return Object.values(st.friends).find((f) => f.snap === snap) || null; }
    // the public inbox gets: accepts for my invites (cancelled ones are answered too), welcomes for invites I took from
    // a Ghost before build 81, and anything from a friend that may not know my private inbox yet: one that hasn't told
    // me its own, or a new friend that hasn't written to it (a re-sent accept after a lost welcome goes there)
    function needPublic() {
      if (now() - pubAt >= PUB_EVERY) return true;
      if (Object.values(st.invites).some((i) => !i.used && now() - i.created < INVITE_TTL)) return true;
      if (Object.values(st.joined).some((j) => j.state === "connecting")) return true;
      return Object.values(st.friends).some((f) => f.state !== "connected" || !(f.cap >= 2) || (!f.piSeen && now() - (f.since || 0) < PI_SEEN_WINDOW));
    }
    const senderKey = (id) => (st.friends[id] && st.friends[id].s) || (st.gone[id] && st.gone[id].s) || null;
    async function handle(msg, viaPi) {
      const me = await identity(false);
      if (!me || typeof msg.message !== "string" || msg.message[0] !== "{" || msg.message.length > 6000) return;
      let got = null;
      try { got = msg.message.startsWith('{"g":2') ? await unseal2(me, msg.message, senderKey) : await unseal(me, msg.message, senderKey); }
      catch (e) { log("unreadable message: " + e.message); return; }
      if (!got) return;
      const { from, obj } = got;
      if (typeof obj.ts !== "number" || obj.ts < now() - 48 * 3600e3 || obj.ts > now() + 3600e3 || !remember(obj.n, obj.ts)) return;
      const f = st.friends[from];
      if (!f && st.gone[from] && obj.type !== "accept") { // someone you disconnected from: they didn't get the bye
        const g = st.gone[from];
        if (obj.type === "bye") { delete st.gone[from]; await save(); return; }
        if (now() - (g.lastBye || 0) > 10 * 60e3) { await sayBye(g); await save(); }
        return;
      }
      if (f && f.since && obj.ts < f.since - 10 * 60e3 && obj.type !== "welcome") return; // older than this connection (replayed; 10 min for clock drift)
      if (f && f.state === "connected") f.heard = now(); // "Last heard from" on their profile
      if (f && viaPi) f.piSeen = true; // they know my private inbox (needPublic)
      let learnt = f ? learnPi(f, obj) : false;
      if (f && obj.bi === 1 && f.bi !== 1) { f.bi = 1; learnt = true; } // their Ghost reads batched "items"
      if (learnt) await save();
      switch (obj.type) {
        case "accept": return onAccept(got);
        case "welcome": {
          if (!f || f.state !== "connecting" || !f.code || obj.p !== await proof(f.code, "welcome", from)) return;
          f.state = "connected"; f.since = now(); f.heard = now(); delete f.code;
          delete st.gone[from];
          for (const j of Object.values(st.joined)) if (j.id === from && j.state === "connecting") j.state = "connected";
          await save(); changed("friends", { id: from, snap: f.snap });
          try { await sendAll(f); await save(); } catch (e) { log("profile after welcome: " + e.message); }
          return;
        }
        case "profile": return f ? onProfile(f, obj) : undefined;
        case "xs": {
          if (!f || f.state !== "connected" || !Array.isArray(obj.items)) return;
          let n = 0;
          for (const it of obj.items.slice(0, 60)) if (it && it.by === from && xapply(f.id, it)) n++;
          if (n) { await save(); changed("extras", { id: f.id, snap: f.snap }); }
          return;
        }
        // their Ghost couldn't fetch a sticker picture I placed (ntfy.sh keeps files 3 h): upload it again
        case "xneed": {
          if (!f || f.state !== "connected" || typeof obj.k !== "string") return;
          const me = await identity(false), it = me && xbox(f.id).items[obj.k];
          if (!it || it.by !== me.id || !it.d || it.d.kd !== "i" || !deps.stickerBlob) return;
          f.xneed = f.xneed || {};
          if (now() - (f.xneed[obj.k] || 0) < 20 * 60e3) return;
          f.xneed[obj.k] = now();
          try {
            const blob = await deps.stickerBlob(obj.k.split(":")[2]);
            if (!blob) return;
            const d = Object.assign({}, it.d, { ref: await api.putPicture(blob) });
            const nit = { k: it.k, v: Math.max(now(), it.v + 1), by: me.id, d };
            if (xapply(f.id, nit)) { await save(); await xsend(f, [nit]); }
          } catch (e) { log("xneed: " + e.message); }
          return;
        }
        case "sync": {
          if (!f || f.state !== "connected") return;
          if (obj.have !== st.profile.v) { try { await sendProfile(f); } catch (e) { log("sync reply: " + e.message); } }
          // (builds before 81 send no status numbers: they get no status)
          if (typeof obj.shave === "number" && obj.shave !== st.status.v) { try { await sendStatus(f); } catch (e) { log("sync status: " + e.message); } }
          // chat extras: they hold a different set of what I wrote than I do -> send all of mine again (1.10+ only)
          if (typeof obj.xc === "number") {
            const me = await identity(false), mine = me ? xsummary(f.id, me.id, false) : null;
            if (mine && (mine.c !== obj.xc || mine.m !== obj.xm) && now() - (f.xResent || 0) > 10 * 60e3) {
              f.xResent = now();
              try { await xsend(f, xmine(f.id, me.id, false)); } catch (e) { log("extras resend: " + e.message); }
            }
          }
          // group pins/stickers (1.14+ only: older builds send no xg)
          if (typeof obj.xg === "number") {
            const me = await identity(false), mine = me ? xsummary(f.id, me.id, true) : null;
            if (mine && (mine.c !== obj.xg || mine.m !== obj.xgm) && now() - (f.xgResent || 0) > 10 * 60e3) {
              f.xgResent = now();
              try { await xsend(f, xmine(f.id, me.id, true)); } catch (e) { log("group extras resend: " + e.message); }
            }
          }
          // my report inbox: they hold another version (1.16+ only: older builds send no rxh)
          if (typeof obj.rxh === "number" && st.rx.v && obj.rxh !== st.rx.v && f.cap >= 2) { try { await sendRx(f); } catch (e) { log("sync rx: " + e.message); } }
          const behind = (typeof obj.mine === "number" && obj.mine > (f.haveV || 0)) || (typeof obj.sv === "number" && obj.sv > (f.statusV || 0)) || (typeof obj.rxv === "number" && obj.rxv > (f.rxV || 0));
          if (behind && !obj.reply) { try { await send(f, Object.assign(Object.assign({ type: "sync", have: f.haveV || 0, mine: st.profile.v, shave: f.statusV || 0, sv: st.status.v, reply: true }, xsyncInfo(f), rxInfo(f)), piInfo())); } catch (e) {} }
          await save();
          return;
        }
        case "status": {
          if (!f || f.state !== "connected" || typeof obj.sv !== "number" || obj.sv <= (f.statusV || 0)) return;
          const text = String(obj.text == null ? "" : obj.text).replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, " ").trim().slice(0, LIMITS.status);
          const until = Number(obj.until) || 0;
          f.status = text ? { text, until } : null; f.statusV = obj.sv;
          await save(); changed("profile", { id: f.id, snap: f.snap });
          return;
        }
        // a connected friend's report inbox (their PC relay takes bug reports from their friends), or null = not any more
        case "rx": {
          if (!f || f.state !== "connected" || !Number.isSafeInteger(obj.rv) || obj.rv <= (f.rxV || 0)) return;
          const d = obj.rx === null ? null : rxValid(obj.rx);
          if (obj.rx !== null && !d) return;
          f.rx = d; f.rxV = obj.rv;
          await save(); changed("rx", { id: f.id, snap: f.snap });
          return;
        }
        // their Ghost couldn't download my pictures (ntfy.sh keeps files 3 h): upload fresh ones and send again
        case "needpics": {
          if (!f || f.state !== "connected" || now() - (f.picsAsked || 0) < 20 * 60e3) return;
          f.picsAsked = now();
          delete st.uploads.pic; delete st.uploads.banner;
          try { await sendProfile(f); } catch (e) { log("needpics: " + e.message); f.sentV = -1; }
          await save();
          return;
        }
        // you accepted an invite they had already cancelled
        case "declined": {
          if (!f || f.state !== "connecting" || !f.code || obj.p !== await proof(f.code, "declined", from)) return;
          const code = f.code;
          await dropFriend(from);
          if (st.joined[code]) st.joined[code].state = "cancelled";
          await save(); changed("friends", { id: from, snap: f.snap, removed: true });
          return;
        }
        // a shared item (a game...) from a connected friend (rules in onItem)
        case "item": {
          if (!f || f.state !== "connected") return;
          const ack = await onItem(f, from, me, obj);
          if (ack) { try { await send(f, { type: "itemack", key: ack.key, v: ack.v }); } catch (e) { log("item reply: " + e.message); } }
          return;
        }
        // several items in one message (a resend): answered with one "itemack" that lists them all
        case "items": {
          if (!f || f.state !== "connected" || !Array.isArray(obj.list)) return;
          const acks = [];
          for (const e of obj.list.slice(0, 20)) { const ack = e && typeof e === "object" ? await onItem(f, from, me, e) : null; if (ack) acks.push(ack); }
          if (acks.length === 1) { try { await send(f, { type: "itemack", key: acks[0].key, v: acks[0].v }); } catch (e) { log("item reply: " + e.message); } }
          else if (acks.length) { try { await send(f, { type: "itemack", acks }); } catch (e) { log("item reply: " + e.message); } }
          return;
        }
        case "itemack": {
          if (!f) return;
          let any = false;
          for (const a of Array.isArray(obj.acks) ? obj.acks.slice(0, 20) : [obj]) {
            const it = a && st.items && st.items[a.key];
            if (!it || it.with !== from || a.v !== it.v || it.acked === it.v) continue;
            it.acked = it.v; any = true;
          }
          if (any) await save();
          return;
        }
        case "bye": {
          if (!f) return;
          await dropFriend(from);
          for (const j of Object.values(st.joined)) if (j.id === from) j.state = "ended";
          st.shareWith = (st.shareWith || []).filter((x) => x !== from);
          await save(); changed("friends", { id: from, snap: f.snap, removed: true });
          return;
        }
      }
    }
    // a shared item (a game...) from a connected friend: the higher version wins; the same version with other data
    // goes to the Ghost with the larger id (both sides end up with the same copy). Always answered, so the sender
    // stops re-sending: returns {key, v} to confirm (we have theirs, or it was refused), or null when our own newer
    // copy was sent back instead.
    async function onItem(f, from, me, obj) {
      if (!ITEM_KEY_RE.test(obj.key || "") || !ITEM_KIND_RE.test(obj.kind || "") || !Number.isInteger(obj.v) || obj.v < 1 || obj.v > 1e6) return null;
      let js = ""; try { js = JSON.stringify(obj.data); } catch (e) { return null; }
      if (!js || js.length > ITEM_MAX || obj.key.split(":")[0] !== obj.kind) return null;
      if (!st.items) st.items = {};
      const cur = st.items[obj.key];
      if (cur && cur.with !== from) return null; // an id another friend's item already uses
      const take = !cur || obj.v > cur.v || (obj.v === cur.v && JSON.stringify(cur.data) !== js && from > me.id);
      // the app checks a new version against its rules (games replay the moves); refused = kept out, but confirmed
      // so their Ghost stops re-sending it. (A same-version clash is settled by id only: nothing to replay from.)
      if (take && (!cur || obj.v > cur.v) && deps.itemCheck) {
        let ok = false;
        try { ok = deps.itemCheck(obj.kind, cur ? { v: cur.v, data: cur.data } : null, { v: obj.v, data: JSON.parse(js) }) !== false; } catch (e) { ok = false; }
        if (!ok) { log("item refused " + obj.key.slice(0, 12) + " v" + obj.v); return { key: obj.key, v: obj.v }; }
      }
      if (take && !cur) itemRoom(from);
      if (take) {
        const prev = cur ? { v: cur.v, data: cur.data } : null;
        st.items[obj.key] = { key: obj.key, kind: obj.kind, with: from, v: obj.v, data: JSON.parse(js), at: now(), by: from, acked: obj.v, sentAt: now() };
        await save(); changed("item", { key: obj.key, kind: obj.kind, with: from, snap: f.snap, prev });
      }
      const mine = st.items[obj.key];
      if (mine.v > obj.v || (mine.v === obj.v && !take && JSON.stringify(mine.data) !== js)) {
        try { await send(f, itemMsg(mine)); mine.sentAt = now(); await save(); } catch (e) { if (tooBig(e)) mine.tooBig = mine.v; else log("item reply: " + e.message); }
        return null;
      }
      return { key: obj.key, v: mine.v };
    }
    async function onAccept({ from, obj, card }) {
      if (!card || typeof obj.p !== "string") return;
      let hit = null;
      for (const inv of Object.values(st.invites)) {
        if (now() - inv.created > (inv.used ? 3 * INVITE_TTL : INVITE_TTL)) continue;
        if (obj.p === await proof(inv.code, "accept", from)) { hit = inv; break; }
      }
      if (!hit) { log("accept without a live invite from " + from); return; }
      const welcome = async (fr) => send(fr, Object.assign({ type: "welcome", p: await proof(hit.code, "welcome", (await identity(false)).id) }, piInfo()));
      if (hit.cancelled) { // tell their Ghost, so it stops saying "Connecting…" (only if it's the person it was for)
        if (card.snap === hit.to && !hit.declined) {
          hit.declined = true; await save();
          try { await send({ id: from, x: card.x, inbox: await inboxOf(from) }, { type: "declined", p: await proof(hit.code, "declined", (await identity(false)).id) }); } catch (e) { log("declined: " + e.message); }
        }
        return;
      }
      if (hit.used) { // codes work once; the same Ghost asking again only means our welcome never reached it
        const again = hit.id === from && st.friends[from];
        if (again) { learnPi(again, obj); try { await welcome(again); again.sentV = -1; await sendAll(again); await save(); } catch (e) { log("welcome again: " + e.message); } }
        return;
      }
      if (card.snap !== hit.to) { hit.wrong = (hit.wrong || 0) + 1; await save(); log("invite " + hit.code + " accepted by the wrong person"); changed("invites", { code: hit.code }); return; }
      const cur = st.friends[from];
      if (cur && cur.state === "connected" && cur.snap === card.snap) {
        // already connected (you both sent invites): keep what you have, just answer
        hit.used = true; hit.id = from; learnPi(cur, obj); await save();
        try { await welcome(cur); } catch (e) { log("welcome (already connected): " + e.message); }
        return;
      }
      const old = friendBySnap(card.snap);
      if (old && old.id !== from) await dropFriend(old.id); // they reinstalled: new keys
      delete st.gone[from];
      st.friends[from] = { id: from, x: card.x, s: card.s, snap: card.snap, inbox: await inboxOf(from), state: "connected", since: now(), heard: now(), haveV: 0, sentV: -1, keyChanged: old && old.id !== from ? now() : 0 };
      learnPi(st.friends[from], obj);
      hit.used = true; hit.id = from;
      await save();
      changed("friends", { id: from, snap: card.snap, keyChanged: !!(old && old.id !== from) });
      const fr = st.friends[from];
      try { await welcome(fr); await sendAll(fr); await save(); }
      catch (e) { log("welcome: " + e.message); }
    }
    async function onProfile(f, obj) {
      if (typeof obj.v !== "number" || obj.v <= (f.haveV || 0)) return;
      const live = () => st.friends[f.id] === f; // (disconnected or left while a picture was downloading)
      if (obj.private) {
        f.profile = null; f.haveV = obj.v; f.picRefs = {};
        await Promise.all([deps.picDel(f.id + ":pic"), deps.picDel(f.id + ":banner")].map((p) => Promise.resolve(p).catch(() => {})));
        await save(); changed("profile", { id: f.id, snap: f.snap });
        return;
      }
      const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, " ").trim().slice(0, n);
      let complete = true;
      const pics = {};
      f.picRefs = f.picRefs || {};
      for (const kind of ["pic", "banner"]) {
        if (!obj[kind]) { pics[kind] = false; delete f.picRefs[kind]; await Promise.resolve(deps.picDel(f.id + ":" + kind)).catch(() => {}); continue; }
        // same upload as last time (only their name/bio changed): keep the copy we have
        if (f.profile && f.profile[kind] && obj[kind].u && f.picRefs[kind] === obj[kind].u) { pics[kind] = true; continue; }
        try {
          const blob = await fetchPic(obj[kind]);
          if (!live()) return;
          await deps.picPut(f.id + ":" + kind, blob); pics[kind] = true; f.picRefs[kind] = obj[kind].u;
          if (!live()) { await Promise.resolve(deps.picDel(f.id + ":" + kind)).catch(() => {}); return; }
        }
        catch (e) { complete = false; pics[kind] = !!(f.profile && f.profile[kind]); log(kind + " from " + f.id + ": " + e.message); }
      }
      if (!live()) return;
      f.profile = { name: clean(obj.name, LIMITS.name), bio: clean(obj.bio, LIMITS.bio), accent: ACCENTS.includes(obj.accent) ? obj.accent : "", pic: pics.pic, banner: pics.banner };
      if (complete) f.haveV = obj.v; // a picture that expired on ntfy.sh is asked for again at the next sync
      else if (f.cap >= 2 && now() - (f.needAsked || 0) > 30 * 60e3) { // ...and right away, from builds that understand it
        f.needAsked = now();
        try { await send(f, { type: "needpics" }); } catch (e) { log("needpics ask: " + e.message); }
      }
      await save(); changed("profile", { id: f.id, snap: f.snap });
    }

    // ---- public API ----
    const api = {
      parseInvite, inviteText, INVITE_TTL, LIMITS, ACCENTS,
      async init() { await state(); if (st.on) await identity(false); return api; },
      get ready() { return !!st; },
      isOn() { return !!(st && st.on); },
      myId() { return ident ? ident.id : null; },
      async myIdentity() { await state(); const me = await identity(true); return { id: me.id, inbox: me.inbox }; },
      friends() { return st ? Object.values(st.friends) : []; },
      friendBySnap(snap) { return st && snap ? friendBySnap(snap) : null; },
      connected(snap) { const f = api.friendBySnap(snap); return !!(f && f.state === "connected"); },
      // anything to check the inbox for: friends, or an invite still in play
      hasWork() {
        if (!st || !st.on) return false;
        if (Object.keys(st.friends).length || st.farewell || Object.values(st.gone).some((g) => !g.sent)) return true;
        return Object.values(st.invites).some((i) => !i.used && !i.cancelled && now() - i.created < INVITE_TTL);
      },
      profile() { return st ? Object.assign({}, st.profile) : blank().profile; },
      // ---- shared items (see ITEM_KEY_RE) ----
      items(kind) { return st ? Object.values(st.items || {}).filter((it) => !kind || it.kind === kind).map((it) => JSON.parse(JSON.stringify(it))) : []; },
      item(key) { const it = st && st.items && st.items[key]; return it ? JSON.parse(JSON.stringify(it)) : null; },
      newItemKey(kind) { return kind + ":" + b32(rand(10)).slice(0, 16).toLowerCase(); },
      // store a new version and send it; v must be higher than the stored one. Resolves once stored (sending may fail:
      // sync() re-sends until the friend confirms). Throws "item too big" when it couldn't go as one message (checked
      // by sealing it before anything is stored).
      async putItem({ key, kind, with: withId, v, data }) {
        await state();
        const f = st.friends[withId];
        if (!f || f.state !== "connected") throw new Error("not connected on Ghost");
        if (!ITEM_KEY_RE.test(key || "") || key.split(":")[0] !== kind || !ITEM_KIND_RE.test(kind || "")) throw new Error("bad item key");
        const js = JSON.stringify(data);
        if (!js || js.length > ITEM_MAX) throw new Error("item too big");
        if (!st.items) st.items = {};
        const cur = st.items[key];
        if (cur && cur.with !== withId) throw new Error("item belongs to another friend");
        if (!Number.isInteger(v) || v < 1 || (cur && v <= cur.v)) throw new Error("stale version");
        const me = await identity(false);
        const it = { key, kind, with: withId, v, data: JSON.parse(js), at: now(), by: me ? me.id : "", acked: 0, sentAt: 0 };
        let env = null;
        if (me) { try { env = await envelope(me, f, itemMsg(it)); } catch (e) { if (tooBig(e)) throw new Error("item too big"); log("item seal: " + e.message); } }
        if (!cur) itemRoom(withId);
        st.items[key] = it;
        await save(); changed("item", { key, kind, with: withId, snap: f.snap, local: true, prev: cur ? { v: cur.v, data: cur.data } : null });
        try { if (env) await post(env.topic, env.text); else await send(f, itemMsg(it)); it.sentAt = now(); await save(); } catch (e) { log("item send: " + e.message); }
        return JSON.parse(JSON.stringify(it));
      },
      async dropItem(key) { await state(); if (st.items && st.items[key]) { delete st.items[key]; await save(); } },
      // chat extras with a connected friend (by their Snapchat id): [{k, v, by, d}] incl. tombstones; mine() = my Ghost ID
      extras(snap) {
        const f = st && snap ? friendBySnap(snap) : null;
        if (!f || f.state !== "connected") return null;
        return { friendId: f.id, myId: ident ? ident.id : null, items: Object.values(xbox(f.id).items).map((i) => Object.assign({}, i)) };
      },
      async setExtra(snap, k, d) {
        await state();
        const f = friendBySnap(snap), me = await identity(false);
        if (!f || f.state !== "connected" || !me) throw new Error("Not connected on Ghost");
        const cur = xbox(f.id).items[k];
        const it = { k, v: Math.max(now(), cur ? cur.v + 1 : 0), by: me.id, d: d == null ? null : d };
        if (!xapply(f.id, it)) throw new Error("Couldn't change that");
        await save(); changed("extras", { id: f.id, snap: f.snap });
        try { await xsend(f, [it]); } catch (e) { log("extras send: " + e.message); } // (sync sends it again if this didn't get out)
        return it;
      },
      // a sticker picture: encrypted with a fresh key and uploaded (ntfy.sh keeps it 3 h; xneed re-uploads)
      async putPicture(blob) {
        if (!blob || blob.size > MAX_PIC) throw new Error("picture too big");
        const bytes = u8(await blob.arrayBuffer());
        const keyBytes = rand(32), iv = rand(12);
        const key = await subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
        const ct = u8(await subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
        return { u: await upload(ct), k: b64(keyBytes), i: b64(iv), t: /^image\/(png|webp|jpeg)$/.test(blob.type) ? blob.type : "image/png" };
      },
      async getPicture(ref) { return fetchPic(ref); },
      async askPicture(snap, k) {
        const f = st && friendBySnap(snap);
        if (!f || f.state !== "connected") return;
        f.xasked = f.xasked || {};
        if (now() - (f.xasked[k] || 0) < 20 * 60e3) return;
        f.xasked[k] = now();
        try { await send(f, { type: "xneed", k }); await save(); } catch (e) { log("xneed ask: " + e.message); }
      },
      share() { return { mode: st.share, with: (st.shareWith || []).slice() }; },
      inviteFor(convId) { // the newest live invite you sent in this chat
        if (!st) return null;
        return Object.values(st.invites).filter((i) => i.conv === convId && !i.used && !i.cancelled && now() - i.created < INVITE_TTL).sort((a, b) => b.created - a.created)[0] || null;
      },
      // what a "ghost:connect" message should show. fromMe: your own invite. sender: the Snapchat id who sent it.
      inviteState(code, fromMe, sender, ts) {
        if (!st) return "off";
        if (!st.on) return "off";
        if (fromMe) {
          const inv = st.invites[code];
          if (!inv) return "unknown"; // sent from another device / an older install
          if (inv.cancelled) return "cancelled";
          if (inv.used) return st.friends[inv.id] && st.friends[inv.id].state === "connected" ? "connected" : "ended";
          return now() - inv.created > INVITE_TTL ? "expired" : "waiting";
        }
        const j = st.joined[code];
        if (j && j.state === "ended") return "ended"; // you were connected through this invite, then disconnected
        if (j && j.state === "cancelled") return "cancelled"; // they cancelled it before your Ghost reached theirs
        if (j && j.state === "connected" && st.friends[j.id]) return "connected";
        const known = friendBySnap(sender);
        if (known && known.state === "connected" && (!j || j.id === known.id)) return "connected";
        if (j && j.state === "connecting" && st.friends[j.id]) return now() - (ts || j.at) > INVITE_TTL ? "failed" : "connecting";
        if (now() - (ts || 0) > INVITE_TTL) return "expired";
        return "connect";
      },
      // a friend's Ghost came back with new keys (reinstall, or a new phone): shown until you've seen it
      async ackKeyChange(id) { await state(); if (st.friends[id]) { st.friends[id].keyChanged = 0; await save(); } },
      async setOn(on) {
        await state(); st.on = !!on; await save();
        if (on) await identity(false);
        changed("on", { on: st.on });
      },
      // Chat options > Connect on Ghost: returns the visible text to send in that chat
      async createInvite(convId, toSnap) {
        await state();
        if (!st.on) throw new Error("Ghost Network is off");
        if (!toSnap) throw new Error("only 1:1 chats");
        if (!(deps.me() && deps.me().id)) throw new Error("not signed in yet");
        const me = await identity(true);
        const code = newCode();
        const card = await makeCard(me, deps.me() && deps.me().id, now());
        const key = await rvKey(code), iv = rand(12);
        const ct = u8(await subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(card))));
        await post(await rvTopic(code), JSON.stringify({ g: 1, rv: 1, i: b64(iv), c: b64(ct) }));
        st.invites[code] = { code, conv: convId, to: toSnap, created: now(), posted: now(), used: false };
        await save(); changed("invites", { code });
        return inviteText(code);
      },
      // the Connect button on a friend's invite
      async accept(code, sender, convId) {
        await state();
        if (!st.on) throw new Error("Turn on Ghost Network in Settings > Privacy first");
        const me = await identity(true);
        const key = await rvKey(code);
        let card = null;
        const ids = new Set();
        for (const m of await poll(await rvTopic(code), "all")) {
          try {
            const o = JSON.parse(m.message);
            if (!o || o.rv !== 1) continue;
            const c = await readCard(JSON.parse(td.decode(await subtle.decrypt({ name: "AES-GCM", iv: unb64(o.i) }, key, unb64(o.c)))));
            if (c.snap !== sender) { log("rendezvous card isn't from the sender"); continue; }
            ids.add(c.id); card = card || c; // (the inviter reposts its card every 10 h: same Ghost, same id)
          } catch (e) {}
        }
        // two different Ghosts both claiming to be the sender: someone else has the code. Don't guess.
        if (ids.size > 1) { log("invite " + code + ": " + ids.size + " different Ghosts answered"); throw new Error("Two different Ghosts answered this invite, so it isn't safe. Ask them to send a new one."); }
        if (!card) throw new Error("Couldn't find their Ghost. Ask them to open Ghost, or to send a new invite.");
        if (card.id === me.id) throw new Error("That's your own invite");
        const old = friendBySnap(card.snap);
        if (old && old.id !== card.id) await dropFriend(old.id);
        const f = st.friends[card.id] && st.friends[card.id].state === "connected" ? st.friends[card.id]
          : { id: card.id, x: card.x, s: card.s, snap: card.snap, inbox: await inboxOf(card.id), state: "connecting", code, since: now(), haveV: 0, sentV: -1, keyChanged: old && old.id !== card.id ? now() : 0 };
        st.friends[card.id] = f;
        st.joined[code] = { id: card.id, state: f.state, at: now(), conv: convId };
        const myCard = await makeCard(me, deps.me() && deps.me().id, now());
        await send(f, Object.assign({ type: "accept", p: await proof(code, "accept", me.id), card: myCard }, piInfo()));
        await save(); changed("friends", { id: card.id, snap: card.snap });
        return f.state;
      },
      // one round: read the inbox, repost rendezvous cards about to expire, resend accepts that are still waiting.
      // full (launch, back to the front): the public inbox too, which otherwise is read only while something can
      // arrive there (see needPublic) or every PUB_EVERY - each read is a request against ntfy.sh's per-IP limit.
      // "pi": the private inbox only (the game view waiting for a friend's move: games only run between Ghosts that
      // have private inboxes)
      async poll(full) {
        await state();
        if (!st.on || leaving) return 0;
        if (busy) { if (full && full !== "pi") pubAt = 0; return busy; } // (a full round asked for meanwhile: the next one reads both)
        busy = serial(async () => {
          await farewells();
          const me = await identity(false);
          if (!me) return 0;
          let n = 0;
          // the private inbox (connected friends on build 81+) and the public one (invites, older builds); not the ones
          // the stream (1.19.0) is reading right now
          const covered = (t) => !!(deps.streamCovers && deps.streamCovers(t));
          if (covered(me.inbox)) pubAt = now();
          const topics = (full === "pi" ? [st.pi] : full || needPublic() ? [st.pi, me.inbox] : [st.pi]).filter((t) => !covered(t));
          for (const topic of topics) {
            let msgs = [];
            const meta = {};
            try { msgs = await poll(topic, st.since[topic], meta); } catch (e) { if (topic === me.inbox) throw e; log("poll pi: " + e.message); continue; }
            if (topic === me.inbox) pubAt = now();
            for (const m of msgs.slice(0, 300)) {
              if (leaving) return n;
              st.since[topic] = m.id; n++;
              try { await handle(m, topic === st.pi); } catch (e) { log("handle: " + e.message); }
              if (deps.streamSeen) { try { deps.streamSeen(m.id); } catch (e) {} } // (the stream drops it if it comes again)
            }
            // read completely and handled: the stream may take this topic over from here
            if (msgs.length <= 300 && deps.readAt) { try { deps.readAt(topic, meta.date); } catch (e) {} }
          }
          for (const inv of Object.values(st.invites)) {
            if (inv.used || inv.cancelled || now() - inv.created > INVITE_TTL) { if (now() - inv.created > 3 * INVITE_TTL) delete st.invites[inv.code]; continue; }
            if (now() - (inv.posted || 0) > RV_REPOST) {
              try {
                const card = await makeCard(me, deps.me() && deps.me().id, now());
                const key = await rvKey(inv.code), iv = rand(12);
                const ct = u8(await subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(card))));
                await post(await rvTopic(inv.code), JSON.stringify({ g: 1, rv: 1, i: b64(iv), c: b64(ct) }));
                inv.posted = now();
              } catch (e) { log("repost invite: " + e.message); }
            }
          }
          await save();
          return n;
        }).finally(() => { busy = null; });
        return busy;
      },
      // the topics this wants on the stream: my two inboxes, while there's anything to read them for
      streamTopics() { return st && st.on && !leaving && ident && api.hasWork() ? [st.pi, ident.inbox] : []; },
      // one message from the stream (a topic of streamTopics): handled like a poll's, the poll cursor moves on to it
      take(m) {
        takes++;
        return serial(async () => {
          try {
            if (!st || !st.on || leaving || !m || typeof m.id !== "string" || m.event !== "message") return 0;
            const me = await identity(false);
            if (!me || (m.topic !== st.pi && m.topic !== me.inbox)) return 0;
            const viaPi = m.topic === st.pi;
            if (!viaPi) pubAt = now();
            st.since[m.topic] = m.id; takeDirty = true;
            try { await handle(m, viaPi); } catch (e) { log("handle: " + e.message); }
            return 1;
          } finally { if (--takes === 0 && takeDirty && st) { takeDirty = false; await save(); } } // (saved once after a burst, like a poll's round)
        });
      },
      // on launch: tell each friend which profile version we have, so missing profiles/pictures are resent
      async sync(force) {
        await state();
        if (!st.on || !(await identity(false))) return;
        for (const f of Object.values(st.friends)) {
          try {
            if (f.state === "connecting") {
              const j = Object.entries(st.joined).find(([, x]) => x.id === f.id && x.state === "connecting");
              if (j && f.code && now() - j[1].at < INVITE_TTL && now() - (f.lastSync || 0) > SYNC_FORCED) {
                const me = await identity(false);
                await send(f, Object.assign({ type: "accept", p: await proof(f.code, "accept", me.id), card: await makeCard(me, deps.me() && deps.me().id, now()) }, piInfo()));
                f.lastSync = now();
              }
              continue;
            }
            // a profile or status that didn't get out earlier (network down, a picture upload failed)
            if (f.sentV !== st.profile.v && now() - (f.retryAt || 0) > 10 * 60e3) { f.retryAt = now(); try { await sendProfile(f); } catch (e) { log("profile retry " + f.id + ": " + e.message); } }
            if (st.status.v && f.sentSV !== st.status.v && f.cap >= 2) { try { await sendStatus(f); } catch (e) { log("status retry: " + e.message); } }
            if (st.rx.v && f.sentRV !== st.rx.v && f.cap >= 2) { try { await sendRx(f); } catch (e) { log("rx retry: " + e.message); } }
            // shared items the friend hasn't confirmed yet (a move they may have missed while offline for days)
            // (all in one message per friend; a friend not heard from for an hour only gets them with the hourly sync)
            const quiet = now() - (f.heard || f.since || 0) > SYNC_FORCED;
            const gap = quiet ? SYNC_FORCED : force ? 60e3 : ITEM_RESEND;
            const owed = Object.values(st.items || {}).filter((it) => it.with === f.id && it.acked !== it.v && it.tooBig !== it.v && now() - (it.sentAt || 0) >= gap);
            if (owed.length) await sendItems(f, owed);
            if (now() - (f.lastSync || 0) < (force ? SYNC_FORCED : SYNC_EVERY)) continue;
            await send(f, Object.assign({ type: "sync", have: f.haveV || 0, mine: st.profile.v, shave: f.statusV || 0, sv: st.status.v }, piInfo(), xsyncInfo(f), rxInfo(f)));
            f.lastSync = now();
          } catch (e) { log("sync " + f.id + ": " + e.message); }
        }
        // goodbyes that didn't get through; forget disconnected friends after a week
        for (const g of Object.values(st.gone)) {
          if (now() - g.at > GONE_KEEP) { delete st.gone[g.id]; continue; }
          if (!g.sent && now() - (g.lastBye || 0) > SYNC_FORCED) await sayBye(g);
        }
        await save();
      },
      // My Ghost Profile. pic/banner: a Blob to set, null to remove, undefined to keep.
      async setProfile(patch) {
        await state();
        await identity(true);
        const p = st.profile;
        if (patch.name !== undefined) p.name = String(patch.name || "").trim().slice(0, LIMITS.name);
        if (patch.bio !== undefined) p.bio = String(patch.bio || "").trim().slice(0, LIMITS.bio);
        if (patch.accent !== undefined) p.accent = ACCENTS.includes(patch.accent) ? patch.accent : "";
        for (const kind of ["pic", "banner"]) {
          if (patch[kind] === undefined) continue;
          if (patch[kind]) { await deps.picPut("me:" + kind, patch[kind]); p[kind] = true; }
          else { await Promise.resolve(deps.picDel("me:" + kind)).catch(() => {}); p[kind] = false; }
          delete st.uploads[kind];
        }
        p.v = (p.v || 0) + 1;
        await save(); changed("me", {});
        await pushProfileToAll();
      },
      async setShare(mode, list) {
        await state();
        st.share = mode === "chosen" ? "chosen" : "all";
        if (Array.isArray(list)) st.shareWith = list.filter((id) => st.friends[id]);
        st.profile.v = (st.profile.v || 0) + 1; // everyone re-checks what they may see
        st.status.v = (st.status.v || 0) + 1;
        await save(); changed("me", {});
        await pushProfileToAll();
        await pushStatusToAll();
      },
      // the status line: text ("" clears it) and when it clears itself (0 = never)
      status() { const s = st ? st.status : null; return s && s.text && (!s.until || s.until > now()) ? { text: s.text, until: s.until || 0 } : null; },
      async setStatus(text, until) {
        await state();
        await identity(true);
        text = String(text || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, LIMITS.status);
        st.status = { v: (st.status.v || 0) + 1, text, until: text ? Math.max(0, Number(until) || 0) : 0 };
        await save(); changed("me", {});
        await pushStatusToAll();
      },
      // a connected friend's status, while it lasts
      friendStatus(id) { const f = st && st.friends[id]; return f && f.status && f.status.text && (!f.status.until || f.status.until > now()) ? f.status : null; },
      // ---- bug reports / feature requests (ui.js section "Feedback") ----
      // my report inbox for connected friends ({t, k, n} from my paired PC relay, null = none); same one again = no-op
      async setReportInbox(d) {
        await state();
        const clean = d ? rxValid(d) : null;
        if (d && !clean) throw new Error("bad report inbox");
        if (JSON.stringify(clean) === JSON.stringify(st.rx.inbox)) return false;
        if (!st.rx.v && !clean) return false; // never had one: nothing to take back
        st.rx = { v: Math.max(now(), (st.rx.v || 0) + 1), inbox: clean };
        await save();
        await pushRxToAll();
        return true;
      },
      myReportInbox() { return st && st.rx && st.rx.inbox ? Object.assign({}, st.rx.inbox) : null; },
      // where I can send a report: connected friends whose relay takes them
      reportInboxes() {
        if (!st) return [];
        return Object.values(st.friends).filter((f) => f.state === "connected" && f.rx && rxValid(f.rx))
          .map((f) => ({ friendId: f.id, snap: f.snap, name: (f.profile && f.profile.name) || "", t: f.rx.t, k: Object.assign({}, f.rx.k), n: f.rx.n || "" }));
      },
      // seal a report (r = the report JSON string, imgs = Uint8Arrays) for a relay's inbox: the file to upload. It
      // must fit ntfy.sh's file limit (ui.js shrinks the pictures until it does)
      async sealReport(inbox, r, imgs) {
        await state();
        const me = await identity(false);
        if (!me) throw new Error("no Ghost identity");
        const d = rxValid(inbox);
        if (!d) throw new Error("bad report inbox");
        if (typeof r !== "string") throw new Error("bad report");
        return sealReport(me, d, r, imgs || []);
      },
      reportFileMax: Math.min(REPORT_MAX, NTFY_FILE_MAX),
      // upload a sealed report (kept by ui.js until it goes through: a 429 / busy / network error is worth retrying)
      async uploadReport(inbox, blob) {
        const d = rxValid(inbox);
        if (!d) throw new Error("bad report inbox");
        if (blob.length > Math.min(REPORT_MAX, NTFY_FILE_MAX)) throw new Error("report too big");
        const res = JSON.parse(td.decode(await net({ url: NTFY + "/" + d.t, method: "PUT", body: b64(blob), headers: { Filename: "report.bin", Firebase: "no" } })));
        if (!res || !res.attachment || typeof res.attachment.url !== "string") throw new Error("upload failed");
        return { id: String(res.id || ""), bytes: blob.length };
      },
      async sendReport(inbox, r, imgs) { return api.uploadReport(inbox, await api.sealReport(inbox, r, imgs)); },
      // ---- Link desktop (#250, see "Link desktop" above): Settings > Privacy > Link Ghost Desktop ----
      // 1. linkCheck(what the owner typed): the PC's beacon must be on the code's topic, alone, under 5 minutes old by
      //    ntfy.sh's clock, with no file answering it yet. Resolves to a ticket for linkSend ({expiresIn, ghostId: the
      //    WHOLE Ghost ID in 7 groups, link.showId}: the secrets stay in here; only the newest ticket can send); throws
      //    an Error whose message can be shown as it is and whose .link says why (code, off, nopc, oldpc, newpc, used,
      //    twice, expired, time, busy, offline, keys).
      // 2. (ui.js asks "only link your own PC" and shows ghostId, which the PC shows too: all of it must match)
      // 3. linkSend(ticket, {stream, app}): looks at the topic again (anything else answered = an alarm for the PC and
      //    "raced"), then the key file + network state + pictures, sealed for that PC, ONE upload. Resolves to {id,
      //    ghostId, bytes, pics, missing}; throws like linkCheck (also raced, big, keys, sent: a ticket can't be used
      //    twice; keys also when the Ghost ID isn't the one the ticket showed).
      async linkCheck(text) {
        if (linkBusy) throw linkErr("busy", "Ghost is still working on the last code. Try again in a moment.");
        linkBusy = true;
        try { return await linkCheckNow(text); } finally { linkBusy = false; }
      },
      async linkSend(ticket, extra) {
        const t = linkTickets.get(ticket);
        if (!t) throw linkErr("sent", "That code was used already. On your PC, start Link with Phone again for a new code.");
        if (linkBusy) throw linkErr("busy", "Ghost is still working on the last code. Try again in a moment."); // (the ticket stays usable)
        linkTickets.delete(ticket); if (linkLive === ticket) linkLive = null; // (one upload per check, whatever happens next)
        linkBusy = true;
        try { return await linkSendNow(t, extra); } finally { linkBusy = false; t.sec.secret.fill(0); }
      },
      linkDrop(ticket) { const t = linkTickets.get(ticket); if (t) { linkTickets.delete(ticket); t.sec.secret.fill(0); } if (linkLive === ticket) linkLive = null; }, // (not sent after all)
      linkedAt() { return (st && st.linkedAt) || 0; },
      // ms until ntfy.sh may be asked again after a 429 (0 = now)
      busyFor() { return Math.max(0, slowUntil - now()); },
      // invites you sent that are still waiting
      pendingInvites() {
        if (!st) return [];
        return Object.values(st.invites).filter((i) => !i.used && !i.cancelled && now() - i.created < INVITE_TTL)
          .sort((a, b) => b.created - a.created).map((i) => ({ code: i.code, conv: i.conv, to: i.to, created: i.created, expires: i.created + INVITE_TTL }));
      },
      // the invite message never made it into the chat: forget it (no "Invite sent · waiting" for 24 h)
      async forgetInvite(code) { await state(); if (st.invites[code] && !st.invites[code].used) { delete st.invites[code]; await save(); changed("invites", { code }); } },
      async cancelInvite(code) {
        await state();
        const inv = st.invites[code];
        if (!inv || inv.used) return false;
        inv.cancelled = true;
        await save(); changed("invites", { code });
        return true;
      },
      // the safety code for a connected friend: the same 12 digits on both phones as long as both keys are the ones
      // you connected with (compare in person or on a call)
      async safetyCode(id) {
        await state();
        const f = st.friends[id], me = await identity(false);
        if (!f || !me) return null;
        const [a, b] = [me.id, f.id].sort();
        const h = await sha256("ghost-safety-v1|" + a + "|" + b);
        let n = 0n; for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(h[i]);
        const digits = String(n % 1000000000000n).padStart(12, "0");
        return digits.slice(0, 4) + " " + digits.slice(4, 8) + " " + digits.slice(8);
      },
      async setVerified(id, on) { await state(); const f = st.friends[id]; if (!f) return; f.verified = on ? now() : 0; await save(); changed("profile", { id, snap: f.snap }); },
      async disconnect(id) {
        await state();
        const f = st.friends[id];
        if (!f) return;
        tombstone(f, false);
        await sayBye(st.gone[id]);
        await dropFriend(id);
        for (const j of Object.values(st.joined)) if (j.id === id) j.state = "ended";
        st.shareWith = (st.shareWith || []).filter((x) => x !== id);
        await save(); changed("friends", { id, snap: f.snap, removed: true });
      },
      // Leave Ghost Network: tell every connected Ghost, then delete the keys and everything received
      // (a "bye" that fails is retried for 3 days with the old keys, kept only for that)
      async leave() {
        await state();
        leaving = true;
        try {
          if (busy) await busy.catch(() => {});
          await lock; // (a message from the stream still being handled)
          const keyText = await Promise.resolve(deps.keysGet()).catch(() => null);
          let parked = false; // the old keys stay only in the Keychain's "farewell" slot, only while byes are owed
          const unsent = [];
          const all = Object.values(st.friends).concat(Object.values(st.gone).filter((g) => !g.sent));
          for (const f of all) {
            let ok = false;
            try { await send(f, { type: "bye" }); ok = true; } catch (e) { log("bye: " + e.message); }
            if (!ok) unsent.push({ id: f.id, x: f.x, inbox: f.inbox, pi: f.pi, cap: f.cap });
            if (st.friends[f.id]) await dropFriend(f.id);
          }
          await Promise.all([deps.picDel("me:pic"), deps.picDel("me:banner")].map((p) => Promise.resolve(p).catch(() => {})));
          if (unsent.length && keyText && deps.farewellKeys) { try { await deps.farewellKeys.set(keyText); parked = true; } catch (e) { log("farewell keys: " + e.message); } }
          try { await deps.keysDelete(); } catch (e) {}
          ident = null;
          const on = st.on, joined = st.joined;
          st = blank(); st.on = on;
          st.pi = "gh-pi-" + b32(rand(17)).slice(0, 26);
          // invites you accepted stay "ended" (they can't work any more: the other Ghost knew your old keys)
          for (const [code, j] of Object.entries(joined || {})) st.joined[code] = Object.assign({}, j, { state: "ended" });
          if (unsent.length && parked) st.farewell = { to: unsent, until: now() + 3 * 24 * 3600e3 };
          await save(); changed("left", {});
        } finally { leaving = false; }
      },
    };
    return api;
  }

  const link = { start: linkStart, codeOf: linkCodeOf, newCode: newLinkCode, showId: linkShowId, TTL: LINK_TTL, LEN: LINK_LEN, V: LINK_V };
  return { create, createStream, parseInvite, inviteText, link, _test: { seal, unseal, seal2, unseal2, loadIdentity, newKeyFile, makeCard, readCard, proof, newCode, rvTopic, b32, sealReport, rxValid,
    linkSecrets, sealLinkBeacon, openLinkBeacon, sealLinkAlarm, openLinkAlarm, sealLinkFile, openLinkFile, linkBeaconVersion, linkFileVersion, linkKeysMatch, LINK_TOPIC_RE } };
})();
if (typeof module !== "undefined" && module.exports) module.exports = GhostNetCore;
