// Auto-reconnecting WebSocket to the tracker process (parallels
// lib/connection.ts, which talks to the display server instead).

import type {
  TrackerClientMessage,
  TrackerConfig,
  TrackerServerMessage,
  TrackerState,
} from "@shared/index.js";

/**
 * Where the tracker process lives, relative to this page. In dev (vite :5173)
 * and when served by the tracker itself, same-origin paths are proxied; in
 * production the pages come from the server (:3000) while the tracker
 * listens on :3001 of the same host.
 */
const SAME_ORIGIN = location.port === "5173" || location.port === "3001";

export function trackerHttp(path: string): string {
  const customUrl = import.meta.env.VITE_TRACKER_URL;
  if (customUrl) {
    const normalized = customUrl.replace(/\/$/, "");
    return `${normalized}${path}`;
  }
  return SAME_ORIGIN ? path : `${location.protocol}//${location.hostname}:3001${path}`;
}

export function trackerWsUrl(): string {
  const customUrl = import.meta.env.VITE_TRACKER_URL;
  if (customUrl) {
    const urlObj = new URL(customUrl, window.location.href);
    const proto = urlObj.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${urlObj.host}/tracker-ws`;
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return SAME_ORIGIN
    ? `${proto}://${location.host}/tracker-ws`
    : `${proto}://${location.hostname}:3001/tracker-ws`;
}

export interface TrackerStreamState {
  connected: boolean;
  state: TrackerState | null;
  config: TrackerConfig | null;
}

type Listener = (s: TrackerStreamState) => void;

export class TrackerConnection {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  stream: TrackerStreamState = { connected: false, state: null, config: null };

  connect(): void {
    this.closed = false;
    this.open();
  }

  private url(): string {
    return trackerWsUrl();
  }

  private open(): void {
    try {
      this.ws = new WebSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.send({ type: "hello", role: "tracker-ui" });
      this.update({ connected: true });
    };
    this.ws.onclose = () => {
      this.update({ connected: false });
      this.scheduleReconnect();
    };
    this.ws.onerror = () => this.ws?.close();
    this.ws.onmessage = (ev) => this.onMessage(ev.data as string);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.open();
    }, 1500);
  }

  private onMessage(raw: string): void {
    let msg: TrackerServerMessage;
    try {
      msg = JSON.parse(raw) as TrackerServerMessage;
    } catch {
      return;
    }
    if (msg.type === "trackerState") this.update({ state: msg.state });
    else if (msg.type === "trackerConfig") this.update({ config: msg.config });
  }

  send(msg: TrackerClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.stream);
    return () => this.listeners.delete(fn);
  }

  private update(partial: Partial<TrackerStreamState>): void {
    this.stream = { ...this.stream, ...partial };
    for (const fn of this.listeners) fn(this.stream);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
