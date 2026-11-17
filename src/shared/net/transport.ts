/**
 * @fileoverview Transport-agnostic networking contracts.
 *
 * Game code talks only to these interfaces. A transport carries opaque byte
 * messages over a `Link` with one of two delivery classes; it knows nothing
 * about the protocol. Implementations:
 *
 *  - `WtLink` / `WtHost` / `WtConnector`: WebTransport (HTTP/3, QUIC).
 *  - `MemHost` / `MemConnector`: in-process, for tests and offline play.
 *
 * Adding a transport (WebSocket fallback, WebRTC, a newer WebTransport API)
 * means implementing these three interfaces; nothing else changes.
 */

/** How a message must be delivered. */
export enum Delivery {
  /** Ordered and guaranteed. Use for control messages and events. */
  RELIABLE = 0,
  /**
   * May be dropped or reordered; never retransmitted once stale. Use for
   * state that the next message supersedes (snapshots).
   */
  LATEST = 1,
}

/** Receives traffic for one link. */
export interface LinkHandler {
  onMessage(data: Uint8Array): void;
  onClose(reason: string): void;
}

/** One open, bidirectional connection between a client and the server. */
export interface Link {
  /** Unique per host for the lifetime of the process. */
  readonly id: number;
  /** Queues `data` for delivery. Messages sent after close are dropped. */
  send(data: Uint8Array, delivery: Delivery): void;
  /** Installs the receiver. Messages arriving before this are buffered. */
  listen(handler: LinkHandler): void;
  close(reason?: string): void;
}

/** Server side of a transport: accepts incoming links. */
export interface Host {
  start(onLink: (link: Link) => void): Promise<void>;
  stop(): Promise<void>;
}

/** Client side of a transport: opens a link to a host. */
export interface Connector {
  connect(): Promise<Link>;
}

/**
 * Base link that buffers inbound messages until a handler is installed and
 * guarantees `onClose` fires exactly once.
 */
export abstract class BaseLink implements Link {
  private handler: LinkHandler | null = null;
  private pending: Uint8Array[] = [];
  private closedWith: string | null = null;
  protected closed = false;

  constructor(readonly id: number) {}

  abstract send(data: Uint8Array, delivery: Delivery): void;

  listen(handler: LinkHandler): void {
    this.handler = handler;
    const queued = this.pending;
    this.pending = [];
    for (const m of queued) handler.onMessage(m);
    if (this.closedWith !== null) handler.onClose(this.closedWith);
  }

  abstract close(reason?: string): void;

  /** Delivers an inbound message to the handler (or buffers it). */
  protected deliver(data: Uint8Array): void {
    if (this.closed) return;
    if (this.handler) this.handler.onMessage(data);
    else this.pending.push(data);
  }

  /** Marks the link closed and notifies the handler once. */
  protected finish(reason: string): void {
    if (this.closedWith !== null) return;
    this.closed = true;
    this.closedWith = reason;
    this.handler?.onClose(reason);
  }
}
