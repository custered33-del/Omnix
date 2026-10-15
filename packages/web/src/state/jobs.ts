import { get } from '../lib/api.js';
import { realtime } from './realtime.js';

const FINISHED = new Set(['done', 'failed', 'cancelled']);

/**
 * Follow one job's progress. Listens for updates first and then reads the job once, so a job
 * that finished while the request starting it was still returning is not missed.
 */
export function watchJob<T extends { id: string; status: string }>(id: string, onUpdate: (job: T) => void): () => void {
  let live = true;
  let heard = false;
  const off = realtime.on('job', (m: { job: T }) => {
    if (!live || m.job?.id !== id) return;
    heard = true;
    onUpdate(m.job);
  });
  get<{ job: T }>(`/api/jobs/${encodeURIComponent(id)}`).then(
    (r) => {
      // A live update may be newer than this snapshot, unless the snapshot is the end.
      if (live && (!heard || FINISHED.has(r.job.status))) onUpdate(r.job);
    },
    () => {},
  );
  return () => {
    live = false;
    off();
  };
}
