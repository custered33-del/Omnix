import { describe, expect, it } from 'vitest';
import { colorWord, createRaster, diffOverlay, differenceHash, hammingDistance, pixelDiff } from '../src/index.js';

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

describe('perceptual hash and color words', () => {
  // A smooth picture sampled at 9×8; `noise` stands in for re-encoding, `shift` for a different picture.
  const scene = (shift = 0, noise = 0) => {
    const g = new Uint8Array(72);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) g[y * 9 + x] = Math.round((Math.sin((x + shift) / 2) + Math.cos(y / 3)) * 60 + 128 + (((x * 7 + y * 3) % 5) - 2) * noise);
    return g;
  };
  it('gives near-identical hashes for copies and distant ones for different pictures', () => {
    const a = differenceHash(scene());
    expect(a).toHaveLength(16);
    expect(hammingDistance(a, differenceHash(scene(0, 1)))).toBeLessThanOrEqual(6);
    expect(hammingDistance(a, differenceHash(scene(3)))).toBeGreaterThan(10);
    expect(hammingDistance('ff00ff00ff00ff00', '00ff00ff00ff00ff')).toBe(64);
  });
  it('names colors plainly', () => {
    expect(colorWord(30, 90, 220)).toBe('blue');
    expect(colorWord(230, 40, 40)).toBe('red');
    expect(colorWord(250, 250, 250)).toBe('white');
    expect(colorWord(10, 10, 12)).toBe('black');
    expect(colorWord(128, 128, 130)).toBe('gray');
    expect(colorWord(250, 140, 20)).toBe('orange');
    expect(colorWord(60, 170, 70)).toBe('green');
  });
});
