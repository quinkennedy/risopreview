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
};

let lcms = null;
let profilePrinter = null;
let profileSRGB = null;
let xformTeal = null;
let xformPink = null;
let xformComposite = null;

async function init() {
  for (const key of ['teal', 'pink']) resetChannelControls(key);
  initDefaultImages();
  await initLCMS();
  bindEvents();
  updateVisibility();
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
  if (!lcms || !xform) return;
  const ch = state[key];
  const count = ch.width * ch.height;
  const inputBuf = buildSingleBuffer(key);
  const out = lcms.cmsDoTransform(xform, inputBuf, count);
  const canvas = setCanvasSize(`canvas-color-${key}`, ch.width, ch.height);
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(ch.width, ch.height);

  for (let i = 0; i < count; i++) {
    imgData.data[i * 4]     = out[i * 3];
    imgData.data[i * 4 + 1] = out[i * 3 + 1];
    imgData.data[i * 4 + 2] = out[i * 3 + 2];
    imgData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
}

async function renderComposite(progressShownRef) {
  if (!lcms || !xformComposite) return;
  const version = renderVersion;
  const w = Math.max(state.teal.width, state.pink.width);
  const h = Math.max(state.teal.height, state.pink.height);
  const count = w * h;

  const progressWrap = document.getElementById('composite-progress-wrap');
  const progressBar  = document.getElementById('composite-progress-bar');

  const onProgress = (p) => {
    if (progressShownRef.shown) progressBar.style.width = `${Math.round(p * 100)}%`;
  };

  const inputBuf = await buildCompositeBufferAsync(w, h, version, onProgress);

  if (!inputBuf || renderVersion !== version) {
    return;
  }

  const out = lcms.cmsDoTransform(xformComposite, inputBuf, count);
  progressWrap.hidden = true;

  const canvas = setCanvasSize('canvas-composite', w, h);
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(w, h);

  for (let i = 0; i < count; i++) {
    imgData.data[i * 4]     = out[i * 3];
    imgData.data[i * 4 + 1] = out[i * 3 + 1];
    imgData.data[i * 4 + 2] = out[i * 3 + 2];
    imgData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
}

async function renderAll() {
  const version = renderVersion;
  const progressWrap = document.getElementById('composite-progress-wrap');
  const progressBar  = document.getElementById('composite-progress-bar');
  const progressShownRef = { shown: false };

  const showTimer = setTimeout(() => {
    if (renderVersion === version) {
      progressShownRef.shown = true;
      progressBar.style.width = '0%';
      progressWrap.hidden = false;
    }
  }, 500);

  for (const key of ['teal', 'pink']) {
    renderRaw(key);
    renderGrayscale(key);
    renderColored(key, key === 'teal' ? xformTeal : xformPink);
  }
  await renderComposite(progressShownRef);
  clearTimeout(showTimer);
  if (progressShownRef.shown) progressWrap.hidden = true;
  updateVisibility();
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
  for (const id of ['row-raw', 'row-grayscale', 'row-colored', 'row-composite']) {
    document.getElementById(id).style.display = '';
  }
  for (const id of ['fig-raw-teal', 'fig-raw-pink', 'fig-gray-teal', 'fig-gray-pink', 'fig-color-teal', 'fig-color-pink', 'fig-composite']) {
    document.getElementById(id).style.display = '';
  }
}

// ── Upload handling ───────────────────────────────────────────────────────────

function handleUploadFile(file, key) {
  if (!file || !file.type.startsWith('image/')) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const img = new Image();
    img.src = e.target.result;
    await img.decode();
    const offscreen = document.createElement('canvas');
    offscreen.width  = img.naturalWidth;
    offscreen.height = img.naturalHeight;
    const ctx = offscreen.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const rawData = ctx.getImageData(0, 0, offscreen.width, offscreen.height);
    processImage(rawData, key);
    updateThumbnail(offscreen, key);
  };
  reader.readAsDataURL(file);
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
  for (const rowId of ['row-raw', 'row-grayscale', 'row-colored', 'row-composite']) {
    const btn = document.querySelector(`#${rowId} .row-toggle`);
    if (btn) {
      btn.addEventListener('click', () => {
        const row = document.getElementById(rowId);
        const isCollapsed = row.classList.toggle('collapsed');
        btn.setAttribute('aria-expanded', String(!isCollapsed));
      });
    }
  }
}

init().catch(console.error);
