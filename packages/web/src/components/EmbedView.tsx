import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link2, ExternalLink, Code2, Image as ImageIcon, Film, Presentation, Sparkles } from 'lucide-react';
import type { EmbedRef, ProjectState, SceneNode } from '@omnix/core';
import { childrenOf, closest, inlineToPlain, walk } from '@omnix/core';
import { describeEmbed, primaryOutput, renderCanvasDocument, renderSequenceFrame, renderSlide, deckOf } from '@omnix/render';
import { useProject, useProjectStore } from '../state/project.js';
import { useHostVersion, useRenderHost } from '../render/context.js';
import { assetUrl, proxyUrl } from '../lib/api.js';
import { Outputs } from '../editors/code/Outputs.js';
import { Dialog, NumberField } from '../ui/primitives.js';
import { AssetPicker } from './AssetPicker.js';

/** The top-level document (canvas, sequence, workspace, document, deck) that contains a node. */
export function sourceDocOf(state: ProjectState, id: string): string | null {
  let cur = state.nodes[id];
  while (cur && cur.parentId && cur.parentId !== state.rootId) cur = state.nodes[cur.parentId];
  return cur && cur.parentId === state.rootId ? cur.id : null;
}

/**
 * A live link to output elsewhere in the project. It re-renders whenever its source changes,
 * so a report or a slide always shows the current chart, image or frame.
 */
export function EmbedView({ embed, height = 320, interactive = true }: { embed: EmbedRef; height?: number; interactive?: boolean }) {
  const state = useProject((s) => s.state)!;
  const store = useProjectStore();
  const source = embed.kind === 'asset' ? null : state.nodes[embed.ref];
  const missing = embed.kind !== 'asset' && !source;
  const docId = source ? sourceDocOf(state, source.id) : null;
  return (
    <figure className="embed-view" style={{ margin: 0 }}>
      <div className="embed-body">{missing ? <div className="embed-missing">The linked content was deleted.</div> : <EmbedBody embed={embed} height={height} interactive={interactive} />}</div>
      <figcaption className="embed-caption">
        <Link2 size={12} aria-hidden="true" />
        <span className="grow truncate">Live link · {describeEmbed(state, embed)}</span>
        {docId && (
          <button className="btn btn-sm btn-ghost" onClick={() => store.getState().setActiveDoc(docId)}>
            <ExternalLink size={12} /> Open source
          </button>
        )}
      </figcaption>
    </figure>
  );
}

function EmbedBody({ embed, height, interactive }: { embed: EmbedRef; height: number; interactive: boolean }) {
  const state = useProject((s) => s.state)!;
  const host = useRenderHost();
  const meta = embed.kind === 'asset' ? host.assetMeta(embed.ref) : null;
  if (embed.kind === 'cell-output' || embed.kind === 'chart') {
    const cell = state.nodes[embed.ref] as SceneNode<'cell'> | undefined;
    const out = cell ? primaryOutput(cell.props.outputs) : null;
    if (!out) return <div className="embed-missing">Run the cell in Code Grounds to show its output here.</div>;
    return interactive ? <Outputs outputs={[out]} /> : <CanvasEmbed embed={embed} height={height} />;
  }
  if (embed.kind === 'asset') {
    if (meta?.kind === 'video') return <video className="embed-media" src={proxyUrl(embed.ref)} controls preload="metadata" style={{ maxHeight: height }} />;
    return <img className="embed-media" src={assetUrl(embed.ref)} alt={meta?.name ?? 'Linked image'} style={{ maxHeight: height }} />;
  }
  return <CanvasEmbed embed={embed} height={height} />;
}

/** Canvases, animation/video frames and slides render through the shared renderer. */
function CanvasEmbed({ embed, height }: { embed: EmbedRef; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const host = useRenderHost();
  const hv = useHostVersion();
  const state = useProject((s) => s.state)!;
  const node = state.nodes[embed.ref];
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = ref.current;
    if (!c || !node || !width) return;
    let w = 0;
    let h = 0;
    if (node.type === 'canvas') ({ width: w, height: h } = (node as SceneNode<'canvas'>).props);
    else if (node.type === 'sequence') ({ width: w, height: h } = (node as SceneNode<'sequence'>).props);
    else if (node.type === 'slide') ({ width: w, height: h } = deckOf(state, node.id).props);
    else if (node.type === 'cell') ({ w, h } = { w: 960, h: 540 });
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(width / w, height / h) * dpr;
    let out;
    try {
      if (node.type === 'canvas') out = renderCanvasDocument(host, state, node.id, { scale });
      else if (node.type === 'sequence') out = renderSequenceFrame(host, state, node.id, embed.time ?? 0, { scale });
      else if (node.type === 'slide') out = renderSlide(host, state, node.id, { scale });
    } catch {
      return;
    }
    if (!out) return;
    c.width = out.width;
    c.height = out.height;
    c.style.width = `${out.width / dpr}px`;
    c.style.height = `${out.height / dpr}px`;
    c.getContext('2d')?.drawImage(out as unknown as CanvasImageSource, 0, 0);
  }, [node, state, width, height, hv, embed.time]);
  return (
    <div ref={wrap} style={{ display: 'flex', justifyContent: 'center' }}>
      <canvas ref={ref} role="img" aria-label={describeEmbed(state, embed)} />
    </div>
  );
}

interface Source {
  embed: EmbedRef;
  label: string;
  detail: string;
  icon: ReactElement;
}

/** Everything in the project that can be embedded live. */
export function embeddableSources(state: ProjectState, exclude?: string): Source[] {
  const out: Source[] = [];
  walk(state, state.rootId, (n) => {
    if (n.type === 'cell') {
      const c = n as SceneNode<'cell'>;
      const o = primaryOutput(c.props.outputs);
      if (!o || c.props.cellType !== 'code') return;
      const nb = closest(state, c.id, 'notebook');
      out.push({ embed: { kind: 'cell-output', ref: c.id }, label: c.props.source.split('\n').find((l) => l.trim())?.slice(0, 60) ?? 'Cell', detail: `${o.kind === 'chart' ? 'Chart' : o.kind === 'image' ? 'Image' : o.kind === 'table' ? 'Table' : 'Output'} · ${(nb as SceneNode<'notebook'> | null)?.props.name ?? 'Notebook'}`, icon: <Code2 size={16} /> });
    } else if (n.type === 'canvas') {
      out.push({ embed: { kind: 'canvas', ref: n.id }, label: (n as SceneNode<'canvas'>).props.name, detail: 'Image', icon: <ImageIcon size={16} /> });
    } else if (n.type === 'sequence') {
      const sp = (n as SceneNode<'sequence'>).props;
      out.push({ embed: { kind: 'sequence-frame', ref: n.id, time: 0 }, label: sp.name, detail: sp.purpose === 'animation' ? 'Animation' : 'Video', icon: sp.purpose === 'animation' ? <Sparkles size={16} /> : <Film size={16} /> });
    } else if (n.type === 'slide' && !(exclude && closest(state, n.id, 'deck')?.id === exclude)) {
      const title = childrenOf(state, n.id).find((e) => e.type === 'slideElement' && (e as SceneNode<'slideElement'>).props.role === 'title') as SceneNode<'slideElement'> | undefined;
      out.push({ embed: { kind: 'slide', ref: n.id }, label: title ? inlineToPlain(title.props.text ?? '') : (n as SceneNode<'slide'>).props.name, detail: 'Slide', icon: <Presentation size={16} /> });
    }
  });
  return out;
}

/** Choose a live source to embed (code outputs, images, video or animation frames, slides, assets). */
export function EmbedPicker({ onPick, onClose, excludeDeck }: { onPick: (e: EmbedRef) => void; onClose: () => void; excludeDeck?: string }) {
  const state = useProject((s) => s.state)!;
  const projectId = useProjectStore().getState().projectId;
  const [assets, setAssets] = useState(false);
  const [timeFor, setTimeFor] = useState<EmbedRef | null>(null);
  const sources = embeddableSources(state, excludeDeck);
  if (assets) return <AssetPicker kinds={['image', 'video']} projectId={projectId} onPick={([a]) => a && onPick({ kind: 'asset', ref: a.id })} onClose={onClose} />;
  if (timeFor) {
    const seq = state.nodes[timeFor.ref] as SceneNode<'sequence'>;
    return (
      <Dialog
        title="Which moment?"
        onClose={onClose}
        footer={
          <button className="btn btn-primary" onClick={() => (onPick(timeFor), onClose())}>
            Embed
          </button>
        }
      >
        <NumberField label="Time" value={timeFor.time ?? 0} min={0} max={seq.props.duration} step={1 / seq.props.fps} unit="s" onCommit={(t) => setTimeFor({ ...timeFor, time: t })} />
      </Dialog>
    );
  }
  return (
    <Dialog title="Insert a live link" onClose={onClose} wide description="Live links stay up to date: when the source changes, this copy changes too.">
      <ul className="picker-list" role="listbox" aria-label="Sources">
        {sources.map((s, i) => (
          <li key={i}>
            <button
              className="picker-row"
              onClick={() => {
                if (s.embed.kind === 'sequence-frame') setTimeFor(s.embed);
                else {
                  onPick(s.embed);
                  onClose();
                }
              }}
            >
              {s.icon}
              <span className="grow truncate">{s.label}</span>
              <span className="muted">{s.detail}</span>
            </button>
          </li>
        ))}
        <li>
          <button className="picker-row" onClick={() => setAssets(true)}>
            <ImageIcon size={16} />
            <span className="grow">An image or video from the library…</span>
          </button>
        </li>
      </ul>
      {sources.length === 0 && <p className="muted">Nothing to link yet. Run a chart cell in Code Grounds, or add an image, video or slide to this project.</p>}
    </Dialog>
  );
}
