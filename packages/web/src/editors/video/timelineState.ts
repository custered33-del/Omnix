import { createStore, type StoreApi } from 'zustand/vanilla';

export type EditMode = 'select' | 'ripple' | 'roll' | 'slip' | 'slide' | 'razor';
export type AnimTool = 'select' | 'brush' | 'eraser' | 'rect' | 'ellipse' | 'bone' | 'pose' | 'path';

export interface TimelineEditorState {
  time: number;
  playing: boolean;
  /** Pixels per second on the timeline. */
  pxPerSec: number;
  selectedClips: string[];
  selectedTrack: string | null;
  mode: EditMode;
  snapping: boolean;
  /** Record movement: every change to a clip's position, size, turn or fade adds a keyframe at the playhead. */
  autoKey: boolean;
  /** Height of the timeline panel in px. */
  timelineHeight: number;
  /** Bottom panel shows the timeline or the audio mixer. */
  bottom: 'timeline' | 'mixer';
  /** Right panel: inspector or captions list. */
  inspectorTab: 'clip' | 'track' | 'sequence';
  soloTracks: string[];
  /** Animation maker. */
  animTool: AnimTool;
  brush: { size: number; color: string; opacity: number; hardness: number };
  shapeFill: string;
  showBones: boolean;
  /** Bone being dragged in pose mode. */
  activeBone: string | null;
  /** Points collected while drawing a motion path. */
  pathDraft: { x: number; y: number }[] | null;
  /** Generative fill: drawing a region on the stage, and the region drawn (sequence pixels). */
  drawingRegion: boolean;
  regionDraft: { x: number; y: number; width: number; height: number } | null;
  set(patch: Partial<TimelineEditorState>): void;
}

export type TimelineEditorStore = StoreApi<TimelineEditorState>;

export function createTimelineStore(purpose: 'video' | 'recense' | 'animation'): TimelineEditorStore {
  return createStore<TimelineEditorState>((set) => ({
    time: 0,
    playing: false,
    pxPerSec: purpose === 'animation' ? 160 : 60,
    selectedClips: [],
    selectedTrack: null,
    mode: 'select',
    snapping: true,
    autoKey: false,
    timelineHeight: purpose === 'animation' ? 240 : 300,
    bottom: 'timeline',
    inspectorTab: 'clip',
    soloTracks: [],
    animTool: 'brush',
    brush: { size: 8, color: '#1d1f24', opacity: 1, hardness: 0.9 },
    shapeFill: '#3b5bdb',
    showBones: true,
    activeBone: null,
    pathDraft: null,
    drawingRegion: false,
    regionDraft: null,
    set: (patch) => set(patch),
  }));
}

/** Format seconds as HH:MM:SS:FF timecode at the given frame rate. */
export function timecode(t: number, fps: number): string {
  const total = Math.max(0, Math.round(t * fps));
  const f = total % fps;
  const s = Math.floor(total / fps);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`;
}

/** Snap a time to the nearest frame boundary. */
export function toFrame(t: number, fps: number): number {
  return Math.round(t * fps) / fps;
}

/** Convert decibels to a linear gain. */
export function dbToGain(db: number): number {
  return db <= -60 ? 0 : Math.pow(10, db / 20);
}
