import { describe, expect, it, beforeEach } from 'vitest';
import {
  TOOL_KINDS,
  createProjectState,
  outlineProject,
  projectTreeText,
  toolOfNode,
  nodesOfType,
  ease,
  evaluateKeyframes,
  cubicBezier,
  playbackTime,
  upsertKeyframe,
  pointAtLength,
  pathLength,
  pathFromPoints,
  pathToSvg,
  pointInPolygon,
  forwardKinematics,
  solveIK,
  evaluateRig,
  parseColor,
  normalizeColor,
  contrastRatio,
  hslToRgb,
  rgbToHsl,
  markdownToBlocks,
  blocksToMarkdown,
  parseInline,
  inlineToHtml,
  validateOperation,
  validateNodeProps,
  setDeterministicIds,
  makeNode,
  referencedAssets,
  applyOp,
  type Bone,
} from '../src/index.js';

beforeEach(() => setDeterministicIds(1));

describe('project model', () => {
  it('creates a starter document for every tool', () => {
    for (const tool of TOOL_KINDS) {
      const state = createProjectState({ name: `My ${tool}`, primaryTool: tool });
      const outline = outlineProject(state);
      expect(outline.documents).toHaveLength(1);
      expect(outline.documents[0]!.tool).toBe(tool);
      const docId = outline.documents[0]!.id;
      expect(toolOfNode(state, docId)).toBe(tool);
      expect(projectTreeText(state)).toContain(docId);
    }
  });

  it('collects referenced assets', () => {
    let state = createProjectState({ primaryTool: 'video' });
    const track = nodesOfType(state, 'track').find((t) => t.props.trackType === 'video')!;
    const clip = makeNode('clip', { assetId: 'sha256-abc' });
    state = applyOp(state, { kind: 'create', parentId: track.id, nodes: [clip] }).state;
    expect([...referencedAssets(state)]).toEqual(['sha256-abc']);
  });
});

describe('keyframes and easing', () => {
  it('evaluates linear and eased keyframes and holds outside the range', () => {
    const keys = [
      { time: 0, value: 0, easing: 'linear' as const },
      { time: 2, value: 100, easing: 'linear' as const },
    ];
    expect(evaluateKeyframes(keys, -1, 5)).toBe(0);
    expect(evaluateKeyframes(keys, 1, 5)).toBe(50);
    expect(evaluateKeyframes(keys, 3, 5)).toBe(100);
    expect(evaluateKeyframes([], 1, 5)).toBe(5);
    expect(evaluateKeyframes([{ time: 0, value: 0, easing: 'hold' }, keys[1]!], 1.9, 0)).toBe(0);
  });

  it('matches CSS cubic-bezier behaviour at the endpoints and midpoint', () => {
    const f = cubicBezier(0.42, 0, 0.58, 1);
    expect(f(0)).toBe(0);
    expect(f(1)).toBe(1);
    expect(f(0.5)).toBeCloseTo(0.5, 3);
    expect(ease('ease-in', 0.25)).toBeLessThan(0.25);
    expect(ease('ease-out', 0.25)).toBeGreaterThan(0.25);
    expect(ease({ bezier: [0, 0, 1, 1] }, 0.3)).toBeCloseTo(0.3, 3);
    expect(ease('bounce-out', 1)).toBeCloseTo(1, 5);
  });

  it('maps playback modes', () => {
    expect(playbackTime('once', 5, 2)).toBe(2);
    expect(playbackTime('loop', 5, 2)).toBe(1);
    expect(playbackTime('pingpong', 3, 2)).toBe(1);
    expect(playbackTime('pingpong', 1.5, 2)).toBe(1.5);
  });

  it('upserts keyframes by time', () => {
    const k = upsertKeyframe([{ time: 1, value: 1, easing: 'linear' }], { time: 0, value: 0, easing: 'linear' });
    const k2 = upsertKeyframe(k, { time: 1, value: 9, easing: 'linear' });
    expect(k2.map((x) => x.value)).toEqual([0, 9]);
  });
});

describe('paths', () => {
  it('measures and samples paths by arc length', () => {
    const p = pathFromPoints([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]);
    expect(pathLength(p)).toBeCloseTo(200, 0);
    const mid = pointAtLength(p, 0.5);
    expect(mid.x).toBeCloseTo(100, 0);
    expect(mid.y).toBeCloseTo(0, 0);
    expect(pathToSvg(p)).toMatch(/^M0 0 C/);
    expect(pointInPolygon({ x: 5, y: 5 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }])).toBe(true);
  });
});

describe('inverse kinematics', () => {
  const bones: Bone[] = [
    { id: 'upper', name: 'Upper arm', parentId: null, length: 50, angle: 0, x: 0, y: 0, attachment: null },
    { id: 'lower', name: 'Forearm', parentId: 'upper', length: 50, angle: 0, x: 0, y: 0, attachment: null },
  ];

  it('computes forward kinematics', () => {
    const w = forwardKinematics(bones);
    expect(w.get('lower')!.end.x).toBeCloseTo(100);
    const bent = forwardKinematics(bones, { lower: Math.PI / 2 });
    expect(bent.get('lower')!.end.x).toBeCloseTo(50);
    expect(bent.get('lower')!.end.y).toBeCloseTo(50);
  });

  it('reaches a reachable target with FABRIK', () => {
    const target = { x: 60, y: 40 };
    const angles = solveIK(bones, 'lower', target);
    const tip = forwardKinematics(bones, angles).get('lower')!.end;
    expect(Math.hypot(tip.x - target.x, tip.y - target.y)).toBeLessThan(0.5);
  });

  it('stretches toward an unreachable target', () => {
    const angles = solveIK(bones, 'lower', { x: 0, y: 500 });
    const tip = forwardKinematics(bones, angles).get('lower')!.end;
    expect(tip.y).toBeCloseTo(100, 0);
  });

  it('interpolates rig poses over time', () => {
    const a = evaluateRig({ bones, poses: [{ time: 0, angles: { lower: 0 }, easing: 'linear' }, { time: 1, angles: { lower: 1 }, easing: 'linear' }] }, 0.5);
    expect(a.lower).toBeCloseTo(0.5);
  });
});

describe('color', () => {
  it('parses and normalizes', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(normalizeColor('rgba(255, 0, 0, 0.5)')).toBe('#ff000080');
    expect(normalizeColor('navy')).toBe('#000080');
    expect(() => parseColor('nope')).toThrow();
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 0);
    const [h, s, l] = rgbToHsl(200, 100, 50);
    expect(hslToRgb(h, s, l)).toEqual([200, 100, 50]);
  });
});

describe('markdown', () => {
  it('parses inline styles', () => {
    const spans = parseInline('Hello **bold *both*** and `code` [link](https://x.y) ~~old~~');
    expect(spans.find((s) => s.text === 'bold ')?.bold).toBe(true);
    expect(spans.find((s) => s.text === 'both')).toMatchObject({ bold: true, italic: true });
    expect(spans.find((s) => s.text === 'code')?.code).toBe(true);
    expect(spans.find((s) => s.text === 'link')?.link).toBe('https://x.y');
    expect(spans.find((s) => s.text === 'old')?.strike).toBe(true);
  });

  it('renders safe html (no script injection, no javascript: links)', () => {
    expect(inlineToHtml('<script>alert(1)</script>')).not.toContain('<script>');
    expect(inlineToHtml('[x](javascript:alert(1))')).toContain('href="#"');
  });

  it('round-trips documents', () => {
    const md = [
      '# Report',
      '',
      'Intro with **bold** text.',
      '',
      '- one',
      '- two',
      '',
      '1. first',
      '2. second',
      '',
      '- [x] done',
      '',
      '> A quote',
      '',
      '```python',
      'print(1)',
      '```',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '![Chart](asset:abc123)',
      '',
      '!embed[cell-output](cel_1)',
      '',
      '---',
      '',
    ].join('\n');
    const blocks = markdownToBlocks(md);
    expect(blocks.map((b) => b.blockType)).toEqual(['heading', 'paragraph', 'bullet', 'bullet', 'numbered', 'numbered', 'todo', 'quote', 'code', 'table', 'image', 'embed', 'divider']);
    expect(blocks[8]).toMatchObject({ language: 'python', text: 'print(1)' });
    expect(blocks[9]!.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    const again = markdownToBlocks(blocksToMarkdown(blocks));
    expect(again).toEqual(blocks);
  });
});

describe('validation', () => {
  it('accepts valid props and rejects invalid ones', () => {
    expect(validateNodeProps('layer', { opacity: 0.5 }, true)).toEqual([]);
    expect(validateNodeProps('layer', { opacity: 5 }, true).length).toBeGreaterThan(0);
    expect(validateNodeProps('layer', { bogus: 1 }, true).length).toBeGreaterThan(0);
    expect(validateNodeProps('codeFile', { path: '../etc/passwd' }, true).length).toBeGreaterThan(0);
  });

  it('validates operations deeply', () => {
    const state = createProjectState({ primaryTool: 'image' });
    const canvas = nodesOfType(state, 'canvas')[0]!;
    const typeOf = (id: string) => state.nodes[id]?.type;
    expect(validateOperation({ kind: 'update', id: canvas.id, set: { width: 800 } }, typeOf)).toEqual([]);
    expect(validateOperation({ kind: 'update', id: canvas.id, set: { width: -3 } }, typeOf).length).toBeGreaterThan(0);
    expect(validateOperation({ kind: 'explode' }, typeOf).length).toBeGreaterThan(0);
    const good = makeNode('layer', { name: 'ok' });
    expect(validateOperation({ kind: 'create', parentId: canvas.id, nodes: [good] }, typeOf)).toEqual([]);
    const bad = { ...good, props: { ...good.props, blendMode: 'sparkle' } };
    expect(validateOperation({ kind: 'create', parentId: canvas.id, nodes: [bad] }, typeOf).length).toBeGreaterThan(0);
  });
});
