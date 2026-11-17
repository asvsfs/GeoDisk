/**
 * @fileoverview In-process transport for tests and offline play.
 *
 * Delivery is asynchronous (microtask) to mirror real networks, and messages
 * are copied so neither side can mutate the other's buffers.
 */

import {
  BaseLink,
  Delivery,
  type Connector,
  type Host,
  type Link,
} from './transport';

let nextLinkId = 1;

class MemLink extends BaseLink {
  peer: MemLink | null = null;

  send(data: Uint8Array, _delivery: Delivery): void {
    const peer = this.peer;
    if (this.closed || !peer) return;
    const copy = data.slice();
    queueMicrotask(() => peer.deliver(copy));
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    const peer = this.peer;
    this.finish(reason);
    if (peer) queueMicrotask(() => peer.finish(reason));
  }
}

/** Host that accepts links from `MemConnector`s bound to it. */
export class MemHost implements Host {
  private onLink: ((link: Link) => void) | null = null;

  start(onLink: (link: Link) => void): Promise<void> {
    this.onLink = onLink;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.onLink = null;
    return Promise.resolve();
  }

  /** Creates a connected pair and hands the server end to the host. */
  accept(): Link {
    if (!this.onLink) throw new Error('MemHost is not started');
    const server = new MemLink(nextLinkId++);
    const client = new MemLink(nextLinkId++);
    server.peer = client;
    client.peer = server;
    this.onLink(server);
    return client;
  }
}

/** Connector that opens links to a `MemHost`. */
export class MemConnector implements Connector {
  constructor(private readonly host: MemHost) {}

  connect(): Promise<Link> {
    return Promise.resolve(this.host.accept());
  }
}
