/// <reference lib="webworker" />
import { contentAwareFill, magicWand, quickSelect, objectSelect, removeBackground, upscale, transferStyle, extendCanvas, type Raster, type Mask } from '@omnix/imaging';

/**
 * Heavy pixel algorithms run here so the editor stays responsive.
 * Messages: { id, op, args } -> { id, result } | { id, error }.
 */
type Req =
  | { id: number; op: 'contentAwareFill'; args: { raster: Raster; mask: Mask } }
  | { id: number; op: 'magicWand'; args: { raster: Raster; x: number; y: number; tolerance: number; contiguous: boolean } }
  | { id: number; op: 'quickSelect'; args: { raster: Raster; points: { x: number; y: number }[]; radius: number; tolerance: number } }
  | { id: number; op: 'objectSelect'; args: { raster: Raster; box: { x: number; y: number; width: number; height: number } } }
  | { id: number; op: 'removeBackground'; args: { raster: Raster; method: 'auto' | 'chroma'; keyColor?: string; tolerance?: number; softness?: number } }
  | { id: number; op: 'upscale'; args: { raster: Raster; factor: number } }
  | { id: number; op: 'transferStyle'; args: { target: Raster; reference: Raster; strength: number } }
  | { id: number; op: 'extendCanvas'; args: { raster: Raster; pad: { top: number; right: number; bottom: number; left: number } } };

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, op, args } = e.data;
  try {
    let result: Raster | Mask;
    switch (op) {
      case 'contentAwareFill':
        result = contentAwareFill(args.raster, args.mask);
        break;
      case 'magicWand':
        result = magicWand(args.raster, args.x, args.y, args.tolerance, args.contiguous);
        break;
      case 'quickSelect':
        result = quickSelect(args.raster, args.points, args.radius, args.tolerance);
        break;
      case 'objectSelect':
        result = objectSelect(args.raster, args.box);
        break;
      case 'removeBackground':
        result = removeBackground(args.raster, { method: args.method, ...(args.keyColor ? { keyColor: args.keyColor } : {}), ...(args.tolerance !== undefined ? { tolerance: args.tolerance } : {}), ...(args.softness !== undefined ? { softness: args.softness } : {}) }).raster;
        break;
      case 'upscale':
        result = upscale(args.raster, args.factor);
        break;
      case 'transferStyle':
        result = transferStyle(args.target, args.reference, { strength: args.strength });
        break;
      case 'extendCanvas':
        result = extendCanvas(args.raster, args.pad);
        break;
    }
    (self as unknown as Worker).postMessage({ id, result }, [result.data.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
