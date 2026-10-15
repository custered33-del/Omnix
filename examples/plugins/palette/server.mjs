#!/usr/bin/env node
// An Omnix plugin is any MCP server. This one has no dependencies at all: it speaks MCP's
// JSON-RPC over stdio directly (one JSON message per line), to show how little is needed.
//
// Tools:
//   suggest_palette  read-only: harmonious colors around a base color
//   add_swatches     changes a canvas: returns Omnix operations (Omnix applies them under the
//                    caller's permission mode, as a proposal when edits need approval)
//   swatch_image     returns a PNG, both as an image and as a file for the Omnix library
import { createInterface } from 'node:readline';
import { deflateSync } from 'node:zlib';

const TOOLS = [
  {
    name: 'suggest_palette',
    title: 'Suggest a palette',
    description: 'Suggest colors that go with a base color, for a mood (calm, bold, warm or cool).',
    inputSchema: {
      type: 'object',
      properties: {
        baseColor: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Base color like #3366cc' },
        mood: { type: 'string', enum: ['calm', 'bold', 'warm', 'cool'], default: 'calm' },
        count: { type: 'integer', minimum: 3, maximum: 8, default: 5 },
      },
      required: ['baseColor'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add_swatches',
    title: 'Add swatches to a canvas',
    description: 'Add a row of color swatches (one shape layer) to a canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        canvasId: { type: 'string' },
        colors: { type: 'array', items: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, minItems: 1, maxItems: 12 },
        size: { type: 'integer', minimum: 16, maximum: 1000, default: 120 },
        x: { type: 'number', default: 40 },
        y: { type: 'number', default: 40 },
      },
      required: ['projectId', 'canvasId', 'colors'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'swatch_image',
    title: 'Make a swatch image',
    description: 'Make a PNG strip of the given colors and save it to the asset library.',
    inputSchema: {
      type: 'object',
      properties: { colors: { type: 'array', items: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, minItems: 1, maxItems: 12 }, name: { type: 'string', default: 'palette.png' } },
      required: ['colors'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const toHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
function hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function rgb([h, s, l]) {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
function palette(base, mood, count) {
  const [h, s, l] = hsl(hex(base));
  const shift = { calm: 18, bold: 137.5, warm: 12, cool: -16 }[mood] ?? 18;
  const out = [];
  for (let i = 0; i < count; i++) {
    let hh = (h + shift * i + 360) % 360;
    if (mood === 'warm') hh = (hh % 70) + 0;
    if (mood === 'cool') hh = 170 + (hh % 90);
    const ss = mood === 'calm' ? Math.min(s, 0.45) : mood === 'bold' ? Math.max(s, 0.75) : s;
    const ll = Math.min(0.85, Math.max(0.2, l + (i - count / 2) * 0.06));
    out.push(toHex(rgb([hh, ss, ll])));
  }
  out[0] = base.toLowerCase();
  return out;
}

// Minimal PNG writer: 8-bit RGB, no filtering.
function png(width, height, pixel) {
  const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const [r, g, b] = pixel(x, y); const o = y * (width * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function call(name, args, meta) {
  if (name === 'suggest_palette') {
    const colors = palette(args.baseColor, args.mood ?? 'calm', args.count ?? 5);
    return { content: [{ type: 'text', text: `Palette (${args.mood ?? 'calm'}): ${colors.join(' ')}` }], structuredContent: { colors } };
  }
  if (name === 'add_swatches') {
    const size = args.size ?? 120, gap = Math.round(size / 6), x0 = args.x ?? 40, y0 = args.y ?? 40;
    const shapes = args.colors.map((c, i) => ({ id: `sw${i}`, kind: 'rect', x: x0 + i * (size + gap), y: y0, width: size, height: size, fill: c, stroke: null, strokeWidth: 0 }));
    const who = meta?.['omnix/context']?.user?.name ?? 'someone';
    return {
      content: [{ type: 'text', text: `Adding ${args.colors.length} swatches for ${who}.` }],
      structuredContent: {
        omnix: {
          projectId: args.projectId,
          label: `Add ${args.colors.length} palette swatches`,
          // Omnix fills in every other layer property with its defaults.
          operations: [{ kind: 'create', parentId: args.canvasId, nodes: [{ type: 'layer', props: { name: 'Palette', layerType: 'vector', shapes } }] }],
        },
      },
    };
  }
  if (name === 'swatch_image') {
    const colors = args.colors.map(hex), w = 80 * colors.length, h = 80;
    const data = png(w, h, (x) => colors[Math.min(colors.length - 1, Math.floor(x / 80))]).toString('base64');
    return {
      content: [{ type: 'text', text: `Made a ${w}x${h} swatch image.` }, { type: 'image', data, mimeType: 'image/png' }],
      structuredContent: { width: w, height: h, omnix: { assets: [{ name: args.name ?? 'palette.png', mimeType: 'image/png', data }] } },
    };
  }
  throw new Error(`Unknown tool ${name}`);
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notifications (initialized, cancelled) need no answer
  try {
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'palette', version: '1.0.0' } } });
    else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    else if (msg.method === 'tools/call') send({ jsonrpc: '2.0', id: msg.id, result: call(msg.params.name, msg.params.arguments ?? {}, msg.params._meta) });
    else if (msg.method === 'ping') send({ jsonrpc: '2.0', id: msg.id, result: {} });
    else send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  } catch (e) {
    send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: e.message }] } });
  }
});
