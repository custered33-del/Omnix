import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { allTools } from '../src/mcp/tools/index.js';
import type { ToolDef } from '../src/mcp/registry.js';
import { startTestServer, type TestServer } from './helpers.js';

let ts: TestServer;
let tools: ToolDef[];

beforeAll(async () => {
  ts = await startTestServer();
  tools = allTools(ts.omnix.services);
});

afterAll(async () => {
  await ts?.close();
});

describe('the MCP tool catalog', () => {
  it('has an example for every tool that fits its own input and output schemas', () => {
    const problems: string[] = [];
    for (const t of tools) {
      if (!t.title || !t.description) problems.push(`${t.name}: missing title or description`);
      if (t.destructive && t.access !== 'write') problems.push(`${t.name}: destructive but not a write tool`);
      const input = z.object(t.input).safeParse(t.example.input);
      if (!input.success) problems.push(`${t.name} example input: ${input.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      if (t.example.output !== undefined) {
        const output = t.output.safeParse(t.example.output);
        if (!output.success) problems.push(`${t.name} example output: ${output.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('matches the tools the server exposes (run pnpm catalog after changing a tool)', () => {
    const file = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../docs/mcp-tools.json');
    const documented = JSON.parse(fs.readFileSync(file, 'utf8')) as { name: string; description: string; access: string }[];
    const live = tools.filter((t) => t.category !== 'plugin');
    expect(documented.map((t) => t.name).sort()).toEqual(live.map((t) => t.name).sort());
    for (const t of live) {
      const d = documented.find((x) => x.name === t.name)!;
      expect({ name: t.name, description: d.description, access: d.access }).toEqual({ name: t.name, description: t.description, access: t.access });
    }
  });
});
