import { createContext, useContext, useEffect, useState } from 'react';
import type { BrowserRenderHost } from './browserHost.js';

export const RenderHostContext = createContext<BrowserRenderHost | null>(null);

export function useRenderHost(): BrowserRenderHost {
  const h = useContext(RenderHostContext);
  if (!h) throw new Error('RenderHost missing');
  return h;
}

/** Re-render when media used by the render host finishes loading. */
export function useHostVersion(): number {
  const host = useRenderHost();
  const [v, setV] = useState(host.version);
  useEffect(() => host.subscribe(() => setV(host.version)), [host]);
  return v;
}
