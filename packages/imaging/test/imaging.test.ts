import { describe, expect, it } from 'vitest';
import {
  createRaster,
  getPixel,
  setPixel,
  applyAdjustment,
  curveLut,
  levelsLut,
  parseCubeLut,
  formatCubeLut,
  lutFromFunction,
  applyLut3D,
  gaussianBlur,
  applyFilter,
  FILTER_DEFAULTS,
  blendPixel,
  composite,
  rasterizeSelection,
  maskCoverage,
  magicWand,
  quickSelect,
  objectSelect,
  combineMasks,
  invertMask,
  maskBounds,
  contentAwareFill,
  healDab,
  extendCanvas,
  resizeBilinear,
  resizeLanczos,
  upscale,
  removeBackground,
  transferStyle,
  meanColor,
  histogram,
  createMask,
  type Raster,
} from '../src/index.js';
import { BLEND_MODES, type FilterKind } from '@omnix/core';

function checker(w: number, h: number, a: [number, number, number, number], b: [number, number, number, number], size = 4): Raster {
  const r = createRaster(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(r, x, y, (Math.floor(x / size) + Math.floor(y / size)) % 2 ? a : b);
  return r;
}

describe('adjustments', () => {
  it('builds monotone curves that pass through control points', () => {
    const lut = curveLut([
      [0, 0],
      [128, 180],
      [255, 255],
    ]);
    expect(lut[0]).toBe(0);
    expect(lut[128]).toBe(180);
    expect(lut[255]).toBe(255);
    for (let i = 1; i < 256; i++) expect(lut[i]!).toBeGreaterThanOrEqual(lut[i - 1]!);
  });

  it('applies levels, invert and brightness/contrast', () => {
    const l = levelsLut(50, 200, 1, 0, 255);
    expect(l[50]).toBe(0);
    expect(l[200]).toBe(255);
    const r = createRaster(1, 1, [10, 100, 200, 255]);
    expect(getPixel(applyAdjustment(r, { kind: 'invert' }), 0, 0)).toEqual([245, 155, 55, 255]);
    const bright = applyAdjustment(r, { kind: 'brightnessContrast', brightness: 50, contrast: 0 });
    expect(getPixel(bright, 0, 0)[0]).toBeGreaterThan(10);
  });

  it('warms and cools with temperature and hue/sat', () => {
    const gray = createRaster(1, 1, [128, 128, 128, 255]);
    const warm = getPixel(applyAdjustment(gray, { kind: 'temperature', amount: 50 }), 0, 0);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    const red = createRaster(1, 1, [255, 0, 0, 255]);
    const desat = getPixel(applyAdjustment(red, { kind: 'hueSaturation', hue: 0, saturation: -100, lightness: 0 }), 0, 0);
    expect(desat[0]).toBe(desat[1]);
    const shifted = getPixel(applyAdjustment(red, { kind: 'hueSaturation', hue: 120, saturation: 0, lightness: 0 }), 0, 0);
    expect(shifted[1]).toBeGreaterThan(200);
  });

  it('color balance shifts shadows toward the requested color', () => {
    const dark = createRaster(1, 1, [30, 30, 30, 255]);
    const p = getPixel(applyAdjustment(dark, { kind: 'colorBalance', shadows: [0, 0, 50], midtones: [0, 0, 0], highlights: [0, 0, 0] }), 0, 0);
    expect(p[2]).toBeGreaterThan(30);
  });
});

describe('3D LUTs', () => {
  it('round-trips .cube text and applies an identity LUT losslessly', () => {
    const identity = lutFromFunction(17, (r, g, b) => [r, g, b], 'Identity');
    const parsed = parseCubeLut(formatCubeLut(identity));
    expect(parsed.size).toBe(17);
    expect(parsed.title).toBe('Identity');
    const r = createRaster(2, 1, [37, 140, 222, 255]);
    const out = applyLut3D(r, parsed, 1);
    const p = getPixel(out, 0, 0);
    expect(Math.abs(p[0] - 37)).toBeLessThanOrEqual(1);
    expect(Math.abs(p[2] - 222)).toBeLessThanOrEqual(1);
  });

  it('applies a color-swapping LUT with intensity', () => {
    const swap = lutFromFunction(9, (r, g, b) => [b, g, r]);
    const r = createRaster(1, 1, [255, 0, 0, 255]);
    expect(getPixel(applyLut3D(r, swap, 1), 0, 0)).toEqual([0, 0, 255, 255]);
    const half = getPixel(applyLut3D(r, swap, 0.5), 0, 0);
    expect(half[0]).toBeGreaterThan(100);
    expect(half[2]).toBeGreaterThan(100);
  });

  it('rejects malformed LUTs', () => {
    expect(() => parseCubeLut('LUT_3D_SIZE 2\n0 0 0\n')).toThrow();
    expect(() => parseCubeLut('LUT_1D_SIZE 2')).toThrow();
  });
});

describe('filters', () => {
  it('blur preserves mean and does not darken transparent edges', () => {
    const r = checker(16, 16, [255, 255, 255, 255], [0, 0, 0, 255]);
    const b = gaussianBlur(r, 3);
    const m1 = meanColor(r);
    const m2 = meanColor(b);
    expect(Math.abs(m1[0] - m2[0])).toBeLessThan(3);
    const half = createRaster(8, 8);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) setPixel(half, x, y, [255, 0, 0, 255]);
    const hb = gaussianBlur(half, 2);
    const edge = getPixel(hb, 4, 4);
    expect(edge[0]).toBeGreaterThan(240);
    expect(edge[3]).toBeLessThan(255);
  });

  it('runs every filter with defaults', () => {
    const r = checker(12, 12, [200, 50, 20, 255], [20, 60, 200, 255]);
    for (const f of Object.keys(FILTER_DEFAULTS) as FilterKind[]) {
      const out = applyFilter(r, f);
      expect(out.width).toBe(12);
      expect(out.data.length).toBe(r.data.length);
    }
    const g = getPixel(applyFilter(r, 'grayscale'), 0, 0);
    expect(g[0]).toBe(g[1]);
  });
});

describe('blend modes', () => {
  it('matches reference results for common modes', () => {
    const bd: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
    const s: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
    expect(blendPixel('multiply', bd, s)[0]).toBeCloseTo(0.25);
    expect(blendPixel('screen', bd, s)[0]).toBeCloseTo(0.75);
    expect(blendPixel('difference', bd, s)[0]).toBeCloseTo(0);
    expect(blendPixel('normal', bd, [1, 0, 0, 0.5])[0]).toBeCloseTo(0.75);
    // Over a transparent backdrop every mode behaves like normal.
    for (const m of BLEND_MODES) {
      const out = blendPixel(m, [0, 0, 0, 0], [0.2, 0.4, 0.6, 1]);
      expect(out[0]).toBeCloseTo(0.2);
      expect(out[3]).toBeCloseTo(1);
    }
    const lumOut = blendPixel('luminosity', [1, 0, 0, 1], [0.5, 0.5, 0.5, 1]);
    expect(lumOut[0]).toBeGreaterThan(lumOut[1]);
  });

  it('composites with opacity, offset and mask', () => {
    const dst = createRaster(4, 4, [0, 0, 0, 255]);
    const src = createRaster(2, 2, [255, 255, 255, 255]);
    const mask = createMask(2, 2, 255);
    mask.data[0] = 0;
    const out = composite(dst, src, 'normal', 0.5, 1, 1, mask);
    expect(getPixel(out, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(getPixel(out, 1, 1)).toEqual([0, 0, 0, 255]); // masked
    expect(getPixel(out, 2, 2)[0]).toBeCloseTo(128, -1);
  });
});

describe('selections', () => {
  it('rasterizes rect and ellipse selections with sensible coverage', () => {
    const rect = rasterizeSelection({ kind: 'rect', x: 0, y: 0, width: 50, height: 100 }, 100, 100);
    expect(maskCoverage(rect)).toBeCloseTo(0.5, 2);
    const ell = rasterizeSelection({ kind: 'ellipse', x: 0, y: 0, width: 100, height: 100 }, 100, 100);
    expect(maskCoverage(ell)).toBeCloseTo(Math.PI / 4, 1);
    const feathered = rasterizeSelection({ kind: 'rect', x: 25, y: 25, width: 50, height: 50, feather: 4 }, 100, 100);
    expect(feathered.data[50 * 100 + 25]!).toBeGreaterThan(0);
    expect(feathered.data[50 * 100 + 25]!).toBeLessThan(255);
    expect(maskBounds(rect)).toEqual({ x: 0, y: 0, width: 50, height: 100 });
    expect(maskCoverage(combineMasks(rect, invertMask(rect), 'intersect'))).toBe(0);
  });

  it('magic wand selects contiguous similar pixels', () => {
    const r = createRaster(10, 10, [255, 255, 255, 255]);
    for (let y = 0; y < 10; y++) setPixel(r, 5, y, [0, 0, 0, 255]); // wall
    const m = magicWand(r, 1, 1, 10, true);
    expect(maskCoverage(m)).toBeCloseTo(0.5, 1);
    const global = magicWand(r, 1, 1, 10, false);
    expect(maskCoverage(global)).toBeCloseTo(0.9, 1);
  });

  it('quick select and object select find a subject', () => {
    const r = createRaster(40, 40, [230, 230, 230, 255]);
    for (let y = 10; y < 30; y++) for (let x = 12; x < 28; x++) setPixel(r, x, y, [200, 30, 30, 255]);
    const q = quickSelect(r, [{ x: 20, y: 20 }], 3, 30);
    expect(maskBounds(q)).toEqual({ x: 12, y: 10, width: 16, height: 20 });
    const o = objectSelect(r, { x: 5, y: 5, width: 30, height: 30 });
    expect(maskBounds(o)).toEqual({ x: 12, y: 10, width: 16, height: 20 });
  });
});

describe('content-aware fill, healing and extend', () => {
  it('removes an object from a textured background', () => {
    const r = checker(48, 48, [40, 120, 40, 255], [60, 140, 60, 255], 3);
    for (let y = 20; y < 28; y++) for (let x = 20; x < 28; x++) setPixel(r, x, y, [255, 0, 255, 255]);
    const hole = rasterizeSelection({ kind: 'rect', x: 19, y: 19, width: 10, height: 10 }, 48, 48);
    const out = contentAwareFill(r, hole);
    for (let y = 20; y < 28; y++)
      for (let x = 20; x < 28; x++) {
        const p = getPixel(out, x, y);
        expect(p[0]).toBeLessThan(120); // no magenta left
        expect(p[1]).toBeGreaterThan(100);
      }
  });

  it('downscales very large holes and still fills them', () => {
    const r = createRaster(700, 700, [10, 80, 160, 255]);
    const hole = rasterizeSelection({ kind: 'rect', x: 100, y: 100, width: 420, height: 420 }, 700, 700);
    for (let y = 100; y < 520; y++) for (let x = 100; x < 520; x++) setPixel(r, x, y, [255, 255, 0, 255]);
    const out = contentAwareFill(r, hole);
    const p = getPixel(out, 300, 300);
    expect(p[2]).toBeGreaterThan(120);
  });

  it('heals a blemish toward the destination tone', () => {
    const r = createRaster(30, 30, [100, 100, 100, 255]);
    setPixel(r, 15, 15, [255, 255, 255, 255]);
    const out = healDab(r, 15, 15, 3, { x: 5, y: 5 });
    expect(getPixel(out, 15, 15)[0]).toBeLessThan(120);
  });

  it('extends a canvas with synthesized content', () => {
    const r = createRaster(20, 20, [50, 90, 200, 255]);
    const out = extendCanvas(r, { top: 4, right: 4, bottom: 4, left: 4 });
    expect(out.width).toBe(28);
    expect(getPixel(out, 1, 1)).toEqual([50, 90, 200, 255]);
  });
});

describe('resampling', () => {
  it('resizes with bilinear and lanczos and upscales', () => {
    const r = checker(16, 16, [255, 255, 255, 255], [0, 0, 0, 255], 8);
    const b = resizeBilinear(r, 8, 8);
    expect(b.width).toBe(8);
    const l = resizeLanczos(r, 32, 32);
    expect(l.width).toBe(32);
    expect(getPixel(l, 2, 2)[0]).toBeLessThan(20);
    const u = upscale(createRaster(4, 4, [10, 20, 30, 255]), 2);
    expect(u.width).toBe(8);
    expect(Math.abs(getPixel(u, 4, 4)[0] - 10)).toBeLessThan(4);
  });
});

describe('background removal and style', () => {
  it('keys out a green screen with spill suppression', () => {
    const r = createRaster(10, 10, [0, 255, 0, 255]);
    for (let y = 3; y < 7; y++) for (let x = 3; x < 7; x++) setPixel(r, x, y, [200, 150, 120, 255]);
    const { raster } = removeBackground(r, { method: 'chroma', keyColor: '#00ff00', tolerance: 0.2, softness: 0.05 });
    expect(getPixel(raster, 0, 0)[3]).toBe(0);
    expect(getPixel(raster, 5, 5)[3]).toBe(255);
  });

  it('removes a plain background but keeps similar interior colors', () => {
    const r = createRaster(30, 30, [250, 250, 250, 255]);
    for (let y = 8; y < 22; y++) for (let x = 8; x < 22; x++) setPixel(r, x, y, [20, 20, 120, 255]);
    for (let y = 13; y < 17; y++) for (let x = 13; x < 17; x++) setPixel(r, x, y, [250, 250, 250, 255]); // enclosed hole
    const { raster } = removeBackground(r, { method: 'auto', softness: 0 });
    expect(getPixel(raster, 1, 1)[3]).toBe(0);
    expect(getPixel(raster, 10, 10)[3]).toBe(255);
    expect(getPixel(raster, 15, 15)[3]).toBe(255);
  });

  it('transfers color palette from a reference', () => {
    const target = checker(20, 20, [120, 120, 120, 255], [140, 140, 140, 255]);
    const warmRef = checker(20, 20, [230, 140, 60, 255], [200, 110, 40, 255]);
    const out = transferStyle(target, warmRef, { strength: 1, texture: false });
    const m = meanColor(out);
    expect(m[0]).toBeGreaterThan(m[2] + 40);
    const h = histogram(out);
    expect(h.r.reduce((a, b) => a + b, 0)).toBe(400);
  });
});
