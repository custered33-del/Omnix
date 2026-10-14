declare module 'gifenc' {
  export type Palette = number[][];
  export function GIFEncoder(opts?: { initialCapacity?: number; auto?: boolean }): {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: { palette?: Palette; delay?: number; repeat?: number; transparent?: boolean; transparentIndex?: number; dispose?: number; first?: boolean }): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
  };
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: { format?: 'rgb565' | 'rgb444' | 'rgba4444'; oneBitAlpha?: boolean | number; clearAlpha?: boolean; clearAlphaThreshold?: number; clearAlphaColor?: number }): Palette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: 'rgb565' | 'rgb444' | 'rgba4444'): Uint8Array;
  export function nearestColorIndex(palette: Palette, pixel: number[]): number;
}

declare module 'upng-js' {
  const UPNG: {
    encode(imgs: ArrayBuffer[], w: number, h: number, cnum: number, dels?: number[], forbidPlte?: boolean): ArrayBuffer;
    decode(buf: ArrayBuffer): { width: number; height: number; depth: number; ctype: number; frames: { rect: { x: number; y: number; width: number; height: number }; delay: number; dispose: number; blend: number }[]; tabs: Record<string, unknown>; data: ArrayBuffer };
    toRGBA8(img: ReturnType<typeof UPNG.decode>): ArrayBuffer[];
  };
  export default UPNG;
}

declare module 'fontkit' {
  export function openSync(path: string): unknown;
  export function create(buffer: Uint8Array): unknown;
}
