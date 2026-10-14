import { cloneRaster, clamp255, type Raster } from './raster.js';

/** A 3D color lookup table. `data` holds size^3 RGB triples (0..1), red varying fastest (Adobe .cube order). */
export interface Lut3D {
  title: string;
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  data: Float32Array;
}

/** Parse an Adobe/Resolve `.cube` 3D LUT. */
export function parseCubeLut(text: string): Lut3D {
  let size = 0;
  let title = '';
  const domainMin: [number, number, number] = [0, 0, 0];
  const domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const key = parts[0]!.toUpperCase();
    if (key === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '');
    else if (key === 'LUT_3D_SIZE') size = parseInt(parts[1]!, 10);
    else if (key === 'LUT_1D_SIZE') throw new Error('1D LUTs are not supported; export a 3D .cube LUT');
    else if (key === 'DOMAIN_MIN') parts.slice(1, 4).forEach((v, i) => (domainMin[i] = parseFloat(v)));
    else if (key === 'DOMAIN_MAX') parts.slice(1, 4).forEach((v, i) => (domainMax[i] = parseFloat(v)));
    else if (/^[-+\d.]/.test(parts[0]!)) {
      if (parts.length < 3) throw new Error(`Malformed LUT line: ${line}`);
      values.push(parseFloat(parts[0]!), parseFloat(parts[1]!), parseFloat(parts[2]!));
    }
  }
  if (!size || size < 2 || size > 256) throw new Error('LUT_3D_SIZE missing or invalid');
  if (values.length !== size * size * size * 3) {
    throw new Error(`Expected ${size ** 3} LUT entries, found ${values.length / 3}`);
  }
  return { title, size, domainMin, domainMax, data: Float32Array.from(values) };
}

/** Serialize a LUT back to .cube text (used for exporting presets). */
export function formatCubeLut(lut: Lut3D): string {
  const lines = [`TITLE "${lut.title}"`, `LUT_3D_SIZE ${lut.size}`];
  for (let i = 0; i < lut.data.length; i += 3) lines.push(`${lut.data[i]!.toFixed(6)} ${lut.data[i + 1]!.toFixed(6)} ${lut.data[i + 2]!.toFixed(6)}`);
  return lines.join('\n') + '\n';
}

/** Build a LUT by sampling a color function (used for tests and for baking adjustment stacks). */
export function lutFromFunction(size: number, fn: (r: number, g: number, b: number) => [number, number, number], title = 'Generated'): Lut3D {
  const data = new Float32Array(size * size * size * 3);
  let k = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const [R, G, B] = fn(r / (size - 1), g / (size - 1), b / (size - 1));
        data[k++] = R;
        data[k++] = G;
        data[k++] = B;
      }
  return { title, size, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data };
}

/** Sample the LUT with trilinear interpolation. Inputs and outputs are 0..1. */
export function sampleLut(lut: Lut3D, r: number, g: number, b: number): [number, number, number] {
  const n = lut.size - 1;
  const norm = (v: number, i: number) => Math.min(1, Math.max(0, (v - lut.domainMin[i]!) / (lut.domainMax[i]! - lut.domainMin[i]! || 1))) * n;
  const fr = norm(r, 0);
  const fg = norm(g, 1);
  const fb = norm(b, 2);
  const r0 = Math.floor(fr);
  const g0 = Math.floor(fg);
  const b0 = Math.floor(fb);
  const r1 = Math.min(n, r0 + 1);
  const g1 = Math.min(n, g0 + 1);
  const b1 = Math.min(n, b0 + 1);
  const dr = fr - r0;
  const dg = fg - g0;
  const db = fb - b0;
  const s = lut.size;
  const at = (ri: number, gi: number, bi: number, c: number) => lut.data[(bi * s * s + gi * s + ri) * 3 + c]!;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = at(r0, g0, b0, c) * (1 - dr) + at(r1, g0, b0, c) * dr;
    const c10 = at(r0, g1, b0, c) * (1 - dr) + at(r1, g1, b0, c) * dr;
    const c01 = at(r0, g0, b1, c) * (1 - dr) + at(r1, g0, b1, c) * dr;
    const c11 = at(r0, g1, b1, c) * (1 - dr) + at(r1, g1, b1, c) * dr;
    const c0 = c00 * (1 - dg) + c10 * dg;
    const c1 = c01 * (1 - dg) + c11 * dg;
    out[c] = c0 * (1 - db) + c1 * db;
  }
  return out;
}

export function applyLut3D(r: Raster, lut: Lut3D, intensity = 1): Raster {
  const out = cloneRaster(r);
  const d = out.data;
  const k = Math.min(1, Math.max(0, intensity));
  for (let i = 0; i < d.length; i += 4) {
    const [R, G, B] = sampleLut(lut, d[i]! / 255, d[i + 1]! / 255, d[i + 2]! / 255);
    d[i] = clamp255(d[i]! + (R * 255 - d[i]!) * k);
    d[i + 1] = clamp255(d[i + 1]! + (G * 255 - d[i + 1]!) * k);
    d[i + 2] = clamp255(d[i + 2]! + (B * 255 - d[i + 2]!) * k);
  }
  return out;
}
