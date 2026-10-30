// Skip Snapchat Web's context/upsell badge when it composites a webcam snap.
// This exact asset is used by the DWEB_SNAP_SENDING_CONTEXT capture path.
// Match narrowly: unknown assets and all other canvas draws stay untouched.
(() => {
  const proto = CanvasRenderingContext2D.prototype;
  const original = proto.drawImage;
  const marker = Symbol.for("dark-glass.snap-clean");
  if (original[marker]) return;

  function drawImage(image, ...args) {
    if (image instanceof HTMLImageElement) {
      try {
        const url = new URL(image.currentSrc || image.src);
        if (url.origin === "https://cf-st.sc-cdn.net"
            && url.pathname === "/dw/0719fccbc89e0b18044d.png") return;
      } catch { /* Let the native method handle invalid image arguments. */ }
    }
    return Reflect.apply(original, this, [image, ...args]);
  }
  Object.defineProperty(drawImage, marker, { value: true });
  Object.defineProperty(proto, "drawImage", {
    ...Object.getOwnPropertyDescriptor(proto, "drawImage"),
    value: drawImage,
  });
})();

// Drop the "Snapchat Web" link Snapchat attaches to a sent snap when DWEB_SNAP_SENDING_CONTEXT is on.
//
// In the bundle, sending a snap builds an attachments array (`he()` in the current build): when that one
// remote flag is on, it always pushes a "webPage" attachment pointing at
// snapchat.com/web/mobile-landing.html?ref=web_snap_context, and on photo snaps also pushes a "context"
// attachment with a tappable sticker over the same URL, positioned near the top of the image. That pair is
// what the recipient sees as a "Snapchat Web" link/card on the snap - metadata attached to the send, not a
// pixel on the photo (that part is the badge snap-clean already strips above). The internal function/variable
// names are minified and change every build, but the URL and the {attachment:{$case,...}} shape are the
// stable part, so this hooks Array.prototype.push (same spirit as the drawImage hook above: a narrow,
// literal-matched predicate, not a rename-fragile call into the bundle) and drops only array items that
// carry that URL under an "attachment" key. When the flag is off (the common case) this never matches
// anything and push behaves exactly as before.
(() => {
  const original = Array.prototype.push;
  const marker = Symbol.for("dark-glass.snap-clean.push");
  if (original[marker]) return;

  const MARKER_STRING = "ref=web_snap_context";

  function hasMarker(value, depth, seen) {
    if (depth > 16 || value == null) return false;
    if (typeof value === "string") return value.includes(MARKER_STRING);
    if (typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some((v) => hasMarker(v, depth + 1, seen));
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key) && hasMarker(value[key], depth + 1, seen)) return true;
    }
    return false;
  }

  // cheap check first (most pushed values have no "attachment" key at all); only walks the object when
  // that's present, so this stays negligible on the hot path of a 9MB app's normal Array.prototype.push use.
  function isWebSnapAttachment(item) {
    return !!(item && typeof item === "object" && "attachment" in item && hasMarker(item.attachment, 0, new Set()));
  }

  // The iPhone app copies this attribute into its trail.txt, so a device log shows whether the link was
  // really dropped (the recipient still saw a link on 2026-09-21 and nothing told us if this hook had fired).
  let dropped = 0;
  function noteDrop(item) {
    try {
      document.documentElement.setAttribute("data-dg-snapclean",
        "dropped " + (++dropped) + " (" + (item.attachment && item.attachment.$case) + ") at " + Math.round(performance.now()));
    } catch { /* logging only */ }
  }

  // push runs constantly: the common single-item call goes straight through without allocating.
  function push(item) {
    if (arguments.length === 1) {
      if (!isWebSnapAttachment(item)) return original.call(this, item);
      noteDrop(item);
      return this.length;
    }
    const kept = [];
    for (let i = 0; i < arguments.length; i++) if (!isWebSnapAttachment(arguments[i])) kept.push(arguments[i]);
    return Reflect.apply(original, this, kept);
  }
  Object.defineProperty(push, marker, { value: true });
  Object.defineProperty(Array.prototype, "push", {
    ...Object.getOwnPropertyDescriptor(Array.prototype, "push"),
    value: push,
  });
})();

// No "from Web" under the sender's name and no "Try Snapchat for Web" button in the chat.
//
// Every snap Snapchat Web sends carries `provenance: { sourceSystem: SourceSystem.SNAPCHAT_WEB_APP }` (7); the
// phone apps draw both of those from it (recipient screenshots 2026-09-21: still there with the link
// attachments already stripped above). The enum is built the usual TypeScript way,
// `e[e.SNAPCHAT_WEB_APP = 7] = "SNAPCHAT_WEB_APP"`, on a fresh plain object - so, like the isWeb hook in
// presence.js, one setter on Object.prototype catches that single assignment and stores UNSET (0) instead.
// Protobuf leaves a 0 enum out of the message, i.e. the snap goes out with no source system at all. The name
// lookup (e[7]) is untouched, and that enum member is used nowhere but the snap send.
(() => {
  if (Object.getOwnPropertyDescriptor(Object.prototype, "SNAPCHAT_WEB_APP")) return;
  Object.defineProperty(Object.prototype, "SNAPCHAT_WEB_APP", {
    configurable: true,
    enumerable: false,
    get() { return undefined; },
    set(v) {
      Object.defineProperty(this, "SNAPCHAT_WEB_APP", { value: v === 7 ? 0 : v, writable: true, enumerable: true, configurable: true });
      try { if (v === 7) document.documentElement.setAttribute("data-dg-snapclean", "source system unset at " + Math.round(performance.now())); } catch { /* logging only */ }
    },
  });
})();
