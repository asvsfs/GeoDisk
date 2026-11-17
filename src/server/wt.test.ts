/**
 * End-to-end test over real WebTransport (HTTP/3 on loopback), using the
 * Node WebTransport client with a pinned self-signed certificate.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {WebTransport, quicheLoaded} from '@fails-components/webtransport';
import {GameClient} from '../client/net/game_client';
import {DEFAULT_CONFIG} from '../shared/config';
import {Room} from '../shared/game/room';
import type {Connector, Link} from '../shared/net/transport';
import {WtLink, type WtSession} from '../shared/net/wt_link';
import {selfSigned} from './cert';
import {WtHost} from './wt_host';

class NodeWtConnector implements Connector {
  constructor(
    private readonly url: string,
    private readonly hash: string,
  ) {}

  async connect(): Promise<Link> {
    await quicheLoaded;
    const wt = new WebTransport(this.url, {
      serverCertificateHashes: [
        {algorithm: 'sha-256', value: Buffer.from(this.hash, 'base64')},
      ],
    });
    await wt.ready;
    const stream = await wt.createBidirectionalStream();
    return new WtLink(1, wt as unknown as WtSession, stream as never);
  }
}

const until = async (ok: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 20));
  }
};

test('two players play over WebTransport', {timeout: 20000}, async () => {
  const cert = await selfSigned(['127.0.0.1', 'localhost']);
  const host = new WtHost({host: '127.0.0.1', port: 0, path: '/geodisk', cert});
  const room = new Room(host, DEFAULT_CONFIG, {seed: 11});
  await room.start();
  const url = `https://127.0.0.1:${host.port}/geodisk`;
  try {
    const a = await GameClient.join(
      new NodeWtConnector(url, cert.hash),
      'alice',
    );
    const b = await GameClient.join(new NodeWtConnector(url, cert.hash), 'bob');
    await until(() => a.players.length === 2 && b.latest() !== null);
    // Snapshots are larger than one datagram, so this exercises uni streams.
    a.launch(0.3, 280);
    await until(() => (b.latest()?.sats.length ?? 0) === 1);
    assert.equal(b.latest()!.sats[0].owner, a.you);
    await until(() => a.rtt > 0);
    a.leave();
    await until(() => room.playerCount === 1);
    b.leave();
  } finally {
    await room.stop();
  }
});
