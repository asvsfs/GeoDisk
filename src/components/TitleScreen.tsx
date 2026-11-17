import type { MissionConfig } from '../physics/types';

interface TitleScreenProps {
  missions: readonly MissionConfig[];
  selectedMissionIndex: number;
  onSelectMission: (index: number) => void;
  onStart: () => void;
  gpuActive: boolean | null;
}

export function TitleScreen({
  missions,
  selectedMissionIndex,
  onSelectMission,
  onStart,
  gpuActive,
}: TitleScreenProps) {
  return (
    <div
      className="fixed inset-0 z-20 flex flex-col justify-between p-6 md:p-12 pointer-events-none"
      aria-label="Title screen"
    >
      {/* Top quiet spec line */}
      <div className="flex items-center justify-between text-xs font-mono text-slate-400">
        <span>2+1D SPACETIME GEODESIC FLIGHT</span>
        <span>
          {gpuActive === null
            ? 'PROBING WEBGPU...'
            : gpuActive
              ? 'WEBGPU COMPUTE · 160×100 UNIFORM GRID'
              : 'UNIFORM GRID SOLVER · 160×100'}
        </span>
      </div>

      {/* Upper-left title lockup over calm negative space */}
      <div className="max-w-md mb-auto mt-6 pointer-events-auto bg-[#0B101B]/92 border border-slate-800 rounded-xl p-6 md:p-7 shadow-2xl">
        <div className="flex items-center gap-4 mb-5">
          {/* Bespoke inline SVG spacetime well & geodesic emblem */}
          <svg
            viewBox="0 0 64 64"
            className="w-12 h-12 shrink-0"
            aria-hidden="true"
          >
            <circle
              cx="32"
              cy="32"
              r="28"
              fill="#070A10"
              stroke="#1E293B"
              strokeWidth="1.5"
            />
            <ellipse
              cx="32"
              cy="34"
              rx="22"
              ry="11"
              fill="none"
              stroke="#22D3EE"
              strokeOpacity="0.45"
              strokeWidth="1.5"
            />
            <ellipse
              cx="32"
              cy="38"
              rx="13"
              ry="6.5"
              fill="none"
              stroke="#F59E0B"
              strokeOpacity="0.7"
              strokeWidth="1.5"
            />
            <path
              d="M 10 42 Q 28 10 54 22"
              fill="none"
              stroke="#22D3EE"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
            <circle cx="32" cy="36" r="4.5" fill="#F59E0B" />
            <circle cx="53" cy="22" r="3" fill="#10B981" />
          </svg>
          <div>
            <h1 className="font-display text-4xl md:text-5xl font-bold tracking-tight text-slate-50 leading-none">
              GEODESIC
            </h1>
            <p className="text-sm text-slate-400 mt-1.5">
              2D + Time Relativistic Gravity Rocket Simulation
            </p>
          </div>
        </div>

        {/* Mission Selector */}
        <div className="mb-6">
          <label
            htmlFor="title-mission-select"
            className="block text-xs font-mono uppercase tracking-wider text-slate-400 mb-2"
          >
            Starting Sector
          </label>
          <select
            id="title-mission-select"
            value={selectedMissionIndex}
            onChange={(e) => onSelectMission(Number(e.target.value))}
            className="w-full bg-[#070A10] border border-slate-700 text-slate-100 text-sm rounded-lg px-3.5 py-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            {missions.map((m, idx) => (
              <option key={m.id} value={idx}>
                {m.title}
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-400 mt-2 leading-relaxed">
            {missions[selectedMissionIndex]?.subtitle}
          </p>
        </div>

        {/* Primary CTA */}
        <div className="flex items-center gap-4">
          <button
            type="button"
            data-start="true"
            onClick={onStart}
            className="px-6 py-3 bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-semibold text-sm rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
          >
            Launch Mission
          </button>
          <span className="text-xs font-mono text-slate-400">
            Press Space or Enter
          </span>
        </div>
      </div>

      {/* Bottom flat control hint */}
      <div className="text-xs font-mono text-slate-400 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>Drag Rocket or A/D to Aim</span>
        <span aria-hidden="true">·</span>
        <span>Space Launch &amp; Main Thruster</span>
        <span aria-hidden="true">·</span>
        <span>W/S Power &amp; Retro</span>
        <span aria-hidden="true">·</span>
        <span>P Pause</span>
        <span aria-hidden="true">·</span>
        <span>R Reset</span>
      </div>
    </div>
  );
}
