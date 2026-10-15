import { z } from 'zod';
import { nodeLabel, type NodeType, type Operation, type ProjectState, type SceneNode } from '@omnix/core';
import { ToolError, outcomeText, type ApplyOutcome, type ToolContext, type ToolResult } from '../registry.js';

/** Result of every write tool: committed (autonomous) or proposed (edit with approval). */
export const zWriteResult = z.object({
  status: z.enum(['committed', 'proposed']),
  commitId: z.string().optional(),
  proposalId: z.string().optional(),
  changes: z.number().optional().describe('How many changes the proposal now holds'),
});

export function writeResult<T extends Record<string, unknown>>(out: ApplyOutcome, data: T = {} as T, extra = ''): ToolResult {
  return {
    text: `${outcomeText(out)}${extra ? `\n${extra}` : ''}`,
    data: { status: out.status, ...(out.commitId ? { commitId: out.commitId } : {}), ...(out.proposalId ? { proposalId: out.proposalId } : {}), ...(out.changes ? { changes: out.changes } : {}), ...data },
  };
}

/** A node of the given type(s), or a clear error that tells Claude how to find the right id. */
export function need<T extends NodeType>(state: ProjectState, id: string, types: T | readonly T[], what: string): SceneNode<T> {
  const n = state.nodes[id];
  const list = (Array.isArray(types) ? types : [types]) as readonly NodeType[];
  if (!n) throw new ToolError(`No ${what} with id "${id}" in this project. Call get_project (or get_node) to find the right id.`);
  if (!list.includes(n.type)) throw new ToolError(`"${id}" is a ${n.type}, not a ${what}.`);
  return n as SceneNode<T>;
}

/** The usual write flow: check access, read the caller's working state, build ops, apply. */
export async function edit(ctx: ToolContext, projectId: string, label: string | ((state: ProjectState) => string), build: (state: ProjectState) => Operation[] | Promise<Operation[]>): Promise<ApplyOutcome> {
  await ctx.requireProject(projectId, 'write');
  const state = await ctx.state(projectId);
  const ops = await build(state);
  if (!ops.length) throw new ToolError('Nothing to change.');
  return ctx.apply(projectId, ops, typeof label === 'function' ? label(state) : label);
}

/** How history names a node: its name, path or opening words, with its kind ("layer \"Title\""). */
export function describeNode(state: ProjectState, id: string): string {
  const n = state.nodes[id];
  if (!n) return id;
  const kind = ({ slideElement: 'slide element', codeFile: 'file', animLayer: 'animation layer', block: 'paragraph' } as Record<string, string>)[n.type] ?? n.type;
  const name = nodeLabel(n);
  return name && name !== n.type ? `${kind} "${name.length > 40 ? `${name.slice(0, 37)}…` : name}"` : kind;
}

export const zId = (what: string) => z.string().min(1).describe(`${what} id`);
