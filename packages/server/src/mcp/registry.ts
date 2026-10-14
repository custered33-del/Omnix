import { z } from 'zod';
import type { Author, Operation } from '@omnix/core';
import type { Services } from '../services.js';
import type { User } from '../auth/users.js';
import type { ProjectMeta } from '../projects/service.js';
import { ProjectError } from '../projects/service.js';

/**
 * Permission scopes a connection can hold. Presets map to them:
 *  - view only:          omnix:read
 *  - edit with approval: omnix:read omnix:edit             (every change becomes a proposal)
 *  - autonomous:         omnix:read omnix:edit omnix:autonomous (changes commit directly in allowed projects)
 */
export type Scope = 'omnix:read' | 'omnix:edit' | 'omnix:autonomous';
export const ALL_SCOPES: Scope[] = ['omnix:read', 'omnix:edit', 'omnix:autonomous'];
export type PermissionMode = 'view' | 'approve' | 'autonomous';

export function modeFromScopes(scopes: Iterable<string>): PermissionMode {
  const s = new Set(scopes);
  if (s.has('omnix:autonomous') && s.has('omnix:edit')) return 'autonomous';
  if (s.has('omnix:edit')) return 'approve';
  return 'view';
}

export function scopesForMode(mode: PermissionMode): Scope[] {
  return mode === 'autonomous' ? ['omnix:read', 'omnix:edit', 'omnix:autonomous'] : mode === 'approve' ? ['omnix:read', 'omnix:edit'] : ['omnix:read'];
}

/** Who is calling a tool: the human account it acts for, and how much it may do. */
export interface Principal {
  user: User;
  /** The AI author recorded on every change it makes. */
  author: Author;
  mode: PermissionMode;
  /** Projects this connection may touch ('all' or a list). */
  projectIds: 'all' | string[];
  /** Connection id (OAuth grant or access token) for the activity feed and revocation. */
  connectionId: string;
  clientName: string;
}

export interface ApplyOutcome {
  status: 'committed' | 'proposed';
  commitId?: string;
  proposalId?: string;
  label: string;
}

export interface ToolContext {
  services: Services;
  principal: Principal;
  via: 'mcp' | 'agent';
  jobId?: string;
  /** Access check that also enforces the connection's project allow-list. */
  requireProject(projectId: string, need: 'read' | 'write'): Promise<ProjectMeta>;
  /**
   * Apply operations according to the permission mode: commit directly (autonomous),
   * or record a proposal for a human to review (edit with approval).
   */
  apply(projectId: string, ops: Operation[], label: string, description?: string): Promise<ApplyOutcome>;
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  /** Human/AI-readable summary. */
  text: string;
  /** Structured data (also serialized into the response). */
  data?: unknown;
  images?: { data: Buffer; mimeType: string }[];
}

export type ToolCategory = 'project' | 'assets' | 'image' | 'video' | 'animation' | 'code' | 'document' | 'slides' | 'ai' | 'agent' | 'collaboration' | 'export';

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  category: ToolCategory;
  /** read tools never change anything; write tools go through the permission mode. */
  access: 'read' | 'write';
  input: S;
  /** Description of the structured result, for the catalog. */
  output: z.ZodType;
  example: { input: z.infer<z.ZodObject<S>>; output?: unknown };
  handler(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Build the per-call context. */
export function makeToolContext(services: Services, principal: Principal, via: 'mcp' | 'agent', jobId?: string): ToolContext {
  const ctx: ToolContext = {
    services,
    principal,
    via,
    ...(jobId ? { jobId } : {}),
    async requireProject(projectId, need) {
      if (principal.projectIds !== 'all' && !principal.projectIds.includes(projectId)) {
        throw new ToolError(`This connection is not allowed to access project ${projectId}. The user can add it in Omnix under Claude connection settings.`);
      }
      const meta = await services.projects.requireAccess(projectId, principal.user.id, need === 'write' ? 'write' : 'read');
      if (need === 'write' && !meta.aiConsent) {
        throw new ToolError(`AI is not allowed on "${meta.name}" yet. Ask the user to turn on "Allow AI" for this project in Omnix.`);
      }
      return meta;
    },
    async apply(projectId, ops, label, description) {
      if (principal.mode === 'view') {
        throw new ToolError('This connection is view-only. Ask the user to switch Claude to "edit with approval" or "autonomous" in Omnix to make changes.');
      }
      await ctx.requireProject(projectId, 'write');
      const job = jobId ?? undefined;
      if (principal.mode === 'autonomous') {
        const op: Operation = ops.length === 1 ? ops[0]! : { kind: 'batch', ops };
        try {
          const commit = await services.projects.commit(projectId, op, principal.author, { label, via, ...(job ? { jobId: job } : {}) });
          return { status: 'committed', commitId: commit.id, label };
        } catch (e) {
          if (e instanceof ProjectError) throw new ToolError(e.message);
          throw e;
        }
      }
      try {
        const p = await services.projects.propose(projectId, ops, { author: principal.author, label, ...(description ? { description } : {}), ...(job ? { jobId: job } : {}), via });
        return { status: 'proposed', proposalId: p.id, label };
      } catch (e) {
        if (e instanceof ProjectError) throw new ToolError(e.message);
        throw e;
      }
    },
  };
  return ctx;
}

/** Wording Claude sees after a write, so it knows whether the change is live or awaiting review. */
export function outcomeText(o: ApplyOutcome): string {
  return o.status === 'committed'
    ? `Done: ${o.label} (commit ${o.commitId}).`
    : `Proposed: ${o.label} (proposal ${o.proposalId}). The change is waiting for the user to approve it in Omnix; it is not applied yet.`;
}

export const zProjectId = z.string().min(1).describe('Project id (from list_projects).');
export const zNodeId = z.string().min(1);
