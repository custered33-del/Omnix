import type { OmnixConfig } from './config.js';
import type { DocStore } from './storage/store.js';
import type { BlobStore } from './storage/blobs.js';
import type { UserService } from './auth/users.js';
import type { ProjectService } from './projects/service.js';
import type { ActivityService } from './projects/activity.js';
import type { AssetPipeline } from './assets/pipeline.js';
import type { JobQueue } from './jobs/queue.js';
import type { PresenceService } from './realtime/presence.js';
import type { ServerRenderHost } from './render/serverHost.js';

/**
 * Everything the HTTP API, MCP tools, realtime hub and agent runner share.
 * Built once in `createOmnix` and passed around explicitly (no globals).
 */
export interface Services {
  config: OmnixConfig;
  store: DocStore;
  blobs: BlobStore;
  users: UserService;
  projects: ProjectService;
  activity: ActivityService;
  assets: AssetPipeline;
  jobs: JobQueue;
  presence: PresenceService;
  /** A fresh render host (cheap; caches are per host). */
  renderHost(): ServerRenderHost;
  /** Late-bound extensions registered by later subsystems (exporters, sandbox, oauth, agent, plugins). */
  ext: Record<string, unknown>;
}
