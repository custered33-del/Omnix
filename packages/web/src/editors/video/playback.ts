import type { ProjectState, SceneNode } from '@omnix/core';
import { clipEnd, clipPropsAt, clipsOf, playbackTime, sourceTimeAt, speedAt, tracksOf, contentDuration } from '@omnix/core';
import type { BrowserRenderHost } from '../../render/browserHost.js';
import { dbToGain, type TimelineEditorStore } from './timelineState.js';

interface ClipVoice {
  el: HTMLAudioElement;
  gain: GainNode;
  assetId: string;
}

interface TrackBus {
  input: GainNode;
  duck: GainNode;
  pan: StereoPannerNode;
  analyser: AnalyserNode;
}

const DRIFT = 0.15;

/**
 * Real-time preview playback: advances the playhead, plays audio through a Web Audio mix
 * (clip volume and keyframes, track gain, pan, mute/solo and ducking), and keeps video
 * elements running in sync so the renderer can draw their current frames.
 */
export class PlaybackEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buses = new Map<string, TrackBus>();
  private voices = new Map<string, ClipVoice>();
  private raf = 0;
  private lastWall = 0;
  private unsub: (() => void) | null = null;

  constructor(
    private host: BrowserRenderHost,
    private getState: () => ProjectState | null,
    private sequenceId: string,
    private ed: TimelineEditorStore,
  ) {
    this.unsub = ed.subscribe((s, prev) => {
      if (s.playing && !prev.playing) this.start();
      if (!s.playing && prev.playing) this.stop();
    });
  }

  private audio(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private bus(trackId: string): TrackBus {
    let b = this.buses.get(trackId);
    if (!b) {
      const ac = this.audio();
      const input = ac.createGain();
      const duck = ac.createGain();
      const pan = ac.createStereoPanner();
      const analyser = ac.createAnalyser();
      analyser.fftSize = 512;
      input.connect(duck).connect(pan).connect(analyser).connect(this.master!);
      b = { input, duck, pan, analyser };
      this.buses.set(trackId, b);
    }
    return b;
  }

  /** Peak level (0..1) of a track's output, for the mixer meters. */
  level(trackId: string): number {
    const b = this.buses.get(trackId);
    if (!b || !this.ed.getState().playing) return 0;
    const data = new Float32Array(b.analyser.fftSize);
    b.analyser.getFloatTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    return Math.min(1, peak);
  }

  private voice(clip: SceneNode<'clip'>, trackId: string): ClipVoice {
    let v = this.voices.get(clip.id);
    if (v && v.assetId !== clip.props.assetId) {
      this.dropVoice(clip.id);
      v = undefined;
    }
    if (!v) {
      const ac = this.audio();
      const el = new Audio();
      el.crossOrigin = 'use-credentials';
      el.preload = 'auto';
      el.src = this.host.audioSource(clip.props.assetId!);
      const src = ac.createMediaElementSource(el);
      const gain = ac.createGain();
      src.connect(gain).connect(this.bus(trackId).input);
      v = { el, gain, assetId: clip.props.assetId! };
      this.voices.set(clip.id, v);
    }
    return v;
  }

  private dropVoice(id: string): void {
    const v = this.voices.get(id);
    if (!v) return;
    v.el.pause();
    v.el.removeAttribute('src');
    v.el.load();
    v.gain.disconnect();
    this.voices.delete(id);
  }

  private start(): void {
    const ac = this.audio();
    void ac.resume();
    this.lastWall = performance.now();
    const loop = () => {
      const now = performance.now();
      const dt = (now - this.lastWall) / 1000;
      this.lastWall = now;
      this.advance(dt);
      if (this.ed.getState().playing) this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private stop(): void {
    cancelAnimationFrame(this.raf);
    for (const v of this.voices.values()) v.el.pause();
    this.pauseVideos();
  }

  private pauseVideos(): void {
    const state = this.getState();
    if (!state || !state.nodes[this.sequenceId]) return;
    for (const track of tracksOf(state, this.sequenceId))
      for (const c of clipsOf(state, track.id)) if (c.props.assetId && this.host.assetMeta(c.props.assetId)?.kind === 'video' && this.host.canPlayVideo(c.props.assetId)) this.host.videoElement(c.props.assetId).pause();
  }

  private advance(dt: number): void {
    const state = this.getState();
    if (!state || !state.nodes[this.sequenceId]) return;
    const seq = state.nodes[this.sequenceId] as SceneNode<'sequence'>;
    const sp = seq.props;
    const st = this.ed.getState();
    const end = sp.purpose === 'animation' ? sp.duration : Math.max(sp.duration, contentDuration(state, this.sequenceId)) || sp.duration;
    let t = st.time + dt;
    if (t >= end) {
      if (sp.purpose === 'animation' && sp.playback !== 'once') {
        // Loop and ping-pong are handled by the renderer; the playhead keeps running and wraps.
        t = sp.playback === 'loop' ? t % end : t % (end * 2);
      } else {
        st.set({ time: end, playing: false });
        return;
      }
    }
    st.set({ time: t });
    if (sp.purpose === 'video') this.syncMedia(state, playbackTime('once', t, end));
  }

  /** Bring audio voices and video elements in line with sequence time t. */
  syncMedia(state: ProjectState, t: number): void {
    const playing = this.ed.getState().playing;
    const solo = this.ed.getState().soloTracks;
    const tracks = tracksOf(state, this.sequenceId);
    const activeVoices = new Set<string>();
    const audibleTracks = new Set<string>();
    const activeVideos = new Map<string, { time: number; rate: number }>();

    for (const track of tracks) {
      const tp = track.props;
      if (tp.trackType !== 'audio' && tp.trackType !== 'video') continue;
      const muted = tp.muted || (solo.length > 0 && !solo.includes(track.id));
      for (const clip of clipsOf(state, track.id)) {
        const p = clip.props;
        if (!p.assetId || t < p.start || t >= clipEnd(p)) continue;
        const meta = this.host.assetMeta(p.assetId);
        const src = sourceTimeAt(p, t);
        if (src === null) continue;
        const rate = speedAt(p, t);
        if (meta?.kind === 'video' && tp.trackType === 'video' && !tp.hidden) activeVideos.set(p.assetId, { time: src, rate: p.reverse ? 0 : rate });
        const hasAudio = meta ? meta.kind === 'audio' || (meta.kind === 'video' && meta.hasAudio !== false) : tp.trackType === 'audio';
        if (!hasAudio || !playing || p.reverse) continue;
        const v = this.voice(clip, track.id);
        activeVoices.add(clip.id);
        const props = clipPropsAt(p, t);
        v.gain.gain.setTargetAtTime(muted ? 0 : dbToGain(props.volume), this.audio().currentTime, 0.02);
        if (!muted) audibleTracks.add(track.id);
        v.el.playbackRate = Math.min(16, Math.max(0.0625, rate));
        if (Math.abs(v.el.currentTime - src) > DRIFT) v.el.currentTime = src;
        if (v.el.paused) void v.el.play().catch(() => {});
      }
    }
    for (const id of [...this.voices.keys()]) {
      if (!activeVoices.has(id)) {
        const v = this.voices.get(id)!;
        if (!v.el.paused) v.el.pause();
        if (!state.nodes[id]) this.dropVoice(id);
      }
    }
    // Track gain, pan and ducking (a track ducks while its source track is playing something).
    const ac = this.ctx;
    if (ac) {
      for (const track of tracks) {
        const b = this.buses.get(track.id);
        if (!b) continue;
        b.input.gain.setTargetAtTime(dbToGain(track.props.gain), ac.currentTime, 0.02);
        b.pan.pan.setTargetAtTime(track.props.pan, ac.currentTime, 0.02);
        const d = track.props.ducking;
        const ducked = d.enabled && d.sourceTrackId && audibleTracks.has(d.sourceTrackId);
        b.duck.gain.setTargetAtTime(ducked ? dbToGain(d.amountDb) : 1, ac.currentTime, ducked ? 0.05 : 0.25);
      }
    }
    // Video elements: run them while playing, otherwise the renderer seeks them per frame.
    for (const [assetId, v] of activeVideos) {
      if (!this.host.canPlayVideo(assetId)) continue;
      const el = this.host.videoElement(assetId);
      if (playing && v.rate > 0) {
        el.playbackRate = Math.min(16, Math.max(0.0625, v.rate));
        if (Math.abs(el.currentTime - v.time) > DRIFT * 1.5) el.currentTime = v.time;
        if (el.paused) void el.play().catch(() => {});
      } else if (!el.paused) el.pause();
    }
    if (playing) {
      for (const track of tracks)
        for (const c of clipsOf(state, track.id)) {
          const id = c.props.assetId;
          if (id && !activeVideos.has(id) && this.host.assetMeta(id)?.kind === 'video' && this.host.canPlayVideo(id)) {
            const el = this.host.videoElement(id);
            if (!el.paused) el.pause();
          }
        }
    }
  }

  dispose(): void {
    this.stop();
    this.unsub?.();
    for (const id of [...this.voices.keys()]) this.dropVoice(id);
    void this.ctx?.close();
  }
}
