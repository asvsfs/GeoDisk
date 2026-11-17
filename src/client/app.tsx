/**
 * @fileoverview Top-level client: lobby, connection and game screen.
 */

import {useCallback, useEffect, useRef, useState} from 'react';
import {GameClient} from './net/game_client';
import {startOffline, type OfflineSession} from './net/offline';
import {WtConnector, discover} from './net/wt_connector';
import {GameView} from './ui/game_view';
import {Lobby} from './ui/lobby';

interface Session {
  client: GameClient;
  offline: OfflineSession | null;
}

/** Root component. */
export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = useRef<Session | null>(null);

  const leave = useCallback((reason?: string) => {
    const s = current.current;
    current.current = null;
    setSession(null);
    if (reason) setError(reason);
    if (s) {
      if (!s.client.closed) s.client.leave();
      void s.offline?.stop();
    }
  }, []);

  const start = useCallback(async (open: () => Promise<Session>) => {
    setBusy(true);
    setError('');
    try {
      const s = await open();
      current.current = s;
      setSession(s);
    } catch (e) {
      setError((e as Error).message || String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const join = useCallback(
    (name: string, server: string) =>
      void start(async () => {
        const endpoint = await discover(server || undefined);
        const client = await GameClient.join(new WtConnector(endpoint), name);
        return {client, offline: null};
      }),
    [start],
  );

  const offline = useCallback(
    (name: string) =>
      void start(async () => {
        const local = await startOffline();
        try {
          return {
            client: await GameClient.join(local.connector, name),
            offline: local,
          };
        } catch (e) {
          await local.stop();
          throw e;
        }
      }),
    [start],
  );

  useEffect(() => () => leave(), [leave]);

  return (
    <main className="relative h-full w-full overflow-hidden bg-[#070A10]">
      {session ? (
        <GameView
          client={session.client}
          offline={Boolean(session.offline)}
          onLeave={leave}
        />
      ) : (
        <Lobby busy={busy} error={error} onJoin={join} onOffline={offline} />
      )}
    </main>
  );
}
