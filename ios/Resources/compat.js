// App only, page world, before Snapchat's bundle: fill in what Safari has and WKWebView lacks.
(() => {
  // Snapchat treats "MacIntel" as a desktop browser (the user agent already says Mac).
  if (navigator.platform !== "MacIntel")
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel", configurable: true });

  // Snapchat Web switches video Snaps (hold to record) off for Safari by name. With "Chrome mode" on (the
  // default; three-finger tap to switch it), scripts on the page read a Chrome-on-Mac user agent instead.
  // Requests to Snapchat's servers still carry the web view's real Safari user agent.
  if (window.__dgChromeUA) {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
    Object.defineProperty(Navigator.prototype, "userAgent", { get: () => ua, configurable: true });
    Object.defineProperty(Navigator.prototype, "appVersion", { get: () => ua.slice(8), configurable: true });
    Object.defineProperty(Navigator.prototype, "vendor", { get: () => "Google Inc.", configurable: true });
  }

  // WKWebView has no Notification API, and Snapchat reads Notification.permission without checking,
  // which crashes the app after login. A stand-in that is always "denied" (no web notifications in an app).
  if (!("Notification" in window)) {
    class Notification extends EventTarget {
      constructor(title, options = {}) { super(); this.title = title; this.body = options.body || ""; }
      close() {}
      static get permission() { return "denied"; }
      static requestPermission(callback) {
        if (typeof callback === "function") callback("denied");
        return Promise.resolve("denied");
      }
    }
    Object.defineProperty(window, "Notification", { value: Notification, writable: true, configurable: true });
  }

  // WKWebView has no service workers either (outside App-Bound Domains). Snapchat's app shell calls
  // navigator.serviceWorker.addEventListener("message", ...) unguarded, which throws into its top-level
  // error boundary ("Oops! Something went wrong"). A stand-in with no registrations: feature checks still
  // see no push support (PushManager is missing), registering fails, and `ready` never resolves, as in a
  // browser where no worker is installed.
  if (!("serviceWorker" in navigator)) {
    const container = new EventTarget();
    Object.assign(container, {
      controller: null,
      ready: new Promise(() => {}),
      oncontrollerchange: null,
      onmessage: null,
      onmessageerror: null,
      register: () => Promise.reject(new DOMException("Service workers are not available", "SecurityError")),
      getRegistration: () => Promise.resolve(undefined),
      getRegistrations: () => Promise.resolve([]),
      startMessages() {},
    });
    Object.defineProperty(Navigator.prototype, "serviceWorker", { get: () => container, configurable: true });
  }

  // In an app the page only counts as "focused" after the web view itself was tapped, so starting stories
  // from the app's own Stories button made Snapchat's away detection say "You are no longer viewing".
  // The app is one full-screen page: focused whenever it is visible.
  if (window.top === window) {
    Document.prototype.hasFocus = function () { return document.visibilityState === "visible"; };
    addEventListener("blur", (e) => {
      if (e.target === window && document.visibilityState === "visible") e.stopImmediatePropagation();
    }, true);
  }

  // Videos play in place (story videos opened iOS's full-screen player): iPhone only plays inline when the
  // <video> says playsinline, which Snapchat Web (a desktop site) never sets.
  if (window.top === window) {
    const inline = (v) => { v.playsInline = true; v.setAttribute("playsinline", ""); v.setAttribute("webkit-playsinline", ""); };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { if (this.tagName === "VIDEO") inline(this); return play.apply(this, arguments); };
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === "VIDEO") inline(n);
        else if (n.querySelectorAll) n.querySelectorAll("video").forEach(inline);
      }
    }).observe(document, { childList: true, subtree: true });
  }

  // Last errors, shown by the three-finger diagnostics (there is no Web Inspector without a Mac).
  const errors = (window.__dgErrors = []);
  const note = (text) => { errors.push(String(text).slice(0, 300)); if (errors.length > 6) errors.shift(); };
  addEventListener("error", (e) => note(`${e.message} @ ${(e.filename || "").split("/").pop()}:${e.lineno}`));
  addEventListener("unhandledrejection", (e) => note("rejection: " + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
  const consoleError = console.error;
  console.error = function (...args) {
    try { note("console: " + args.map((a) => (a && a.stack) || (a && a.message) || String(a)).join(" ")); } catch {}
    return consoleError.apply(this, args);
  };
})();
