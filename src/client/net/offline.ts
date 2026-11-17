/**
 * @fileoverview Offline play: runs a room inside the page over the in-memory
 * transport. Same room, same protocol, no network.
 */

import {DEFAULT_CONFIG} from '../../shared/config';
import {Room} from '../../shared/game/room';
import {MemConnector, MemHost} from '../../shared/net/mem_transport';
import type {Connector} from '../../shared/net/transport';

/** A local room and a connector bound to it. */
export interface OfflineSession {
  connector: Connector;
  stop(): Promise<void>;
}

/** Starts a local room. */
export async function startOffline(): Promise<OfflineSession> {
  const host = new MemHost();
  const room = new Room(host, DEFAULT_CONFIG, {
    seed: (Math.random() * 0xffff) | 0,
  });
  await room.start();
  return {connector: new MemConnector(host), stop: () => room.stop()};
}
