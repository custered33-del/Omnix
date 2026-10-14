import { createRequire } from 'node:module';
import fs from 'node:fs';
import * as fontkit from 'fontkit';

/**
 * Fonts for PDF export. Inter and JetBrains Mono ship with Omnix (from Fontsource) split into
 * script subsets, so text is drawn with the first subset that has each character. System
 * DejaVu fonts, when installed, cover anything else (for example Arabic or symbols).
 */
const require = createRequire(import.meta.url);

export type FontFace = 'regular' | 'bold' | 'italic' | 'boldItalic' | 'mono';

interface LoadedFont {
  key: string;
  path: string;
  has(cp: number): boolean;
}

const SUBSETS = ['latin', 'latin-ext', 'cyrillic', 'greek', 'vietnamese'] as const;
const SYSTEM_FALLBACK = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf', '/Library/Fonts/Arial Unicode.ttf', 'C:\\Windows\\Fonts\\arial.ttf'];

function fontFile(pkg: string, file: string): string | null {
  try {
    return require.resolve(`${pkg}/files/${file}`);
  } catch {
    return null;
  }
}

const cache = new Map<FontFace, LoadedFont[]>();

function load(path: string, key: string): LoadedFont | null {
  try {
    const f = fontkit.openSync(path) as unknown as { hasGlyphForCodePoint(cp: number): boolean };
    return { key, path, has: (cp) => f.hasGlyphForCodePoint(cp) };
  } catch {
    return null;
  }
}

/** Font files for a face, in fallback order. */
export function fontChain(face: FontFace): LoadedFont[] {
  const hit = cache.get(face);
  if (hit) return hit;
  const chain: LoadedFont[] = [];
  if (face === 'mono') {
    for (const s of ['latin', 'latin-ext', 'cyrillic', 'greek']) {
      const p = fontFile('@fontsource/jetbrains-mono', `jetbrains-mono-${s}-400-normal.woff`);
      const f = p && load(p, `mono-${s}`);
      if (f) chain.push(f);
    }
  }
  const weight = face === 'bold' || face === 'boldItalic' ? 700 : 400;
  const style = face === 'italic' || face === 'boldItalic' ? 'italic' : 'normal';
  for (const s of SUBSETS) {
    const p = fontFile('@fontsource/inter', `inter-${s}-${weight}-${style}.woff`);
    const f = p && load(p, `inter-${s}-${weight}-${style}`);
    if (f) chain.push(f);
  }
  for (const p of SYSTEM_FALLBACK) {
    if (fs.existsSync(p)) {
      const f = load(p, `system-${p}`);
      if (f) {
        chain.push(f);
        break;
      }
    }
  }
  cache.set(face, chain);
  return chain;
}

/** Split text into runs that each use one font from the chain. */
export function splitByFont(text: string, face: FontFace): { font: LoadedFont; text: string }[] {
  const chain = fontChain(face);
  if (!chain.length) throw new Error('No fonts available for PDF export');
  const out: { font: LoadedFont; text: string }[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // Whitespace and control characters stay with the current run.
    const font = cp <= 32 && out.length ? out[out.length - 1]!.font : (chain.find((f) => f.has(cp)) ?? chain[0]!);
    const last = out[out.length - 1];
    if (last && last.font === font) last.text += ch;
    else out.push({ font, text: ch });
  }
  return out;
}
