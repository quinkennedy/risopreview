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
  renderIntent: INTENT_PERCEPTUAL,
};

let lcms = null;
let profilePrinter = null;
let profileSRGB = null;
let xformTeal = null;
let xformPink = null;
let xformComposite = null;

async function init() {
  initDefaultImages();
  await initLCMS();
  bindEvents();
  updateVisibility();
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

  const printer = lcms.cmsOpenProfileFromMem(buf, buf.byteLength);
  const srgb    = lcms.cmsCreate_sRGBProfile();

  buildTransforms(printer, srgb);

  lcms.cmsCloseProfile(printer);
  lcms.cmsCloseProfile(srgb);

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

async function rebuildTransforms() {
  if (!lcms) return;
  const resp = await fetch(`./${ICC_FILE}`);
  if (!resp.ok) return;
  const ab = await resp.arrayBuffer();
  const buf = new Uint8Array(ab);
  const printer = lcms.cmsOpenProfileFromMem(buf, buf.byteLength);
  const srgb    = lcms.cmsCreate_sRGBProfile();
  buildTransforms(printer, srgb);
  lcms.cmsCloseProfile(printer);
  lcms.cmsCloseProfile(srgb);
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

function buildCompositeBuffer(w, h) {
  const count = w * h;
  const buf = new Uint8Array(count * 3);
  const teal = state.teal;
  const pink = state.pink;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const outIdx = (y * w + x) * 3;

      let tealDensity = 255;
      if (x < teal.width && y < teal.height) {
        tealDensity = getDensity(teal.imageData[y * teal.width + x], teal.inverted, teal.brightness, teal.contrast);
      }

      let pinkDensity = 255;
      if (x < pink.width && y < pink.height) {
        pinkDensity = getDensity(pink.imageData[y * pink.width + x], pink.inverted, pink.brightness, pink.contrast);
      }

      buf[outIdx]     = tealDensity;
      buf[outIdx + 1] = pinkDensity;
      buf[outIdx + 2] = 0;
    }
  }
  return buf;
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

function renderComposite() {
  if (!lcms || !xformComposite) return;
  const w = Math.max(state.teal.width, state.pink.width);
  const h = Math.max(state.teal.height, state.pink.height);
  const count = w * h;
  const inputBuf = buildCompositeBuffer(w, h);
  const out = lcms.cmsDoTransform(xformComposite, inputBuf, count);
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

function renderAll() {
  for (const key of ['teal', 'pink']) {
    renderRaw(key);
    renderGrayscale(key);
    renderColored(key, key === 'teal' ? xformTeal : xformPink);
  }
  renderComposite();
  updateVisibility();
}

let renderPending = false;
function scheduleRender() {
  if (!renderPending) {
    renderPending = true;
    requestAnimationFrame(() => {
      renderAll();
      renderPending = false;
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
  document.getElementById('intent-perceptual').addEventListener('change', async () => {
    state.renderIntent = INTENT_PERCEPTUAL;
    await rebuildTransforms();
  });
  document.getElementById('intent-relative').addEventListener('change', async () => {
    state.renderIntent = INTENT_RELATIVE_COLORIMETRIC;
    await rebuildTransforms();
  });

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
