import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Radio, RotateCcw } from 'lucide-react';
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
  const reload = useRef<() => Promise<void>>(async () => {});
  const host = useMemo(() => new BrowserRenderHost(`/api/present/${encodeURIComponent(shareId)}/assets`), [shareId]);
  // Where the presenter is, while someone presents this deck from Omnix.
  const [live, setLive] = useState<{ presenting: boolean; slideId?: string; step?: number; seq: number }>({ presenting: false, seq: 0 });
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const events = new EventSource(`/api/present/${encodeURIComponent(shareId)}/live`);
    events.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data) as { presenting: boolean; slideId?: string; step?: number };
        setLive((prev) => ({ ...m, seq: prev.seq + 1 }));
      } catch {
        // Ignore anything that is not a position.
      }
    };
    return () => events.close();
  }, [shareId]);

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
    reload.current = load;
    // Pick up edits when the viewer comes back to the tab.
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [shareId]);

  useEffect(() => {
    // The presenter is on a slide added since this copy loaded: load the deck again, then go there.
    if (data && live.presenting && live.slideId && !data.state.nodes[live.slideId]) void reload.current().then(() => setLive((p) => ({ ...p, seq: p.seq + 1 })));
    if (live.presenting && following) setEnded(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.seq]);

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
  if (ended && !(live.presenting && following)) {
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
      <Presenter
        key={run}
        host={host}
        state={data.state}
        deckId={data.deckId}
        startSlide={null}
        mode="audience"
        onExit={() => setEnded(true)}
        follow={following && live.presenting && live.slideId ? { slideId: live.slideId, step: live.step ?? 0, seq: live.seq } : null}
        onNavigate={() => live.presenting && setFollowing(false)}
        banner={
          live.presenting ? (
            <div className="follow-banner" role="status">
              <Radio size={14} aria-hidden="true" />
              {following ? 'Following the presenter' : 'Browsing on your own'}
              <button
                className="btn btn-sm"
                onClick={() => {
                  // Following again jumps straight to where the presenter is.
                  if (!following) setLive((p) => ({ ...p, seq: p.seq + 1 }));
                  setFollowing(!following);
                }}
              >
                {following ? 'Browse on my own' : 'Follow the presenter'}
              </button>
            </div>
          ) : null
        }
      />
    </main>
  );
}
