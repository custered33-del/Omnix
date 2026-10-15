import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Some stylesheets load only with the screen that imports them (code splitting). A class defined
 * only there, but used by a shared component, is unstyled until that screen happens to load: a
 * comment card on a canvas was see-through until a document had been opened.
 */
const SRC = path.resolve(__dirname, '../src');
const GLOBAL = ['tokens.css', 'base.css', 'components.css', 'layout.css', 'editors.css', 'ai.css', 'setup.css'];
const LAZY: Record<string, string[]> = {
  'documents.css': ['editors/document/'],
  'slides.css': ['editors/slides/', 'pages/PresentPage.tsx'],
};

function classesIn(file: string): Set<string> {
  const css = fs.readFileSync(path.join(SRC, 'styles', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = css.replace(/\{[^{}]*\}/g, '{}');
  return new Set([...selectors.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]!));
}

function tsxFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tsxFiles(path.join(dir, e.name)) : e.name.endsWith('.tsx') ? [path.join(dir, e.name)] : []));
}

describe('stylesheets', () => {
  it('main.tsx loads every global stylesheet', () => {
    const main = fs.readFileSync(path.join(SRC, 'main.tsx'), 'utf8');
    for (const f of GLOBAL) expect(main).toContain(`./styles/${f}`);
  });

  it('shared components use no class that only a lazily loaded stylesheet defines', () => {
    const global = new Set(GLOBAL.flatMap((f) => [...classesIn(f)]));
    const problems: string[] = [];
    for (const [sheet, owners] of Object.entries(LAZY)) {
      const only = [...classesIn(sheet)].filter((c) => !global.has(c));
      for (const file of tsxFiles(SRC)) {
        const rel = path.relative(SRC, file).split(path.sep).join('/');
        if (owners.some((o) => rel.startsWith(o))) continue;
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/className=\{?[`"']([^`"']*)[`"']/g)) {
          for (const cls of m[1]!.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (only.includes(cls)) problems.push(`.${cls} (${sheet}) in ${rel}`);
        }
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });
});
