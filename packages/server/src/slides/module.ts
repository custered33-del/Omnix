import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { createCanvas } from '@napi-rs/canvas';
import { zipSync } from 'fflate';
import { z } from 'zod';
import type { ElementAnimation, ProjectState, SceneNode, SlideElementProps } from '@omnix/core';
import { deckDependencies, deckSlides, inlineToPlain, LAYOUT_MASTER, makeNode, newId, requireNodeOfType, slideElements, type Operation } from '@omnix/core';
import { animationGroups, deckOf, drawEmbed, drawShape, fitShape, isDarkColor, primaryOutput, renderSlide, slideBackground, slideTextLook, BUILT, type CanvasLike } from '@omnix/render';
import { deckToPdf, deckToPptx, importPptx, type DeckAnimation, type DeckExportElement, type DeckExportModel, type DeckExportSlide, type ImportedElement } from '@omnix/exporters';
import type { Services } from '../services.js';
import { useModule } from '../app.js';
import { h, requireUser, author as authorOf } from '../http/middleware.js';
import { assetFileRoutes } from '../http/assetRoutes.js';
import { assetSummary } from '../mcp/tools/assets.js';
import { registerExportHandler } from '../export/module.js';
import { encodeCanvas, type ServerRenderHost } from '../render/serverHost.js';
import { ProjectError } from '../projects/service.js';
import { C } from '../storage/store.js';
import type { AssetRecord } from '../assets/pipeline.js';

/**
 * Slideshows on the server: public presentation links, PowerPoint/PDF/PNG export and
 * PowerPoint/PDF import.
 */

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const fileSafe = (s: string) => s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'slides';

function requireDeck(state: ProjectState, deckId: string): SceneNode<'deck'> {
  try {
    return requireNodeOfType(state, deckId, 'deck');
  } catch {
    throw new ProjectError('Slideshow not found', 404);
  }
}

/** Load every asset and live-link target a deck uses into the render host. */
async function prepareDeck(host: ServerRenderHost, state: ProjectState, deckId: string): Promise<void> {
  const deps = deckDependencies(state, deckId);
  await host.prepare(state, deckId);
  await Promise.all([...deps.assetIds].map((id) => host.loadAsset(id)));
  for (const root of deps.embedRoots) await host.prepare(state, root.id, root.time ?? 0);
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

async function pictureFor(data: Buffer, w: number, h: number): Promise<{ data: Buffer; mime: 'image/png' | 'image/jpeg' } | null> {
  try {
    // Crop to the element's shape exactly like the slide renderer (cover), at 1.5x for sharpness.
    const tw = Math.max(1, Math.min(3000, Math.round(w * 1.5)));
    const th = Math.max(1, Math.min(3000, Math.round(h * 1.5)));
    const img = sharp(data, { failOn: 'none' }).rotate().resize(tw, th, { fit: 'cover' });
    const meta = await sharp(data, { failOn: 'none' }).metadata();
    if (meta.hasAlpha) return { data: await img.png().toBuffer(), mime: 'image/png' };
    return { data: await img.jpeg({ quality: 88 }).toBuffer(), mime: 'image/jpeg' };
  } catch {
    return null;
  }
}

function canvasPng(c: CanvasLike): Buffer {
  return (c as unknown as { toBuffer(m: string): Buffer }).toBuffer('image/png');
}

function exportAnimations(anims: readonly ElementAnimation[], notes: Set<string>): DeckAnimation[] {
  const groups = animationGroups(anims);
  const out: DeckAnimation[] = [];
  anims.forEach((a, i) => {
    if (a.kind === 'custom') {
      notes.add('Custom keyframe animations are not included in PowerPoint files.');
      return;
    }
    out.push({ kind: a.kind, step: groups[i]!, delay: a.delay, duration: a.duration });
  });
  return out;
}

/** Everything the PPTX and PDF writers need, with media loaded and theme defaults applied. */
export async function deckExportModel(services: Services, state: ProjectState, deckId: string, options: { renders?: boolean; pptx?: boolean; notes: Set<string> }): Promise<DeckExportModel> {
  const deck = requireDeck(state, deckId);
  const dp = deck.props;
  const host = services.renderHost();
  await prepareDeck(host, state, deckId);
  const notes = options.notes;
  let videoBytes = 0;
  const slides: DeckExportSlide[] = [];
  for (const slide of deckSlides(state, deckId)) {
    const bg = slideBackground(dp, slide.props);
    const dark = isDarkColor(bg);
    const elements: DeckExportElement[] = [];
    if (options.pptx) {
      for (const node of slideElements(state, slide.id)) {
        const el = node.props;
        const base = { x: el.x, y: el.y, w: el.w, h: el.h, rotation: el.rotation, opacity: el.opacity, animations: exportAnimations(el.animations, notes) };
        const picture = async (canvas: CanvasLike, pad = 0) => {
          elements.push({ ...base, x: el.x - pad, y: el.y - pad, w: el.w + pad * 2, h: el.h + pad * 2, kind: 'image', data: canvasPng(canvas), mime: 'image/png', alt: el.elementType });
        };
        switch (el.elementType) {
          case 'text': {
            const look = slideTextLook(el, dp, dark);
            elements.push({ ...base, kind: 'text', text: el.text ?? '', fontFamily: look.fontFamily, monoFamily: look.monoFamily, fontSize: look.fontSize, color: look.color, linkColor: look.linkColor, align: look.align, valign: look.valign, bold: look.bold, lineHeight: look.lineHeight });
            break;
          }
          case 'image': {
            const a = el.assetId ? await services.assets.get(el.assetId) : null;
            const blob = a ? (a.kind === 'image' ? a.id : a.thumbnailBlob) : null;
            const data = blob ? await services.blobs.get(blob) : null;
            const pic = data ? await pictureFor(data, el.w, el.h) : null;
            if (pic) elements.push({ ...base, kind: 'image', ...pic, alt: a?.name ?? 'Image' });
            else if (el.assetId) notes.add('Some pictures were missing and were left out.');
            break;
          }
          case 'video': {
            const a = el.assetId ? await services.assets.get(el.assetId) : null;
            const poster = a?.thumbnailBlob ? await services.blobs.get(a.thumbnailBlob) : null;
            const posterPng = poster ? await sharp(poster).png().toBuffer().catch(() => null) : null;
            // PowerPoint plays MP4 (H.264): the original when it is MP4, the editing proxy otherwise.
            const source = a ? (a.mime === 'video/mp4' ? a.id : a.proxyBlob) : null;
            const size = a ? (source === a.id ? a.size : 0) : 0;
            if (a && source && videoBytes + size <= MAX_VIDEO_BYTES * 3 && size <= MAX_VIDEO_BYTES) {
              const data = await services.blobs.get(source);
              if (data && data.length <= MAX_VIDEO_BYTES) {
                videoBytes += data.length;
                elements.push({ ...base, kind: 'video', data, extn: 'mp4', poster: posterPng, name: a.name });
                break;
              }
            }
            if (a) notes.add('Some videos were too large or not yet converted to MP4, so their poster frame was used instead.');
            if (posterPng) {
              const pic = await pictureFor(posterPng, el.w, el.h);
              if (pic) elements.push({ ...base, kind: 'image', ...pic, alt: a?.name ?? 'Video' });
            }
            break;
          }
          case 'shape': {
            if (!el.shape) break;
            const sh = fitShape(el.shape, el.w, el.h);
            if (sh.kind === 'rect' || sh.kind === 'ellipse') {
              elements.push({ ...base, kind: 'shape', shape: sh.kind, radius: sh.radius ?? 0, fill: sh.fill, stroke: sh.stroke, strokeWidth: sh.strokeWidth });
            } else if (sh.kind === 'line' && (sh.points?.length ?? 0) === 2) {
              const [a, b] = sh.points!;
              elements.push({ ...base, x: el.x + Math.min(a!.x, b!.x), y: el.y + Math.min(a!.y, b!.y), w: Math.abs(b!.x - a!.x), h: Math.abs(b!.y - a!.y), kind: 'shape', shape: 'line', radius: 0, fill: null, stroke: sh.stroke, strokeWidth: sh.strokeWidth, flipH: b!.x < a!.x !== b!.y < a!.y });
            } else {
              // Polygons and paths go in as pictures (PowerPoint has no matching preset).
              const pad = Math.ceil(sh.strokeWidth);
              const k = 2;
              const c = createCanvas(Math.max(1, Math.round((el.w + pad * 2) * k)), Math.max(1, Math.round((el.h + pad * 2) * k)));
              const ctx = c.getContext('2d');
              ctx.scale(k, k);
              ctx.translate(pad, pad);
              drawShape(ctx as never, sh);
              await picture(c as unknown as CanvasLike, pad);
            }
            break;
          }
          case 'chart':
            if (el.chart) elements.push({ ...base, kind: 'chart', spec: el.chart, dark, fontFamily: dp.theme.fonts.body });
            break;
          case 'embed': {
            if (!el.embed) break;
            const target = state.nodes[el.embed.ref];
            if ((el.embed.kind === 'cell-output' || el.embed.kind === 'chart') && target?.type === 'cell') {
              const out = primaryOutput((target as SceneNode<'cell'>).props.outputs ?? []);
              if (out?.kind === 'chart') {
                elements.push({ ...base, kind: 'chart', spec: out.spec, dark, fontFamily: dp.theme.fonts.body });
                break;
              }
              if (out?.kind === 'table') {
                elements.push({ ...base, kind: 'table', columns: out.columns, rows: out.rows.slice(0, 40), color: dark ? '#ffffff' : dp.theme.colors.text, fontFamily: dp.theme.fonts.body, fontSize: Math.max(12, Math.min(28, el.h / Math.max(4, Math.min(41, out.rows.length + 1)) / 1.6)), dark });
                if (out.rows.length > 40) notes.add('Long tables were cut to their first 40 rows.');
                break;
              }
            }
            const k = 1.5;
            const c = createCanvas(Math.max(1, Math.round(el.w * k)), Math.max(1, Math.round(el.h * k)));
            const ctx = c.getContext('2d');
            ctx.scale(k, k);
            const ok = drawEmbed(ctx as never, el.embed, 0, 0, el.w, el.h, {
              host,
              state,
              scheme: dark ? 'dark' : 'light',
              fontScale: dp.width / 960,
              depth: 1,
              renderSlide: (id, w, hh) => {
                const d = deckOf(state, id).props;
                return renderSlide(host, state, id, { scale: Math.min(w / d.width, hh / d.height), depth: 1 });
              },
            });
            if (ok) await picture(c as unknown as CanvasLike);
            else notes.add('Some live links point at content that no longer exists and were left out.');
            break;
          }
        }
      }
    }
    const out: DeckExportSlide = {
      name: slide.props.name,
      hidden: slide.props.hidden,
      notes: slide.props.notes,
      background: bg,
      elements,
      transition: slide.props.transition,
    };
    if (options.renders && !slide.props.hidden) {
      const canvas = renderSlide(host, state, slide.id, { scale: Math.min(2, 1920 / dp.width), playhead: BUILT });
      out.render = { data: await encodeCanvas(canvas, 'jpeg', { quality: 92 }), mime: 'image/jpeg' };
      if (!options.pptx) {
        // Text boxes still go along for the PDF's invisible, searchable text layer.
        for (const node of slideElements(state, slide.id)) {
          const el = node.props;
          if (el.elementType !== 'text') continue;
          const look = slideTextLook(el, dp, dark);
          elements.push({ x: el.x, y: el.y, w: el.w, h: el.h, rotation: el.rotation, opacity: el.opacity, kind: 'text', text: el.text ?? '', fontFamily: look.fontFamily, monoFamily: look.monoFamily, fontSize: look.fontSize, color: look.color, linkColor: look.linkColor, align: look.align, valign: look.valign, bold: look.bold, lineHeight: look.lineHeight });
        }
      }
    }
    slides.push(out);
  }
  return { name: dp.name, width: dp.width, height: dp.height, slides };
}

export const DECK_FORMATS = ['pptx', 'pdf', 'pdf-notes', 'png'] as const;

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

function run(cmd: string, args: string[], timeoutMs: number, missing: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()));
    proc.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new ProjectError(missing, 400) : e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new ProjectError(`Conversion failed: ${err.trim().split('\n').pop() || `exit code ${code}`}`, 400));
    });
  });
}

export interface DeckImportResult {
  slides: number;
  firstSlideId: string | null;
  notes: string[];
}

type By = { userId: string; author: ReturnType<typeof authorOf> };

function slideNameFrom(elements: ImportedElement[], n: number): string {
  const title = elements.find((e) => e.kind === 'text' && e.role === 'title');
  const text = title && title.kind === 'text' ? inlineToPlain(title.text.split('\n')[0] ?? '').trim() : '';
  return text ? text.slice(0, 60) : `Slide ${n}`;
}

async function importPptxIntoDeck(services: Services, projectId: string, deck: SceneNode<'deck'>, data: Buffer, by: By, label: string): Promise<DeckImportResult> {
  let imp;
  try {
    imp = importPptx(new Uint8Array(data), { width: deck.props.width, height: deck.props.height });
  } catch (e) {
    throw new ProjectError((e as Error).message, 400);
  }
  const notes = [...imp.notes];
  const media = new Map<string, Promise<string | null>>();
  const ingest = (p: string, crop: { l: number; t: number; r: number; b: number } | null) => {
    const key = `${p}|${crop ? [crop.l, crop.t, crop.r, crop.b].join(',') : ''}`;
    let job = media.get(key);
    if (!job) {
      job = (async () => {
        const bytes = imp.media(p);
        if (!bytes) return null;
        let buf: Buffer = Buffer.from(bytes);
        const name = p.split('/').pop() ?? 'media';
        if (crop) {
          try {
            const meta = await sharp(buf, { failOn: 'none' }).metadata();
            const W = meta.width ?? 0;
            const H = meta.height ?? 0;
            const left = Math.round(W * Math.max(0, crop.l));
            const top = Math.round(H * Math.max(0, crop.t));
            const width = Math.max(1, Math.round(W * (1 - Math.max(0, crop.l) - Math.max(0, crop.r))));
            const height = Math.max(1, Math.round(H * (1 - Math.max(0, crop.t) - Math.max(0, crop.b))));
            if (W && H && left + width <= W && top + height <= H) buf = await sharp(buf, { failOn: 'none' }).extract({ left, top, width, height }).png().toBuffer();
          } catch {
            // Keep the uncropped picture.
          }
        }
        try {
          const a = await services.assets.ingestBuffer(buf, { name, ownerId: by.userId, projectId, tags: ['imported'], mimeHint: '', source: { kind: 'import', projectId } });
          return a.kind === 'image' || a.kind === 'video' ? a.id : null;
        } catch {
          return null;
        }
      })();
      media.set(key, job);
    }
    return job;
  };

  const ops: Operation[] = [];
  let firstSlideId: string | null = null;
  let n = deck.children.length;
  for (const s of imp.slides) {
    n += 1;
    const master = deck.props.masters.find((m) => m.id === LAYOUT_MASTER[s.layout]);
    const slide = makeNode('slide', {
      name: slideNameFrom(s.elements, n),
      layout: s.layout,
      masterId: master ? master.id : null,
      background: s.background,
      notes: s.notes,
      hidden: s.hidden,
      ...(s.transition ? { transition: { kind: s.transition.kind, duration: s.transition.duration, easing: 'ease-in-out' as const } } : {}),
    });
    firstSlideId ??= slide.id;
    const nodes: SceneNode[] = [];
    if (s.backgroundMedia) {
      const id = await ingest(s.backgroundMedia, null);
      if (id) nodes.push(makeNode('slideElement', { elementType: 'image', role: null, x: 0, y: 0, w: deck.props.width, h: deck.props.height, assetId: id }));
    }
    for (const e of s.elements) {
      const animations: ElementAnimation[] = e.animations.map((a) => ({ id: newId('anim'), kind: a.kind, delay: a.delay, duration: a.duration, easing: 'ease-out', trigger: a.trigger, ...(a.click ? { click: a.click } : {}) }));
      const base: Partial<SlideElementProps> = { x: round(e.x), y: round(e.y), w: round(Math.max(1, e.w)), h: round(Math.max(0, e.h)), rotation: round(e.rotation), opacity: 1, animations };
      switch (e.kind) {
        case 'text':
          nodes.push(makeNode('slideElement', { ...base, elementType: 'text', role: e.role, text: e.text, fontSize: e.fontSize ? Math.round(e.fontSize * 10) / 10 : null, fontFamily: e.fontFamily, color: e.color ? e.color.slice(0, 9) : null, align: e.align, valign: e.valign, bold: e.bold }));
          break;
        case 'image': {
          const id = await ingest(e.media, e.crop);
          if (id) nodes.push(makeNode('slideElement', { ...base, elementType: 'image', role: e.role, assetId: id }));
          break;
        }
        case 'video': {
          const id = await ingest(e.media, null);
          if (id) nodes.push(makeNode('slideElement', { ...base, elementType: 'video', role: null, assetId: id }));
          else if (e.poster) {
            const pid = await ingest(e.poster, null);
            if (pid) nodes.push(makeNode('slideElement', { ...base, elementType: 'image', role: null, assetId: pid }));
          }
          break;
        }
        case 'shape':
          nodes.push(makeNode('slideElement', { ...base, elementType: 'shape', role: null, shape: { id: newId('shp'), ...e.shape } }));
          break;
        case 'chart':
          nodes.push(makeNode('slideElement', { ...base, elementType: 'chart', role: null, chart: e.spec }));
          break;
      }
    }
    slide.children = nodes.map((x) => x.id);
    for (const x of nodes) x.parentId = slide.id;
    ops.push({ kind: 'create', parentId: deck.id, nodes: [slide, ...nodes] });
  }
  if (!ops.length) return { slides: 0, firstSlideId: null, notes: notes.length ? notes : ['No slides were found in the file.'] };
  if ([...media.values()].length) {
    const results = await Promise.all(media.values());
    if (results.some((r) => r === null)) notes.push('Some pictures could not be read and were left out.');
  }
  await services.projects.commit(projectId, { kind: 'batch', ops }, by.author, { label, via: by.author.type === 'ai' ? 'mcp' : 'ui' });
  if (imp.fonts.heading && !['Inter', deck.props.theme.fonts.heading].includes(imp.fonts.heading)) notes.push(`The presentation uses ${imp.fonts.heading}${imp.fonts.body && imp.fonts.body !== imp.fonts.heading ? ` and ${imp.fonts.body}` : ''}; text shows in a similar font when they are not installed.`);
  return { slides: ops.length, firstSlideId, notes };
}

const round = (v: number) => Math.round(v * 100) / 100;

async function importPdfIntoDeck(services: Services, projectId: string, deck: SceneNode<'deck'>, file: string, by: By, label: string): Promise<DeckImportResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnix-pdf-'));
  try {
    await run(services.config.pdftoppmPath, ['-png', '-l', '300', '-scale-to-x', String(Math.min(3840, deck.props.width)), '-scale-to-y', '-1', file, path.join(dir, 'page')], 300_000, 'Importing PDF needs Poppler (pdftoppm) on the server. Install poppler-utils (Linux) or poppler (macOS), or set OMNIX_PDFTOPPM.');
    const pages = (await fs.readdir(dir))
      .filter((f) => f.endsWith('.png'))
      .sort((a, b) => Number(/(\d+)\.png$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.png$/.exec(b)?.[1] ?? 0));
    if (!pages.length) throw new ProjectError('The PDF has no pages', 400);
    const ops: Operation[] = [];
    let firstSlideId: string | null = null;
    const W = deck.props.width;
    const H = deck.props.height;
    let n = deck.children.length;
    for (const page of pages) {
      n += 1;
      const buf = await fs.readFile(path.join(dir, page));
      const meta = await sharp(buf).metadata();
      const s = Math.min(W / (meta.width ?? W), H / (meta.height ?? H));
      const w = (meta.width ?? W) * s;
      const hh = (meta.height ?? H) * s;
      const a = await services.assets.ingestBuffer(buf, { name: `Page ${n}.png`, ownerId: by.userId, projectId, tags: ['imported'], mimeHint: 'image/png', source: { kind: 'import', projectId } });
      const slide = makeNode('slide', { name: `Page ${pages.indexOf(page) + 1}`, layout: 'blank', masterId: null, background: '#ffffff' });
      const img = makeNode('slideElement', { elementType: 'image', role: 'image', x: round((W - w) / 2), y: round((H - hh) / 2), w: round(w), h: round(hh), assetId: a.id });
      img.parentId = slide.id;
      slide.children = [img.id];
      firstSlideId ??= slide.id;
      ops.push({ kind: 'create', parentId: deck.id, nodes: [slide, img] });
    }
    await services.projects.commit(projectId, { kind: 'batch', ops }, by.author, { label, via: by.author.type === 'ai' ? 'mcp' : 'ui' });
    const notes = ['PDF pages were imported as pictures. Import the PowerPoint file instead to keep text editable.'];
    if (pages.length >= 300) notes.push('Only the first 300 pages were imported.');
    return { slides: ops.length, firstSlideId, notes };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Import a PowerPoint, PDF (or, with LibreOffice installed, .ppt/.odp/.key) file as new slides at the end of a deck. */
export async function importIntoDeck(services: Services, projectId: string, deckId: string, assetId: string, by: By): Promise<DeckImportResult> {
  const asset = await services.assets.get(assetId);
  if (!asset || !(asset.owners.includes(by.userId) || asset.projectIds.includes(projectId))) throw new ProjectError('File not found', 404);
  const state = await services.projects.state(projectId);
  const deck = requireDeck(state, deckId);
  const ext = path.extname(asset.name).toLowerCase();
  const label = `Import ${asset.name}`;
  if (asset.mime === PPTX_MIME || ext === '.pptx') {
    const data = await services.blobs.get(asset.id);
    if (!data) throw new ProjectError('The file is missing from storage', 404);
    return importPptxIntoDeck(services, projectId, deck, data, by, label);
  }
  if (asset.mime === 'application/pdf' || ext === '.pdf') return importPdfIntoDeck(services, projectId, deck, await services.blobs.localPath(asset.id), by, label);
  if (['.ppt', '.odp', '.key', '.pps', '.ppsx'].includes(ext)) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnix-convert-'));
    try {
      const input = path.join(dir, `input${ext}`);
      await fs.copyFile(await services.blobs.localPath(asset.id), input);
      await run(services.config.sofficePath, ['--headless', '--norestore', `-env:UserInstallation=file://${path.join(dir, 'profile')}`, '--convert-to', 'pptx', '--outdir', dir, input], 180_000, `Importing ${ext} files needs LibreOffice on the server to convert them. Save the file as PowerPoint (.pptx) and import that instead.`);
      const data = await fs.readFile(path.join(dir, 'input.pptx'));
      const r = await importPptxIntoDeck(services, projectId, deck, data, by, label);
      return { ...r, notes: [`Converted from ${ext} with LibreOffice; check layouts and fonts.`, ...r.notes] };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
  throw new ProjectError('Choose a PowerPoint (.pptx) or PDF file to import', 400);
}

/* ------------------------------------------------------------------ */
/* Public presentation links                                           */
/* ------------------------------------------------------------------ */

interface ShareRecord {
  id: string;
  kind: 'deck';
  projectId: string;
  nodeId: string;
  createdBy: string;
  createdAt: string;
}

interface SharedDeck {
  name: string;
  deckId: string;
  state: ProjectState;
  assets: Set<string>;
}

/** The part of a project a shared deck shows, without speaker notes, code or comments. */
export function sharedDeckState(state: ProjectState, deckId: string, shareId: string): { state: ProjectState; assets: Set<string> } {
  const deps = deckDependencies(state, deckId);
  const nodes: Record<string, SceneNode> = {};
  for (const id of deps.nodeIds) {
    const n = state.nodes[id]!;
    let props = n.props as unknown as Record<string, unknown>;
    if (n.type === 'slide') props = { ...props, notes: '' };
    if (n.type === 'cell') props = { ...props, source: '' };
    if (n.type === 'deck') props = { ...props, shareId: null };
    nodes[id] = { ...n, props: props as never, children: n.children.filter((c) => deps.nodeIds.has(c)) };
  }
  return { state: { id: shareId, rootId: deckId, nodes }, assets: deps.assetIds };
}

const SHARE_TTL = 10_000;

useModule(({ services, router }) => {
  registerExportHandler(services, async (_s, state, node, req, ctx) => {
    if (node.type !== 'deck') return null;
    if (!(DECK_FORMATS as readonly string[]).includes(req.format)) throw new ProjectError(`Slideshows export as ${DECK_FORMATS.join(', ')}`, 400);
    const notes = new Set<string>();
    const base = fileSafe((node as SceneNode<'deck'>).props.name);
    ctx.progress(0.1, 'Preparing slides');
    switch (req.format) {
      case 'pptx': {
        const model = await deckExportModel(services, state, node.id, { pptx: true, notes });
        ctx.progress(0.7, 'Writing PowerPoint');
        return { data: await deckToPptx(model), name: `${base}.pptx`, mime: PPTX_MIME, notes: [...notes] };
      }
      case 'pdf':
      case 'pdf-notes': {
        const model = await deckExportModel(services, state, node.id, { renders: true, notes });
        ctx.progress(0.7, 'Writing PDF');
        if (model.slides.some((s) => s.hidden)) notes.add('Hidden slides were left out.');
        if (req.format === 'pdf') notes.add('Each slide is shown fully built; animations and videos play only when presenting.');
        return { data: await deckToPdf(model, { notes: req.format === 'pdf-notes' }), name: `${base}${req.format === 'pdf-notes' ? '-handout' : ''}.pdf`, mime: 'application/pdf', notes: [...notes] };
      }
      default: {
        const host = services.renderHost();
        await prepareDeck(host, state, node.id);
        const files: Record<string, Uint8Array> = {};
        const slides = deckSlides(state, node.id).filter((s) => !s.props.hidden);
        for (const [i, s] of slides.entries()) {
          const c = renderSlide(host, state, s.id, { scale: req.scale ?? 1, playhead: BUILT });
          files[`${String(i + 1).padStart(2, '0')}-${fileSafe(s.props.name)}.png`] = new Uint8Array(await encodeCanvas(c, 'png'));
          ctx.progress(0.1 + (0.8 * (i + 1)) / slides.length, `Rendering slide ${i + 1} of ${slides.length}`);
        }
        return { data: Buffer.from(zipSync(files, { level: 0 })), name: `${base}-slides.zip`, mime: 'application/zip', notes: ['One PNG per visible slide, fully built.'] };
      }
    }
  });

  router.post(
    '/projects/:id/decks/:deckId/import',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      await services.projects.requireAccess(projectId, user.id, 'write');
      const body = z.object({ assetId: z.string() }).parse(req.body);
      res.json(await importIntoDeck(services, projectId, String(req.params.deckId), body.assetId, { userId: user.id, author: authorOf(req) }));
    }),
  );

  /** Turn the public link on. The deck's shareId is the source of truth; the shares collection indexes it. */
  router.post(
    '/projects/:id/decks/:deckId/share',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      await services.projects.requireAccess(projectId, user.id, 'write');
      const state = await services.projects.state(projectId);
      const deck = requireDeck(state, String(req.params.deckId));
      let shareId = deck.props.shareId;
      if (!shareId) {
        shareId = crypto.randomBytes(18).toString('base64url');
        await services.projects.commit(projectId, { kind: 'update', id: deck.id, set: { shareId } }, authorOf(req), { label: 'Turn on presentation link', via: 'ui' });
      }
      const rec: ShareRecord = { id: shareId, kind: 'deck', projectId, nodeId: deck.id, createdBy: user.id, createdAt: new Date().toISOString() };
      await services.store.put(C.shares, shareId, rec);
      res.json({ shareId, url: `${services.config.publicUrl}/present/${shareId}` });
    }),
  );

  router.delete(
    '/projects/:id/decks/:deckId/share',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      await services.projects.requireAccess(projectId, user.id, 'write');
      const state = await services.projects.state(projectId);
      const deck = requireDeck(state, String(req.params.deckId));
      if (deck.props.shareId) await services.projects.commit(projectId, { kind: 'update', id: deck.id, set: { shareId: null } }, authorOf(req), { label: 'Turn off presentation link', via: 'ui' });
      cache.delete(deck.props.shareId ?? '');
      res.json({ ok: true });
    }),
  );

  const cache = new Map<string, { at: number; value: SharedDeck }>();
  const loadShare = async (shareId: string): Promise<SharedDeck> => {
    const hit = cache.get(shareId);
    if (hit && Date.now() - hit.at < SHARE_TTL) return hit.value;
    const gone = new ProjectError('This presentation link is not available. It may have been turned off.', 404);
    if (!/^[\w-]{10,64}$/.test(shareId)) throw gone;
    const rec = await services.store.get<ShareRecord>(C.shares, shareId);
    if (!rec || rec.kind !== 'deck') throw gone;
    let state: ProjectState;
    try {
      state = await services.projects.state(rec.projectId);
    } catch {
      throw gone;
    }
    const deck = state.nodes[rec.nodeId] as SceneNode<'deck'> | undefined;
    // Turning sharing off (or undoing it) clears shareId on the deck, which closes the link.
    if (!deck || deck.type !== 'deck' || deck.props.shareId !== shareId) throw gone;
    const shared = sharedDeckState(state, deck.id, shareId);
    const value: SharedDeck = { name: deck.props.name, deckId: deck.id, state: shared.state, assets: shared.assets };
    cache.set(shareId, { at: Date.now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    return value;
  };

  router.get(
    '/present/:shareId',
    h(async (req, res) => {
      const d = await loadShare(String(req.params.shareId));
      res.set('Cache-Control', 'no-store');
      res.set('X-Robots-Tag', 'noindex');
      res.json({ name: d.name, deckId: d.deckId, state: d.state });
    }),
  );

  /*
   * Follow the presenter. Whoever presents a shared deck from the editor reports where they are;
   * people watching the public link receive it as server-sent events (no account needed) and
   * follow along. Only the slide and build step travel, and nothing is stored.
   */
  const live = new Map<string, { slideId: string; step: number; at: number }>();
  const watchers = new Map<string, Set<express.Response>>();
  const MAX_WATCHERS = 500;
  const send = (res: express.Response, data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const broadcast = (shareId: string, data: unknown) => {
    for (const res of watchers.get(shareId) ?? []) send(res, data);
  };

  router.post(
    '/projects/:id/decks/:deckId/live',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      await services.projects.requireAccess(projectId, user.id, 'read');
      const deck = requireDeck(await services.projects.state(projectId), String(req.params.deckId));
      const body = z.object({ slideId: z.string().max(80).optional(), step: z.number().int().min(0).max(1000).default(0), ended: z.boolean().optional() }).parse(req.body);
      const shareId = deck.props.shareId;
      if (shareId) {
        if (body.ended || !body.slideId) {
          live.delete(shareId);
          broadcast(shareId, { presenting: false });
        } else {
          const at = { slideId: body.slideId, step: body.step, at: Date.now() };
          live.set(shareId, at);
          broadcast(shareId, { presenting: true, slideId: at.slideId, step: at.step });
        }
      }
      res.json({ shared: !!shareId, watching: shareId ? (watchers.get(shareId)?.size ?? 0) : 0 });
    }),
  );

  router.get(
    '/present/:shareId/live',
    h(async (req, res) => {
      const shareId = String(req.params.shareId);
      await loadShare(shareId);
      const set = watchers.get(shareId) ?? new Set<express.Response>();
      if (set.size >= MAX_WATCHERS) throw new ProjectError('Too many people are following this presentation right now.', 503);
      watchers.set(shareId, set);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Robots-Tag': 'noindex' });
      const now = live.get(shareId);
      // A position more than two hours old is a presentation that ended without saying so.
      send(res, now && Date.now() - now.at < 2 * 3600_000 ? { presenting: true, slideId: now.slideId, step: now.step } : { presenting: false });
      set.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(ping);
        set.delete(res);
        if (!set.size) watchers.delete(shareId);
      });
    }),
  );

  const sharedAsset = async (req: express.Request, id: string): Promise<AssetRecord> => {
    const d = await loadShare(String(req.params.shareId));
    const a = d.assets.has(id) ? await services.assets.get(id) : undefined;
    if (!a) throw new ProjectError('Not found', 404);
    return a;
  };
  router.get(
    '/present/:shareId/assets/:id',
    h(async (req, res) => {
      const a = await sharedAsset(req, String(req.params.id));
      res.json({ asset: { ...assetSummary(a, ''), url: undefined, proxyStatus: a.proxyStatus } });
    }),
  );
  router.use('/present/:shareId/assets', assetFileRoutes(services, sharedAsset));
});

