import { describe, expect, it } from 'vitest';
import { createRaster, diffOverlay, pixelDiff } from '../src/index.js';

describe('pixel diff', () => {
  it('finds the changed area and ignores invisible or tiny differences', () => {
    const a = createRaster(40, 30, [200, 200, 200, 255]);
    const b = createRaster(40, 30, [200, 200, 200, 255]);
    // A 10×5 red patch, plus one pixel nudged by less than the threshold.
    for (let y = 10; y < 15; y++) for (let x = 20; x < 30; x++) b.data.set([220, 30, 30, 255], (y * 40 + x) * 4);
    b.data.set([205, 200, 200, 255], 0);
    const d = pixelDiff(a, b);
    expect(d.changed).toBe(50);
    expect(d.bbox).toEqual({ x: 20, y: 10, width: 10, height: 5 });
    expect(d.fraction).toBeCloseTo(50 / 1200, 5);
    // Fully transparent pixels never count, whatever their color.
    const t1 = createRaster(4, 4, [255, 0, 0, 0]);
    const t2 = createRaster(4, 4, [0, 0, 255, 0]);
    expect(pixelDiff(t1, t2).changed).toBe(0);
  });

  it('counts new area when the size changes and draws a highlight', () => {
    const a = createRaster(10, 10, [0, 0, 0, 255]);
    const b = createRaster(20, 10, [0, 0, 0, 255]);
    const d = pixelDiff(a, b);
    expect(d.width).toBe(20);
    expect(d.changed).toBe(100);
    expect(d.bbox).toEqual({ x: 10, y: 0, width: 10, height: 10 });
    const o = diffOverlay(b, d);
    const at = (x: number, y: number) => [...o.data.slice((y * 20 + x) * 4, (y * 20 + x) * 4 + 3)];
    // Changed pixels are magenta-ish; unchanged ones gray.
    expect(at(15, 5)[0]).toBeGreaterThan(180);
    expect(at(15, 5)[1]).toBeLessThan(60);
    expect(at(3, 5)[0]).toBe(at(3, 5)[1]);
  });
});
