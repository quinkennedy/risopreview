# Riso Print Preview

Static site that previews images as two-color risograph prints using an ICC color profile. Built with Vite.

## Dev server

```
npm run dev
```

Build for production (outputs to `dist/`):

```
npm run build
```

## ICC profile — color channel semantics

The profile (`[colorshift] light-teal fluorescent-pink - preview (beta).icc`) has **RGB input space** where each channel represents an ink density:

- **R = Light Teal** ink density
- **G = Fluorescent Pink** ink density
- **B = unused** (always 0)

White pixel (luma=255) = no ink = channel value 255. Black pixel (luma=0) = full ink = channel value 0. Density is `luma` directly. The unused ink channel in single-layer previews must be set to 255 (not 0) to suppress that ink.

## Three-transform architecture

Three separate lcms **proofing** transforms are created at init time — one for teal alone, one for pink alone, one for the composite. Each uses `cmsCreateProofingTransform(srgb, TYPE_RGB_8, srgb, TYPE_RGB_8, printer, INTENT_PERCEPTUAL, INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_SOFTPROOFING | cmsFLAGS_BLACKPOINTCOMPENSATION)`.

The printer profile acts as the *proof device* (not the source) — this is the correct way to use a preview/soft-proof ICC profile. Source and output are both sRGB; the profile simulates how the Riso will render the input. The composite passes `(tealDensity, pinkDensity, 0)` — i.e. `(R=teal, G=pink, B=0)` — directly through the ICC LUT, which models ink interaction natively. No manual multiply blending.

## lcms-wasm

Loaded via the `lcms-wasm` npm package. Vite's `vite-plugin-wasm` and `vite-plugin-top-level-await` handle WASM loading automatically. The wasm file URL is imported with `import wasmUrl from 'lcms-wasm/dist/lcms.wasm?url'` and passed to `instantiate({ locateFile: () => wasmUrl })`.

## icc (lovell/icc)

Used only for displaying the profile description and copyright in the UI — does **not** parse LUT or color transformation data. Requires a small Node Buffer compatibility shim (`makeBuffer` in `app.js`) since it uses `readUInt32BE` etc.
