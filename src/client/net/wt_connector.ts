/**
 * @fileoverview Browser WebTransport `Connector`.
 */

import type {Connector, Link} from '../../shared/net/transport';
import {WtLink, type WtSession} from '../../shared/net/wt_link';

/** Where and how to reach a WebTransport game server. */
export interface WtEndpoint {
  url: string;
  /** Base64 SHA-256 hashes of self-signed certificates to pin. */
  certHashes: string[];
}

let nextLinkId = 1;

/** True when the browser implements WebTransport. */
export function hasWebTransport(): boolean {
  return (
    typeof (globalThis as {WebTransport?: unknown}).WebTransport === 'function'
  );
}

/**
 * Asks the page's origin where the game server listens (`/wt-info`), or uses
 * `server` ("host:port") as the WebTransport address directly.
 */
export async function discover(server?: string): Promise<WtEndpoint> {
  const res = await fetch('/wt-info', {cache: 'no-store'});
  if (!res.ok) throw new Error(`server info unavailable (${res.status})`);
  const info = (await res.json()) as {
    port: number;
    path: string;
    certHashes: string[];
  };
  const target = server || `${location.hostname}:${info.port}`;
  return {url: `https://${target}${info.path}`, certHashes: info.certHashes};
}

/** Opens WebTransport sessions to one endpoint. */
export class WtConnector implements Connector {
  constructor(private readonly endpoint: WtEndpoint) {}

  async connect(): Promise<Link> {
    if (!hasWebTransport())
      throw new Error('This browser does not support WebTransport.');
    const opts: WebTransportOptions = {};
    if (this.endpoint.certHashes.length > 0) {
      opts.serverCertificateHashes = this.endpoint.certHashes.map(h => ({
        algorithm: 'sha-256',
        value: Uint8Array.from(atob(h), c => c.charCodeAt(0)),
      }));
    }
    const wt = new WebTransport(this.endpoint.url, opts);
    await wt.ready;
    const stream = await wt.createBidirectionalStream();
    return new WtLink(nextLinkId++, wt as unknown as WtSession, stream);
  }
}
