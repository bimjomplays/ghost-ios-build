// App only, page world, before Snapchat's bundle: video recording. Snapchat Web records by reading raw
// frames off the camera track with MediaStreamTrackProcessor and encoding them itself (VideoEncoder /
// AudioEncoder). WebKit has the encoders but no MediaStreamTrackProcessor on pages, so Snapchat switched
// hold-to-record off. This is that one missing piece: video frames are grabbed from a <video> playing the
// track, audio through a Web Audio tap.
(() => {
  if (window.top !== window) return;
  if (window.MediaStreamTrackProcessor || typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return;

  // what happened during a recording, left on <html data-dg-rec> (bridge.js copies it into trail.txt)
  const stats = {}, last = {};
  const publish = (why) => { stats.at = why; document.documentElement.setAttribute("data-dg-rec", JSON.stringify(stats)); };
  // Snapchat swallows whatever goes wrong while it writes the MP4 (it only shows "Failed to record video",
  // and its own catch(e) never reads e at all - see stopRecording in the bundle): for a few seconds after the
  // encoders are flushed, note the real name + message + stack of every Error that gets created, so the next
  // trail.txt tells us exactly what threw instead of "unknown_error".
  let spying = false;
  function spyErrors() {
    if (spying) return;
    spying = true;
    const seen = (stats.errs = []);
    const names = ["Error", "TypeError", "RangeError", "DOMException", "SyntaxError"];
    const originals = names.map((n) => window[n]);
    const describe = (err, fallbackName) => {
      const name = (err && err.name) || fallbackName;
      const message = (err && err.message != null) ? String(err.message) : String(err);
      const stack = err && err.stack ? " STACK " + String(err.stack).split("\n").slice(0, 4).join(" < ").slice(0, 400) : "";
      return (name + ": " + message).slice(0, 250) + stack;
    };
    names.forEach((n, i) => {
      const log = (err) => { if (seen.length < 8) seen.push(describe(err, n)); };
      window[n] = new Proxy(originals[i], {
        construct(target, args, newTarget) { const e = Reflect.construct(target, args, newTarget); log(e); return e; },
        apply(target, self, args) { const e = Reflect.apply(target, self, args); log(e); return e; },
      });
    });
    // errors the engine itself throws (not made with `new`) surface as rejections / Sentry reports
    const onReject = (e) => { if (seen.length < 8) seen.push("rejection " + describe(e && e.reason, "unknown")); };
    addEventListener("unhandledrejection", onReject);
    setTimeout(() => {
      names.forEach((n, i) => { window[n] = originals[i]; });
      removeEventListener("unhandledrejection", onReject);
      spying = false;
      publish("after mux");
    }, 3000);
  }

  const wrap = (name, key) => {
    const Orig = window[name];
    if (!Orig) return;
    window[name] = class extends Orig {
      constructor(init) {
        super({
          output: (chunk, meta) => {
            stats[key + "Out"] = (stats[key + "Out"] || 0) + 1;
            if (chunk.timestamp < (last[key] ?? -Infinity)) stats[key + "BackInTime"] = (stats[key + "BackInTime"] || 0) + 1;
            last[key] = chunk.timestamp;
            if (stats[key + "Out"] === 1) stats[key + "FirstType"] = chunk.type;
            if (meta && meta.decoderConfig) stats[key + "Desc"] = meta.decoderConfig.description ? meta.decoderConfig.description.byteLength : "none";
            // Snapchat hands chunk.duration straight to mp4-muxer's addVideoChunkRaw, which throws on null
            // ("duration must be a non-negative real number" = the "Failed to record video" on device, trail
            // 2026-09-21). WebKit leaves it null unless the frame carried one, so rebuild the chunk if needed.
            if (!(chunk.duration >= 0) || chunk.duration === null) {
              try {
                const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
                chunk = new window[key === "v" ? "EncodedVideoChunk" : "EncodedAudioChunk"]({ type: chunk.type, timestamp: chunk.timestamp, duration: key === "v" ? 33333 : 21333, data });
                stats[key + "DurFixed"] = (stats[key + "DurFixed"] || 0) + 1;
              } catch (e) { stats[key + "DurFixErr"] = String(e); }
            }
            init.output(chunk, meta);
          },
          error: (e) => { stats[key + "Err"] = String(e && e.message || e); publish(name + " error"); init.error(e); },
        });
      }
      configure(config) {
        // Apple's H.264 encoder reorders frames (B-frames) unless asked for real-time output; Snapchat's MP4
        // writer needs chunks in order and gave "Failed to record video" otherwise
        if (key === "v") config = { ...config, latencyMode: "realtime" };
        delete last[key];
        for (const k of Object.keys(stats)) if (k.startsWith(key) && k !== "vSource") delete stats[k];
        stats[key + "Config"] = JSON.stringify(config);
        return super.configure(config);
      }
      flush() {
        spyErrors();
        const done = super.flush();
        // recording over: let go of the lazily opened microphone once the last sound has been encoded
        if (key === "a") done.then(() => window.__dgMicRelease && window.__dgMicRelease(), () => window.__dgMicRelease && window.__dgMicRelease()); done.then(() => publish(name + " flushed"), (e) => { stats[key + "FlushErr"] = String(e); publish(name + " flush failed"); }); return done; }
    };
  };
  // Snapchat's stopRecording always muxes a video-only MP4 first, then (only when it opened an audio track
  // too) a second, separate MP4 with both video and audio - built from the SAME EncodedVideoChunk objects,
  // so every video chunk's native copyTo() gets called twice (once per mp4-muxer instance; audio chunks are
  // only ever added to the second mux, so they're read once). copyTo() is spec'd to be a plain, repeatable
  // byte copy, but WebKit's WebCodecs implementation is young enough that a second read of the same chunk is
  // a real suspect for the swallowed exception ("Failed to record video" with otherwise-clean encoder stats -
  // see DEV_NOTES builds #61-#65). This makes the native call happen at most ONCE per chunk: the first
  // copyTo() result is cached (by chunk identity) and replayed for any later call on the same chunk, so
  // mp4-muxer's second pass never touches WebKit's copyTo a second time, whatever the real bug is.
  const copyCache = new WeakMap();
  for (const name of ["EncodedVideoChunk", "EncodedAudioChunk"]) {
    const proto = window[name] && window[name].prototype;
    if (!proto || !proto.copyTo) continue;
    const key = name === "EncodedVideoChunk" ? "v" : "a";
    const copyTo = proto.copyTo;
    proto.copyTo = function (destination) {
      const cached = copyCache.get(this);
      if (cached) {
        const view = destination instanceof ArrayBuffer ? new Uint8Array(destination) : new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength);
        if (view.byteLength === cached.byteLength) {
          view.set(cached);
          stats[key + "CopyCacheHits"] = (stats[key + "CopyCacheHits"] || 0) + 1;
          return;
        }
        stats[key + "CopySizeMismatch"] = (stats[key + "CopySizeMismatch"] || 0) + 1; // fall through to a real (2nd) native call below
      }
      try {
        const result = copyTo.apply(this, [destination]);
        if (!cached) {
          const view = destination instanceof ArrayBuffer ? new Uint8Array(destination) : new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength);
          copyCache.set(this, view.slice());
        }
        return result;
      } catch (e) {
        const errName = (e && e.name) || name;
        const stack = e && e.stack ? " STACK " + String(e.stack).split("\n").slice(0, 4).join(" < ").slice(0, 400) : "";
        stats.copyToErr = errName + ": " + (e && e.message != null ? e.message : String(e))
          + " (byteLength " + this.byteLength + ", 2nd call " + Boolean(cached) + ")" + stack;
        publish("copyTo threw");
        throw e;
      }
    };
  }
  wrap("VideoEncoder", "v");
  wrap("AudioEncoder", "a");

  // the camera track is camhook.js's canvas: frames come straight from that canvas (exact, no extra decode)
  function canvasFrames(track, canvas) {
    const t0 = performance.now();
    let timer = 0, done = false;
    return new ReadableStream({
      pull(controller) {
        return new Promise((resolve) => {
          timer = setTimeout(() => {
            if (done) return resolve();
            if (track.readyState === "ended") { controller.close(); return resolve(); }
            try { controller.enqueue(new VideoFrame(canvas, { timestamp: Math.round((performance.now() - t0) * 1000), duration: 33333 })); stats.vFrames = (stats.vFrames || 0) + 1; }
            catch (e) { stats.vFrameErr = String(e); }
            resolve();
          }, 33);
        });
      },
      cancel() { done = true; clearTimeout(timer); },
    }, { highWaterMark: 1 });
  }

  function videoFrames(track) {
    const cam = window.__dgCam;
    stats.vSource = cam && cam.ids.has(track.id) ? "canvas" : "video element";
    stats.vFrames = 0;
    if (cam && cam.ids.has(track.id)) return canvasFrames(track, cam.canvas);
    for (const old of document.querySelectorAll("video[data-dg-rec]")) { old.srcObject = null; old.remove(); } // earlier recordings' leftovers
    const v = document.createElement("video");
    v.setAttribute("data-dg-rec", "");
    v.muted = true; v.playsInline = true; v.setAttribute("playsinline", "");
    v.style.cssText = "position:fixed;left:0;top:0;width:32px;height:56px;opacity:0.01;pointer-events:none;z-index:-1";
    (document.body || document.documentElement).appendChild(v);
    v.srcObject = new MediaStream([track]);
    v.play().catch(() => {});
    const t0 = performance.now();
    let done = false, last = -1, fallback = null;
    const finish = () => { done = true; v.srcObject = null; v.remove(); };
    // The second recording after leaving and re-entering the camera got 0 frames (REC vFrames 0, 2026-09-21):
    // the hidden <video> never reached readyState 2. If that happens for more than a second, draw the frames
    // from camhook's own camera canvas instead, mirrored the way Snapchat mirrors the front camera.
    const useFallback = () => {
      if (!cam || !cam.canvas) return false;
      const c = document.createElement("canvas");
      c.width = cam.canvas.width; c.height = cam.canvas.height;
      const g = c.getContext("2d");
      fallback = () => {
        if (c.width !== cam.canvas.width || c.height !== cam.canvas.height) { c.width = cam.canvas.width; c.height = cam.canvas.height; }
        g.setTransform(1, 0, 0, 1, 0, 0);
        if (cam.facing !== "environment") { g.translate(c.width, 0); g.scale(-1, 1); }
        g.drawImage(cam.canvas, 0, 0);
        return c;
      };
      stats.vSource = "camhook canvas (fallback: video readyState " + v.readyState + ", track " + track.readyState + "/" + (track.muted ? "muted" : "live") + ")";
      return true;
    };
    return new ReadableStream({
      pull(controller) {
        return new Promise((resolve) => {
          const attempt = () => {
            if (done) return resolve();
            if (track.readyState === "ended") { finish(); controller.close(); return resolve(); }
            const ts = Math.round((performance.now() - t0) * 1000);
            if (ts - last < 25000) return setTimeout(attempt, 8); // ~30 fps at most
            if (!fallback && v.readyState < 2) {
              if (!(ts > 1000000 && stats.vFrames === 0 && useFallback())) {
                stats.vWait = v.readyState + "/" + track.readyState + (track.muted ? "/muted" : "");
                return setTimeout(attempt, 8);
              }
            }
            try { controller.enqueue(new VideoFrame(fallback ? fallback() : v, { timestamp: ts, duration: 33333 })); last = ts; stats.vFrames++; resolve(); }
            catch (e) { stats.vFrameErr = String(e); setTimeout(attempt, 16); }
          };
          attempt();
        });
      },
      cancel: finish,
    }, { highWaterMark: 1 });
  }

  function audioFrames(track) {
    const settings = track.getSettings ? track.getSettings() : {};
    // Snapchat configured its AudioEncoder from THIS track's settings (sampleRate ?? 44100, channelCount ?? 1),
    // so the AudioData must use the same numbers even when the sound really comes from the lazily opened mic.
    const channels = settings.channelCount || 1;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const cam = window.__dgCam;
    const lazy = Boolean(cam && cam.lazyIds && cam.lazyIds.has(track.id) && cam.realGUM); // camhook.js's silent stand-in
    let ctx, node, source, mic = null, frames = 0, finished = false, failsafe = 0, peak = 0;
    let ctl = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(failsafe);
      if (window.__dgMicRelease === finish) window.__dgMicRelease = null;
      try { node.disconnect(); source.disconnect(); ctx.close(); } catch {}
      if (mic) for (const t of mic.getTracks()) t.stop(); // give the phone's audio back
      try { ctl && ctl.close(); } catch {}
    };
    return new ReadableStream({
      async start(controller) {
        ctl = controller;
        const t0 = performance.now();
        let input = track;
        if (lazy) {
          // the recording has started: only now open the real microphone (see camhook.js, lazy microphone)
          window.__dgMicRelease = finish; // the AudioEncoder wrapper calls this when Snapchat flushes = recording over
          failsafe = setTimeout(finish, 75000);
          try {
            const pre = cam.preMic; cam.preMic = null; // opened on the shutter touch (camhook.js), if it was
            mic = pre ? await pre : await cam.realGUM({ audio: cam.lazyConstraints || true });
            input = mic.getAudioTracks()[0];
            stats.aMic = (pre ? "pre-opened, ready after " : "opened after ") + Math.round(performance.now() - t0) + "ms";
          } catch (e) { stats.aMicErr = String(e); publish("mic failed"); }
          if (finished) { if (mic) for (const t of mic.getTracks()) t.stop(); return; }
        }
        // WebKit plays SILENCE from a MediaStreamAudioSourceNode whose track rate differs from the context's
        // (the iPhone mic is 48kHz, the stand-in track said 44.1kHz: REC aPeak 0.0096 = nothing but noise floor,
        // 2026-09-21). So the graph runs at the mic's own rate and the samples are resampled to the rate
        // Snapchat configured its AudioEncoder with.
        const outRate = settings.sampleRate || 44100;
        const inSettings = input.getSettings ? input.getSettings() : {};
        try { ctx = inSettings.sampleRate ? new Ctx({ sampleRate: inSettings.sampleRate }) : new Ctx(); } catch { ctx = new Ctx(); }
        stats.aRates = ctx.sampleRate + "->" + outRate;
        const ratio = ctx.sampleRate / outRate;
        let carry = 0; // fractional input position carried between blocks
        const resample = (data, n) => {
          if (ratio === 1) return { data, n };
          const m = Math.ceil((n - carry) / ratio); // so the carried position for the next block stays within [0, ratio)
          const out = new Float32Array(m * channels);
          for (let c = 0; c < channels; c++) {
            for (let i = 0; i < m; i++) {
              const pos = carry + i * ratio, k = Math.floor(pos), f = pos - k;
              const a = data[c * n + k], b = data[c * n + Math.min(k + 1, n - 1)];
              out[c * m + i] = a + (b - a) * f;
            }
          }
          carry = carry + m * ratio - n;
          return { data: out, n: m };
        };
        // the muxer shifts each track to start at 0, so cover the time the mic took to open with silence or
        // the sound would run ahead of the picture by that much
        const lead = Math.round((performance.now() - t0) / 1000 * outRate);
        if (lazy && lead > 0) {
          try {
            controller.enqueue(new AudioData({ format: "f32-planar", sampleRate: outRate, numberOfFrames: lead,
              numberOfChannels: channels, timestamp: 0, data: new Float32Array(lead * channels) }));
            frames = lead;
          } catch (e) { stats.aLeadErr = String(e); }
        }
        source = ctx.createMediaStreamSource(new MediaStream([input]));
        node = ctx.createScriptProcessor(2048, channels, channels);
        node.onaudioprocess = (e) => {
          if (finished) return;
          const input = e.inputBuffer, n0 = input.length;
          const raw = new Float32Array(n0 * channels);
          for (let c = 0; c < channels; c++) raw.set(input.getChannelData(Math.min(c, input.numberOfChannels - 1)), c * n0);
          for (let k = 0; k < n0; k += 16) { const a = Math.abs(raw[k]); if (a > peak) peak = a; } // is the mic really heard?
          stats.aPeak = +peak.toFixed(4);
          const { data, n } = resample(raw, n0);
          if (!n) return;
          try {
            controller.enqueue(new AudioData({
              format: "f32-planar", sampleRate: outRate, numberOfFrames: n, numberOfChannels: channels,
              timestamp: Math.round(frames / outRate * 1e6), data,
            }));
          } catch (e) { stats.aEnqErr = String(e); }
          frames += n;
          stats.aFrames = (stats.aFrames || 0) + 1;
        };
        source.connect(node);
        node.connect(ctx.destination); // plays silence: the node writes nothing to its output
        ctx.resume().catch(() => {});
        stats.aCtx = ctx.state + " " + ctx.sampleRate + "Hz x" + channels + (lazy ? " lazy" : "");
      },
      cancel: finish,
    });
  }

  window.MediaStreamTrackProcessor = class MediaStreamTrackProcessor {
    constructor(init) {
      const track = init && init.track;
      if (!track) throw new TypeError("track is required");
      this.readable = track.kind === "audio" ? audioFrames(track) : videoFrames(track);
    }
  };

  // no usable AAC encoder or AudioData: Snapchat then records video without sound instead of refusing
  const dropAudio = () => { try { delete window.AudioEncoder; } catch {} if (window.AudioEncoder) window.AudioEncoder = undefined; };
  if (typeof AudioEncoder !== "undefined") {
    if (typeof AudioData === "undefined") dropAudio();
    else AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: 44100, numberOfChannels: 1 })
      .then((r) => { if (!r || !r.supported) dropAudio(); }, dropAudio);
  }
})();
