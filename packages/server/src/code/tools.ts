import { z } from 'zod';
import { childrenOf, closest, insertBlocksOps, makeNode, type CellOutput, type SceneNode } from '@omnix/core';
import { defineTool, ToolError, zProjectId, type ToolDef } from '../mcp/registry.js';
import { edit, need, writeResult, zWriteResult } from '../mcp/tools/helpers.js';
import type { CodeService } from './module.js';

/**
 * Code Grounds tools: write and patch files, notebook cells, sandboxed runs, and placing a
 * cell's chart or output live into a document or slide.
 */

const LANG_OF: Record<string, string> = { py: 'python', js: 'javascript', mjs: 'javascript', ts: 'typescript', json: 'json', md: 'markdown', css: 'css', html: 'html' };
const langOf = (p: string) => LANG_OF[p.split('.').pop()?.toLowerCase() ?? ''] ?? 'text';

function summarize(outputs: CellOutput[]): string {
  return outputs
    .map((o) => {
      switch (o.kind) {
        case 'stdout':
        case 'stderr':
        case 'result':
          return o.text.length > 4000 ? `${o.text.slice(0, 4000)}\n… (${o.text.length - 4000} more characters)` : o.text;
        case 'error':
          return `${o.name}: ${o.message}${o.traceback ? `\n${o.traceback.slice(-2000)}` : ''}`;
        case 'chart':
          return `[chart: ${o.spec.title ?? o.spec.type}, ${o.spec.series.length} series × ${o.spec.labels.length} points]`;
        case 'table':
          return `[table: ${o.columns.join(', ')}; ${o.rows.length} rows]`;
        case 'image':
          return `[image ${o.assetId}]`;
      }
    })
    .join('\n');
}

export function codeTools(code: CodeService): ToolDef[] {
  return [
    defineTool({
      name: 'code_write_file',
      title: 'Write a code file',
      description: 'Create a file in a code workspace, or replace its whole content if the path exists. For small changes to a long file use code_edit_file. Paths are relative (for example "src/app.py" or "data/sales.csv").',
      category: 'code',
      access: 'write',
      input: { projectId: zProjectId, workspaceId: z.string(), path: z.string().min(1).max(300).regex(/^[^/\\][^\\]*$/, 'Use a relative path with forward slashes'), content: z.string().max(2_000_000) },
      output: zWriteResult.extend({ fileId: z.string(), created: z.boolean() }),
      example: { input: { projectId: 'prj_8Kq2...', workspaceId: 'ws_1', path: 'analysis.py', content: 'import csv\nprint("hi")\n' }, output: { status: 'proposed', proposalId: 'prop_code...', fileId: 'file_3...', created: true } },
      async handler(args, ctx) {
        let fileId = '';
        let created = false;
        const out = await edit(ctx, args.projectId, `Write ${args.path}`, (state) => {
          need(state, args.workspaceId, 'codeWorkspace', 'code workspace');
          const existing = childrenOf(state, args.workspaceId).find((n) => n.type === 'codeFile' && (n as SceneNode<'codeFile'>).props.path === args.path);
          if (existing) {
            fileId = existing.id;
            return [{ kind: 'update', id: existing.id, set: { content: args.content } }];
          }
          const f = makeNode('codeFile', { path: args.path, language: langOf(args.path) as never, content: args.content });
          fileId = f.id;
          created = true;
          return [{ kind: 'create', parentId: args.workspaceId, nodes: [f] }];
        });
        return writeResult(out, { fileId, created });
      },
    }),

    defineTool({
      name: 'code_edit_file',
      title: 'Edit part of a code file',
      description: 'Replace exact text in a file. Each find must occur exactly once (or pass all: true to replace every occurrence). Edits apply in order. Use get_node on the file to read it first.',
      category: 'code',
      access: 'write',
      input: { projectId: zProjectId, fileId: z.string(), edits: z.array(z.object({ find: z.string().min(1), replace: z.string(), all: z.boolean().default(false) })).min(1).max(50) },
      output: zWriteResult.extend({ replacements: z.number() }),
      example: { input: { projectId: 'prj_8Kq2...', fileId: 'file_3', edits: [{ find: 'print("hi")', replace: 'print("Hello, Seb")' }] }, output: { status: 'committed', commitId: 'c_ed...', replacements: 1 } },
      async handler(args, ctx) {
        let replacements = 0;
        const out = await edit(ctx, args.projectId, 'Edit code', (state) => {
          const f = need(state, args.fileId, 'codeFile', 'code file');
          let content = f.props.content;
          for (const e of args.edits) {
            const count = content.split(e.find).length - 1;
            if (count === 0) throw new ToolError(`Could not find ${JSON.stringify(e.find.slice(0, 80))} in ${f.props.path}.`);
            if (count > 1 && !e.all) throw new ToolError(`${JSON.stringify(e.find.slice(0, 80))} occurs ${count} times in ${f.props.path}; add surrounding text to make it unique, or pass all: true.`);
            content = e.all ? content.split(e.find).join(e.replace) : content.replace(e.find, () => e.replace);
            replacements += e.all ? count : 1;
          }
          return [{ kind: 'update', id: f.id, set: { content } }];
        });
        return writeResult(out, { replacements });
      },
    }),

    defineTool({
      name: 'code_add_cell',
      title: 'Add a notebook cell',
      description: 'Add a code or markdown cell to a notebook, after afterCellId (default: at the end). Python cells can call omnix.chart(type=..., labels=..., series=[...]) and omnix.table(...) for rich outputs that documents and slides can link to.',
      category: 'code',
      access: 'write',
      input: { projectId: zProjectId, notebookId: z.string(), source: z.string().max(500_000), cellType: z.enum(['code', 'markdown']).default('code'), language: z.enum(['python', 'javascript', 'typescript']).optional(), afterCellId: z.string().optional() },
      output: zWriteResult.extend({ cellId: z.string() }),
      example: { input: { projectId: 'prj_8Kq2...', notebookId: 'nb_1', source: 'import omnix\nomnix.chart(type="line", labels=["Q1","Q2"], series=[{"name": "Sales", "values": [10, 14]}])' }, output: { status: 'proposed', proposalId: 'prop_cell...', cellId: 'cell_8...' } },
      async handler(args, ctx) {
        let cellId = '';
        const out = await edit(ctx, args.projectId, `Add ${args.cellType} cell`, (state) => {
          const nb = need(state, args.notebookId, 'notebook', 'notebook');
          const index = args.afterCellId ? nb.children.indexOf(args.afterCellId) + 1 : nb.children.length;
          if (args.afterCellId && index === 0) throw new ToolError(`Cell ${args.afterCellId} is not in this notebook.`);
          const cell = makeNode('cell', { cellType: args.cellType, language: args.language ?? nb.props.language, source: args.source });
          cellId = cell.id;
          return [{ kind: 'create', parentId: nb.id, index, nodes: [cell] }];
        });
        return writeResult(out, { cellId });
      },
    }),

    defineTool({
      name: 'code_run',
      title: 'Run code',
      description:
        'Run a file, a notebook cell or a snippet in the workspace sandbox (Python, JavaScript or TypeScript; no network unless the workspace allows it; time and memory limits apply) and get its output. In autonomous mode cell outputs are saved to the notebook (and update everything linked to them); otherwise you see the results without changing the project.',
      category: 'code',
      access: 'write',
      input: { projectId: zProjectId, workspaceId: z.string(), fileId: z.string().optional(), cellId: z.string().optional(), source: z.string().max(500_000).optional(), language: z.enum(['python', 'javascript', 'typescript']).optional() },
      output: z.object({ ok: z.boolean(), ms: z.number(), outputs: z.array(z.record(z.string(), z.unknown())), saved: z.boolean() }),
      example: { input: { projectId: 'prj_8Kq2...', workspaceId: 'ws_1', cellId: 'cell_8' }, output: { ok: true, ms: 412, outputs: [{ kind: 'chart', spec: { type: 'line', labels: ['Q1', 'Q2'], series: [{ name: 'Sales', values: [10, 14] }] } }], saved: true } },
      async handler(args, ctx) {
        if (ctx.principal.mode === 'view') throw new ToolError('This connection is view-only, so it cannot run code.');
        await ctx.requireProject(args.projectId, 'write');
        if (!args.fileId && !args.cellId && args.source === undefined) throw new ToolError('Pass fileId, cellId or source.');
        const persist = ctx.principal.mode === 'autonomous';
        const r = await code.run(args.projectId, { workspaceId: args.workspaceId, ...(args.fileId ? { fileId: args.fileId } : {}), ...(args.cellId ? { cellId: args.cellId } : {}), ...(args.source !== undefined ? { source: args.source } : {}), ...(args.language ? { language: args.language } : {}) }, { userId: ctx.principal.user.id, author: ctx.principal.author, via: ctx.via === 'agent' ? 'agent' : 'mcp', ...(ctx.jobId ? { jobId: ctx.jobId } : {}), persist });
        const saved = persist && !!r.commitId;
        return { text: `${r.ok ? 'Ran' : 'Failed'} in ${r.ms} ms${saved ? ' (outputs saved to the notebook)' : ''}.\n${summarize(r.outputs) || '(no output)'}`, data: { ok: r.ok, ms: r.ms, outputs: r.outputs as unknown as Record<string, unknown>[], saved } };
      },
    }),

    defineTool({
      name: 'code_place_output',
      title: 'Use a cell\'s output in a document or slide',
      description: 'Link a notebook cell\'s chart, table or output live into a document (as a block after afterBlockId, default at the end) or onto a slide (at x, y, w, h). When the cell runs again, the document and slide update.',
      category: 'code',
      access: 'write',
      input: { projectId: zProjectId, cellId: z.string(), documentId: z.string().optional(), afterBlockId: z.string().optional(), slideId: z.string().optional(), x: z.number().default(160), y: z.number().default(260), w: z.number().positive().default(1600), h: z.number().positive().default(720), caption: z.string().max(500).optional() },
      output: zWriteResult.extend({ nodeId: z.string() }),
      example: { input: { projectId: 'prj_8Kq2...', cellId: 'cell_8', slideId: 'sld_3' }, output: { status: 'committed', commitId: 'c_pl...', nodeId: 'el_7...' } },
      async handler(args, ctx) {
        if (!args.documentId === !args.slideId) throw new ToolError('Pass either documentId or slideId.');
        let nodeId = '';
        const out = await edit(ctx, args.projectId, args.documentId ? 'Link output into document' : 'Link output onto slide', (state) => {
          const cell = need(state, args.cellId, 'cell', 'notebook cell');
          if (!closest(state, cell.id, 'codeWorkspace')) throw new ToolError('That cell is not in a code workspace.');
          const hasChart = cell.props.outputs.some((o) => o.kind === 'chart');
          const embed = { kind: hasChart ? ('chart' as const) : ('cell-output' as const), ref: cell.id };
          if (args.documentId) {
            need(state, args.documentId, 'document', 'document');
            const r = insertBlocksOps(state, args.documentId, args.afterBlockId, [{ blockType: 'embed', text: '', embed, ...(args.caption ? { caption: args.caption } : {}) }]);
            nodeId = r.ids[0]!;
            return r.ops;
          }
          need(state, args.slideId!, 'slide', 'slide');
          const el = makeNode('slideElement', { elementType: 'embed', x: args.x, y: args.y, w: args.w, h: args.h, embed });
          nodeId = el.id;
          return [{ kind: 'create', parentId: args.slideId!, nodes: [el] }];
        });
        return writeResult(out, { nodeId });
      },
    }),
  ] as unknown as ToolDef[];
}
