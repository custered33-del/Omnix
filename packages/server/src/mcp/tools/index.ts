import type { Services } from '../../services.js';
import type { ToolDef } from '../registry.js';
import { projectReadTools, projectWriteTools } from './project.js';
import { assetReadTools, assetWriteTools } from './assets.js';
import { imageTools } from './image.js';
import { timelineTools } from './timeline.js';
import { documentTools } from './docs.js';

/** Extra tool sets registered by later subsystems (editors, AI, agent, plugins). */
export type ToolProvider = (services: Services) => ToolDef[];

export function registerToolProvider(services: Services, p: ToolProvider): void {
  const list = (services.ext.toolProviders as ToolProvider[] | undefined) ?? [];
  list.push(p);
  services.ext.toolProviders = list;
}

/** Every tool Omnix exposes over MCP, in catalog order. Names are unique. */
export function allTools(services: Services): ToolDef[] {
  const tools: ToolDef[] = [...(projectReadTools as unknown as ToolDef[]), ...(projectWriteTools as unknown as ToolDef[]), ...(assetReadTools as unknown as ToolDef[]), ...(assetWriteTools as unknown as ToolDef[]), ...(imageTools as unknown as ToolDef[]), ...(timelineTools as unknown as ToolDef[]), ...(documentTools as unknown as ToolDef[])];
  for (const p of (services.ext.toolProviders as ToolProvider[] | undefined) ?? []) tools.push(...p(services));
  const seen = new Set<string>();
  return tools.filter((t) => {
    if (seen.has(t.name)) return false;
    seen.add(t.name);
    return true;
  });
}
