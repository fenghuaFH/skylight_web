// Single auto-reconnecting WebSocket connection shared within a page.
// Receives config / aircraft / status; sends config patches.

import {
  DEFAULT_CONFIG,
  type Aircraft,
  type ClientMessage,
  type Config,
  type ServerMessage,
  type SourceStatus,
} from "@shared/index.js";

export interface StreamState {
  connected: boolean;
  config: Config | null;
  now: number;
  aircraft: Aircraft[];
  status: SourceStatus | null;
}

type Listener = (state: StreamState) => void;

export function serverHttp(path: string): string {
  const customUrl = import.meta.env.VITE_SERVER_URL;
  if (customUrl) {
    const normalized = customUrl.replace(/\/$/, "");
    return `${normalized}${path}`;
  }
  return path;
}

export class Connection {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private localConfig: Config;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  state: StreamState;

  constructor(private role: "display" | "control") {
    // Load local config
    let saved: Config | null = null;
    try {
      const raw = localStorage.getItem("skylight_local_config");
      if (raw) saved = JSON.parse(raw);
    } catch {
      // ignore
    }
    this.localConfig = saved || { ...DEFAULT_CONFIG };
    
    // Set initial fallback state
    this.state = {
      connected: false,
      config: this.localConfig,
      now: Date.now(),
      aircraft: [],
      status: { source: "api", message: "Connecting to local server (standalone fallback)...", ok: true, count: 0, lastOk: null },
    };

    // Listen to storage changes to sync tabs
    if (typeof window !== "undefined") {
      window.addEventListener("storage", (e) => {
        if (e.key === "skylight_local_config" && !this.state.connected) {
          try {
            const parsed = e.newValue ? JSON.parse(e.newValue) : null;
            if (parsed) {
              this.localConfig = parsed;
              this.update({ config: this.localConfig });
            }
          } catch {
            // ignore
          }
        }
      });
    }
  }

  connect(): void {
    this.closed = false;
    this.open();
    this.startPolling();
  }

  private startPolling(): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => {
      if (!this.state.connected) {
        this.pollAircraft();
      }
    }, 4000);
    // Initial immediate poll
    this.pollAircraft();
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async pollAircraft(): Promise<void> {
    if (this.state.connected) return;
    const cfg = this.localConfig;
    const radius = Math.round(cfg.radiusMiles || 3);
    const lat = cfg.centerLat;
    const lon = cfg.centerLon;
    try {
      // Fetch public airplanes.live API via our Vercel serverless proxy
      const url = `/api/aircraft?lat=${lat}&lon=${lon}&radius=${radius}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const raw = await res.json();
      const rawList = raw.aircraft || raw.ac || [];
      const now = Date.now();
      
      // Normalize raw aircraft from airplanes.live
      const list: Aircraft[] = rawList.map((ac: any) => ({
        hex: ac.hex || String(Math.random()),
        flight: ac.flight?.trim() || undefined,
        lat: ac.lat,
        lon: ac.lon,
        altBaro: ac.alt_baro === "ground" ? null : (ac.alt_baro as number | undefined) ?? null,
        altGeom: ac.alt_geom ?? null,
        gs: ac.gs,
        track: ac.track,
        baroRate: ac.baro_rate ?? null,
        squawk: ac.squawk,
        category: ac.category,
        onGround: ac.alt_baro === "ground",
        registration: ac.r,
        typeCode: ac.t,
        seen: ac.seen,
        rssi: ac.rssi,
        ts: now,
      }));

      this.update({
        now,
        aircraft: list,
        status: { source: "api", message: "Running without local server (standalone)", ok: true, count: list.length, lastOk: Date.now() },
      });
    } catch (err) {
      console.warn("Offline aircraft poll failed:", err);
    }
  }

  private url(): string {
    const customUrl = import.meta.env.VITE_SERVER_URL;
    if (customUrl) {
      const urlObj = new URL(customUrl, window.location.href);
      const proto = urlObj.protocol === "https:" ? "wss" : "ws";
      return `${proto}://${urlObj.host}/ws`;
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws`;
  }

  private open(): void {
    try {
      this.ws = new WebSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.send({ type: "hello", role: this.role });
      this.update({ connected: true });
    };
    this.ws.onclose = () => {
      this.update({ connected: false, config: this.localConfig });
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
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "config":
        this.update({ config: msg.config });
        break;
      case "aircraft":
        this.update({ now: msg.now, aircraft: msg.aircraft });
        break;
      case "status":
        this.update({ status: msg.status });
        break;
    }
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  patchConfig(patch: Partial<Config>): void {
    if (this.state.connected) {
      this.send({ type: "patchConfig", patch });
    } else {
      // Local patch
      this.localConfig = {
        ...this.localConfig,
        ...patch,
        showFields: patch.showFields ? { ...this.localConfig.showFields, ...patch.showFields } : this.localConfig.showFields,
        palette: patch.palette ? { ...this.localConfig.palette, ...patch.palette } : this.localConfig.palette,
      };
      localStorage.setItem("skylight_local_config", JSON.stringify(this.localConfig));
      this.update({ config: this.localConfig });
    }
  }

  resetConfig(): void {
    if (this.state.connected) {
      this.send({ type: "resetConfig" });
    } else {
      this.localConfig = { ...DEFAULT_CONFIG };
      localStorage.setItem("skylight_local_config", JSON.stringify(this.localConfig));
      this.update({ config: this.localConfig });
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private update(partial: Partial<StreamState>): void {
    this.state = { ...this.state, ...partial };
    for (const fn of this.listeners) fn(this.state);
  }

  close(): void {
    this.closed = true;
    this.stopPolling();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
