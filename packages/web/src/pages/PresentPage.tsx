import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { RotateCcw } from 'lucide-react';
import type { ProjectState } from '@omnix/core';
import { BrowserRenderHost } from '../render/browserHost.js';
import { Presenter } from '../editors/slides/Presenter.js';
import { ApiError, get } from '../lib/api.js';
import '../styles/slides.css';

interface Shared {
  name: string;
  deckId: string;
  state: ProjectState;
}

/**
 * Public presentation link (/present/:shareId). Anyone with the link can watch the deck:
 * transitions, builds, video and live charts play as in the editor. Speaker notes, code and
 * comments never leave the server, and only media the deck uses can be loaded.
 */
export function PresentPage() {
  const { shareId = '' } = useParams();
  const [data, setData] = useState<Shared | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [run, setRun] = useState(0);
  const host = useMemo(() => new BrowserRenderHost(`/api/present/${encodeURIComponent(shareId)}/assets`), [shareId]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      get<Shared>(`/api/present/${encodeURIComponent(shareId)}`).then(
        (d) => {
          if (!alive) return;
          setData(d);
          setError(null);
          document.title = `${d.name} · Omnix`;
        },
        (e: unknown) => {
          if (!alive) return;
          setError(e instanceof ApiError && e.status === 404 ? e.message : 'The presentation could not be loaded. Check your connection and try again.');
        },
      );
    void load();
    // Pick up edits when the viewer comes back to the tab.
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [shareId]);

  if (error) {
    return (
      <main className="present-message" id="main">
        <h1>Presentation unavailable</h1>
        <p>{error}</p>
        <p className="muted">Ask the person who shared it for a new link.</p>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="present-message" id="main" aria-busy="true">
        <p className="muted">Loading presentation…</p>
      </main>
    );
  }
  if (ended) {
    return (
      <main className="present-message" id="main">
        <h1>{data.name}</h1>
        <p className="muted">End of presentation.</p>
        <button
          className="btn btn-primary"
          autoFocus
          onClick={() => {
            setEnded(false);
            setRun(run + 1);
          }}
        >
          <RotateCcw /> Watch again
        </button>
      </main>
    );
  }
  return (
    <main id="main">
      <h1 className="sr-only">{data.name}</h1>
      <Presenter key={run} host={host} state={data.state} deckId={data.deckId} startSlide={null} mode="audience" onExit={() => setEnded(true)} />
    </main>
  );
}
