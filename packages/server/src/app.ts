import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import { loadConfig, type OmnixConfig } from './config.js';
import type { DocStore } from './storage/store.js';
import { FileStore } from './storage/fileStore.js';
import { MemoryStore } from './storage/memoryStore.js';
import { PostgresStore } from './storage/postgresStore.js';
import { LocalBlobStore, S3BlobStore, type BlobStore } from './storage/blobs.js';
import { UserService } from './auth/users.js';
import { ActivityService } from './projects/activity.js';
import { ProjectService } from './projects/service.js';
import { JobQueue } from './jobs/queue.js';
import { AssetPipeline } from './assets/pipeline.js';
import { PresenceService } from './realtime/presence.js';
import { ServerRenderHost } from './render/serverHost.js';
import type { Services } from './services.js';
import { attachUser, errorHandler, h, requireUser } from './http/middleware.js';
import { authRoutes } from './http/authRoutes.js';
import { projectRoutes } from './http/projectRoutes.js';
import { assetRoutes } from './http/assetRoutes.js';
import { mcpRouter } from './mcp/http.js';
import { RealtimeHub, summarizeJob } from './realtime/hub.js';
import { allTools } from './mcp/tools/index.js';
import { OMNIX_VERSION } from './mcp/server.js';
import { ffmpegAvailable } from './util/media.js';

export interface OmnixInstance {
  config: OmnixConfig;
  services: Services;
  app: express.Express;
  server: http.Server;
  hub: RealtimeHub;
  /** Start listening. Resolves with the bound port. */
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

/** Plugins that extend Omnix during startup (editors, exporters, OAuth, agent...). */
export type OmnixModule = (instance: { services: Services; app: express.Express; router: express.Router }) => void | Promise<void>;

const modules: OmnixModule[] = [];
/** Register a module that runs for every Omnix instance created afterwards. */
export function useModule(m: OmnixModule): void {
  modules.push(m);
}

export async function createOmnix(overrides: Partial<OmnixConfig> & { memory?: boolean } = {}): Promise<OmnixInstance> {
  const config: OmnixConfig = { ...loadConfig(), ...overrides };
  const store: DocStore = overrides.memory ? new MemoryStore() : config.databaseUrl ? new PostgresStore(config.databaseUrl) : new FileStore(config.dataDir);
  const blobs: BlobStore = config.s3 ? new S3BlobStore(config.s3, path.join(config.dataDir, 'blob-cache')) : new LocalBlobStore(path.join(config.dataDir, 'blobs'));
  const activity = new ActivityService(store);
  const projects = new ProjectService(store, activity);
  const jobs = new JobQueue(store, 2);
  const presence = new PresenceService();
  const users = new UserService(store, { openSignup: config.openSignup });
  const services = { config, store, blobs, users, projects, activity, jobs, presence, ext: {} } as unknown as Services;
  const assets = new AssetPipeline(store, blobs, config, jobs, (a) => {
    for (const owner of a.owners) services.jobs.emit('asset', { ownerId: owner, asset: a });
  });
  services.assets = assets;
  services.renderHost = () => new ServerRenderHost(blobs, assets, config);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(cookieParser());

  // Security headers for the app shell and API.
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  // MCP endpoints authenticate with bearer tokens and must not depend on cookies.
  app.use(mcpRouter(services));

  const api = express.Router();
  api.use(express.json({ limit: '50mb' }));
  api.use(attachUser(services));

  api.get(
    '/health',
    h(async (_req, res) => {
      res.json({ ok: true, version: OMNIX_VERSION, storage: store.kind, blobs: blobs.kind, ffmpeg: await ffmpegAvailable(config.ffmpegPath), tools: allTools(services).length, ai: { anthropic: !!config.anthropicApiKey } });
    }),
  );
  api.use('/auth', authRoutes(services));
  api.use('/projects', projectRoutes(services));
  api.use('/assets', assetRoutes(services));
  api.get(
    '/activity',
    h(async (req, res) => {
      const user = requireUser(req);
      const projectIds = new Set((await projects.listForUser(user.id, { includeArchived: true })).map((p) => p.id));
      const entries = await activity.list({
        projectIds,
        ...(req.query.projectId ? { projectId: String(req.query.projectId) } : {}),
        ...(req.query.actor === 'ai' || req.query.actor === 'human' ? { actorType: req.query.actor } : {}),
        limit: Math.min(200, Number(req.query.limit ?? 50)),
        ...(req.query.before ? { before: String(req.query.before) } : {}),
      });
      res.json({ entries: entries.filter((e) => !e.projectId || projectIds.has(e.projectId)) });
    }),
  );
  api.get(
    '/jobs',
    h(async (req, res) => {
      const user = requireUser(req);
      const list = await jobs.list({ ownerId: user.id, ...(req.query.projectId ? { projectId: String(req.query.projectId) } : {}) });
      res.json({ jobs: list.slice(0, 100).map(summarizeJob) });
    }),
  );
  api.get(
    '/jobs/:id',
    h(async (req, res) => {
      const user = requireUser(req);
      const j = jobs.get(String(req.params.id));
      if (!j || j.ownerId !== user.id) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      res.json({ job: summarizeJob(j) });
    }),
  );
  api.post(
    '/jobs/:id/cancel',
    h(async (req, res) => {
      const user = requireUser(req);
      const j = jobs.get(String(req.params.id));
      if (!j || j.ownerId !== user.id) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      jobs.cancel(j.id);
      res.json({ ok: true });
    }),
  );

  for (const m of modules) await m({ services, app, router: api });

  api.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use('/api', api);

  // Built web app (single-page): serve static files, fall back to index.html for client routes.
  if (config.webDist && fs.existsSync(path.join(config.webDist, 'index.html'))) {
    app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api|\/mcp|\/sse|\/messages|\/\.well-known|\/oauth).*/, (_req, res) => {
      res.sendFile(path.join(config.webDist!, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Omnix</title><body style="font-family:system-ui;padding:40px;max-width:640px"><h1>Omnix server is running</h1><p>The web app has not been built yet. Run <code>pnpm build</code> (or <code>pnpm dev</code> for development), then reload.</p><p>MCP endpoint: <code>${config.publicUrl}/mcp</code></p></body>`);
    });
  }
  app.use(errorHandler(config.dev));

  const server = http.createServer(app);
  const hub = new RealtimeHub(services, server);

  const evict = setInterval(() => void projects.evictIdle(), 10 * 60_000);
  evict.unref();

  return {
    config,
    services,
    app,
    server,
    hub,
    listen(port = config.port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, config.host, () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      });
    },
    async close() {
      hub.close();
      await projects.flushAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await store.close();
    },
  };
}
