// App only, page world, before Snapchat's bundle: the phone's cameras behind Snapchat Web's webcam camera.
//
// Snapchat Web asks for "a webcam" once and knows nothing about front/back lenses, pinch zoom or double-tap
// to flip. So getUserMedia hands Snapchat a canvas stream instead, and this script feeds that canvas from
// whichever real camera it has open: front camera first, double-tap flips, pinch zooms (the ultra-wide
// lens below 1x when the phone lists one, the lens's own zoom where WebKit offers it, digital crop beyond
// that). Snapchat keeps mirroring its preview like a webcam, so back-camera frames are pre-flipped to come
// out the right way round.
//
// The camera itself never opens the microphone: opening the mic puts iOS's audio session into record mode,
// which interrupts whatever else is playing on the phone (it gets
// suspended and stays paused - see origin/try/camera-no-mic). Sound for video snaps comes from the "lazy
// microphone" below: Snapchat gets a silent stand-in track and recorder.js opens the real mic only while a
// video snap is being recorded.
(() => {
  if (window.top !== window) return;
  // The app grants camera + microphone itself (App.swift), but WebKit still reports "prompt", so Snapchat
  // put its "Heads Up! We're about to ask for permission" sheet in front of every camera start.
  if (navigator.permissions && navigator.permissions.query) {
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (desc) => {
      // Snapchat only records sound on a video snap when the microphone reads "granted" - and then asks for
      // the mic as soon as a chat opens. That request gets a silent stand-in track below (lazy microphone),
      // so answering "granted" no longer opens the real mic.
      if (desc && (desc.name === "camera" || desc.name === "microphone")) {
        const status = new EventTarget();
        Object.assign(status, { state: "granted", name: desc.name, onchange: null });
        return Promise.resolve(status);
      }
      return query(desc);
    };
  }

  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia || !HTMLCanvasElement.prototype.captureStream) return;
  const real = md.getUserMedia.bind(md);
  const W = 720, H = 1280;

  let facing = "user", zoom = 1, lens = "wide", hwZoom = 1, ultraId = null;
  let srcStream = null, out = null, busy = false, watch = 0;
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.setAttribute("playsinline", "");
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  const cam = (window.__dgCam = { canvas, ids: new Set() }); // recorder.js reads frames straight off the canvas

  // Lazy microphone. Opening the mic switches iOS's audio session to recording and pauses other audio on the
  // phone (music, calls, other audio apps), so it must not happen just because a chat or the camera is
  // open. Snapchat fetches its "audio for recording" stream long before anything is recorded, with the same
  // call it uses for voice notes and calls. So: a mic-only request gets a silent stand-in track (a Web Audio
  // destination on a context that is never started) unless the user has just touched a voice-note / call
  // control. recorder.js opens the real mic only while a video snap is actually recording (it recognises the
  // stand-in by id) and lets go of it when the recording stops.
  cam.lazyIds = new Set();
  cam.realGUM = real;
  let touched = { at: 0, label: "" };
  addEventListener("touchstart", (e) => {
    const b = e.target && e.target.closest && e.target.closest("button, [role='button']");
    touched = { at: performance.now(), label: b ? [b.title, b.getAttribute("aria-label"), b.getAttribute("data-tooltip"), b.textContent].join(" ") : "" };
  }, { capture: true, passive: true });
  // Ghost (its own UI, so no Snapchat button labels to read) says so directly while a call is starting / live
  const wantsRealMic = () => window.__ghostWantsMic === true || (performance.now() - touched.at < 2500 && /voice|call|micro|note/i.test(touched.label));
  // The real mic took ~0.9s to open once recording had started (REC aMic), which showed as a late start of the
  // video. Open it as soon as the shutter is touched instead: Snapchat's hold-to-record only begins a moment
  // later, and recorder.js picks this stream up (cam.preMic). Let go of it again if no recording follows.
  addEventListener("touchstart", (e) => {
    const b = e.target && e.target.closest && e.target.closest("button");
    if (!b || !b.querySelector("#CaptureButton_captureButton") || cam.preMic) return;
    const p = real({ audio: cam.lazyConstraints || true });
    cam.preMic = p;
    p.catch(() => { if (cam.preMic === p) cam.preMic = null; });
    setTimeout(() => { if (cam.preMic === p) { cam.preMic = null; p.then((s) => { for (const t of s.getTracks()) t.stop(); }, () => {}); } }, 4000);
  }, { capture: true, passive: true });
  function standInAudio(constraints) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!cam.silence) cam.silence = new Ctx(); // stays suspended: nothing is ever played or captured through it
    const stream = cam.silence.createMediaStreamDestination().stream;
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error("no stand-in track");
    cam.lazyIds.add(track.id);
    cam.lazyConstraints = constraints.audio;
    return stream;
  }
  const stopSource = () => { if (srcStream) for (const t of srcStream.getTracks()) t.stop(); srcStream = null; };

  async function findLenses() {
    try {
      const cams = (await md.enumerateDevices()).filter((d) => d.kind === "videoinput");
      const ultra = cams.find((d) => /ultra/i.test(d.label) && /back|rear/i.test(d.label));
      ultraId = ultra ? ultra.deviceId : null;
    } catch {}
  }

  async function openSource() {
    stopSource();
    const v = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    if (facing === "environment" && lens === "ultra" && ultraId) v.deviceId = { exact: ultraId };
    else v.facingMode = facing === "user" ? "user" : { ideal: "environment" };
    srcStream = await real({ video: v });
    hwZoom = 1;
    video.srcObject = srcStream;
    await video.play().catch(() => {});
    if (!ultraId) findLenses();
  }

  // Camera roll: a picture picked with the photo button is shown in place of the camera, so Snapchat's own
  // shutter turns it into a normal snap (Snapchat Web has no upload). Drawn flipped exactly like back-camera
  // frames, because Snapchat mirrors whatever this canvas shows (it assumes a selfie camera).
  let photo = null, photoFlip = true; // flip button on the chip in case a snap comes out mirrored (unconfirmed on device)
  function drawPhoto() {
    const pw = photo.width, ph = photo.height;
    const cover = Math.max(W / pw, H / ph), fit = Math.min(W / pw, H / ph);
    ctx.save();
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    if (photoFlip) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    // the whole photo fits in the 9:16 frame (a landscape shot isn't cropped to a sliver); the empty space is filled
    // with a dimmed, zoomed copy of it, like the app does for camera-roll snaps
    ctx.globalAlpha = 0.35;
    ctx.drawImage(photo, (W - pw * cover) / 2, (H - ph * cover) / 2, pw * cover, ph * cover);
    ctx.globalAlpha = 1;
    ctx.drawImage(photo, (W - pw * fit) / 2, (H - ph * fit) / 2, pw * fit, ph * fit);
    ctx.restore();
  }
  function draw() {
    if (photo) return drawPhoto();
    const vw = video.videoWidth, vh = video.videoHeight;
    if (vw && vh) {
      const digital = Math.max(1, (lens === "ultra" ? zoom / 0.5 : zoom) / hwZoom);
      let sw = vw, sh = vw * H / W; // largest 9:16 crop
      if (sh > vh) { sh = vh; sw = vh * W / H; }
      sw /= digital; sh /= digital;
      ctx.save();
      if (facing === "environment") { ctx.translate(W, 0); ctx.scale(-1, 1); }
      ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, W, H);
      ctx.restore();
    }
  }
  function loop() {
    if (!out) return;
    draw();
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(loop); else requestAnimationFrame(loop);
  }
  // requestVideoFrameCallback stalls while the source is being swapped: keep a slow heartbeat too
  setInterval(() => { if (out) draw(); }, 250);

  function shutdown() {
    setPhoto(null);
    clearInterval(watch); watch = 0;
    if (out) for (const t of out.getTracks()) t.stop();
    out = null;
    stopSource();
    video.srcObject = null;
  }

  md.getUserMedia = async function (constraints) {
    if (!constraints || !constraints.video) {
      if (constraints && constraints.audio && !wantsRealMic()) {
        try { return standInAudio(constraints); } catch (e) { cam.lazyErr = String(e); }
      }
      return real(constraints);
    }
    facing = "user"; zoom = 1; lens = "wide"; cam.facing = facing;
    if (out) shutdown();
    await openSource();
    out = canvas.captureStream(30);
    for (const t of out.getVideoTracks()) cam.ids.add(t.id);
    loop();
    const mine = out;
    watch = setInterval(() => { // Snapchat stopped its tracks: release the real camera
      if (out !== mine) return;
      if (mine.getVideoTracks().every((t) => t.readyState === "ended")) shutdown();
    }, 500);
    return out;
  };

  cam.flip = () => flip(); // Ghost's call screen flips the camera with this
  async function flip() {
    if (!out || busy) return;
    busy = true;
    facing = facing === "user" ? "environment" : "user"; cam.facing = facing;
    zoom = 1; lens = "wide";
    try { await openSource(); } catch { facing = facing === "user" ? "environment" : "user"; cam.facing = facing; try { await openSource(); } catch {} }
    busy = false;
    badge(facing === "user" ? "Front" : "Back");
  }

  async function setZoom(z) {
    const min = facing === "environment" && ultraId ? 0.5 : 1;
    zoom = Math.min(10, Math.max(min, z));
    badge((Math.round(zoom * 10) / 10) + "x");
    if (facing !== "environment" || busy) return;
    const want = zoom < 1 && ultraId ? "ultra" : "wide";
    if (want !== lens) {
      busy = true; lens = want;
      try { await openSource(); } catch {}
      busy = false;
      return;
    }
    const track = srcStream && srcStream.getVideoTracks()[0];
    const caps = track && track.getCapabilities ? track.getCapabilities() : null;
    if (lens === "wide" && caps && caps.zoom && caps.zoom.max > 1) {
      const hw = Math.min(zoom, caps.zoom.max);
      try { await track.applyConstraints({ advanced: [{ zoom: hw }] }); hwZoom = hw; } catch {}
    }
  }

  let label = null, hide = 0;
  function badge(text) {
    if (!label) {
      label = document.createElement("div");
      label.style.cssText = "position:fixed;left:50%;bottom:22%;transform:translateX(-50%);z-index:2147483000;padding:6px 14px;"
        + "border-radius:16px;background:rgba(0,0,0,.55);color:#fff;font:600 17px -apple-system,sans-serif;pointer-events:none;transition:opacity .25s";
      document.body.appendChild(label);
    }
    label.textContent = text;
    label.style.opacity = "1";
    clearTimeout(hide);
    hide = setTimeout(() => { label.style.opacity = "0"; }, 900);
  }

  // gestures on the live camera (html.dg-camera is set by camera.js while it is on screen)
  const active = () => out && document.documentElement.classList.contains("dg-camera");
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  let pinch = null, lastTap = null;
  document.addEventListener("touchstart", (e) => {
    if (!active()) return;
    if (e.touches.length === 2) { pinch = { d: dist(e.touches), z: zoom }; lastTap = null; }
  }, { capture: true, passive: true });
  document.addEventListener("touchmove", (e) => {
    if (!active() || !pinch || e.touches.length !== 2) return;
    e.preventDefault();
    setZoom(pinch.z * dist(e.touches) / pinch.d);
  }, { capture: true, passive: false });
  document.addEventListener("touchend", (e) => {
    if (!active()) return;
    if (pinch) { if (e.touches.length < 2) pinch = null; return; }
    if (e.changedTouches.length !== 1 || e.touches.length) return;
    if (e.target.closest && e.target.closest("button, a, input, [role='button'], [role='listbox']")) { lastTap = null; return; }
    const t = e.changedTouches[0], now = Date.now();
    if (lastTap && now - lastTap.time < 320 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 45) {
      lastTap = null;
      flip();
    } else lastTap = { time: now, x: t.clientX, y: t.clientY };
  }, { capture: true, passive: true });

  addEventListener("dg-camera-stop", shutdown);

  // troubleshooting video recording: what Snapchat's checks see, left on <html> for camera.js to save
  addEventListener("dg-camera-probe", async () => {
    const probe = {
      ua: navigator.userAgent.includes("Chrome/") ? "chrome" : "safari",
      types: [typeof VideoEncoder, typeof AudioEncoder, typeof AudioData, typeof window.MediaStreamTrackProcessor, typeof VideoFrame],
      track: out && out.getVideoTracks()[0] ? out.getVideoTracks()[0].getSettings() : null,
    };
    try { probe.video = (await VideoEncoder.isConfigSupported({ codec: "avc1.64002a", width: W, height: H })).supported; } catch (e) { probe.video = "err " + e.message; }
    try { probe.audio = (await AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: 44100, numberOfChannels: 1 })).supported; } catch (e) { probe.audio = "err " + e.message; }
    try { probe.mic = (await navigator.permissions.query({ name: "microphone" })).state; } catch (e) { probe.mic = "err"; }
    const shutter = document.querySelector('[aria-roledescription="draggable"]');
    probe.shutterDisabled = shutter ? shutter.getAttribute("aria-disabled") : "none";
    probe.errors = (window.__dgErrors || []).slice(-4);
    document.documentElement.setAttribute("data-dg-probe", JSON.stringify(probe));
  });

  // ---- camera roll button (page DOM, shown only on the live camera screen) ---------------------------
  let rollBtn = null, rollChip = null, rollInput = null;
  function setPhoto(bitmap) {
    if (photo && photo.close) try { photo.close(); } catch (e) {}
    photo = bitmap;
    if (rollChip) rollChip.hidden = !photo;
    if (out) draw();
  }
  function rollUI() {
    const html = document.documentElement;
    const live = html.classList.contains("dg-camera") && !!out && !document.querySelector('button[title^="Close snap preview"]');
    if (!rollBtn && live && document.body) {
      const st = document.createElement("style");
      st.textContent = ".dg-roll-btn{position:fixed;top:76px;left:15px;width:52px;height:52px;border-radius:50%;border:0;z-index:2147483000;"
        + "background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;-webkit-tap-highlight-color:transparent}"
        + ".dg-roll-btn:active{transform:scale(.92)}.dg-roll-btn svg{width:26px;height:26px}"
        + ".dg-roll-chip{position:fixed;top:84px;left:78px;z-index:2147483000;display:flex;align-items:center;gap:8px;padding:8px 8px 8px 14px;"
        + "border-radius:18px;background:rgba(0,0,0,.6);color:#fff;font:600 15px/1 -apple-system,system-ui,sans-serif}"
        + ".dg-roll-chip[hidden]{display:none}.dg-roll-chip button{width:26px;height:26px;border-radius:50%;border:0;background:rgba(255,255,255,.22);color:#fff;font:700 14px/1 sans-serif}";
      document.head.appendChild(st);
      rollInput = document.createElement("input");
      rollInput.type = "file"; rollInput.accept = "image/*"; rollInput.style.display = "none";
      rollInput.addEventListener("change", async () => {
        const f = rollInput.files && rollInput.files[0];
        rollInput.value = "";
        if (!f) return;
        try { setPhoto(await createImageBitmap(f)); }
        catch (e) { // older engines: go through an <img>
          const img = new Image(); img.src = URL.createObjectURL(f);
          try { await img.decode(); setPhoto(img); } catch (e2) {}
        }
      });
      rollBtn = document.createElement("button");
      rollBtn.className = "dg-roll-btn"; rollBtn.type = "button"; rollBtn.setAttribute("aria-label", "Photo from library");
      rollBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 9"/></svg>';
      rollBtn.addEventListener("click", (e) => { e.stopPropagation(); rollInput.click(); });
      rollChip = document.createElement("div");
      rollChip.className = "dg-roll-chip"; rollChip.hidden = true;
      rollChip.innerHTML = "Photo <button type=\"button\" aria-label=\"Mirror\">⇆</button><button type=\"button\" aria-label=\"Back to camera\">✕</button>";
      const [flipBtn, closeBtn] = rollChip.querySelectorAll("button");
      flipBtn.addEventListener("click", (e) => { e.stopPropagation(); photoFlip = !photoFlip; if (out) draw(); });
      closeBtn.addEventListener("click", (e) => { e.stopPropagation(); setPhoto(null); });
      document.body.append(rollInput, rollBtn, rollChip);
    }
    if (rollBtn) {
      rollBtn.style.display = live ? "" : "none";
      rollChip.style.display = live ? "" : "none";
    }
  }
  new MutationObserver(rollUI).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  setInterval(rollUI, 600); // the snap preview appears/disappears without a class change
})();
