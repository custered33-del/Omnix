import {
  applyOp,
  createProjectState,
  layerProps,
  makeNode,
  markdownToBlocks,
  nodesOfType,
  childrenOf,
  type Operation,
  type ProjectState,
  type SceneNode,
  type ToolKind,
} from '@omnix/core';

/**
 * Built-in starter templates. Each is an ordinary project state; creating a project from a
 * template copies it with fresh ids. People can also save their own projects as templates.
 */
export interface TemplateInfo {
  id: string;
  name: string;
  tool: ToolKind;
  description: string;
  builtIn: boolean;
}

const commit = (s: ProjectState, op: Operation) => applyOp(s, op).state;

function socialPost(): ProjectState {
  let s = createProjectState({ name: 'Social post', primaryTool: 'image' });
  const canvas = nodesOfType(s, 'canvas')[0]!;
  const bg = childrenOf(s, canvas.id)[0]!;
  s = commit(s, { kind: 'update', id: canvas.id, set: { width: 1080, height: 1080, name: 'Post' } });
  s = commit(s, { kind: 'update', id: bg.id, set: { fillColor: '#1d2a5c' } });
  const glow = makeNode('layer', layerProps('vector', { name: 'Glow', opacity: 0.55, blendMode: 'screen', shapes: [{ id: 'g', kind: 'ellipse', x: 520, y: -160, width: 760, height: 760, fill: '#e8590c', stroke: null, strokeWidth: 0 }], filters: [{ id: 'blur', filter: 'gaussianBlur', params: { radius: 120 }, enabled: true, opacity: 1 }] }));
  const title = makeNode('layer', layerProps('text', { name: 'Headline', text: 'Your big\nannouncement', x: 90, y: 560, fontSize: 112, fontWeight: 800, color: '#ffffff', lineHeight: 1.05, letterSpacing: -2 }));
  const sub = makeNode('layer', layerProps('text', { name: 'Subtitle', text: 'Add a short line of detail here', x: 92, y: 840, fontSize: 40, fontWeight: 500, color: '#c7d0f5' }));
  for (const l of [glow, title, sub]) s = commit(s, { kind: 'create', parentId: canvas.id, nodes: [l] });
  return s;
}

function productTeaser(): ProjectState {
  let s = createProjectState({ name: 'Product teaser', primaryTool: 'video' });
  const seq = nodesOfType(s, 'sequence')[0]!;
  s = commit(s, { kind: 'update', id: seq.id, set: { duration: 30, name: 'Teaser' } });
  const titles = nodesOfType(s, 'track').find((t) => t.props.trackType === 'title')!;
  const audio = nodesOfType(s, 'track').find((t) => t.props.trackType === 'audio')!;
  s = commit(s, { kind: 'update', id: audio.id, set: { name: 'Music' } });
  const voice = makeNode('track', { name: 'Voice', trackType: 'audio' });
  s = commit(s, { kind: 'create', parentId: seq.id, nodes: [voice] });
  s = commit(s, { kind: 'update', id: audio.id, set: { ducking: { enabled: true, sourceTrackId: voice.id, amountDb: -12 } } });
  const intro = makeNode('clip', {
    name: 'Intro title',
    start: 0,
    in: 0,
    out: 3,
    title: { text: 'Introducing\nyour product', fontFamily: 'Inter', fontSize: 96, fontWeight: 800, color: '#ffffff', background: null, align: 'center', caption: false },
    transitionIn: { kind: 'crossfade', duration: 0.6, easing: 'ease-out' },
    transitionOut: { kind: 'crossfade', duration: 0.6, easing: 'ease-in' },
    keyframes: { scale: [{ time: 0, value: 0.92, easing: 'ease-out' }, { time: 3, value: 1.04, easing: 'linear' }] },
  });
  const outro = makeNode('clip', {
    name: 'Call to action',
    start: 26,
    in: 0,
    out: 4,
    title: { text: 'Available now', fontFamily: 'Inter', fontSize: 84, fontWeight: 700, color: '#ffffff', background: null, align: 'center', caption: false },
    transitionIn: { kind: 'dip-to-black', duration: 0.8, easing: 'ease-in-out' },
  });
  s = commit(s, { kind: 'create', parentId: titles.id, nodes: [intro] });
  s = commit(s, { kind: 'create', parentId: titles.id, nodes: [outro] });
  return s;
}

function bouncingBall(): ProjectState {
  let s = createProjectState({ name: 'Bouncing ball', primaryTool: 'animation' });
  const seq = nodesOfType(s, 'sequence')[0]!;
  const layer = nodesOfType(s, 'animLayer')[0]!;
  s = commit(s, { kind: 'update', id: seq.id, set: { duration: 1.2, playback: 'loop', background: '#f7f3ea' } });
  const ground = makeNode('animLayer', {
    name: 'Ground',
    duration: 1.2,
    frames: [{ id: 'g', hold: 1, shapes: [{ id: 'floor', kind: 'rect', x: 0, y: 600, width: 1280, height: 120, fill: '#e6dccb', stroke: null, strokeWidth: 0 }], strokes: [], assetId: null }],
  });
  const track = nodesOfType(s, 'track')[0]!;
  s = commit(s, { kind: 'create', parentId: track.id, index: 0, nodes: [ground] });
  s = commit(s, {
    kind: 'update',
    id: layer.id,
    set: {
      name: 'Ball',
      duration: 1.2,
      anchorX: 0,
      anchorY: 0,
      x: 640,
      frames: [{ id: 'ball', hold: 1, shapes: [{ id: 'b', kind: 'ellipse', x: -60, y: -120, width: 120, height: 120, fill: '#e8590c', stroke: null, strokeWidth: 0 }], strokes: [], assetId: null }],
      keyframes: {
        y: [
          { time: 0, value: 220, easing: 'ease-in' },
          { time: 0.6, value: 600, easing: 'ease-out' },
          { time: 1.2, value: 220, easing: 'linear' },
        ],
        scale: [
          { time: 0, value: 1, easing: 'ease-in' },
          { time: 0.55, value: 1, easing: 'linear' },
          { time: 0.6, value: 0.85, easing: 'ease-out' },
          { time: 0.7, value: 1, easing: 'linear' },
        ],
      },
    },
  });
  return s;
}

function dataNotebook(): ProjectState {
  let s = createProjectState({ name: 'Data notebook', primaryTool: 'code' });
  const ws = nodesOfType(s, 'codeWorkspace')[0]!;
  const nb = nodesOfType(s, 'notebook')[0]!;
  for (const c of childrenOf(s, nb.id)) s = commit(s, { kind: 'delete', id: c.id });
  const data = makeNode('codeFile', { path: 'sales.csv', language: 'text', content: 'month,web,stores\nJan,120,80\nFeb,135,82\nMar,160,90\nApr,152,96\nMay,181,101\nJun,210,108\n' });
  s = commit(s, { kind: 'create', parentId: ws.id, nodes: [data] });
  const cells: Partial<SceneNode<'cell'>['props']>[] = [
    { cellType: 'markdown', language: 'python', source: '# Sales overview\nLoad the CSV in this workspace, summarize it, and chart it. Charts can be placed live into documents and slides.' },
    { cellType: 'code', language: 'python', source: 'import csv\nrows = list(csv.DictReader(open("sales.csv")))\nlen(rows)' },
    { cellType: 'code', language: 'python', source: 'total = sum(int(r["web"]) + int(r["stores"]) for r in rows)\nprint(f"Total sales: {total}")' },
    { cellType: 'code', language: 'python', source: 'import omnix\nomnix.chart(\n    type="line",\n    title="Monthly sales",\n    labels=[r["month"] for r in rows],\n    series=[\n        {"name": "Web", "values": [int(r["web"]) for r in rows]},\n        {"name": "Stores", "values": [int(r["stores"]) for r in rows]},\n    ],\n)' },
  ];
  for (const c of cells) s = commit(s, { kind: 'create', parentId: nb.id, nodes: [makeNode('cell', c)] });
  return s;
}

function report(): ProjectState {
  let s = createProjectState({ name: 'Project report', primaryTool: 'document' });
  const doc = nodesOfType(s, 'document')[0]!;
  for (const c of childrenOf(s, doc.id)) s = commit(s, { kind: 'delete', id: c.id });
  const md = `# Project report

A short summary of what this project set out to do and what it achieved. **Replace this paragraph** with your own overview.

## Goals

- Goal one, written as an outcome
- Goal two, with a clear measure
- Goal three

## Results

Describe what happened. Charts from Code Grounds can be linked here and update automatically when the data changes.

| Metric | Target | Actual |
| --- | --- | --- |
| Signups | 1,000 | 1,240 |
| Retention | 80% | 86% |

## Next steps

1. First thing to do
2. Second thing to do

> Decisions and open questions can go in comments. Claude can suggest edits you accept or reject.
`;
  for (const b of markdownToBlocks(md)) s = commit(s, { kind: 'create', parentId: doc.id, nodes: [makeNode('block', b)] });
  return s;
}

function pitchDeck(): ProjectState {
  let s = createProjectState({ name: 'Pitch deck', primaryTool: 'slides' });
  const deck = nodesOfType(s, 'deck')[0]!;
  const first = nodesOfType(s, 'slide')[0]!;
  const [title, subtitle] = childrenOf(s, first.id);
  s = commit(s, { kind: 'update', id: title!.id, set: { text: 'Your company' } });
  s = commit(s, { kind: 'update', id: subtitle!.id, set: { text: 'One line on what you do and for whom' } });
  const W = 1920;
  const H = 1080;
  const titled = (name: string, heading: string, body: string, extra: SceneNode[] = []) => {
    const slide = makeNode('slide', { name, layout: 'title-body', masterId: 'master-title-body' });
    const t = makeNode('slideElement', { elementType: 'text', role: 'title', text: heading, x: W * 0.06, y: H * 0.06, w: W * 0.88, h: H * 0.14, bold: true });
    const b = makeNode('slideElement', { elementType: 'text', role: 'body', text: body, x: W * 0.06, y: H * 0.26, w: extra.length ? W * 0.42 : W * 0.88, h: H * 0.6, animations: [{ id: 'a1', kind: 'fade-in', delay: 0, duration: 0.5, easing: 'ease-out', trigger: 'on-enter' }] });
    for (const e of [t, b, ...extra]) {
      e.parentId = slide.id;
      slide.children.push(e.id);
    }
    return [slide, t, b, ...extra];
  };
  const chart = makeNode('slideElement', {
    elementType: 'chart',
    x: W * 0.52,
    y: H * 0.26,
    w: W * 0.42,
    h: H * 0.6,
    chart: { type: 'bar', title: 'Revenue (thousands)', labels: ['2024', '2025', '2026'], series: [{ name: 'Revenue', values: [120, 340, 910] }] },
  });
  const slides = [
    titled('Problem', 'The problem', '- Who has this problem\n- How painful it is today\n- Why now'),
    titled('Solution', 'Our solution', '- What it does\n- Why it is better\n- **Proof** it works'),
    titled('Traction', 'Traction', '- Customers and growth\n- Key metrics', [chart]),
    titled('Team', 'Team', '- Founder, background\n- Founder, background'),
  ];
  for (const nodes of slides) s = commit(s, { kind: 'create', parentId: deck.id, nodes });
  const closing = makeNode('slide', { name: 'Thanks', layout: 'section', masterId: 'master-section', background: '#1d1f24' });
  const ct = makeNode('slideElement', { elementType: 'text', role: 'title', text: 'Thank you', x: W * 0.08, y: H * 0.4, w: W * 0.84, h: H * 0.2, align: 'center', bold: true });
  ct.parentId = closing.id;
  closing.children.push(ct.id);
  s = commit(s, { kind: 'create', parentId: deck.id, nodes: [closing, ct] });
  return s;
}

const BUILTIN: { info: TemplateInfo; build: () => ProjectState }[] = [
  { info: { id: 'builtin-social-post', name: 'Social post', tool: 'image', description: 'A 1080x1080 post with a headline, subtitle and soft glow.', builtIn: true }, build: socialPost },
  { info: { id: 'builtin-product-teaser', name: 'Product teaser', tool: 'video', description: 'A 30-second sequence with intro and outro titles, music ducking under voice.', builtIn: true }, build: productTeaser },
  { info: { id: 'builtin-bouncing-ball', name: 'Bouncing ball', tool: 'animation', description: 'A looping bounce with squash, the classic animation exercise.', builtIn: true }, build: bouncingBall },
  { info: { id: 'builtin-data-notebook', name: 'Data notebook', tool: 'code', description: 'A Python notebook that loads a CSV, summarizes it and charts it.', builtIn: true }, build: dataNotebook },
  { info: { id: 'builtin-report', name: 'Project report', tool: 'document', description: 'Goals, results with a table, and next steps.', builtIn: true }, build: report },
  { info: { id: 'builtin-pitch-deck', name: 'Pitch deck', tool: 'slides', description: 'Problem, solution, traction with a chart, team and a closing slide.', builtIn: true }, build: pitchDeck },
];

export function builtinTemplates(): TemplateInfo[] {
  return BUILTIN.map((b) => b.info);
}

export function builtinTemplateState(id: string): ProjectState | null {
  return BUILTIN.find((b) => b.info.id === id)?.build() ?? null;
}
