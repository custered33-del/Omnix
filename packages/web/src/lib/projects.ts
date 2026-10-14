import type { ToolKind } from '@omnix/core';
import { post } from './api.js';
import { t } from '../i18n/index.js';

export interface ProjectListItem {
  id: string;
  name: string;
  primaryTool: ToolKind;
  updatedAt: string;
  createdAt: string;
  archived: boolean;
  aiConsent: boolean;
  thumbnailVersion: number;
  role: 'owner' | 'editor' | 'viewer';
  description?: string;
}

export async function createProject(tool: ToolKind, options: { name?: string; templateId?: string } = {}): Promise<ProjectListItem> {
  const name = options.name ?? t('dashboard.newProjectName', { tool: t(`tools.${tool}`).toLowerCase() });
  const r = await post<{ project: ProjectListItem }>('/api/projects', { name, primaryTool: tool, ...(options.templateId ? { templateId: options.templateId } : {}) });
  return r.project;
}

export const thumbnailUrl = (p: Pick<ProjectListItem, 'id' | 'thumbnailVersion'>, scheme: 'light' | 'dark' = 'light') => `/api/projects/${p.id}/thumbnail?v=${p.thumbnailVersion}&scheme=${scheme}`;
