import {
  instantiate,
  TYPE_RGB_8,
  INTENT_PERCEPTUAL,
  INTENT_RELATIVE_COLORIMETRIC,
  cmsFLAGS_SOFTPROOFING,
  cmsFLAGS_BLACKPOINTCOMPENSATION,
} from 'lcms-wasm';
import wasmUrl from 'lcms-wasm/dist/lcms.wasm?url';
import { parse } from 'icc';

const ICC_FILE = '[colorshift] light-teal fluorescent-pink - preview (beta).icc';

const DEFAULT_SIZE = 600;

// Thin shim so icc.mjs (which uses Node Buffer methods) works in the browser
function makeBuffer(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  u8.readUInt32BE = (offset) => new DataView(arrayBuffer, offset, 4).getUint32(0, false);
  u8.readInt32BE  = (offset) => new DataView(arrayBuffer, offset, 4).getInt32(0, false);
  u8.slice = (start, end) => {
    const sliced = new Uint8Array(arrayBuffer, start, end - start);
    return makeBuffer(sliced.buffer.slice(start, end));
  };
  u8.toString = (enc, start, end) => {
    const bytes = (start !== undefined)
      ? new Uint8Array(arrayBuffer, start, (end ?? u8.length) - start)
      : u8;
    return new TextDecoder(enc === 'utf16be' ? 'utf-16be' : 'latin1').decode(bytes);
  };
  return u8;
}

const state = {
  teal: { imageData: null, rawData: null, width: 0, height: 0, inverted: false, brightness: 0, contrast: 0, isDefault: true },
  pink: { imageData: null, rawData: null, width: 0, height: 0, inverted: false, brightness: 0, contrast: 0, isDefault: true },
  renderIntent: INTENT_RELATIVE_COLORIMETRIC,
  misregistration: { perfect: true, dx: 0, dy: 0, angle: 0 },
  previewMode: 'csv',
  screenType: 'grain-touch',
  dpiDetected: { teal: 0, pink: 0 },
  dpiManual: 300,
  dpiOverride: false,
  effectiveDpi: 300,
  actualSizeMode: false,
  calibrationFactor: 1.0,
};

let lcms = null;
let profilePrinter = null;
let profileSRGB = null;
let xformTeal = null;
let xformPink = null;
let xformComposite = null;
let csvLut = null;
let screenCoveredDensityCurve = null;

async function init() {
  for (const key of ['teal', 'pink']) resetChannelControls(key);
  document.getElementById('method-csv').checked       = true;
  document.getElementById('screen-grain').checked     = true;
  document.getElementById('intent-relative').checked  = true;
  document.getElementById('reg-perfect').checked      = true;
  document.getElementById('btn-randomize').hidden     = true;
  const saved = parseFloat(localStorage.getItem('risoCalibrationFactor'));
  if (!isNaN(saved) && saved >= 0.25 && saved <= 4) state.calibrationFactor = saved;
  initDefaultImages();
  await Promise.all([initLCMS(), buildCsvLut()]);
  bindEvents();
  updateVisibility();
  updateEffectiveDpi();
}

function resetChannelControls(key) {
  state[key].inverted   = false;
  state[key].brightness = 0;
  state[key].contrast   = 0;
  document.getElementById(`invert-${key}`).checked              = false;
  document.getElementById(`brightness-${key}`).value            = 0;
  document.getElementById(`brightness-val-${key}`).textContent  = '0';
  document.getElementById(`contrast-${key}`).value              = 0;
  document.getElementById(`contrast-val-${key}`).textContent    = '0';
}

function makeWhiteImageData(w, h) {
  const lumas = new Uint8Array(w * h).fill(255);
  const raw = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    raw[i * 4]     = 255;
    raw[i * 4 + 1] = 255;
    raw[i * 4 + 2] = 255;
    raw[i * 4 + 3] = 255;
  }
  return { lumas, raw };
}

function initDefaultImages() {
  const size = DEFAULT_SIZE;
  for (const key of ['teal', 'pink']) {
    const { lumas, raw } = makeWhiteImageData(size, size);
    state[key].imageData = lumas;
    state[key].rawData   = raw;
    state[key].width     = size;
    state[key].height    = size;
    state[key].isDefault = true;
  }
}

function resizeDefaultToMatch(key) {
  const other = key === 'teal' ? 'pink' : 'teal';
  if (!state[key].isDefault) return;
  const { width, height } = state[other];
  if (width === 0 || height === 0) return;
  const { lumas, raw } = makeWhiteImageData(width, height);
  state[key].imageData = lumas;
  state[key].rawData   = raw;
  state[key].width     = width;
  state[key].height    = height;
}

async function initLCMS() {
  lcms = await instantiate({ locateFile: () => wasmUrl });

  const resp = await fetch(`./${ICC_FILE}`);
  if (!resp.ok) throw new Error(`Failed to fetch ICC profile: ${resp.status}`);
  const ab = await resp.arrayBuffer();
  const buf = new Uint8Array(ab);

  profilePrinter = lcms.cmsOpenProfileFromMem(buf, buf.byteLength);
  profileSRGB    = lcms.cmsCreate_sRGBProfile();

  buildTransforms(profilePrinter, profileSRGB);

  // Display ICC metadata via icc.mjs
  try {
    const iccBuf = makeBuffer(ab);
    const meta = parse(iccBuf);
    if (meta.description) {
      document.getElementById('icc-description').textContent = meta.description;
    }
    if (meta.copyright) {
      document.getElementById('icc-footer').textContent = meta.copyright;
    }
  } catch (_) {
    // Metadata parsing is best-effort; don't let it break the app
  }

  // Re-render if images were uploaded before lcms was ready
  scheduleRender();
}

async function buildCsvLut() {
  const resp = await fetch('./results.csv');
  if (!resp.ok) throw new Error(`Failed to fetch CSV: ${resp.status}`);
  const lines = (await resp.text()).trim().split('\n');

  const accumMap = new Map();
  for (let i = 1; i < lines.length; i++) {
    const [pHex, tHex, sHex] = lines[i].split(',').map(s => s.trim());
    const p = parseInt(pHex.slice(2, 4), 16);
    const t = parseInt(tHex.slice(2, 4), 16);
    const r = parseInt(sHex.slice(2, 4), 16);
    const g = parseInt(sHex.slice(4, 6), 16);
    const b = parseInt(sHex.slice(6, 8), 16);
    const key = p * 256 + t;
    if (!accumMap.has(key)) accumMap.set(key, { r: 0, g: 0, b: 0, count: 0 });
    const acc = accumMap.get(key);
    acc.r += r; acc.g += g; acc.b += b; acc.count++;
  }

  const pts = [];
  for (const [key, acc] of accumMap) {
    pts.push({ p: key >> 8, t: key & 0xFF,
               r: acc.r / acc.count, g: acc.g / acc.count, b: acc.b / acc.count });
  }

  const EPS = 1e-6;
  const lut = new Uint8Array(256 * 256 * 3);
  for (let tIdx = 0; tIdx < 256; tIdx++) {
    for (let pIdx = 0; pIdx < 256; pIdx++) {
      let wR = 0, wG = 0, wB = 0, wSum = 0;
      for (const pt of pts) {
        const dp = pIdx - pt.p, dt = tIdx - pt.t;
        const w = 1 / (dp * dp + dt * dt + EPS);
        wR += w * pt.r; wG += w * pt.g; wB += w * pt.b; wSum += w;
      }
      const base = (tIdx * 256 + pIdx) * 3;
      lut[base]     = Math.round(wR / wSum);
      lut[base + 1] = Math.round(wG / wSum);
      lut[base + 2] = Math.round(wB / wSum);
    }
  }
  csvLut = lut;
  screenCoveredDensityCurve = buildScreenCoveredDensityCurve(lut);
}

// Models screen-covered as a density shift applied before LUT lookup, so full-ink and
// no-ink are always unchanged and only the midtones darken.
// Shape: d' = d - A * sin(pi * d/255), amplitude A calibrated from one reference measurement
// (digital #76, grain-touch 5B8C94, screen-covered 51808A) using the LUT's own gradient.
function buildScreenCoveredDensityCurve(lut) {
  const REF_D = 0x76;
  const REF_SCREEN_LUMA = 0.2126 * 0x51 + 0.7152 * 0x80 + 0.0722 * 0x8A;
  const luma = (base) => 0.2126 * lut[base] + 0.7152 * lut[base + 1] + 0.0722 * lut[base + 2];
  const idx = (tD) => (tD * 256 + 255) * 3;
  const grainLuma = luma(idx(REF_D));
  // Central-difference: lower density value = more ink = darker, so REF_D+2 is lighter than REF_D-2
  const dLumaDDensity = (luma(idx(REF_D + 2)) - luma(idx(REF_D - 2))) / 4;
  const A = (grainLuma - REF_SCREEN_LUMA) / (dLumaDDensity * Math.sin(Math.PI * REF_D / 255));
  const curve = new Uint8Array(256);
  for (let d = 0; d < 256; d++) {
    curve[d] = Math.max(0, Math.min(255, Math.round(d - A * Math.sin(Math.PI * d / 255))));
  }
  return curve;
}

function buildTransforms(printer, srgb) {
  if (xformTeal)      { lcms.cmsDeleteTransform(xformTeal);      xformTeal      = null; }
  if (xformPink)      { lcms.cmsDeleteTransform(xformPink);      xformPink      = null; }
  if (xformComposite) { lcms.cmsDeleteTransform(xformComposite); xformComposite = null; }

  const flags = cmsFLAGS_SOFTPROOFING | cmsFLAGS_BLACKPOINTCOMPENSATION;
  const intent = state.renderIntent;
  xformTeal      = lcms.cmsCreateProofingTransform(srgb, TYPE_RGB_8, srgb, TYPE_RGB_8, printer, intent, INTENT_RELATIVE_COLORIMETRIC, flags);
  xformPink      = lcms.cmsCreateProofingTransform(srgb, TYPE_RGB_8, srgb, TYPE_RGB_8, printer, intent, INTENT_RELATIVE_COLORIMETRIC, flags);
  xformComposite = lcms.cmsCreateProofingTransform(srgb, TYPE_RGB_8, srgb, TYPE_RGB_8, printer, intent, INTENT_RELATIVE_COLORIMETRIC, flags);
}

function rebuildTransforms() {
  if (!lcms || !profilePrinter || !profileSRGB) return;
  buildTransforms(profilePrinter, profileSRGB);
  scheduleRender();
}

// ── Image processing ──────────────────────────────────────────────────────────

function processImage(rawImageData, key) {
  const { data, width, height } = rawImageData;
  const pixelCount = width * height;
  const lumas = new Uint8Array(pixelCount);
  let isGrayscale = true;

  for (let i = 0; i < pixelCount; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];

    if (Math.abs(r - g) > 2 || Math.abs(g - b) > 2) {
      isGrayscale = false;
    }

    lumas[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }

  resetChannelControls(key);
  state[key].imageData = lumas;
  state[key].rawData = new Uint8ClampedArray(data.buffer.slice(0, pixelCount * 4));
  state[key].width = width;
  state[key].height = height;
  state[key].isDefault = false;

  // Resize the other channel's default white image to match
  const other = key === 'teal' ? 'pink' : 'teal';
  resizeDefaultToMatch(other);

  document.getElementById(`warn-${key}`).hidden = isGrayscale;
  scheduleRender();
}

// ── TAC computation ───────────────────────────────────────────────────────────

function computeChannelTAC(key) {
  const ch = state[key];
  const count = ch.width * ch.height;
  if (count === 0) return null;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    sum += 255 - getDensity(ch.imageData[i], ch.inverted, ch.brightness, ch.contrast);
  }
  return (sum / count / 255) * 100;
}

function computeCompositeTAC(buf, count) {
  if (count === 0) return null;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    sum += (255 - buf[i * 3]) + (255 - buf[i * 3 + 1]);
  }
  return (sum / count / 255) * 100;
}

// ── Buffer construction ───────────────────────────────────────────────────────

function getDensity(luma, inverted, brightness, contrast) {
  let d = inverted ? 255 - luma : luma;
  // brightness: positive = less ink (lighter), negative = more ink (darker)
  d = d + brightness;
  // contrast: positive = more contrast, negative = less; scaled around midpoint 128
  if (contrast !== 0) {
    const factor = (contrast > 0)
      ? 1 + contrast / 100
      : 1 / (1 - contrast / 100);
    d = (d - 128) * factor + 128;
  }
  return Math.max(0, Math.min(255, Math.round(d)));
}

function buildSingleBuffer(key) {
  const ch = state[key];
  const count = ch.width * ch.height;
  const buf = new Uint8Array(count * 3);
  const isTeal = key === 'teal'; // teal → R channel, pink → G channel

  for (let i = 0; i < count; i++) {
    const d = getDensity(ch.imageData[i], ch.inverted, ch.brightness, ch.contrast);
    if (isTeal) {
      buf[i * 3]     = d;   // R=teal density
      buf[i * 3 + 1] = 255; // G=pink: 255 = no pink ink
    } else {
      buf[i * 3]     = 255; // R=teal: 255 = no teal ink
      buf[i * 3 + 1] = d;   // G=pink density
    }
    buf[i * 3 + 2] = 0;
  }
  return buf;
}

// Bilinear sample of the pink channel at a (possibly fractional) pixel position.
// Returns 255 (no ink) for out-of-bounds coordinates.
function samplePinkDensity(px, py) {
  const { imageData, width, height, inverted, brightness, contrast } = state.pink;
  const getPinkAt = (xi, yi) => {
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return 255;
    return getDensity(imageData[yi * width + xi], inverted, brightness, contrast);
  };
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const fx = px - x0;
  const fy = py - y0;
  return Math.round(
    getPinkAt(x0,     y0)     * (1 - fx) * (1 - fy) +
    getPinkAt(x0 + 1, y0)     *      fx  * (1 - fy) +
    getPinkAt(x0,     y0 + 1) * (1 - fx) *      fy  +
    getPinkAt(x0 + 1, y0 + 1) *      fx  *      fy
  );
}

// Yields back to the browser roughly every 16ms so the UI can update.
// Returns null if a newer render has been scheduled (this one is stale).
async function buildCompositeBufferAsync(w, h, version, onProgress) {
  const count = w * h;
  const buf = new Uint8Array(count * 3);
  const teal = state.teal;
  const pink = state.pink;
  const { perfect, dx, dy, angle } = state.misregistration;

  const cosA = perfect ? 1 : Math.cos(-angle * Math.PI / 180);
  const sinA = perfect ? 0 : Math.sin(-angle * Math.PI / 180);
  const cx = w / 2;
  const cy = h / 2;

  const YIELD_MS = 16;
  let lastYield = performance.now();

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const outIdx = (y * w + x) * 3;

      let tealDensity = 255;
      if (x < teal.width && y < teal.height) {
        tealDensity = getDensity(teal.imageData[y * teal.width + x], teal.inverted, teal.brightness, teal.contrast);
      }

      let pinkDensity;
      if (perfect) {
        pinkDensity = (x < pink.width && y < pink.height)
          ? getDensity(pink.imageData[y * pink.width + x], pink.inverted, pink.brightness, pink.contrast)
          : 255;
      } else {
        const tx = x - dx;
        const ty = y - dy;
        const px = cosA * (tx - cx) - sinA * (ty - cy) + cx;
        const py = sinA * (tx - cx) + cosA * (ty - cy) + cy;
        pinkDensity = samplePinkDensity(px, py);
      }

      buf[outIdx]     = tealDensity;
      buf[outIdx + 1] = pinkDensity;
      buf[outIdx + 2] = 0;
    }

    // Yield roughly once per frame so the browser can repaint progress
    const now = performance.now();
    if (now - lastYield >= YIELD_MS) {
      onProgress(y / h);
      await new Promise(r => setTimeout(r, 0));
      if (renderVersion !== version) return null;
      lastYield = performance.now();
    }
  }

  return buf;
}

const MISREG_MAX_PX = 12; // ~1mm at 300 DPI
const MISREG_MAX_DEG = 0.25;

function randomizeMisregistration() {
  state.misregistration.dx    = (Math.random() * 2 - 1) * MISREG_MAX_PX;
  state.misregistration.dy    = (Math.random() * 2 - 1) * MISREG_MAX_PX;
  state.misregistration.angle = (Math.random() * 2 - 1) * MISREG_MAX_DEG;
  scheduleRender();
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function setCanvasSize(canvasId, w, h) {
  const canvas = document.getElementById(canvasId);
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function renderRaw(key) {
  const ch = state[key];
  const canvas = setCanvasSize(`canvas-raw-${key}`, ch.width, ch.height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(ch.rawData, ch.width, ch.height), 0, 0);
}

function renderGrayscale(key) {
  const ch = state[key];
  const canvas = setCanvasSize(`canvas-gray-${key}`, ch.width, ch.height);
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(ch.width, ch.height);
  const count = ch.width * ch.height;

  for (let i = 0; i < count; i++) {
    const v = getDensity(ch.imageData[i], ch.inverted, ch.brightness, ch.contrast);
    imgData.data[i * 4]     = v;
    imgData.data[i * 4 + 1] = v;
    imgData.data[i * 4 + 2] = v;
    imgData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
}

function renderColored(key, xform) {
  const ch = state[key];
  const count = ch.width * ch.height;
  const canvas = setCanvasSize(`canvas-color-${key}`, ch.width, ch.height);
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(ch.width, ch.height);

  if (state.previewMode === 'csv' && csvLut) {
    const dc = state.screenType === 'screen-covered' ? screenCoveredDensityCurve : null;
    const isTeal = key === 'teal';
    for (let i = 0; i < count; i++) {
      const d = getDensity(ch.imageData[i], ch.inverted, ch.brightness, ch.contrast);
      const tD = dc ? dc[isTeal ? d : 255] : (isTeal ? d : 255);
      const pD = dc ? dc[isTeal ? 255 : d] : (isTeal ? 255 : d);
      const base = (tD * 256 + pD) * 3;
      imgData.data[i * 4]     = csvLut[base];
      imgData.data[i * 4 + 1] = csvLut[base + 1];
      imgData.data[i * 4 + 2] = csvLut[base + 2];
      imgData.data[i * 4 + 3] = 255;
    }
  } else {
    if (!lcms || !xform) return;
    const inputBuf = buildSingleBuffer(key);
    const out = lcms.cmsDoTransform(xform, inputBuf, count);
    for (let i = 0; i < count; i++) {
      imgData.data[i * 4]     = out[i * 3];
      imgData.data[i * 4 + 1] = out[i * 3 + 1];
      imgData.data[i * 4 + 2] = out[i * 3 + 2];
      imgData.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

async function renderComposite(progressShownRef) {
  const version = renderVersion;
  const w = Math.max(state.teal.width, state.pink.width);
  const h = Math.max(state.teal.height, state.pink.height);
  const count = w * h;

  const progressWrap = document.getElementById('composite-progress-wrap');
  const progressBar  = document.getElementById('composite-progress-bar');

  const onProgress = (p) => {
    if (progressShownRef.shown) progressBar.style.width = `${Math.round(30 + p * 70)}%`;
  };

  const inputBuf = await buildCompositeBufferAsync(w, h, version, onProgress);

  if (!inputBuf || renderVersion !== version) return;

  progressWrap.hidden = true;

  const tacVal = computeCompositeTAC(inputBuf, count);
  const tacEl = document.getElementById('tac-composite');
  tacEl.textContent = `TAC: ${tacVal !== null ? tacVal.toFixed(1) + '%' : '—'}`;
  tacEl.classList.toggle('over-limit', tacVal !== null && tacVal > 125);

  const canvas = setCanvasSize('canvas-composite', w, h);
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(w, h);

  if (state.previewMode === 'csv' && csvLut) {
    const dc = state.screenType === 'screen-covered' ? screenCoveredDensityCurve : null;
    for (let i = 0; i < count; i++) {
      const tD = dc ? dc[inputBuf[i * 3]]     : inputBuf[i * 3];
      const pD = dc ? dc[inputBuf[i * 3 + 1]] : inputBuf[i * 3 + 1];
      const base = (tD * 256 + pD) * 3;
      imgData.data[i * 4]     = csvLut[base];
      imgData.data[i * 4 + 1] = csvLut[base + 1];
      imgData.data[i * 4 + 2] = csvLut[base + 2];
      imgData.data[i * 4 + 3] = 255;
    }
  } else {
    if (!lcms || !xformComposite) return;
    const out = lcms.cmsDoTransform(xformComposite, inputBuf, count);
    for (let i = 0; i < count; i++) {
      imgData.data[i * 4]     = out[i * 3];
      imgData.data[i * 4 + 1] = out[i * 3 + 1];
      imgData.data[i * 4 + 2] = out[i * 3 + 2];
      imgData.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

async function renderAll() {
  const version = renderVersion;
  const progressWrap = document.getElementById('composite-progress-wrap');
  const progressBar  = document.getElementById('composite-progress-bar');
  const progressShownRef = { shown: false };
  const startTime = performance.now();
  let firstRenderMs = null;

  function maybeShowProgress() {
    if (progressShownRef.shown) return;
    const elapsed = performance.now() - startTime;
    if (firstRenderMs > 100 || elapsed > 500) {
      progressShownRef.shown = true;
      progressWrap.hidden = false;
    }
  }

  const syncRenders = [
    () => renderRaw('teal'),
    () => renderGrayscale('teal'),
    () => renderColored('teal', xformTeal),
    () => renderRaw('pink'),
    () => renderGrayscale('pink'),
    () => renderColored('pink', xformPink),
  ];

  for (let i = 0; i < syncRenders.length; i++) {
    const t0 = performance.now();
    syncRenders[i]();
    if (i === 0) firstRenderMs = performance.now() - t0;
    maybeShowProgress();
    if (progressShownRef.shown) progressBar.style.width = `${(i + 1) * 5}%`;
    await new Promise(r => setTimeout(r, 0));
    if (renderVersion !== version) {
      if (progressShownRef.shown) progressWrap.hidden = true;
      return;
    }
  }

  for (const key of ['teal', 'pink']) {
    const tac = computeChannelTAC(key);
    const el = document.getElementById(`tac-${key}`);
    el.textContent = `Coverage: ${tac !== null ? tac.toFixed(1) + '%' : '—'}`;
    el.classList.toggle('over-limit', tac !== null && tac > 75);
  }

  await renderComposite(progressShownRef);
  if (progressShownRef.shown) progressWrap.hidden = true;
  updateVisibility();
  runPrintWarnings();
  applyActualSizeScaling();
  drawRulers();
}

let renderPending = false;
let renderVersion = 0;

function scheduleRender() {
  renderVersion++;
  if (!renderPending) {
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      renderAll().catch(console.error);
    });
  }
}

// ── Visibility ────────────────────────────────────────────────────────────────

function updateVisibility() {
  // All rows are always visible now (default white images are always present)
  for (const id of ['row-raw', 'row-grayscale', 'row-colored', 'row-composite', 'row-warnings']) {
    document.getElementById(id).style.display = '';
  }
  for (const id of ['fig-raw-teal', 'fig-raw-pink', 'fig-gray-teal', 'fig-gray-pink', 'fig-color-teal', 'fig-color-pink', 'fig-composite']) {
    document.getElementById(id).style.display = '';
  }
}

// ── DPI detection ─────────────────────────────────────────────────────────────

function parseDpiFromArrayBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  const view  = new DataView(buffer);

  // PNG: 89 50 4E 47 signature
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    let offset = 8; // skip PNG signature
    while (offset + 12 <= bytes.length) {
      const chunkLen = view.getUint32(offset, false);
      const type = String.fromCharCode(bytes[offset+4], bytes[offset+5], bytes[offset+6], bytes[offset+7]);
      if (type === 'pHYs' && chunkLen >= 9) {
        const ppuX = view.getUint32(offset + 8, false);
        const unit = bytes[offset + 16];
        if (unit === 1 && ppuX > 0) return Math.round(ppuX / 39.3701);
        return 0;
      }
      if (type === 'IDAT' || type === 'IEND') break;
      offset += 12 + chunkLen; // length(4) + type(4) + data(chunkLen) + CRC(4)
    }
    return 0;
  }

  // JPEG: FF D8 signature
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xFF) break;
      const marker = bytes[offset + 1];
      const segLen = view.getUint16(offset + 2, false); // includes 2-byte length field
      if (marker === 0xE0 && segLen >= 16) { // APP0 / JFIF
        if (bytes[offset+4] === 0x4A && bytes[offset+5] === 0x46 &&
            bytes[offset+6] === 0x49 && bytes[offset+7] === 0x46) {
          const units = bytes[offset + 11];
          const xDensity = view.getUint16(offset + 12, false);
          if (units === 1 && xDensity > 0) return xDensity;
          if (units === 2 && xDensity > 0) return Math.round(xDensity * 2.54);
        }
        return 0;
      }
      if (marker === 0xDA) break; // SOS — start of scan data
      offset += 2 + segLen;
    }
    return 0;
  }

  return 0;
}

function updateEffectiveDpi() {
  const det = Math.max(state.dpiDetected.teal, state.dpiDetected.pink);
  const dpi = state.dpiOverride ? state.dpiManual : (det > 0 ? det : 300);
  state.effectiveDpi = dpi;
  const readout = document.getElementById('dpi-readout');
  if (readout) {
    const label = state.dpiOverride ? 'manual' : (det > 0 ? 'from file' : 'default');
    readout.textContent = `${dpi} DPI (${label})`;
  }
  drawRulers();
  runPrintWarnings();
}

// ── Physical size display ──────────────────────────────────────────────────────

function drawRulers() {
  const rulerH = document.getElementById('canvas-ruler-h');
  const rulerV = document.getElementById('canvas-ruler-v');
  if (!rulerH || !rulerV) return;

  const composite = document.getElementById('canvas-composite');
  const cw = composite.width;
  const ch = composite.height;
  if (cw === 0 || ch === 0) { rulerH.width = 0; rulerV.height = 0; return; }

  const dpi = state.effectiveDpi;
  const RULER_PX = 24; // thickness of ruler strip in canvas pixels

  rulerH.width  = cw;
  rulerH.height = RULER_PX;
  rulerV.width  = RULER_PX;
  rulerV.height = ch;

  drawRulerCanvas(rulerH, cw, RULER_PX, dpi, 'horizontal');
  drawRulerCanvas(rulerV, RULER_PX, ch, dpi, 'vertical');
}

function drawRulerCanvas(canvas, w, h, dpi, orientation) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, w, h);

  const isH = orientation === 'horizontal';
  const length = isH ? w : h;

  // Draw ticks for inches (top/left half of ruler) and cm (bottom/right half)
  const rulerMid = isH ? h / 2 : w / 2;

  function drawTick(pos, tickLen, color, label, labelSide) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (isH) {
      const y0 = labelSide === 'top' ? 0 : h - tickLen;
      ctx.moveTo(pos + 0.5, y0);
      ctx.lineTo(pos + 0.5, y0 + tickLen);
    } else {
      const x0 = labelSide === 'top' ? 0 : w - tickLen;
      ctx.moveTo(x0, pos + 0.5);
      ctx.lineTo(x0 + tickLen, pos + 0.5);
    }
    ctx.stroke();

    if (label !== null) {
      ctx.fillStyle = color;
      ctx.font = '8px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.textAlign = isH ? 'left' : 'left';
      const LABEL_OFFSET = 2;
      if (isH) {
        const y = labelSide === 'top' ? tickLen + LABEL_OFFSET : h - tickLen - 9;
        ctx.fillText(label, pos + 2, y);
      } else {
        const x = labelSide === 'top' ? tickLen + LABEL_OFFSET : w - tickLen - 2;
        ctx.fillText(label, x, pos + 1);
      }
    }
  }

  // Inches (top/left half of ruler strip)
  const inPx = dpi;
  const inSubdiv = [
    { frac: 1,    tick: 10, label: true  },
    { frac: 0.5,  tick: 7,  label: false },
    { frac: 0.25, tick: 4,  label: false },
  ];
  for (const { frac, tick, label } of inSubdiv) {
    const step = inPx * frac;
    for (let pos = 0; pos < length; pos += step) {
      const p = Math.round(pos);
      const lbl = (label && pos > 0) ? String(Math.round(pos / inPx)) + '"' : null;
      drawTick(p, tick, '#666', lbl, 'top');
    }
  }

  // cm (bottom/right half of ruler strip)
  const cmPx = dpi / 2.54;
  const cmSubdiv = [
    { frac: 1,   tick: 10, label: true  },
    { frac: 0.5, tick: 6,  label: false },
    { frac: 0.1, tick: 3,  label: false },
  ];
  for (const { frac, tick, label } of cmSubdiv) {
    const step = cmPx * frac;
    for (let pos = 0; pos < length; pos += step) {
      const p = Math.round(pos);
      const lbl = (label && pos > 0) ? String(Math.round(pos / cmPx)) : null;
      drawTick(p, tick, '#555', lbl, 'bottom');
    }
  }
}

function applyActualSizeScaling() {
  const layout    = document.getElementById('ruler-layout');
  const composite = document.getElementById('canvas-composite');
  const rulerH    = document.getElementById('canvas-ruler-h');
  const rulerV    = document.getElementById('canvas-ruler-v');
  if (!layout || !composite) return;

  if (state.actualSizeMode && composite.width > 0 && composite.height > 0) {
    const cssW = Math.round((composite.width  / state.effectiveDpi) * 96 * state.calibrationFactor);
    const cssH = Math.round((composite.height / state.effectiveDpi) * 96 * state.calibrationFactor);
    composite.style.width    = `${cssW}px`;
    composite.style.height   = `${cssH}px`;
    composite.style.maxWidth = 'none';
    if (rulerH) { rulerH.style.width = `${cssW}px`; }
    if (rulerV) { rulerV.style.height = `${cssH}px`; }
    layout.style.gridTemplateColumns = `24px ${cssW}px`;
    layout.style.gridTemplateRows    = `24px ${cssH}px`;
    layout.classList.add('actual-size');
  } else {
    composite.style.width    = '';
    composite.style.height   = '';
    composite.style.maxWidth = '';
    if (rulerH) { rulerH.style.width  = ''; }
    if (rulerV) { rulerV.style.height = ''; }
    layout.style.gridTemplateColumns = '';
    layout.style.gridTemplateRows    = '';
    layout.classList.remove('actual-size');
  }
}

function updateCalibrationBar(factor) {
  const bar = document.getElementById('calibration-bar');
  const val = document.getElementById('calibration-val');
  if (!bar || !val) return;
  // 5cm reference: at default 96 CSS px/inch → 5 * 96/2.54 ≈ 189px
  bar.style.width = `${Math.round(5 * 96 / 2.54 * factor)}px`;
  val.textContent = `${Math.round(factor * 100)}%`;
}

function openCalibrationWidget() {
  document.getElementById('calibration-widget').hidden = false;
  const slider = document.getElementById('calibration-slider');
  slider.value = state.calibrationFactor;
  updateCalibrationBar(state.calibrationFactor);
}

function confirmCalibration() {
  state.calibrationFactor = Number(document.getElementById('calibration-slider').value);
  localStorage.setItem('risoCalibrationFactor', state.calibrationFactor);
  document.getElementById('calibration-widget').hidden = true;
  applyActualSizeScaling();
}

function closeCalibrationWidget() {
  document.getElementById('calibration-widget').hidden = true;
  applyActualSizeScaling();
}

// ── Print warnings ────────────────────────────────────────────────────────────

function countSolidPixels(key, xMin, xMax, yMin, yMax) {
  const ch = state[key];
  const w = ch.width, h = ch.height;
  if (w === 0 || h === 0) return 0;
  xMin = Math.max(0, xMin); xMax = Math.min(w, xMax);
  yMin = Math.max(0, yMin); yMax = Math.min(h, yMax);
  let count = 0;
  for (let y = yMin; y < yMax; y++) {
    for (let x = xMin; x < xMax; x++) {
      if (getDensity(ch.imageData[y * w + x], ch.inverted, ch.brightness, ch.contrast) <= 12) count++;
    }
  }
  return count;
}

function runPrintWarnings() {
  const list = document.getElementById('warnings-list');
  if (!list) return;
  const warnings = [];
  const dpi = state.effectiveDpi;
  const pxPerCm = dpi / 2.54;

  // Size warning — use the uploaded channel dimensions (they match after resizeDefaultToMatch)
  const uploaded = ['teal', 'pink'].find(k => !state[k].isDefault);
  if (uploaded) {
    const { width: w, height: h } = state[uploaded];
    if (w / dpi > 8.5 || h / dpi > 14) {
      const wIn = (w / dpi).toFixed(2), hIn = (h / dpi).toFixed(2);
      warnings.push(`Image too large: ${wIn}″ × ${hIn}″ (max 8.5″ × 14″)`);
    }
  }

  for (const key of ['teal', 'pink']) {
    const ch = state[key];
    const w = ch.width, h = ch.height;
    if (w === 0 || h === 0) continue;
    const label = key === 'teal' ? 'Light Teal' : 'Fluorescent Pink';

    // Large solid area: > 3 cm²
    const solidAll = countSolidPixels(key, 0, w, 0, h);
    const solidAllCm2 = solidAll / (pxPerCm * pxPerCm);
    if (solidAllCm2 > 3) {
      warnings.push(`${label}: ${solidAllCm2.toFixed(1)} cm² of ≥95% solid coverage (limit: 3 cm²)`);
    }

    // Pickup area: top 1"
    const pickupRows = Math.round(dpi);
    const solidPickup = countSolidPixels(key, 0, w, 0, pickupRows);
    if (solidPickup / (pxPerCm * pxPerCm) > 1) {
      warnings.push(`${label}: heavy ink in pickup area (top 1″)`);
    }

    // Feed roller: center ±1" vertical strip
    const cx = Math.floor(w / 2);
    const solidRoller = countSolidPixels(key, cx - Math.round(dpi), cx + Math.round(dpi), 0, h);
    if (solidRoller / (pxPerCm * pxPerCm) > 1) {
      warnings.push(`${label}: heavy ink in feed roller zone (center ±1″)`);
    }

    // Margin bleed: any ink within 0.25" of edge (only warn if file exceeds 8"×13.5")
    if (!ch.isDefault && (w / dpi > 8 || h / dpi > 13.5)) {
      const margin = Math.round(dpi * 0.25);
      if (checkMarginInk(key, margin)) {
        warnings.push(`${label}: ink within 0.25″ margin`);
      }
    }
  }

  list.innerHTML = warnings.length === 0
    ? '<li class="warning-item warning-ok">No warnings</li>'
    : warnings.map(w => `<li class="warning-item">${w}</li>`).join('');
}

function checkMarginInk(key, marginPx) {
  const ch = state[key];
  const w = ch.width, h = ch.height;
  if (w === 0 || h === 0 || marginPx <= 0) return false;
  const zones = [
    [0, w, 0, marginPx],
    [0, w, h - marginPx, h],
    [0, marginPx, 0, h],
    [w - marginPx, w, 0, h],
  ];
  for (const [x0, x1, y0, y1] of zones) {
    const xMin = Math.max(0, x0), xMax = Math.min(w, x1);
    const yMin = Math.max(0, y0), yMax = Math.min(h, y1);
    for (let y = yMin; y < yMax; y++) {
      for (let x = xMin; x < xMax; x++) {
        if (getDensity(ch.imageData[y * w + x], ch.inverted, ch.brightness, ch.contrast) < 250) return true;
      }
    }
  }
  return false;
}

// ── Upload handling ───────────────────────────────────────────────────────────

function handleUploadFile(file, key) {
  if (!file || !file.type.startsWith('image/')) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const buffer = e.target.result;
    state.dpiDetected[key] = parseDpiFromArrayBuffer(buffer);
    updateEffectiveDpi();

    const url = URL.createObjectURL(new Blob([buffer], { type: file.type }));
    const img = new Image();
    img.src = url;
    await img.decode();
    URL.revokeObjectURL(url);

    const offscreen = document.createElement('canvas');
    offscreen.width  = img.naturalWidth;
    offscreen.height = img.naturalHeight;
    const ctx = offscreen.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const rawData = ctx.getImageData(0, 0, offscreen.width, offscreen.height);
    processImage(rawData, key);
    updateThumbnail(offscreen, key);
  };
  reader.readAsArrayBuffer(file);
}

function updateThumbnail(srcCanvas, key) {
  const thumb = document.getElementById(`thumb-${key}`);
  const prompt = document.querySelector(`#upload-area-${key} .upload-prompt`);
  const MAX = 200;
  const scale = Math.min(1, MAX / Math.max(srcCanvas.width, srcCanvas.height));
  thumb.width  = Math.round(srcCanvas.width  * scale);
  thumb.height = Math.round(srcCanvas.height * scale);
  thumb.getContext('2d').drawImage(srcCanvas, 0, 0, thumb.width, thumb.height);
  thumb.hidden  = false;
  prompt.hidden = true;
}

// ── Events ────────────────────────────────────────────────────────────────────

function bindEvents() {
  for (const key of ['teal', 'pink']) {
    // File input
    document.getElementById(`upload-${key}`).addEventListener('change', (e) => {
      handleUploadFile(e.target.files[0], key);
    });

    // Invert toggle
    document.getElementById(`invert-${key}`).addEventListener('change', (e) => {
      state[key].inverted = e.target.checked;
      scheduleRender();
    });

    // Brightness/contrast sliders
    document.getElementById(`brightness-${key}`).addEventListener('input', (e) => {
      state[key].brightness = Number(e.target.value);
      document.getElementById(`brightness-val-${key}`).textContent = e.target.value;
      scheduleRender();
    });
    document.getElementById(`contrast-${key}`).addEventListener('input', (e) => {
      state[key].contrast = Number(e.target.value);
      document.getElementById(`contrast-val-${key}`).textContent = e.target.value;
      scheduleRender();
    });

    // Click to open file picker
    const area = document.getElementById(`upload-area-${key}`);
    area.addEventListener('click', () => {
      document.getElementById(`upload-${key}`).click();
    });

    // Drag-and-drop
    area.addEventListener('dragover', (e) => {
      e.preventDefault();
      area.classList.add('drag-over');
    });
    area.addEventListener('dragleave', (e) => {
      if (!area.contains(e.relatedTarget)) {
        area.classList.remove('drag-over');
      }
    });
    area.addEventListener('drop', (e) => {
      e.preventDefault();
      area.classList.remove('drag-over');
      handleUploadFile(e.dataTransfer.files[0], key);
    });
  }

  // Preview method toggle
  for (const id of ['method-icc', 'method-csv']) {
    document.getElementById(id).addEventListener('change', (e) => {
      if (!e.target.checked) return;
      state.previewMode = e.target.value;
      document.getElementById('intent-bar').classList.toggle('disabled', state.previewMode === 'csv');
      document.getElementById('screen-type-bar').hidden = state.previewMode !== 'csv';
      scheduleRender();
    });
  }

  // Screen type toggle (grain-touch vs screen-covered)
  for (const id of ['screen-grain', 'screen-covered']) {
    document.getElementById(id).addEventListener('change', (e) => {
      if (!e.target.checked) return;
      state.screenType = e.target.value;
      scheduleRender();
    });
  }

  // Render intent toggle
  document.getElementById('intent-perceptual').addEventListener('change', () => {
    state.renderIntent = INTENT_PERCEPTUAL;
    rebuildTransforms();
  });
  document.getElementById('intent-relative').addEventListener('change', () => {
    state.renderIntent = INTENT_RELATIVE_COLORIMETRIC;
    rebuildTransforms();
  });

  // Registration toggle
  document.getElementById('reg-perfect').addEventListener('change', (e) => {
    state.misregistration.perfect = e.target.checked;
    document.getElementById('btn-randomize').hidden = e.target.checked;
    if (e.target.checked) {
      state.misregistration.dx = 0;
      state.misregistration.dy = 0;
      state.misregistration.angle = 0;
      scheduleRender();
    } else {
      randomizeMisregistration();
    }
  });
  document.getElementById('btn-randomize').addEventListener('click', randomizeMisregistration);

  // Preview row collapse toggles
  for (const rowId of ['row-raw', 'row-grayscale', 'row-colored', 'row-composite', 'row-warnings']) {
    const btn = document.querySelector(`#${rowId} .row-toggle`);
    if (btn) {
      btn.addEventListener('click', () => {
        const row = document.getElementById(rowId);
        const isCollapsed = row.classList.toggle('collapsed');
        btn.setAttribute('aria-expanded', String(!isCollapsed));
      });
    }
  }

  // DPI controls
  document.getElementById('dpi-override').addEventListener('change', (e) => {
    state.dpiOverride = e.target.checked;
    document.getElementById('dpi-manual').disabled = !e.target.checked;
    updateEffectiveDpi();
  });
  document.getElementById('dpi-manual').addEventListener('change', (e) => {
    state.dpiManual = Number(e.target.value);
    updateEffectiveDpi();
  });
  document.getElementById('actual-size-mode').addEventListener('change', (e) => {
    state.actualSizeMode = e.target.checked;
    applyActualSizeScaling();
  });
  document.getElementById('btn-calibrate').addEventListener('click', openCalibrationWidget);
  document.getElementById('btn-calibrate-confirm').addEventListener('click', confirmCalibration);
  document.getElementById('btn-calibrate-cancel').addEventListener('click', closeCalibrationWidget);
  document.getElementById('calibration-slider').addEventListener('input', (e) => {
    updateCalibrationBar(Number(e.target.value));
  });
}

init().catch(console.error);
