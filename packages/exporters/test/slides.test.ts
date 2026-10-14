import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { XMLValidator } from 'fast-xml-parser';
import { deckToPdf, deckToPptx, importPptx, parseXml, pptxColor, timingXml, transitionXml, type DeckExportElement, type DeckExportModel } from '../src/index.js';

const fixture = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/sample.pptx')));

const text = (over: Partial<Extract<DeckExportElement, { kind: 'text' }>> = {}): DeckExportElement => ({ kind: 'text', x: 100, y: 100, w: 1200, h: 200, rotation: 0, opacity: 1, text: 'Hello', fontFamily: 'Inter', monoFamily: 'JetBrains Mono', fontSize: 48, color: '#1d1f24', linkColor: '#3b5bdb', align: 'left', valign: 'top', bold: false, lineHeight: 1.4, ...over });

describe('PowerPoint import', () => {
  const imp = importPptx(fixture, { width: 1920, height: 1080 });

  it('reads slides in order with placeholders resolved through layouts and masters', () => {
    expect(imp.slides.map((s) => s.layout)).toEqual(['title', 'title-body', 'blank', 'title-body', 'blank']);
    const [title, subtitle] = imp.slides[0]!.elements;
    expect(title).toMatchObject({ kind: 'text', role: 'title', text: 'Quarterly Review', valign: 'middle', align: 'center' });
    expect(subtitle).toMatchObject({ kind: 'text', role: 'subtitle', text: 'Prepared for Seb' });
    // 44pt titles at 1920 px wide are 88 px.
    expect(title!.kind === 'text' && Math.round(title.fontSize!)).toBe(88);
    expect(imp.fonts).toEqual({ heading: 'Calibri', body: 'Calibri' });
  });

  it('keeps bullets, levels, bold, italic and links as inline markdown', () => {
    const body = imp.slides[1]!.elements.find((e) => e.kind === 'text' && e.role === 'body');
    expect(body && body.kind === 'text' && body.text).toBe('- Revenue grew 12%\n- Costs **fell** *slightly*\n  - [Details on the website](https://example.com/report)');
  });

  it('maps shapes, pictures with crops, groups and connectors', () => {
    const els = imp.slides[2]!.elements;
    const shapes = els.filter((e) => e.kind === 'shape').map((e) => (e.kind === 'shape' ? e.shape.kind : ''));
    expect(shapes).toEqual(['rect', 'ellipse', 'polygon', 'polygon', 'line', 'rect']);
    const star = els.find((e) => e.kind === 'shape' && e.shape.kind === 'polygon')!;
    expect(star.rotation).toBe(15);
    expect(star.kind === 'shape' && star.shape.points!.length).toBe(10);
    const pic = els.find((e) => e.kind === 'image')!;
    expect(pic.kind === 'image' && pic.crop).toEqual({ l: 0.25, t: 0, r: 0, b: 0 });
    // The grouped text box keeps its position from the group transform.
    const grouped = els.find((e) => e.kind === 'text' && e.text === 'Grouped')!;
    expect(Math.round(grouped.y)).toBe(756);
  });

  it('turns charts into native chart specs and tables into text', () => {
    const els = imp.slides[3]!.elements;
    const bar = els.find((e) => e.kind === 'chart' && e.spec.type === 'bar');
    expect(bar && bar.kind === 'chart' && bar.spec).toMatchObject({ title: 'Sales by region', labels: ['Q1', 'Q2', 'Q3'], series: [{ name: 'North', values: [10, 14, 18] }, { name: 'South', values: [8, 9, 12] }] });
    expect(els.some((e) => e.kind === 'chart' && e.spec.type === 'pie')).toBe(true);
    expect(els.some((e) => e.kind === 'text' && e.text.startsWith('**Region**'))).toBe(true);
    expect(imp.notes).toContain('Tables were imported as text.');
  });

  it('brings notes, transitions, builds, hidden slides, backgrounds and video', () => {
    expect(imp.slides[0]!.notes).toBe('Welcome everyone.\nKeep this short.');
    expect(imp.slides[1]!.transition).toEqual({ kind: 'push', duration: 1 });
    const body = imp.slides[1]!.elements.find((e) => e.kind === 'text' && e.role === 'body')!;
    expect(body.animations).toEqual([{ kind: 'fade-in', trigger: 'on-click', click: 1, delay: 0, duration: 0.75 }]);
    const hidden = imp.slides[4]!;
    expect(hidden).toMatchObject({ hidden: true, background: '#14161c' });
    const video = hidden.elements[0]!;
    expect(video.kind).toBe('video');
    expect(video.kind === 'video' && imp.media(video.media)?.length).toBe(fs.statSync(path.join(__dirname, 'fixtures/tiny.mp4')).size);
  });

  it('refuses files that are not presentations', () => {
    expect(() => importPptx(new Uint8Array([1, 2, 3]), { width: 1920, height: 1080 })).toThrow(/not a valid Office document/);
  });
});

describe('PowerPoint export', () => {
  const model: DeckExportModel = {
    name: 'Round trip',
    width: 1920,
    height: 1080,
    slides: [
      {
        name: 'One',
        hidden: false,
        notes: 'Say hello',
        background: '#ffffff',
        transition: { kind: 'fade', duration: 0.4 },
        elements: [
          text({ text: 'Intro **bold** and *italic*\n- first\n- second with [a link](https://example.com)\n1. one\n2. two', animations: [{ kind: 'fade-in', step: 0, delay: 0, duration: 0.5 }] }),
          { kind: 'shape', x: 1400, y: 100, w: 300, h: 200, rotation: 0, opacity: 1, shape: 'ellipse', radius: 0, fill: '#3b5bdb', stroke: null, strokeWidth: 0, animations: [{ kind: 'fly-in', step: 1, delay: 0.2, duration: 0.8 }, { kind: 'spin', step: 2, delay: 0, duration: 1 }] },
          { kind: 'chart', x: 100, y: 500, w: 800, h: 450, rotation: 0, opacity: 1, spec: { type: 'line', title: 'Trend', labels: ['A', 'B'], series: [{ name: 'S', values: [1, 2] }] }, dark: false, fontFamily: 'Inter' },
        ],
      },
      { name: 'Two', hidden: true, notes: '', background: '#14161c', elements: [] },
    ],
  };

  it('writes valid slide XML with one paragraph-properties block per paragraph', async () => {
    const files = unzipSync(new Uint8Array(await deckToPptx(model)));
    const xml = strFromU8(files['ppt/slides/slide1.xml']!);
    expect(XMLValidator.validate(xml)).toBe(true);
    for (const p of xml.match(/<a:p>[\s\S]*?<\/a:p>/g)!) expect((p.match(/<a:pPr\b/g) ?? []).length).toBeLessThanOrEqual(1);
    // Shape ids are unique on each slide.
    const ids = [...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(xml).toContain('<p:transition spd="fast"><p:fade/></p:transition>');
    expect(xml).toContain('<p:timing>');
    expect(strFromU8(files['ppt/slides/slide2.xml']!)).toContain('show="0"');
  });

  it('reads back what it wrote', async () => {
    const back = importPptx(new Uint8Array(await deckToPptx(model)), { width: 1920, height: 1080 });
    expect(back.slides).toHaveLength(2);
    const [t, shape] = back.slides[0]!.elements;
    expect(t!.kind === 'text' && t.text).toBe('Intro **bold** and *italic*\n- first\n- second with [a link](https://example.com)\n1. one\n2. two');
    expect(t!.animations).toEqual([{ kind: 'fade-in', trigger: 'on-enter', click: null, delay: 0, duration: 0.5 }]);
    expect(shape!.animations.map((a) => [a.kind, a.trigger, a.click, a.delay])).toEqual([
      ['fly-in', 'on-click', 1, 0.2],
      ['spin', 'on-click', 2, 0],
    ]);
    expect(back.slides[0]!.notes).toBe('Say hello');
    expect(back.slides[0]!.transition?.kind).toBe('fade');
    expect(back.slides[1]!.hidden).toBe(true);
    expect(back.slides[0]!.elements.some((e) => e.kind === 'chart' && e.spec.title === 'Trend')).toBe(true);
  });

  it('builds a timing tree PowerPoint accepts', () => {
    const xml = timingXml([text({ animations: [{ kind: 'zoom-in', step: 1, delay: 0, duration: 0.6 }, { kind: 'fade-out', step: 2, delay: 0, duration: 0.5 }] })], (i) => i + 2);
    expect(XMLValidator.validate(`<r xmlns:p="p">${xml}</r>`)).toBe(true);
    const ids = [...xml.matchAll(/<p:cTn id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(xml.match(/nodeType="clickEffect"/g)).toHaveLength(2);
    expect(parseXml(xml).tag).toBe('p:timing');
    expect(transitionXml({ kind: 'none', duration: 1 })).toBe('');
    expect(transitionXml({ kind: 'wipe', duration: 1.2 })).toBe('<p:transition spd="slow"><p:wipe dir="r"/></p:transition>');
  });

  it('converts colors with transparency', () => {
    expect(pptxColor('#3b5bdb')).toEqual({ color: '3B5BDB', transparency: 0 });
    expect(pptxColor('#00000080')).toEqual({ color: '000000', transparency: 50 });
    expect(pptxColor('#fff')).toEqual({ color: 'FFFFFF', transparency: 0 });
  });
});

describe('PDF export', () => {
  it('skips hidden slides and writes a handout page per slide with notes', async () => {
    const pdf = await deckToPdf({ name: 'D', width: 1920, height: 1080, slides: [{ name: 'A', hidden: false, notes: 'n', background: '#ffffff', elements: [text()] }, { name: 'B', hidden: true, notes: '', background: '#000000', elements: [] }] });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect((pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBe(1);
    const handout = await deckToPdf({ name: 'D', width: 1920, height: 1080, slides: [{ name: 'A', hidden: false, notes: 'n', background: '#ffffff', elements: [] }] }, { notes: true });
    expect(handout.toString('latin1')).toMatch(/\/MediaBox \[0 0 612 792\]/);
  });
});
