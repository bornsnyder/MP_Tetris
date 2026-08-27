// Thin WebSocket wrapper with typed messages + reconnect support.
import type { ClientMsg, ServerMsg } from "../../../shared/protocol";

type Handler = (msg: ServerMsg) => void;

export class Connection {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  onOpen: (() => void) | null = null;
  onClose: ((code: number) => void) | null = null;
  get open(): boolean { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

  connect(url?: string): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const target = url ?? `${proto}://${location.host}/ws`;
    this.ws = new WebSocket(target);
    this.ws.onopen = () => this.onOpen?.();
    this.ws.onclose = (e) => this.onClose?.(e.code);
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as ServerMsg;
        for (const h of this.handlers) h(msg);
      } catch { /* ignore malformed */ }
    };
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  on(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  close(): void { try { this.ws?.close(); } catch { /* noop */ } }
}
