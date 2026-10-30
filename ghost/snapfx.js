// Ghost snap filters (1.12.0): the colour looks you swipe through on the snap review screen, and the WebGL renderer
// that shows them live and bakes them into a sent photo. ui.js's snap editor owns the swiping, the info filters and
// the video speed entries; this file has no DOM of its own.
//
// A look is a colour matrix (rows r, g, b: four weights + an offset, on sRGB 0..1 values) followed by
//   fade      lifts the blacks and dims the whites a little:  v = fade + v * (1 - 1.4 * fade)
//   vignette  darkens towards the corners: v *= 1 - vignette * clamp((d - 0.3) / 0.7), d = distance from the centre
//             in pixels / half the diagonal (a circle, like CIRadialGradient)
//   grain     grey noise, v += (noise - 0.5) * grain
// Photos are rendered here (WebGL, full size). Videos are rendered natively: nativeParams() is what
// GalleryLibrary.swift's SnapFX.apply mirrors with Core Image (same maths, applied on sRGB values).
const SnapFX = (() => {
  const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  // 3x4 matrices: [r0 r1 r2 rOff, g0 g1 g2 gOff, b0 b1 b2 bOff]
  const mul = (a, b) => { // a after b
    const o = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) o.push(a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c]);
      o.push(a[r * 4] * b[3] + a[r * 4 + 1] * b[7] + a[r * 4 + 2] * b[11] + a[r * 4 + 3]);
    }
    return o;
  };
  const sat = (s) => {
    const lr = 0.2126 * (1 - s), lg = 0.7152 * (1 - s), lb = 0.0722 * (1 - s);
    return [lr + s, lg, lb, 0, lr, lg + s, lb, 0, lr, lg, lb + s, 0];
  };
  const contrast = (k) => [k, 0, 0, (1 - k) / 2, 0, k, 0, (1 - k) / 2, 0, 0, k, (1 - k) / 2];
  const gain = (r, g, b, or, og, ob) => [r, 0, 0, or || 0, 0, g, 0, og || 0, 0, 0, b, ob || 0];
  const chain = (...ms) => ms.reduce((acc, m) => mul(m, acc), ID);
  const sepia = [0.393, 0.769, 0.189, 0, 0.349, 0.686, 0.168, 0, 0.272, 0.534, 0.131, 0];
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

  const FILTERS = [
    { id: "none", name: "Original", m: ID, fade: 0, vignette: 0, grain: 0 },
    { id: "bw", name: "B&W", m: chain(sat(0), contrast(1.08)), fade: 0, vignette: 0, grain: 0 },
    { id: "vintage", name: "Vintage", m: chain(mix(ID, sepia, 0.75), contrast(0.94), gain(1.04, 1, 0.92, 0.02, 0.01, 0)), fade: 0.08, vignette: 0.35, grain: 0.04 },
    { id: "warm", name: "Warm", m: chain(sat(1.08), gain(1.07, 1.01, 0.86, 0.025, 0.008, -0.01)), fade: 0, vignette: 0, grain: 0 },
    { id: "cool", name: "Cool", m: chain(sat(0.95), gain(0.9, 1, 1.1, -0.015, 0.004, 0.035)), fade: 0, vignette: 0, grain: 0 },
    { id: "vivid", name: "Vivid", m: chain(sat(1.5), contrast(1.12)), fade: 0, vignette: 0.12, grain: 0 },
    { id: "film", name: "Film", m: chain(sat(0.82), contrast(1.06), gain(1.03, 1, 0.94, 0.01, 0.01, 0.02)), fade: 0.05, vignette: 0.2, grain: 0.1 },
    { id: "fade", name: "Fade", m: chain(sat(0.72), contrast(0.92)), fade: 0.16, vignette: 0, grain: 0 },
    { id: "noir", name: "Noir", m: chain(sat(0), contrast(1.45)), fade: 0, vignette: 0.55, grain: 0.05 },
  ];
  const byId = new Map(FILTERS.map((f) => [f.id, f]));
  const get = (id) => byId.get(id) || FILTERS[0];
  const isNone = (id) => !id || id === "none";

  // what the native side needs (GalleryLibrary.swift SnapFX.apply)
  function nativeParams(id) {
    if (isNone(id)) return null;
    const f = get(id);
    return { matrix: f.m.slice(), fade: f.fade, vignette: f.vignette, grain: f.grain };
  }

  // the same maths on one pixel (0..1 sRGB); used by the CPU fallback and by tests
  function applyPixel(f, r, g, b, x, y, w, h, noise) {
    const m = f.m;
    let o = [m[0] * r + m[1] * g + m[2] * b + m[3], m[4] * r + m[5] * g + m[6] * b + m[7], m[8] * r + m[9] * g + m[10] * b + m[11]];
    if (f.fade) o = o.map((v) => f.fade + v * (1 - 1.4 * f.fade));
    if (f.vignette) {
      const d = Math.hypot(x - w / 2, y - h / 2) / (Math.hypot(w, h) / 2);
      const k = 1 - f.vignette * Math.min(1, Math.max(0, (d - 0.3) / 0.7));
      o = o.map((v) => v * k);
    }
    if (f.grain) o = o.map((v) => v + (noise - 0.5) * f.grain);
    return o.map((v) => Math.min(1, Math.max(0, v)));
  }

  const VS = `attribute vec2 p; varying vec2 uv; uniform vec4 crop;
void main(){ vec2 q = p * 0.5 + 0.5; q.y = 1.0 - q.y; uv = crop.xy + q * crop.zw; gl_Position = vec4(p, 0.0, 1.0); }`;
  // two looks at once, split at x = split (0..1 of the output): left of it look A, right of it look B (the swipe)
  const FS = `precision highp float; varying vec2 uv; uniform sampler2D tex; uniform vec2 size; uniform float split; uniform float seed;
uniform mat3 mA; uniform vec3 oA; uniform vec3 fA; uniform mat3 mB; uniform vec3 oB; uniform vec3 fB;
float hash(vec2 q){ return fract(sin(dot(q, vec2(12.9898, 78.233)) + seed) * 43758.5453); }
vec3 look(vec3 c, mat3 m, vec3 o, vec3 f, vec2 px){
  vec3 v = m * c + o;
  v = f.x + v * (1.0 - 1.4 * f.x);
  float d = length(px - size * 0.5) / (length(size) * 0.5);
  v *= 1.0 - f.y * clamp((d - 0.3) / 0.7, 0.0, 1.0);
  v += (hash(floor(px)) - 0.5) * f.z;
  return clamp(v, 0.0, 1.0);
}
void main(){
  vec4 c = texture2D(tex, uv);
  vec2 px = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y);
  gl_FragColor = vec4(px.x / size.x < split ? look(c.rgb, mA, oA, fA, px) : look(c.rgb, mB, oB, fB, px), 1.0);
}`;

  // A WebGL renderer bound to one canvas. draw() uploads the source (img / video / canvas) and draws it filtered,
  // stretched over the whole canvas (the caller sizes the canvas to the media's own aspect).
  function createRenderer(canvas) {
    let gl = null;
    const opts = { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false };
    try { gl = canvas.getContext("webgl2", opts) || canvas.getContext("webgl", opts); } catch (e) { gl = null; }
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("shader: " + gl.getShaderInfoLog(s)); return s; };
    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(prog));
    } catch (e) { return null; }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const U = {};
    for (const n of ["tex", "size", "split", "seed", "mA", "oA", "fA", "mB", "oB", "fB", "crop"]) U[n] = gl.getUniformLocation(prog, n);
    const setLook = (m, o, f, look) => {
      const a = look.m; // column-major mat3 for GLSL (m * c)
      gl.uniformMatrix3fv(m, false, [a[0], a[4], a[8], a[1], a[5], a[9], a[2], a[6], a[10]]);
      gl.uniform3f(o, a[3], a[7], a[11]);
      gl.uniform3f(f, look.fade || 0, look.vignette || 0, look.grain || 0);
    };
    let lost = false;
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); lost = true; });
    return {
      gl,
      get lost() { return lost || gl.isContextLost(); },
      // crop: [x, y, w, h] of the source (0..1) to draw - the whole source by default
      draw(source, lookA, lookB, split, seed, crop) {
        if (lost) return false;
        const w = canvas.width, h = canvas.height;
        gl.viewport(0, 0, w, h);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); } catch (e) { return false; }
        gl.uniform1i(U.tex, 0);
        const cr = crop || [0, 0, 1, 1];
        gl.uniform4f(U.crop, cr[0], cr[1], cr[2], cr[3]);
        gl.uniform2f(U.size, w, h);
        gl.uniform1f(U.split, split == null ? 2 : split);
        gl.uniform1f(U.seed, seed || 0);
        setLook(U.mA, U.oA, U.fA, get(lookA));
        setLook(U.mB, U.oB, U.fB, get(lookB == null ? lookA : lookB));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return !gl.getError();
      },
      dispose() { try { gl.deleteTexture(tex); gl.deleteBuffer(buf); gl.deleteProgram(prog); const ext = gl.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext(); } catch (e) {} },
    };
  }

  // Full-size filtered copy of an image/canvas as a new 2D-drawable canvas (w x h). WebGL first; a CPU loop if
  // WebGL isn't available (slow for big photos, but correct).
  function renderCanvas(source, w, h, id) {
    const out = document.createElement("canvas");
    out.width = w; out.height = h;
    const r = createRenderer(out);
    if (r && r.draw(source, id, id, null, 0)) return { canvas: out, gl: true, dispose: () => r.dispose() };
    if (r) r.dispose();
    const cpu = document.createElement("canvas");
    cpu.width = w; cpu.height = h;
    const g = cpu.getContext("2d");
    g.drawImage(source, 0, 0, w, h);
    const f = get(id);
    if (isNone(id)) return { canvas: cpu, gl: false, dispose() {} };
    const img = g.getImageData(0, 0, w, h), d = img.data;
    let s = 1234567;
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i += 4) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const o = applyPixel(f, d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, x + 0.5, y + 0.5, w, h, s / 0x7fffffff);
        d[i] = o[0] * 255; d[i + 1] = o[1] * 255; d[i + 2] = o[2] * 255;
      }
    }
    g.putImageData(img, 0, 0);
    return { canvas: cpu, gl: false, dispose() {} };
  }

  return { filters: FILTERS, get, isNone, nativeParams, applyPixel, createRenderer, renderCanvas };
})();
if (typeof window !== "undefined") window.SnapFX = SnapFX;
