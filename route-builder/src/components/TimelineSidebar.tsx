import React from 'react';
import {
  Clock,
  Compass,
  MapPin,
  Trash2,
  Navigation,
  Sparkles,
  Zap,
  Info,
  RotateCcw,
} from 'lucide-react';
import type { Waypoint, RouteResponse } from '../types/routing';

interface TimelineSidebarProps {
  waypoints: Waypoint[];
  route: RouteResponse | null;
  isLoadingRoute: boolean;
  onDeleteWaypoint: (id: string) => void;
  onResetSample: () => void;
  onClearAll: () => void;
}

export const TimelineSidebar: React.FC<TimelineSidebarProps> = ({
  waypoints,
  route,
  isLoadingRoute,
  onDeleteWaypoint,
  onResetSample,
  onClearAll,
}) => {
  const formatDuration = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours === 0) return `${minutes}m`;
    return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  };

  return (
    <aside className="w-96 h-full flex flex-col bg-slate-900 border-r border-slate-800 text-slate-100 shrink-0 z-10 shadow-xl select-none">
      {/* App Header */}
      <div className="p-4 border-b border-slate-800 bg-slate-900/90 backdrop-blur-sm">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center shadow-md shadow-sky-500/20">
            <Compass className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight text-white flex items-center gap-1.5">
              Route Builder Studio
            </h1>
            <p className="text-xs text-slate-400">
              Roadtrip Co-Pilot &bull; Offline In-Car Sync
            </p>
          </div>
        </div>

        {/* Status bar */}
        <div className="mt-3 flex items-center justify-between text-xs text-slate-400 bg-slate-800/60 px-2.5 py-1.5 rounded-lg border border-slate-700/50">
          <div className="flex items-center gap-1.5">
            <div
              className={`w-2 h-2 rounded-full ${
                isLoadingRoute ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'
              }`}
            />
            <span>
              {isLoadingRoute
                ? 'Routing...'
                : route?.cached
                ? 'OSRM (Cached)'
                : 'OSRM Ready'}
            </span>
          </div>
          <span className="font-mono text-slate-500 text-[11px]">
            v2.0 • Phase 2A
          </span>
        </div>
      </div>

      {/* Telemetry KPI Cards */}
      <div className="p-4 grid grid-cols-2 gap-2 border-b border-slate-800 bg-slate-950/40">
        <div className="bg-slate-800/70 p-2.5 rounded-xl border border-slate-700/60">
          <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1">
            <Navigation className="w-3.5 h-3.5 text-sky-400" />
            <span>Drive Distance</span>
          </div>
          <div className="text-lg font-bold text-white">
            {route ? `${route.distanceMiles} mi` : '--'}
          </div>
        </div>

        <div className="bg-slate-800/70 p-2.5 rounded-xl border border-slate-700/60">
          <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1">
            <Clock className="w-3.5 h-3.5 text-indigo-400" />
            <span>Drive Duration</span>
          </div>
          <div className="text-lg font-bold text-white">
            {route ? formatDuration(route.durationSeconds) : '--'}
          </div>
        </div>
      </div>

      {/* Waypoints Section Header */}
      <div className="px-4 py-2.5 flex items-center justify-between border-b border-slate-800 bg-slate-900/60">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
            Waypoints
          </span>
          <span className="text-xs px-1.5 py-0.2 rounded-full bg-slate-800 text-sky-400 font-mono font-bold">
            {waypoints.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onResetSample}
            className="p-1 text-slate-400 hover:text-sky-400 hover:bg-slate-800 rounded transition-colors"
            title="Reset sample itinerary"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          {waypoints.length > 0 && (
            <button
              onClick={onClearAll}
              className="p-1 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded transition-colors"
              title="Clear all waypoints"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Waypoint List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {waypoints.length === 0 ? (
          <div className="text-center py-10 px-4 border border-dashed border-slate-700 rounded-xl bg-slate-950/20">
            <MapPin className="w-8 h-8 mx-auto text-slate-600 mb-2" />
            <p className="text-sm font-medium text-slate-300">No waypoints added</p>
            <p className="text-xs text-slate-500 mt-1">
              Search a location in the search bar or click anywhere on the map to add stops.
            </p>
            <button
              onClick={onResetSample}
              className="mt-4 px-3 py-1.5 text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white rounded-lg transition-colors shadow-sm"
            >
              Load Sample Route (PHX &rarr; Flagstaff)
            </button>
          </div>
        ) : (
          waypoints.map((wp, idx) => (
            <div
              key={wp.id}
              className="group p-3 rounded-xl bg-slate-800/80 border border-slate-700/70 hover:border-slate-600 transition-all shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2.5 min-w-0">
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0 shadow-sm pin-${wp.type}`}
                  >
                    {idx + 1}
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-white truncate group-hover:text-sky-300 transition-colors">
                      {wp.name}
                    </h3>
                    <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-400 font-mono">
                      <span>{wp.type}</span>
                      <span>&bull;</span>
                      <span>
                        {wp.lat.toFixed(3)}, {wp.lng.toFixed(3)}
                      </span>
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => onDeleteWaypoint(wp.id)}
                  className="text-slate-500 hover:text-rose-400 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Delete waypoint"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              {/* Waypoint parameters preview */}
              <div className="mt-2.5 pt-2 border-t border-slate-700/50 flex items-center justify-between text-xs text-slate-400">
                <div className="flex items-center gap-1">
                  <Clock className="w-3 h-3 text-slate-500" />
                  <span>Dwell: {wp.dwell_minutes}m</span>
                </div>
                <div className="flex items-center gap-1">
                  <Zap className="w-3 h-3 text-amber-500/80" />
                  <span>Trigger: {wp.trigger_radius_miles}mi</span>
                </div>
              </div>
            </div>
          ))
        )}

        {/* Phase 2B Placeholder / Preview Card */}
        <div className="mt-4 p-3.5 rounded-xl border border-indigo-900/40 bg-indigo-950/20 text-slate-300">
          <div className="flex items-center gap-2 text-indigo-400 font-medium text-xs mb-1.5">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Upcoming: Phase 2B Timeline Cascade</span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Deterministic arrival/departure calculation, multi-day scheduling, and Google Maps Navigation link generation will live here.
          </p>
        </div>
      </div>

      {/* Footer Info */}
      <div className="p-3 border-t border-slate-800 bg-slate-950/60 text-xs text-slate-500 flex items-center gap-2">
        <Info className="w-4 h-4 shrink-0 text-slate-400" />
        <span>Click map to place waypoint. Drag/drop coming in Phase 2B.</span>
      </div>
    </aside>
  );
};
