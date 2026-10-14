import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { childrenOf, clipEnd, clipsOf, makeNode, requireNodeOfType, tracksOf, type Author, type Operation, type ProjectState, type SceneNode, type TitleSpec } from '@omnix/core';
import { parseSubtitles } from '@omnix/exporters';
import type { Services } from '../services.js';
import { useModule } from '../app.js';
import { h, requireUser, author as authorOf } from '../http/middleware.js';
import { ProjectError } from '../projects/service.js';
import { decodeAudioMono } from '../util/media.js';
import { encodeWav, resolveSpeechProvider, toCaptionLines, type CaptionSegment, type SpeechProvider } from './stt.js';

export { DEFAULT_CAPTION_STYLE, captionTrackOps, captionClipOps, captionSegments, type CaptionJobInput } from './core.js';
import { captionClipOps, captionSegments, type CaptionJobInput } from './core.js';

export async function generateCaptions(services: Services, input: CaptionJobInput, provider: SpeechProvider, progress: (f: number, m: string) => void): Promise<{ count: number; provider: string; hasText: boolean; commitId: string | null }> {
  const state = await services.projects.state(input.projectId);
  const { segments: all, hasText } = await captionSegments(services, state, input, provider, progress);
  if (!all.length) return { count: 0, provider: provider.id, hasText, commitId: null };
  const ops = captionClipOps(state, input.sequenceId, all, input.style);
  const commit = await services.projects.commit(input.projectId, { kind: 'batch', ops }, input.author, {
    label: hasText ? `Generate ${all.length} captions` : `Add ${all.length} caption slots from detected speech`,
    via: input.author.type === 'ai' ? 'mcp' : 'ui',
  });
  return { count: all.length, provider: provider.id, hasText, commitId: commit.id };
}

useModule(async ({ services, router }) => {
  const provider = await resolveSpeechProvider();
  services.ext.speechProvider = provider;
  services.jobs.register<CaptionJobInput, Awaited<ReturnType<typeof generateCaptions>>>('captions.generate', (ctx) => generateCaptions(services, ctx.job.input, provider, ctx.progress));

  router.get('/captions/provider', (_req, res) => {
    res.json({ id: provider.id, label: provider.label, transcribes: provider.id !== 'vad' });
  });

  router.post(
    '/projects/:id/captions/generate',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      await services.projects.requireAccess(projectId, user.id, 'write');
      const body = z.object({ sequenceId: z.string(), clipIds: z.array(z.string()).optional(), language: z.string().max(10).optional() }).parse(req.body);
      const job = await services.jobs.enqueue('captions.generate', { projectId, ...body, author: authorOf(req) }, { title: 'Generate captions', ownerId: user.id, projectId });
      if (req.query.wait === 'true') {
        res.json({ job: await services.jobs.wait(job.id) });
        return;
      }
      res.status(202).json({ job });
    }),
  );

  router.post(
    '/projects/:id/captions/import',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectId = String(req.params.id);
      await services.projects.requireAccess(projectId, user.id, 'write');
      const body = z.object({ sequenceId: z.string(), text: z.string().max(5_000_000), offset: z.number().optional() }).parse(req.body);
      let cues: CaptionSegment[];
      try {
        cues = parseSubtitles(body.text).map((c) => ({ ...c, start: c.start + (body.offset ?? 0), end: c.end + (body.offset ?? 0) }));
      } catch (e) {
        throw new ProjectError(`Could not read the subtitle file: ${(e as Error).message}`, 400);
      }
      if (!cues.length) throw new ProjectError('No captions found in that file', 400);
      const state = await services.projects.state(projectId);
      const commit = await services.projects.commit(projectId, { kind: 'batch', ops: captionClipOps(state, body.sequenceId, cues) }, authorOf(req), { label: `Import ${cues.length} captions` });
      res.json({ count: cues.length, commitId: commit.id });
    }),
  );
});

void childrenOf;
