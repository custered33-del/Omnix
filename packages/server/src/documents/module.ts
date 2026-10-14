import sharp from 'sharp';
import { zipSync, strToU8 } from 'fflate';
import { createCanvas } from '@napi-rs/canvas';
import type { EmbedRef, ProjectState, SceneNode } from '@omnix/core';
import { commentsContainer, documentBlocks, documentSuggestions, inlineToPlain } from '@omnix/core';
import { describeEmbed, drawChart, primaryOutput } from '@omnix/render';
import { documentToDocx, documentToHtml, documentToMarkdown, documentToPdf, type DocumentModel, type ExportBlock, type ResolvedEmbed, type ResolvedMedia } from '@omnix/exporters';
import type { Services } from '../services.js';
import { useModule } from '../app.js';
import { registerExportHandler } from '../export/module.js';
import { renderNode } from '../render/renderNode.js';
import { ProjectError } from '../projects/service.js';

/**
 * Document exports. Images and live links are resolved to what they show right now
 * (a chart from a code cell, a canvas, a video or animation frame, a slide) and handed
 * to the exporters as images, tables or text.
 */

const MAX_MEDIA = 1600;

async function pngMedia(data: Buffer, alt: string): Promise<ResolvedMedia | null> {
  try {
    const img = sharp(data, { failOn: 'none' }).rotate().resize(MAX_MEDIA, MAX_MEDIA, { fit: 'inside', withoutEnlargement: true });
    const { data: png, info } = await img.png().toBuffer({ resolveWithObject: true });
    return { png, width: info.width, height: info.height, alt };
  } catch {
    return null;
  }
}

async function assetMedia(services: Services, assetId: string): Promise<ResolvedMedia | null> {
  const a = await services.assets.get(assetId);
  if (!a) return null;
  const blob = a.kind === 'image' ? a.id : a.thumbnailBlob;
  if (!blob) return null;
  const data = await services.blobs.get(blob);
  return data ? pngMedia(data, a.name) : null;
}

async function resolveEmbed(services: Services, state: ProjectState, e: EmbedRef): Promise<ResolvedEmbed> {
  const label = describeEmbed(state, e);
  try {
    if (e.kind === 'asset') {
      const m = await assetMedia(services, e.ref);
      return m ? { kind: 'image', media: m } : { kind: 'missing', label: 'Linked file unavailable' };
    }
    const node = state.nodes[e.ref];
    if (!node) return { kind: 'missing', label: 'The linked content was deleted' };
    if (e.kind === 'cell-output' || e.kind === 'chart') {
      const out = primaryOutput((node as SceneNode<'cell'>).props.outputs ?? []);
      if (!out) return { kind: 'missing', label: 'The linked cell has no output yet' };
      switch (out.kind) {
        case 'chart': {
          const W = 1200;
          const H = 700;
          const c = createCanvas(W, H);
          drawChart(c.getContext('2d') as never, out.spec, 0, 0, W, H, { scheme: 'light', fontScale: 1.6 });
          return { kind: 'image', media: { png: c.toBuffer('image/png'), width: W, height: H, alt: out.spec.title ?? 'Chart' } };
        }
        case 'image': {
          const m = await assetMedia(services, out.assetId);
          return m ? { kind: 'image', media: m } : { kind: 'missing', label };
        }
        case 'table':
          return { kind: 'table', columns: out.columns, rows: out.rows };
        case 'error':
          return { kind: 'text', text: `${out.name}: ${out.message}` };
        default:
          return { kind: 'text', text: out.text };
      }
    }
    const r = await renderNode(services, state, { nodeId: node.id, time: e.time ?? 0, maxSize: MAX_MEDIA, format: 'png' });
    return { kind: 'image', media: { png: r.data, width: r.width, height: r.height, alt: label } };
  } catch {
    return { kind: 'missing', label };
  }
}

/** Everything an exporter needs, with images and live links resolved. */
export async function documentModel(services: Services, state: ProjectState, docId: string): Promise<DocumentModel> {
  const doc = state.nodes[docId] as SceneNode<'document'> | undefined;
  if (!doc || doc.type !== 'document') throw new ProjectError('Not a document', 400);
  const blocks: ExportBlock[] = [];
  for (const b of documentBlocks(state, docId)) {
    const eb: ExportBlock = { id: b.id, ...structuredClone(b.props) };
    if (b.props.blockType === 'image' && b.props.assetId) eb.media = await assetMedia(services, b.props.assetId);
    if (b.props.blockType === 'embed' && b.props.embed) eb.embedded = await resolveEmbed(services, state, b.props.embed);
    blocks.push(eb);
  }
  const ids = new Set(blocks.map((b) => b.id));
  const comments = commentsContainer(state)
    .children.map((id) => state.nodes[id] as SceneNode<'comment'>)
    .filter((c) => c && c.type === 'comment' && ids.has(c.props.anchor.nodeId) && !c.props.resolved)
    .map((c) => {
      const block = state.nodes[c.props.anchor.nodeId] as SceneNode<'block'>;
      const plain = inlineToPlain(block.props.text);
      const r = c.props.anchor.range;
      return { id: c.id, blockId: block.id, quote: r ? plain.slice(r[0], r[1]) : plain.slice(0, 80), author: c.props.author.name, date: c.props.createdAt, text: c.props.text, replies: c.props.replies.map((x) => ({ author: x.author.name, date: x.createdAt, text: x.text })) };
    });
  const suggestions = documentSuggestions(state, docId, 'open')
    .filter((s) => ids.has(s.props.blockId))
    .map((s) => ({ id: s.id, blockId: s.props.blockId, kind: s.props.kind, text: s.props.text, author: s.props.author.name, date: s.props.createdAt }));
  return { name: doc.props.name, pageSize: doc.props.pageSize, styles: doc.props.styles, blocks, comments, suggestions };
}

const fileSafe = (s: string) => s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'document';

export const DOCUMENT_FORMATS = ['docx', 'pdf', 'md', 'html'] as const;

useModule(({ services }) => {
  registerExportHandler(services, async (_s, state, node, req, ctx) => {
    if (node.type !== 'document') return null;
    if (!(DOCUMENT_FORMATS as readonly string[]).includes(req.format)) throw new ProjectError(`Documents export as ${DOCUMENT_FORMATS.join(', ')}`, 400);
    ctx.progress(0.1, 'Resolving images and live links');
    const model = await documentModel(services, state, node.id);
    const base = fileSafe(model.name);
    const notes: string[] = [];
    if (model.blocks.some((b) => b.blockType === 'embed')) notes.push('Live links were exported as they look right now.');
    ctx.progress(0.5, `Writing ${req.format.toUpperCase()}`);
    switch (req.format) {
      case 'docx': {
        if (model.suggestions.length) notes.push(`${model.suggestions.length} open suggestions are included as tracked changes.`);
        if (model.comments.length) notes.push(`${model.comments.length} open comments are included.`);
        return { data: await documentToDocx(model), name: `${base}.docx`, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', notes };
      }
      case 'pdf':
        if (model.suggestions.length) notes.push(`${model.suggestions.length} open suggestions were not included. Accept them first to export them.`);
        return { data: await documentToPdf(model), name: `${base}.pdf`, mime: 'application/pdf', notes };
      case 'html':
        if (model.suggestions.length) notes.push(`${model.suggestions.length} open suggestions were not included.`);
        return { data: Buffer.from(documentToHtml(model)), name: `${base}.html`, mime: 'text/html', notes };
      default: {
        const md = documentToMarkdown(model);
        if (!md.images.length) return { data: Buffer.from(md.markdown), name: `${base}.md`, mime: 'text/markdown', notes: md.notes };
        const files: Record<string, Uint8Array> = { [`${base}.md`]: strToU8(md.markdown) };
        for (const img of md.images) files[img.name] = new Uint8Array(img.data);
        return { data: Buffer.from(zipSync(files, { level: 6 })), name: `${base}-markdown.zip`, mime: 'application/zip', notes: [...md.notes, 'Markdown and its images are in one ZIP file.'] };
      }
    }
  });
});
