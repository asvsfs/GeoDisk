/**
 * @fileoverview WebTransport implementation of `Link`, shared by browser and
 * server (both expose the same WHATWG-streams session shape).
 *
 * Channel mapping:
 *  - RELIABLE: one client-opened bidirectional stream, u32-length framed.
 *  - LATEST: a datagram when the message fits, otherwise its own
 *    unidirectional stream so a large snapshot never blocks control traffic
 *    and is never queued behind an older one (in-flight cap, latest wins).
 */

import {BaseLink, Delivery} from './transport';

/** A bidirectional stream as exposed by WebTransport. */
export interface WtStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

/** The subset of a WebTransport session this link needs. */
export interface WtSession {
  readonly closed: Promise<unknown>;
  readonly datagrams: {
    readonly readable: ReadableStream<Uint8Array>;
    /** Older API; superseded by `createWritable()`. */
    readonly writable?: WritableStream<Uint8Array>;
    createWritable?(): WritableStream<Uint8Array>;
    readonly maxDatagramSize?: number;
  };
  readonly incomingUnidirectionalStreams: ReadableStream<
    ReadableStream<Uint8Array>
  >;
  createUnidirectionalStream(): Promise<WritableStream<Uint8Array>>;
  close(info?: {closeCode?: number; reason?: string}): void;
}

/** Largest reliable frame accepted from a peer. */
const MAX_FRAME = 1 << 20;
/** Largest unidirectional-stream message accepted from a peer. */
const MAX_UNI = 1 << 21;
/** Conservative datagram payload when the session does not report one. */
const DEFAULT_DATAGRAM = 1000;
/** Large LATEST messages allowed in flight before new ones are dropped. */
const MAX_INFLIGHT = 2;
/** Reliable bytes queued before the peer is considered stalled. */
const MAX_QUEUED = 4 << 20;

/** A `Link` over one WebTransport session. */
export class WtLink extends BaseLink {
  private readonly control: WritableStreamDefaultWriter<Uint8Array>;
  private readonly datagrams: WritableStreamDefaultWriter<Uint8Array>;
  private inflight = 0;
  private queued = 0;

  constructor(
    id: number,
    private readonly session: WtSession,
    stream: WtStream,
  ) {
    super(id);
    this.control = stream.writable.getWriter();
    const dg = session.datagrams;
    const writable =
      typeof dg.createWritable === 'function'
        ? dg.createWritable()
        : dg.writable;
    if (!writable) throw new Error('session has no datagram writer');
    this.datagrams = writable.getWriter();
    void this.readFrames(stream.readable);
    void this.readDatagrams();
    void this.readUniStreams();
    session.closed.then(
      () => this.finish('closed'),
      (e: unknown) => this.finish(String((e as Error)?.message ?? e)),
    );
  }

  send(data: Uint8Array, delivery: Delivery): void {
    if (this.closed) return;
    if (delivery === Delivery.RELIABLE) {
      this.sendReliable(data);
    } else if (data.byteLength <= this.datagramSize()) {
      this.datagrams.write(data.slice()).catch(() => {});
    } else {
      void this.sendUni(data.slice());
    }
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.finish(reason);
    try {
      this.session.close({closeCode: 0, reason});
    } catch {
      // Already closed.
    }
  }

  private datagramSize(): number {
    const max = this.session.datagrams.maxDatagramSize;
    return typeof max === 'number' && max > 0
      ? Math.min(max, 1200)
      : DEFAULT_DATAGRAM;
  }

  private sendReliable(data: Uint8Array): void {
    const frame = new Uint8Array(4 + data.byteLength);
    new DataView(frame.buffer).setUint32(0, data.byteLength, true);
    frame.set(data, 4);
    this.queued += frame.byteLength;
    if (this.queued > MAX_QUEUED) {
      this.close('peer stalled');
      return;
    }
    this.control.write(frame).then(
      () => {
        this.queued -= frame.byteLength;
      },
      () => this.close('control stream failed'),
    );
  }

  private async sendUni(data: Uint8Array): Promise<void> {
    if (this.inflight >= MAX_INFLIGHT) return;
    this.inflight++;
    try {
      const stream = await this.session.createUnidirectionalStream();
      const writer = stream.getWriter();
      await writer.write(data);
      await writer.close();
    } catch {
      // Dropped: LATEST messages are superseded by the next one anyway.
    } finally {
      this.inflight--;
    }
  }

  private async readFrames(
    readable: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const reader = readable.getReader();
    let buf: Uint8Array = new Uint8Array(0);
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        buf = concat(buf, value);
        while (buf.byteLength >= 4) {
          const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(
            0,
            true,
          );
          if (len > MAX_FRAME) {
            this.close('frame too large');
            return;
          }
          if (buf.byteLength < 4 + len) break;
          this.deliver(buf.slice(4, 4 + len));
          buf = buf.subarray(4 + len);
        }
      }
      this.close('control stream ended');
    } catch {
      this.close('control stream error');
    }
  }

  private async readDatagrams(): Promise<void> {
    const reader = this.session.datagrams.readable.getReader();
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) return;
        this.deliver(value);
      }
    } catch {
      // Session closed.
    }
  }

  private async readUniStreams(): Promise<void> {
    const reader = this.session.incomingUnidirectionalStreams.getReader();
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) return;
        void this.readUni(value);
      }
    } catch {
      // Session closed.
    }
  }

  private async readUni(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_UNI) {
          await reader.cancel();
          return;
        }
        parts.push(value);
      }
    } catch {
      return;
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    this.deliver(out);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
