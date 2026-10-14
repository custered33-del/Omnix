/** Sprite sheet atlas metadata (TexturePacker "hash" style, readable by most engines). */
export interface SpriteAtlas {
  frames: Record<string, { frame: { x: number; y: number; w: number; h: number }; rotated: false; trimmed: false; spriteSourceSize: { x: number; y: number; w: number; h: number }; sourceSize: { w: number; h: number }; duration: number }>;
  meta: { app: string; version: string; image: string; format: 'RGBA8888'; size: { w: number; h: number }; scale: '1'; frameTags: { name: string; from: number; to: number; direction: 'forward' | 'pingpong' }[] };
}

export function spriteAtlas(name: string, image: string, frameCount: number, columns: number, frameW: number, frameH: number, fps: number, direction: 'forward' | 'pingpong' = 'forward'): SpriteAtlas {
  const frames: SpriteAtlas['frames'] = {};
  for (let i = 0; i < frameCount; i++) {
    const x = (i % columns) * frameW;
    const y = Math.floor(i / columns) * frameH;
    frames[`${name}_${String(i).padStart(4, '0')}`] = { frame: { x, y, w: frameW, h: frameH }, rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: frameW, h: frameH }, sourceSize: { w: frameW, h: frameH }, duration: Math.round(1000 / fps) };
  }
  const rows = Math.ceil(frameCount / columns);
  return { frames, meta: { app: 'Omnix', version: '1.0', image, format: 'RGBA8888', size: { w: columns * frameW, h: rows * frameH }, scale: '1', frameTags: [{ name, from: 0, to: frameCount - 1, direction }] } };
}

/** Work out the grid of an imported sprite sheet from its size and frame size (or frame count). */
export function sliceGrid(sheetW: number, sheetH: number, opts: { frameWidth?: number; frameHeight?: number; columns?: number; rows?: number; frameCount?: number }): { columns: number; rows: number; frameWidth: number; frameHeight: number; frameCount: number } {
  const columns = opts.columns ?? (opts.frameWidth ? Math.floor(sheetW / opts.frameWidth) : 1);
  const rows = opts.rows ?? (opts.frameHeight ? Math.floor(sheetH / opts.frameHeight) : 1);
  const frameWidth = opts.frameWidth ?? Math.floor(sheetW / Math.max(1, columns));
  const frameHeight = opts.frameHeight ?? Math.floor(sheetH / Math.max(1, rows));
  if (columns < 1 || rows < 1 || frameWidth < 1 || frameHeight < 1) throw new Error('Sprite sheet grid does not fit the image');
  return { columns, rows, frameWidth, frameHeight, frameCount: Math.min(opts.frameCount ?? columns * rows, columns * rows) };
}
