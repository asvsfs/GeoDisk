import type { GameState, RunSnapshot } from '../physics/types';

interface GameModalsProps {
  gameState: GameState;
  snapshot: RunSnapshot | null;
  hasNextMission: boolean;
  onResume: () => void;
  onRestart: () => void;
  onNextMission: () => void;
  onReturnTitle: () => void;
}

export function GameModals({
  gameState,
  snapshot,
  hasNextMission,
  onResume,
  onRestart,
  onNextMission,
  onReturnTitle,
}: GameModalsProps) {
  if (gameState !== 'paused' && gameState !== 'gameover') {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center p-4 bg-[#070A10]/75"
      role="dialog"
      aria-modal="true"
      aria-label={gameState === 'paused' ? 'Mission paused' : 'Mission summary'}
    >
      {gameState === 'paused' ? (
        <div className="w-full max-w-sm bg-[#0B101B] border border-slate-800 rounded-xl p-6 shadow-2xl">
          <h2 className="font-display text-2xl font-bold text-slate-100">
            Simulation Paused
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Gravitational grid and geodesic integration suspended.
          </p>

          <div className="mt-6 flex flex-col gap-2.5">
            <button
              type="button"
              onClick={onResume}
              className="w-full px-4 py-2.5 bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-semibold text-sm rounded-lg transition-colors cursor-pointer"
            >
              Resume Flight
            </button>
            <button
              type="button"
              onClick={onRestart}
              className="w-full px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-100 font-medium text-sm rounded-lg transition-colors cursor-pointer"
            >
              Restart Mission
            </button>
            <button
              type="button"
              onClick={onReturnTitle}
              className="w-full px-4 py-2.5 bg-transparent hover:bg-slate-900 text-slate-300 border border-slate-700 font-medium text-sm rounded-lg transition-colors cursor-pointer"
            >
              Title Screen
            </button>
          </div>
        </div>
      ) : snapshot ? (
        <div className="w-full max-w-md bg-[#0B101B] border border-slate-800 rounded-xl p-6 shadow-2xl">
          <div className="flex items-center justify-between">
            <span
              className={`text-xs font-mono uppercase tracking-wider font-semibold ${
                snapshot.outcome === 'victory' ? 'text-emerald-400' : 'text-amber-400'
              }`}
            >
              {snapshot.outcome === 'victory' ? 'Target Captured' : 'Telemetry Lost'}
            </span>
            <span className="text-xs font-mono text-slate-400">
              {snapshot.physicsModelName}
            </span>
          </div>

          <h2 className="font-display text-2xl font-bold text-slate-100 mt-1.5">
            {snapshot.outcome === 'victory' ? 'Geodesic Insertion Complete' : 'Rocket Lost'}
          </h2>
          <p className="text-sm text-slate-400 mt-1">{snapshot.reason}</p>

          {/* 3 Stat Tiles */}
          <div className="grid grid-cols-3 gap-3 mt-5">
            <div className="bg-[#070A10] border border-slate-800 rounded-lg p-3">
              <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
                Proper Time <span className="normal-case">τ</span>
              </div>
              <div className="font-mono text-lg font-semibold text-slate-100 tabular-nums mt-0.5">
                {snapshot.properTime.toFixed(2)}s
              </div>
              <div className="text-[11px] font-mono text-slate-400 tabular-nums">
                Δt {snapshot.timeDilationSaved.toFixed(2)}s
              </div>
            </div>

            <div className="bg-[#070A10] border border-slate-800 rounded-lg p-3">
              <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
                Peak Speed
              </div>
              <div className="font-mono text-lg font-semibold text-slate-100 tabular-nums mt-0.5">
                {Math.round(snapshot.peakSpeed)}
              </div>
              <div className="text-[11px] font-mono text-slate-400 tabular-nums">
                Fuel {Math.round(snapshot.fuelRemainingPct)}%
              </div>
            </div>

            <div className="bg-[#070A10] border border-slate-800 rounded-lg p-3">
              <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
                Min Lapse <span className="normal-case">α</span>
              </div>
              <div className="font-mono text-lg font-semibold text-amber-400 tabular-nums mt-0.5">
                {snapshot.minLapse.toFixed(2)}×
              </div>
              <div className="text-[11px] font-mono text-slate-400 tabular-nums">
                Nodes {snapshot.waypointsCollected}/{snapshot.waypointsTotal}
              </div>
            </div>
          </div>

          <div className="mt-6 flex items-center gap-2.5">
            {snapshot.outcome === 'victory' && hasNextMission ? (
              <>
                <button
                  type="button"
                  data-start="true"
                  onClick={onNextMission}
                  className="flex-1 px-4 py-2.5 bg-emerald-400 hover:bg-emerald-300 text-slate-950 font-semibold text-sm rounded-lg transition-colors cursor-pointer"
                >
                  Next Mission
                </button>
                <button
                  type="button"
                  onClick={onRestart}
                  className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-100 font-medium text-sm rounded-lg transition-colors cursor-pointer"
                >
                  Replay
                </button>
              </>
            ) : (
              <button
                type="button"
                data-start="true"
                onClick={onRestart}
                className="flex-1 px-4 py-2.5 bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-semibold text-sm rounded-lg transition-colors cursor-pointer"
              >
                Try Again
              </button>
            )}
            <button
              type="button"
              onClick={onReturnTitle}
              className="px-4 py-2.5 bg-transparent hover:bg-slate-900 text-slate-300 border border-slate-700 font-medium text-sm rounded-lg transition-colors cursor-pointer"
            >
              Title
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
