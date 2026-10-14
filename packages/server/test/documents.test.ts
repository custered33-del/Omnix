import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { unzipSync, strFromU8 } from 'fflate';
import { commentsContainer, insertBlocksOps, makeNode, markdownToBlocks, nodesOfType, suggestOp, type Operation, type ProjectState } from '@omnix/core';
import { startTestServer, json, type TestServer } from './helpers.js';

let ts: TestServer;
let projectId = '';
let docId = '';

const commit = async (op: Operation) => json(await ts.api(`/api/projects/${projectId}/commits`, { method: 'POST', json: { op } }));
const getState = async () => (await json(await ts.api(`/api/projects/${projectId}`))).state as ProjectState;

async function exportAs(format: string) {
  const j = await json(await ts.api(`/api/projects/${projectId}/export?wait=true`, { method: 'POST', json: { nodeId: docId, format } }));
  expect(j.job.status, j.job.error).toBe('done');
  const out = { name: j.job.result.name as string, notes: j.job.result.notes as string[], data: Buffer.from(await (await ts.api(j.job.result.downloadUrl)).arrayBuffer()) };
  // Set OMNIX_TEST_DUMP=<dir> to keep the exported files for a visual check.
  if (process.env.OMNIX_TEST_DUMP) fs.writeFileSync(path.join(process.env.OMNIX_TEST_DUMP, out.name), out.data);
  return out;
}

beforeAll(async () => {
  ts = await startTestServer();
  projectId = (await json(await ts.api('/api/projects', { method: 'POST', json: { name: 'Quarterly report', primaryTool: 'document' } }))).project.id;
  let state = await getState();
  docId = nodesOfType(state, 'document')[0]!.id;

  // A notebook cell with a chart output, linked live from the document.
  const ws = makeNode('codeWorkspace', { name: 'Analysis' });
  const nb = makeNode('notebook', { name: 'Charts' });
  const cell = makeNode('cell', { source: 'omnix.chart(...)', outputs: [{ kind: 'chart', spec: { type: 'bar', title: 'Revenue', labels: ['Q1', 'Q2', 'Q3'], series: [{ name: 'Revenue', values: [12, 18, 24] }] } }] });
  ws.children = [nb.id];
  nb.parentId = ws.id;
  nb.children = [cell.id];
  cell.parentId = nb.id;
  await commit({ kind: 'create', parentId: state.rootId, nodes: [ws, nb, cell] });

  const png = await sharp({ create: { width: 320, height: 200, channels: 3, background: '#3b5bdb' } }).png().toBuffer();
  const up = await json(await ts.api(`/api/assets?name=chart.png&projectId=${projectId}`, { method: 'POST', body: new Uint8Array(png), headers: { 'content-type': 'image/png' } }));

  state = await getState();
  const md = [
    '## Results',
    '',
    'Sales grew **12%**, see [the dashboard](https://example.com/dash).',
    '',
    '- First point',
    '- Second point',
    '',
    '1. Step one',
    '2. Step two',
    '',
    '- [x] Done item',
    '',
    '> A quote worth keeping.',
    '',
    '```python',
    'print("hi")',
    '```',
    '',
    '| Region | Sales |',
    '| --- | --- |',
    '| North | 120 |',
    '',
    '---',
    '',
    `![Brand blue](asset:${up.asset.id})`,
    '',
    `!embed[cell-output](${cell.id})`,
    '',
    'Café, naïve, Ελληνικά, Кириллица.',
  ].join('\n');
  const { ops } = insertBlocksOps(state, docId, undefined, markdownToBlocks(md));
  await commit({ kind: 'batch', ops });
  state = await getState();
  const target = Object.values(state.nodes).find((n) => n.type === 'block' && (n.props as { text: string }).text.startsWith('Sales grew'))!;
  await commit(suggestOp(state, docId, { blockId: target.id, kind: 'replace', text: 'Sales grew **14%** after the correction.' }, { type: 'ai', id: 'claude', name: 'Claude' }).op);
  const comment = makeNode('comment', { anchor: { tool: 'document', nodeId: target.id, range: [0, 10] }, text: 'Check this number', author: { type: 'human', id: 'u', name: 'Seb' }, createdAt: new Date().toISOString(), resolved: false, replies: [] });
  await commit({ kind: 'create', parentId: commentsContainer(state).id, nodes: [comment] });
});
afterAll(async () => {
  await ts.close();
});

describe('document export', () => {
  it('writes Word with styles, lists, tables, images, the live chart, comments and tracked changes', async () => {
    const r = await exportAs('docx');
    expect(r.name).toMatch(/\.docx$/);
    const files = unzipSync(new Uint8Array(r.data));
    const xml = strFromU8(files['word/document.xml']!);
    expect(xml).toContain('Sales grew');
    expect(xml).toContain('Step one');
    expect(xml).toContain('North');
    expect(xml).toMatch(/<w:ins [^>]*w:author="Claude"/);
    expect(xml).toMatch(/<w:del [^>]*w:author="Claude"/);
    expect(xml).toContain('w:commentRangeStart');
    expect(strFromU8(files['word/comments.xml']!)).toContain('Check this number');
    expect(Object.keys(files).filter((f) => f.startsWith('word/media/')).length).toBeGreaterThanOrEqual(2);
    expect(strFromU8(files['word/numbering.xml']!)).toContain('decimal');
    expect(r.notes.join(' ')).toMatch(/tracked changes/);
  });

  it('writes a PDF with real text in every script, links, bookmarks and images', async () => {
    const r = await exportAs('pdf');
    expect(r.data.subarray(0, 5).toString()).toBe('%PDF-');
    const raw = r.data.toString('latin1');
    expect(raw).toContain('/Outlines');
    expect(raw).toContain('/URI (https://example.com/dash)');
    expect(raw.match(/\/Subtype \/Image/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    const has = spawnSync('pdftotext', ['-v']).status === 0;
    if (has) {
      const f = path.join(os.tmpdir(), `omnix-doc-${Date.now()}.pdf`);
      fs.writeFileSync(f, r.data);
      const text = spawnSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }).stdout;
      fs.rmSync(f);
      expect(text).toContain('Sales grew 12%');
      expect(text).toContain('Café, naïve, Ελληνικά, Кириллица.');
      expect(text).toContain('Step one');
      expect(text).toMatch(/1\s*\/\s*\d/);
    }
  });

  it('writes standalone HTML with inlined images', async () => {
    const r = await exportAs('html');
    const html = r.data.toString('utf8');
    expect(html).toContain('<h2');
    expect(html).toContain('<strong>12%</strong>');
    expect(html).toContain('href="https://example.com/dash"');
    expect(html).toContain('<table>');
    expect(html).toContain('<input type="checkbox" disabled checked');
    expect(html.match(/src="data:image\/png;base64,/g)?.length).toBe(2);
    expect(html).not.toContain('<script');
  });

  it('writes Markdown with its images in a ZIP', async () => {
    const r = await exportAs('md');
    expect(r.name).toMatch(/markdown\.zip$/);
    const files = unzipSync(new Uint8Array(r.data));
    const mdName = Object.keys(files).find((f) => f.endsWith('.md'))!;
    const md = strFromU8(files[mdName]!);
    expect(md).toContain('## Results');
    expect(md).toContain('1. Step one');
    expect(md).toContain('| North | 120 |');
    expect(md).toContain('](images/image-1.png)');
    expect(files['images/image-2.png']).toBeDefined();
  });
});
