/**
 * Performance benchmarks for the hot paths: applying operations to a large project, history
 * (replaying to old versions), version comparison, text and pixel diffs, rendering, and the
 * server paths behind the library and MCP. Run with `pnpm bench`; numbers are milliseconds.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { applyOp, assetRefs, compareVersions, createProjectState, diffLines, diffStates, insertBlocksOps, layerProps, makeNode, newSlideOps, nodesOfType, outlineProject, ProjectSession, type Operation, type ProjectState } from '../packages/core/src/index.js';
import { createRaster, pixelDiff } from '../packages/imaging/src/index.js';
import { createOmnix } from '../packages/server/src/app.js';
import '../packages/server/src/modules.js';
import { renderNodeCanvas } from '../packages/server/src/render/renderNode.js';

const results: { name: string; ms: number; note?: string }[] = [];
async function time<T>(name: string, fn: () => T | Promise<T>, note?: string, runs = 1): Promise<T> {
  let out!: T;
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) out = await fn();
  const ms = (performance.now() - t0) / runs;
  results.push({ name, ms, ...(note ? { note } : {}) });
  return out;
}

function bigProject(): ProjectState {
  let s = createProjectState({ primaryTool: 'image', withPrimaryDocument: true });
  const canvas = nodesOfType(s, 'canvas')[0]!;
  const ops: Operation[] = [];
  for (let i = 0; i < 400; i++) ops.push({ kind: 'create', parentId: canvas.id, nodes: [makeNode('layer', layerProps(i % 3 === 0 ? 'text' : 'vector', { name: `Layer ${i}`, ...(i % 3 === 0 ? { text: `Title ${i}`, x: (i * 37) % 1800, y: (i * 53) % 1000, fontSize: 24 } : { shapes: [{ id: `s${i}`, kind: 'rect', x: (i * 41) % 1800, y: (i * 29) % 1000, width: 80, height: 60, fill: '#3366cc', stroke: null, strokeWidth: 0 }] }) }))] });
  s = applyOp(s, { kind: 'batch', ops }).state;
  const deckNodes = createProjectState({ primaryTool: 'slides' });
  const deck = nodesOfType(deckNodes, 'deck')[0]!;
  s = applyOp(s, { kind: 'create', parentId: s.rootId, nodes: [{ ...deck, parentId: s.rootId, children: [] }] }).state;
  for (let i = 0; i < 150; i++) s = applyOp(s, newSlideOps(s, deck.id, 'title-body', { name: `Slide ${i}`, text: { title: `Slide ${i}`, body: 'Body text\n- one\n- two' } }).op).state;
  const docState = createProjectState({ primaryTool: 'document' });
  const doc = nodesOfType(docState, 'document')[0]!;
  s = applyOp(s, { kind: 'create', parentId: s.rootId, nodes: [{ ...doc, parentId: s.rootId, children: [] }] }).state;
  const blocks = Array.from({ length: 2000 }, (_, i) => (i % 25 === 0 ? { blockType: 'heading' as const, level: 2, text: `Section ${i / 25}` } : { blockType: 'paragraph' as const, text: `Paragraph ${i} with some **bold** words and a [link](https://example.com) for realism.` }));
  s = applyOp(s, { kind: 'batch', ops: insertBlocksOps(s, doc.id, null, blocks).ops }).state;
  return s;
}

async function main() {
  const big = await time('build a project with 400 layers, 150 slides and 2,000 paragraphs', bigProject);
  const nodes = Object.keys(big.nodes).length;
  const layers = nodesOfType(big, 'layer');
  await time('apply one property change to that project', () => applyOp(big, { kind: 'update', id: layers[200]!.id, set: { opacity: 0.5 } }), `${nodes} nodes, average of 200`, 200);

  // History: 1,500 commits, then jump back to the start and compare.
  const session = new ProjectSession(big);
  const author = { type: 'human' as const, id: 'u', name: 'Seb' };
  await time('commit 1,500 small edits', () => {
    for (let i = 0; i < 1500; i++) session.commit({ kind: 'update', id: layers[i % layers.length]!.id, set: { x: i } }, { author, label: `Move ${i}` });
  });
  const first = session.log()[0]!.id;
  await time('rebuild the state 1,500 commits back', () => session.stateAt(first));
  await time('rebuild it again (cached)', () => session.stateAt(first));
  await time('diff the project against that version', () => diffStates(session.stateAt(first), session.state));
  await time('compare versions (every document)', () => compareVersions(session.stateAt(first), session.state));
  await time('outline the project for get_project', () => outlineProject(session.state));
  await time('find every asset reference', () => assetRefs(session.state));
  await time('serialize the project to JSON', () => JSON.stringify(session.state).length, `${Math.round(JSON.stringify(session.state).length / 1024)} KB`);

  // Text and pixels.
  const a = Array.from({ length: 10_000 }, (_, i) => `line ${i} = ${i * 3}`).join('\n');
  const b = a.split('\n').map((l, i) => (i % 97 === 0 ? `${l} // changed` : l)).join('\n');
  await time('line diff of two 10,000-line files (100 changes)', () => diffLines(a, b).length);
  const r1 = createRaster(1920, 1080, [40, 80, 160, 255]);
  const r2 = createRaster(1920, 1080, [40, 80, 160, 255]);
  for (let i = 0; i < r2.data.length; i += 4 * 7) r2.data[i] = 200;
  await time('pixel diff of two 1920x1080 pictures', () => pixelDiff(r1, r2).changed);

  // Server: rendering and the library.
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnix-bench-'));
  const omnix = await createOmnix({ dataDir, memory: true, port: 0, host: '127.0.0.1', webDist: null, dev: false });
  try {
    const canvas = nodesOfType(big, 'canvas')[0]!;
    await time('render the 400-layer canvas at 1920x1080', async () => (await renderNodeCanvas(omnix.services, big, { nodeId: canvas.id, scale: 1 })).width, undefined, 3);
    await time('render it as a 960 px preview', async () => (await renderNodeCanvas(omnix.services, big, { nodeId: canvas.id, maxSize: 960 })).width, undefined, 3);
    const slide = nodesOfType(big, 'slide')[10]!;
    await time('render a slide', async () => (await renderNodeCanvas(omnix.services, big, { nodeId: slide.id, maxSize: 1280 })).width, undefined, 5);
    await time('render the project thumbnail', async () => (await renderNodeCanvas(omnix.services, big, { nodeId: null, maxSize: 640 })).width, undefined, 3);
  } finally {
    await omnix.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  const width = Math.max(...results.map((r) => r.name.length));
  console.log(`\nOmnix benchmarks (${os.cpus()[0]?.model ?? 'cpu'}, node ${process.version})\n`);
  for (const r of results) console.log(`${r.name.padEnd(width)}  ${r.ms.toFixed(r.ms < 10 ? 2 : 0).padStart(8)} ms${r.note ? `  (${r.note})` : ''}`);
}

void main().then(() => process.exit(0));
