import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, X, Monitor, Timer, Maximize, Square } from 'lucide-react';
import type { ProjectState, SceneNode } from '@omnix/core';
import { deckSlides, ease, slideElements } from '@omnix/core';
import { renderSlide, renderSlideTransition, slideStepCount, type CanvasLike } from '@omnix/render';
import type { BrowserRenderHost } from '../../render/browserHost.js';
import { Markdown } from '../../components/Markdown.js';

export interface PresenterResult {
  /** Seconds spent on each slide during a rehearsal. */
  timings: Record<string, number>;
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Full-screen presentation: slide transitions, click-by-click builds, playing video and
 * animation embeds, and a presenter view with notes, the next slide and timers. Rehearsal
 * mode records how long each slide takes. The public web link uses the audience mode.
 */
export interface PresenterPosition {
  slideId: string;
  step: number;
}

export function Presenter({
  host,
  state,
  deckId,
  startSlide,
  mode,
  onExit,
  onPosition,
  follow,
  onNavigate,
  banner,
}: {
  host: BrowserRenderHost;
  state: ProjectState;
  deckId: string;
  startSlide: string | null;
  mode: 'present' | 'rehearse' | 'audience';
  onExit: (r: PresenterResult) => void;
  /** Told the slide and build step whenever they change (to share with an audience). */
  onPosition?: (p: PresenterPosition) => void;
  /** Go to this position whenever seq changes (an audience following the presenter). */
  follow?: (PresenterPosition & { seq: number }) | null;
  /** The viewer moved on their own (keys, clicks or the buttons). */
  onNavigate?: () => void;
  /** Shown over the slide, also in full screen. */
  banner?: ReactNode;
}) {
  const slides = deckSlides(state, deckId).filter((s) => !s.props.hidden);
  const deck = state.nodes[deckId] as SceneNode<'deck'>;
  const [index, setIndex] = useState(() => Math.max(0, slides.findIndex((s) => s.id === startSlide)));
  const [step, setStep] = useState(0);
  const [presenterView, setPresenterView] = useState(mode !== 'audience' && window.innerWidth >= 1000);
  const [black, setBlack] = useState(false);
  const [now, setNow] = useState(performance.now());
  const [summary, setSummary] = useState<PresenterResult | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const timing = useRef({ startedAt: performance.now(), slideStartedAt: performance.now(), stepStartedAt: performance.now(), perSlide: {} as Record<string, number> });
  const transition = useRef<{ from: CanvasLike | null; startedAt: number; kind: string; duration: number; easing: SceneNode<'slide'>['props']['transition']['easing'] } | null>(null);
  const lastFrame = useRef<CanvasLike | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const slide = slides[index];

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [presenterView]);

  useEffect(() => {
    root.current?.focus();
    if (mode === 'audience') return;
    root.current?.requestFullscreen?.().catch(() => {});
    return () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  const finish = useCallback(() => {
    const t = timing.current;
    if (slide) t.perSlide[slide.id] = (t.perSlide[slide.id] ?? 0) + (performance.now() - t.slideStartedAt) / 1000;
    if (mode === 'rehearse') setSummary({ timings: { ...t.perSlide } });
    else onExit({ timings: t.perSlide });
  }, [slide, mode, onExit]);

  const goTo = useCallback(
    (i: number, built = false) => {
      if (i < 0 || i >= slides.length || i === index) return;
      const t = timing.current;
      const nowMs = performance.now();
      if (slide) t.perSlide[slide.id] = (t.perSlide[slide.id] ?? 0) + (nowMs - t.slideStartedAt) / 1000;
      const target = slides[i]!;
      const tr = target.props.transition;
      transition.current = tr.kind !== 'none' && i > index ? { from: lastFrame.current, startedAt: nowMs, kind: tr.kind, duration: tr.duration, easing: tr.easing } : null;
      t.slideStartedAt = nowMs;
      t.stepStartedAt = nowMs;
      setIndex(i);
      setStep(built ? slideStepCount(state, target.id) : 0);
    },
    [slides, index, slide, state],
  );

  const next = useCallback(() => {
    if (!slide) return;
    if (step < slideStepCount(state, slide.id)) {
      setStep(step + 1);
      timing.current.stepStartedAt = performance.now();
    } else if (index < slides.length - 1) goTo(index + 1);
    else finish();
  }, [slide, step, state, index, slides.length, goTo, finish]);
  const prev = useCallback(() => {
    if (step > 0) {
      setStep(step - 1);
      timing.current.stepStartedAt = performance.now() - 60_000;
    } else goTo(index - 1, true);
  }, [step, index, goTo]);

  useEffect(() => {
    if (slide) onPosition?.({ slideId: slide.id, step });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slide?.id, step]);

  useEffect(() => {
    if (!follow) return;
    const i = slides.findIndex((s) => s.id === follow.slideId);
    if (i < 0) return;
    if (i !== index) goTo(i);
    setStep(Math.min(follow.step, slideStepCount(state, follow.slideId)));
    timing.current.stepStartedAt = performance.now();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow?.seq]);

  // Draw every animation frame (builds, transitions, playing embeds).
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const c = canvas.current;
      const nowMs = performance.now();
      setNow(nowMs);
      if (c && slide && box.w) {
        const dpr = window.devicePixelRatio || 1;
        const k = Math.min(box.w / deck.props.width, box.h / deck.props.height) * dpr;
        const t = timing.current;
        const videos = new Set(slideElements(state, slide.id).filter((e) => e.props.elementType === 'video').map((e) => e.id));
        let out = renderSlide(host, state, slide.id, { scale: k, playhead: { step, t: (nowMs - t.stepStartedAt) / 1000 }, mediaTime: (nowMs - t.slideStartedAt) / 1000, skipElements: videos });
        const tr = transition.current;
        if (tr) {
          const p = (nowMs - tr.startedAt) / 1000 / Math.max(0.01, tr.duration);
          if (p >= 1) transition.current = null;
          else out = renderSlideTransition(host, tr.from && tr.from.width === out.width ? tr.from : null, out, tr.kind, ease(tr.easing, p));
        }
        lastFrame.current = out;
        if (c.width !== out.width || c.height !== out.height) {
          c.width = out.width;
          c.height = out.height;
        }
        c.getContext('2d')!.drawImage(out as unknown as CanvasImageSource, 0, 0);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [slide?.id, step, box, state, host]);

  // Moving on one's own (as opposed to following the presenter).
  const userNext = () => {
    onNavigate?.();
    next();
  };
  const userPrev = () => {
    onNavigate?.();
    prev();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (summary) return;
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n'].includes(e.key)) {
      e.preventDefault();
      userNext();
    } else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p'].includes(e.key)) {
      e.preventDefault();
      userPrev();
    } else if (e.key === 'Home') {
      onNavigate?.();
      goTo(0);
    } else if (e.key === 'End') {
      onNavigate?.();
      goTo(slides.length - 1, true);
    }
    else if (e.key === 'Escape') finish();
    else if (e.key.toLowerCase() === 'b' || e.key === '.') setBlack(!black);
    else if (e.key.toLowerCase() === 'v' && mode !== 'audience') setPresenterView(!presenterView);
  };

  if (!slide) {
    return (
      <div className="presenter" ref={root} tabIndex={-1} onKeyDown={(e) => e.key === 'Escape' && onExit({ timings: {} })}>
        <p style={{ color: '#fff', margin: 'auto' }}>This deck has no visible slides.</p>
      </div>
    );
  }
  const t = timing.current;
  const W = deck.props.width;
  const H = deck.props.height;
  const k = Math.min(box.w / W, box.h / H) || 0;
  const ox = (box.w - W * k) / 2;
  const oy = (box.h - H * k) / 2;
  const videos = slideElements(state, slide.id).filter((e) => e.props.elementType === 'video' && e.props.assetId);
  const nextSlide = slides[index + 1];
  const steps = slideStepCount(state, slide.id);

  return (
    <div className={`presenter${presenterView ? ' with-notes' : ''}`} ref={root} tabIndex={-1} onKeyDown={onKey} role="application" aria-roledescription="slideshow" aria-label={`${deck.props.name}, slide ${index + 1} of ${slides.length}`}>
      <div className="presenter-stage" ref={stage} onClick={(e) => (e.button === 0 && !summary ? userNext() : undefined)}>
        <canvas ref={canvas} style={{ position: 'absolute', left: ox, top: oy, width: W * k, height: H * k }} aria-hidden="true" />
        {videos.map((v) => (
          <video
            key={v.id}
            className="presenter-video"
            src={host.proxySource(v.props.assetId!)}
            autoPlay
            playsInline
            controls={false}
            style={{ left: ox + v.props.x * k, top: oy + v.props.y * k, width: v.props.w * k, height: v.props.h * k, transform: v.props.rotation ? `rotate(${v.props.rotation}deg)` : undefined, opacity: v.props.opacity }}
          />
        ))}
        {black && <div className="presenter-black" aria-label="Screen blanked" />}
        <div className="sr-only" aria-live="polite">
          Slide {index + 1} of {slides.length}
          {steps ? `, step ${step} of ${steps}` : ''}
        </div>
      </div>
      {presenterView && (
        <aside className="presenter-side" aria-label="Presenter view">
          <div className="presenter-timers">
            <span title="Total time">
              <Timer size={14} /> {fmt((now - t.startedAt) / 1000)}
            </span>
            <span title="Time on this slide">{fmt((now - t.slideStartedAt) / 1000)}</span>
            {mode !== 'rehearse' && slide.props.rehearsalSeconds !== null && <span className="muted" title="Rehearsed time for this slide">rehearsed {fmt(slide.props.rehearsalSeconds)}</span>}
            {mode === 'rehearse' && <span className="badge warning">Rehearsing</span>}
          </div>
          <div className="presenter-count">
            Slide {index + 1} / {slides.length}
            {steps > 0 && ` · step ${step}/${steps}`}
          </div>
          <div className="presenter-next">
            <span className="muted">Next</span>
            {nextSlide ? <NextThumb host={host} state={state} slideId={nextSlide.id} /> : <div className="presenter-end">End of presentation</div>}
          </div>
          <div className="presenter-notes" aria-label="Speaker notes">{slide.props.notes.trim() ? <Markdown source={slide.props.notes} /> : <span className="muted">No notes for this slide.</span>}</div>
        </aside>
      )}
      <div className="presenter-controls" role="toolbar" aria-label="Presentation controls">
        <button className="icon-btn" aria-label="Previous" onClick={userPrev}>
          <ChevronLeft />
        </button>
        <span className="tabular">
          {index + 1} / {slides.length}
        </span>
        <button className="icon-btn" aria-label="Next" onClick={userNext}>
          <ChevronRight />
        </button>
        <button className="icon-btn" aria-label={black ? 'Show slide' : 'Black screen'} aria-pressed={black} onClick={() => setBlack(!black)}>
          <Square />
        </button>
        {mode !== 'audience' && (
          <button className="icon-btn" aria-label="Presenter view" aria-pressed={presenterView} onClick={() => setPresenterView(!presenterView)}>
            <Monitor />
          </button>
        )}
        <button className="icon-btn" aria-label="Full screen" onClick={() => void root.current?.requestFullscreen?.().catch(() => {})}>
          <Maximize />
        </button>
        <button className="icon-btn" aria-label="End presentation" onClick={finish}>
          <X />
        </button>
      </div>
      {banner}
      {summary && (
        <div className="presenter-summary" role="dialog" aria-modal="true" aria-labelledby="rehearsal-title">
          <h2 id="rehearsal-title">Rehearsal finished</h2>
          <p>
            Total: <strong>{fmt(Object.values(summary.timings).reduce((a, b) => a + b, 0))}</strong>
          </p>
          <ol>
            {slides.map((s, i) => (
              <li key={s.id}>
                <span className="grow">
                  {i + 1}. {s.props.name}
                </span>
                <span className="tabular">{fmt(summary.timings[s.id] ?? 0)}</span>
              </li>
            ))}
          </ol>
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => onExit({ timings: {} })}>
              Discard
            </button>
            <button className="btn btn-primary" autoFocus onClick={() => onExit(summary)}>
              Save timings
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NextThumb({ host, state, slideId }: { host: BrowserRenderHost; state: ProjectState; slideId: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const deck = state.nodes[state.nodes[slideId]!.parentId!] as SceneNode<'deck'>;
    const out = renderSlide(host, state, slideId, { scale: 360 / deck.props.width });
    c.width = out.width;
    c.height = out.height;
    c.getContext('2d')!.drawImage(out as unknown as CanvasImageSource, 0, 0);
  }, [slideId, state, host, host.version]);
  return <canvas ref={ref} className="presenter-next-thumb" aria-hidden="true" />;
}
