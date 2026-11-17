/**
 * @fileoverview Lobby: pick a name and join the shared universe or play
 * offline.
 */

import {useState} from 'react';
import {hasWebTransport} from '../net/wt_connector';

/** Lobby props. */
export interface LobbyProps {
  busy: boolean;
  error: string;
  onJoin(name: string, server: string): void;
  onOffline(name: string): void;
}

const NAME_KEY = 'geodisk.name';

function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Storage unavailable; the name just is not remembered.
  }
}

/** Entry screen. */
export function Lobby({busy, error, onJoin, onOffline}: LobbyProps) {
  const [name, setName] = useState(savedName);
  const [server, setServer] = useState(
    () => new URLSearchParams(location.search).get('server') ?? '',
  );
  const [advanced, setAdvanced] = useState(false);
  const wt = hasWebTransport();
  const pilot = name.trim() || 'pilot';

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-[#070A10]/70 backdrop-blur-sm">
      <form
        className="w-[min(420px,calc(100vw-32px))] rounded-2xl border border-slate-800 bg-slate-950/90 p-6 shadow-2xl"
        onSubmit={e => {
          e.preventDefault();
          saveName(pilot);
          onJoin(pilot, server.trim());
        }}
      >
        <h1 className="font-display text-3xl font-bold tracking-tight text-slate-50">
          GeoDisk
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          A shared relativistic universe. Launch satellites from your planet,
          throw worlds into each other, and watch stars go supernova.
        </p>

        <label className="mt-6 block text-xs font-semibold uppercase tracking-wider text-slate-400">
          Pilot name
          <input
            className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-base text-slate-100 outline-none focus:border-cyan-400"
            maxLength={16}
            value={name}
            placeholder="pilot"
            autoFocus
            onChange={e => setName(e.target.value)}
          />
        </label>

        {advanced && (
          <label className="mt-4 block text-xs font-semibold uppercase tracking-wider text-slate-400">
            Server (host:port, blank = this site)
            <input
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-cyan-400"
              value={server}
              placeholder="localhost:4433"
              onChange={e => setServer(e.target.value)}
            />
          </label>
        )}

        <div className="mt-6 flex gap-3">
          <button
            type="submit"
            disabled={busy || !wt}
            className="flex-1 rounded-lg bg-cyan-400 px-4 py-2.5 font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Connecting…' : 'Join universe'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              saveName(pilot);
              onOffline(pilot);
            }}
            className="rounded-lg border border-slate-700 px-4 py-2.5 font-semibold text-slate-200 transition hover:border-slate-500 disabled:opacity-40"
          >
            Offline
          </button>
        </div>

        {!wt && (
          <p className="mt-3 text-xs text-amber-400">
            This browser has no WebTransport support. Use a recent Chrome, Edge
            or Firefox to join online, or play offline.
          </p>
        )}
        {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}

        <button
          type="button"
          className="mt-4 text-xs text-slate-500 underline-offset-2 hover:underline"
          onClick={() => setAdvanced(!advanced)}
        >
          {advanced ? 'Hide server settings' : 'Server settings'}
        </button>
      </form>
    </div>
  );
}
