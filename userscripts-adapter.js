// Private compatibility layer inside the content-world userscript closure.
// No chrome object or privileged API is exposed to Snapchat's page scripts.
const chrome = {
  storage: { local: {
    async get(key) { return { [key]: await GM.getValue(key) }; },
    async set(values) {
      for (const [key, value] of Object.entries(values)) await GM.setValue(key, value);
    },
  } },
  runtime: {
    lastError: undefined,
    onMessage: { addListener(handler) { this.handler = handler; } },
    sendMessage(message, reply) {
      try {
        const pending = this.onMessage.handler(message, {}, reply);
        if (!pending) reply({});
      } catch (error) { reply({ error: String(error.message || error) }); }
    },
  },
};

// Only the bundled Giphy backend calls this function. It cannot fetch arbitrary hosts.
async function fetch(url) {
  const target = new URL(url);
  if (target.protocol !== "https:" || !["media.giphy.com", "api.giphy.com"].includes(target.hostname))
    throw new Error("Unsupported GIF host");
  const response = await GM.xmlHttpRequest({
    method: "GET", url: target.href, responseType: "arraybuffer", timeout: 20000,
  });
  const headers = new Map((response.responseHeaders || "").split(/\r?\n/)
    .filter(line => line.includes(":"))
    .map(line => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]));
  const bytes = response.response;
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    headers: { get: name => headers.get(name.toLowerCase()) || null },
    arrayBuffer: async () => bytes,
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
  };
}
