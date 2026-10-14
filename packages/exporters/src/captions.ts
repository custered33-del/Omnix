/** SRT and WebVTT subtitle formats for captions. Times are in seconds. */
export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

function ts(seconds: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(f).padStart(3, '0')}`;
}

export function toSrt(cues: CaptionCue[]): string {
  return cues.map((c, i) => `${i + 1}\n${ts(c.start, ',')} --> ${ts(c.end, ',')}\n${c.text.trim()}\n`).join('\n');
}

export function toVtt(cues: CaptionCue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${ts(c.start, '.')} --> ${ts(c.end, '.')}\n${c.text.trim()}\n`).join('\n')}`;
}

function parseTs(s: string): number {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/.exec(s.trim());
  if (!m) throw new Error(`Bad timestamp: ${s}`);
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]!.padEnd(3, '0')) / 1000;
}

/** Parse SRT or WebVTT. Styling tags are stripped; cue settings are ignored. */
export function parseSubtitles(text: string): CaptionCue[] {
  const blocks = text.replace(/\r\n?/g, '\n').replace(/^WEBVTT[^\n]*\n/, '').split(/\n{2,}/);
  const cues: CaptionCue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const timeLine = lines.findIndex((l) => l.includes('-->'));
    if (timeLine < 0) continue;
    const [a, b] = lines[timeLine]!.split('-->');
    const textLines = lines.slice(timeLine + 1).map((l) => l.replace(/<[^>]+>/g, ''));
    cues.push({ start: parseTs(a!), end: parseTs(b!.trim().split(/\s+/)[0]!), text: textLines.join('\n') });
  }
  return cues;
}
