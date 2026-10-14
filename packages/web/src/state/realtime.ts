/**
 * WebSocket client for realtime collaboration. Reconnects with backoff and re-joins rooms.
 * Components subscribe to message types; the connection status is observable.
 */
type Handler = (msg: any) => void;

class Realtime {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private statusListeners = new Set<(s: 'connecting' | 'open' | 'closed') => void>();
  private rooms = new Set<string>();
  private queue: string[] = [];
  private attempt = 0;
  private stopped = true;
  clientId: string | null = null;
  status: 'connecting' | 'open' | 'closed' = 'closed';

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  private setStatus(s: 'connecting' | 'open' | 'closed'): void {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  private connect(): void {
    if (this.stopped) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.setStatus('connecting');
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus('open');
      for (const room of this.rooms) ws.send(JSON.stringify({ type: 'join', projectId: room }));
      for (const m of this.queue.splice(0)) ws.send(m);
      this.emit({ type: 'reconnected' });
    };
    ws.onmessage = (e) => {
      let msg: any;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'hello') this.clientId = msg.clientId;
      this.emit(msg);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.setStatus('closed');
      if (this.stopped) return;
      const delay = Math.min(15000, 500 * 2 ** this.attempt++) * (0.8 + Math.random() * 0.4);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  private emit(msg: any): void {
    for (const h of this.handlers.get(msg.type) ?? []) h(msg);
    for (const h of this.handlers.get('*') ?? []) h(msg);
  }

  on(type: string, h: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(h);
    return () => set!.delete(h);
  }

  onStatus(l: (s: 'connecting' | 'open' | 'closed') => void): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  send(msg: unknown): boolean {
    const s = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(s);
      return true;
    }
    this.queue.push(s);
    return false;
  }

  join(projectId: string): void {
    this.rooms.add(projectId);
    this.send({ type: 'join', projectId });
  }

  leave(projectId: string): void {
    this.rooms.delete(projectId);
    this.send({ type: 'leave', projectId });
  }
}

export const realtime = new Realtime();
