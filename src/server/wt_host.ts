/**
 * @fileoverview WebTransport `Host` for Node, backed by
 * @fails-components/webtransport (HTTP/3 over libquiche).
 */

import {Http3Server, quicheLoaded} from '@fails-components/webtransport';
import type {Host, Link} from '../shared/net/transport';
import {WtLink, type WtSession, type WtStream} from '../shared/net/wt_link';
import type {CertBundle} from './cert';

/** Options for `WtHost`. */
export interface WtHostOptions {
  host: string;
  port: number;
  /** URL path clients connect to, e.g. "/geodisk". */
  path: string;
  cert: CertBundle;
  log?: (line: string) => void;
}

/** Milliseconds a session has to open its control stream. */
const CONTROL_TIMEOUT_MS = 5000;

interface IncomingSession extends WtSession {
  readonly ready: Promise<unknown>;
  readonly incomingBidirectionalStreams: ReadableStream<WtStream>;
}

/** Accepts WebTransport sessions and turns each into a `Link`. */
export class WtHost implements Host {
  private server: Http3Server | null = null;
  private nextId = 1;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: WtHostOptions) {
    this.log = opts.log ?? (() => {});
  }

  async start(onLink: (link: Link) => void): Promise<void> {
    await quicheLoaded;
    const server = new Http3Server({
      host: this.opts.host,
      port: this.opts.port,
      secret: crypto.randomUUID(),
      cert: this.opts.cert.cert,
      privKey: this.opts.cert.key,
      defaultDatagramsReadableMode: 'bytes',
    });
    this.server = server;
    const sessions = server.sessionStream(this.opts.path);
    server.startServer();
    await server.ready;
    void this.acceptLoop(
      sessions as unknown as ReadableStream<IncomingSession>,
      onLink,
    );
  }

  /** Bound UDP port (useful when started with port 0). */
  get port(): number {
    return this.server?.address()?.port ?? this.opts.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.stopServer();
    await server.closed.catch(() => {});
  }

  private async acceptLoop(
    sessions: ReadableStream<IncomingSession>,
    onLink: (link: Link) => void,
  ): Promise<void> {
    const reader = sessions.getReader();
    for (;;) {
      const {value: session, done} = await reader.read();
      if (done) return;
      void this.open(session, onLink);
    }
  }

  private async open(
    session: IncomingSession,
    onLink: (link: Link) => void,
  ): Promise<void> {
    try {
      await session.ready;
      const stream = await withTimeout(
        firstStream(session),
        CONTROL_TIMEOUT_MS,
      );
      onLink(new WtLink(this.nextId++, session, stream));
    } catch (e) {
      this.log(`session rejected: ${(e as Error).message}`);
      try {
        session.close({closeCode: 1, reason: 'no control stream'});
      } catch {
        // Already closed.
      }
    }
  }
}

async function firstStream(session: IncomingSession): Promise<WtStream> {
  const reader = session.incomingBidirectionalStreams.getReader();
  const {value, done} = await reader.read();
  reader.releaseLock();
  if (done || !value) throw new Error('session closed before control stream');
  return value;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out')), ms);
    p.then(
      v => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e as Error);
      },
    );
  });
}
