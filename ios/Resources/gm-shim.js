// GM.* for ui.js inside the app: the same calls Userscripts provides in Safari, answered by the app's "dg"
// message handler (App.swift). Only exists in the app's private content world, never in Snapchat's page.
const GM = (() => {
  const call = (msg) => window.webkit.messageHandlers.dg.postMessage(msg);
  return {
    async getValue(key, fallback) {
      const v = await call({ op: "get", key });
      return v == null ? fallback : JSON.parse(v);
    },
    async setValue(key, value) {
      await call({ op: "set", key, value: JSON.stringify(value) });
    },
    async xmlHttpRequest({ url }) {
      const r = await call({ op: "fetch", url });
      const bin = atob(r.body);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { status: r.status, responseHeaders: "content-type: " + r.type, response: bytes.buffer };
    },
  };
})();
