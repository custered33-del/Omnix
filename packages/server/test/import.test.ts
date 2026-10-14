import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { layerProps, makeNode, nodesOfType, type ProjectState, type SceneNode } from '@omnix/core';
import { startTestServer, json, type TestServer } from './helpers.js';

let ts: TestServer;
let projectId = '';

beforeAll(async () => {
  ts = await startTestServer();
  projectId = (await json(await ts.api('/api/projects', { method: 'POST', json: { name: 'Poster', primaryTool: 'image' } }))).project.id;
});
afterAll(async () => {
  await ts.close();
});

describe('PSD import', () => {
  it('round-trips a layered canvas through PSD into editable layers with masks and blend modes', async () => {
    let state = (await json(await ts.api(`/api/projects/${projectId}`))).state as ProjectState;
    const canvas = nodesOfType(state, 'canvas')[0]!;
    const red = makeNode('layer', layerProps('vector', { name: 'Red box', blendMode: 'multiply', opacity: 0.5, shapes: [{ id: 's', kind: 'rect', x: 10, y: 10, width: 40, height: 30, fill: '#ff0000', stroke: null, strokeWidth: 0 }] }));
    const green = makeNode('layer', layerProps('fill', { name: 'Green', fillColor: '#00ff00', mask: { source: { kind: 'rect', x: 100, y: 50, width: 20, height: 20 }, inverted: false, enabled: true } }));
    for (const n of [red, green]) await json(await ts.api(`/api/projects/${projectId}/commits`, { method: 'POST', json: { op: { kind: 'create', parentId: canvas.id, nodes: [n] } } }));

    const exp = await json(await ts.api(`/api/projects/${projectId}/export?wait=true`, { method: 'POST', json: { nodeId: canvas.id, format: 'psd' } }));
    expect(exp.job.status, exp.job.error).toBe('done');
    const psd = Buffer.from(await (await ts.api(exp.job.result.downloadUrl)).arrayBuffer());

    const up = await json(await ts.api(`/api/assets?name=poster.psd&projectId=${projectId}`, { method: 'POST', body: new Uint8Array(psd), headers: { 'content-type': 'image/vnd.adobe.photoshop' } }));
    expect(up.asset.mime).toBe('image/vnd.adobe.photoshop');

    const r = await json(await ts.api(`/api/projects/${projectId}/import/psd`, { method: 'POST', json: { assetId: up.asset.id } }));
    expect(r.layers).toBe(3);
    state = (await json(await ts.api(`/api/projects/${projectId}`))).state as ProjectState;
    const imported = state.nodes[r.canvasId] as SceneNode<'canvas'>;
    // The export already stored this exact file, so the upload deduplicates to its name.
    expect(imported.props.name).toMatch(/poster/i);
    expect(imported.props.width).toBe(canvas.props.width);
    const layers = imported.children.map((id) => state.nodes[id] as SceneNode<'layer'>);
    expect(layers.map((l) => l.props.name)).toEqual(['Background', 'Red box', 'Green']);
    expect(layers[1]!.props.blendMode).toBe('multiply');
    expect(layers[1]!.props.opacity).toBeCloseTo(0.5, 1);
    expect(layers[1]!.props.x).toBe(10);
    expect(layers[1]!.props.layerType).toBe('raster');
    expect(layers[2]!.props.mask?.source.kind).toBe('mask');

    // The imported canvas renders like the original.
    const a = Buffer.from(await (await ts.api(`/api/projects/${projectId}/render?node=${canvas.id}&format=png&size=2048`)).arrayBuffer());
    const b = Buffer.from(await (await ts.api(`/api/projects/${projectId}/render?node=${r.canvasId}&format=png&size=2048`)).arrayBuffer());
    const sharp = (await import('sharp')).default;
    const [ra, rb] = await Promise.all([sharp(a).ensureAlpha().raw().toBuffer(), sharp(b).ensureAlpha().raw().toBuffer()]);
    expect(ra.length).toBe(rb.length);
    let diff = 0;
    for (let i = 0; i < ra.length; i++) diff += Math.abs(ra[i]! - rb[i]!);
    expect(diff / ra.length).toBeLessThan(3);
  }, 60_000);

  it('rejects files that are not PSDs', async () => {
    const up = await json(await ts.api(`/api/assets?name=notes.txt&projectId=${projectId}`, { method: 'POST', body: 'hello', headers: { 'content-type': 'text/plain' } }));
    const r = await ts.api(`/api/projects/${projectId}/import/psd`, { method: 'POST', json: { assetId: up.asset.id } });
    expect(r.status).toBe(400);
  });
});
