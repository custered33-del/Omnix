import { describe, expect, it } from 'vitest';
import { addClipOp, applyOp, applyPresetOps, BUILTIN_PRESETS, createProjectState, layerProps, makeNode, nodesOfType, parsePresetData, presetFromNode, tracksOf, type Operation, type ProjectState, type SceneNode } from '../src/index.js';

const apply = (s: ProjectState, ops: Operation[]) => ops.reduce((st, op) => applyOp(st, op).state, s);

describe('presets', () => {
  it('captures a layer look and adds it to other pictures on a canvas', () => {
    let s = createProjectState({ primaryTool: 'image' });
    const canvas = nodesOfType(s, 'canvas')[0]!;
    const look = makeNode('layer', layerProps('raster', { name: 'Graded', filters: [{ id: 'f1', filter: 'sepia', params: { amount: 0.5 }, enabled: true, opacity: 1 }] }));
    const photo = makeNode('layer', layerProps('raster', { name: 'Photo' }));
    const title = makeNode('layer', layerProps('text', { name: 'Title', text: 'Hi' }));
    s = apply(s, [look, photo, title].map((l) => ({ kind: 'create', parentId: canvas.id, nodes: [l] })));
    const captured = presetFromNode(s, look.id);
    expect(captured).toEqual({ kind: 'layer-effects', data: { filters: [{ filter: 'sepia', params: { amount: 0.5 }, enabled: true, opacity: 1 }] } });
    // On a whole canvas the look goes on the pictures, not the text.
    s = apply(s, applyPresetOps(s, { ...captured, name: 'Sepia' }, canvas.id));
    const filtersOf = (id: string) => (s.nodes[id] as SceneNode<'layer'>).props.filters;
    expect(filtersOf(photo.id)).toHaveLength(1);
    expect(filtersOf(look.id)).toHaveLength(2);
    expect(filtersOf(title.id)).toHaveLength(0);
    expect(filtersOf(photo.id)[0]!.id).not.toBe('f1');
    expect(() => presetFromNode(s, title.id)).toThrow(/no filters/);
  });

  it('applies a clip look to every picture clip of a video, but not to audio', () => {
    let s = createProjectState({ primaryTool: 'video' });
    const seq = nodesOfType(s, 'sequence')[0]!;
    const [video, , audio] = tracksOf(s, seq.id);
    s = applyOp(s, addClipOp(s, video!.id, { name: 'A', start: 0, in: 0, out: 2 })).state;
    s = applyOp(s, addClipOp(s, video!.id, { name: 'B', start: 2, in: 0, out: 2 })).state;
    if (audio) s = applyOp(s, addClipOp(s, audio.id, { name: 'Music', start: 0, in: 0, out: 4 })).state;
    const warm = BUILTIN_PRESETS.find((p) => p.id === 'builtin-clip-warm-film')!;
    const ops = applyPresetOps(s, warm, seq.id);
    expect(ops).toHaveLength(2);
    s = apply(s, ops);
    const clips = nodesOfType(s, 'clip');
    expect(clips.filter((c) => c.props.effects.length === 2).map((c) => c.props.name).sort()).toEqual(['A', 'B']);
  });

  it('replaces document styles and slideshow themes, and checks preset data', () => {
    let s = createProjectState({ primaryTool: 'document' });
    const doc = nodesOfType(s, 'document')[0]!;
    const classic = BUILTIN_PRESETS.find((p) => p.id === 'builtin-doc-classic')!;
    s = apply(s, applyPresetOps(s, classic, doc.id));
    expect((s.nodes[doc.id] as SceneNode<'document'>).props.styles.body!.fontFamily).toBe('Georgia');
    let d = createProjectState({ primaryTool: 'slides' });
    const deck = nodesOfType(d, 'deck')[0]!;
    const theme = BUILTIN_PRESETS.find((p) => p.kind === 'slide-theme' && p.name === 'Midnight')!;
    d = apply(d, applyPresetOps(d, theme, deck.id));
    expect((d.nodes[deck.id] as SceneNode<'deck'>).props.theme.name).toBe('Midnight');
    expect(() => applyPresetOps(d, theme, nodesOfType(d, 'slide')[0]!.id)).toThrow(/does not apply to a slide/);
    expect(() => parsePresetData('slide-theme', { theme: { name: 'x' } })).toThrow(/not a valid slide-theme preset/);
    for (const p of BUILTIN_PRESETS) expect(() => parsePresetData(p.kind, p.data)).not.toThrow();
  });
});
