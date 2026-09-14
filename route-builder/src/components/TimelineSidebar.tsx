import React, { useState, useEffect, useRef } from 'react';
import {
  Clock,
  MapPin,
  Trash2,
  ArrowUp,
  ArrowDown,
  RotateCcw,
  Sparkles,
  Loader2,
  Plus,
  Edit2,
  Check,
  ChevronLeft,
  ChevronRight,
  Compass,
} from 'lucide-react';

import type { Waypoint, WaypointType } from '../types/routing';
import type { WaypointContext, CopilotAlert } from '../types/ai';
import type { TimelineCascadeResult, ScheduledStop } from '../engine/types';
import { AiAlertModal } from './AiAlertModal';
import { generateBatchCopilotAlerts } from '../services/api';

interface TimelineSidebarProps {
  waypoints: Waypoint[];
  cascadeResult: TimelineCascadeResult;
  isLoadingRoute: boolean;
  onDeleteWaypoint: (id: string) => void;
  onUpdateWaypoint: (id: string, updates: Partial<Waypoint>) => void;
  onMoveWaypoint: (index: number, direction: 'up' | 'down') => void;
  onResetSample: () => void;
  onClearAll: () => void;
  onFocusAddStop: () => void;
  onOpenScoutForDay?: () => void;
  onOpenScoutForWaypoint?: (waypoint: Waypoint) => void;
}

const STOP_TYPE_OPTIONS: Array<{ value: WaypointType; label: string }> = [
  { value: 'origin', label: 'Origin' },
  { value: 'scenic_pull_off', label: 'Scenic Pull-off' },
  { value: 'scenic_drive_by', label: 'Scenic Drive-by' },
  { value: 'meal', label: 'Meal / Food' },
  { value: 'fuel', label: 'Fuel / Charging' },
  { value: 'lodging', label: 'Hotel / Lodging' },
  { value: 'destination', label: 'Destination' },
];

const DWELL_PRESETS = [0, 15, 30, 45, 60, 90];
const RADIUS_PRESETS = [0.5, 1.0, 2.0, 3.0, 5.0];

const DEFAULT_WIDTH = 440;
const MIN_WIDTH = 320;
const MAX_WIDTH = 680;

export const TimelineSidebar: React.FC<TimelineSidebarProps> = ({
  waypoints,
  cascadeResult,
  isLoadingRoute,
  onDeleteWaypoint,
  onUpdateWaypoint,
  onMoveWaypoint,
  onResetSample,
  onClearAll,
  onFocusAddStop,
  onOpenScoutForDay,
  onOpenScoutForWaypoint,
}) => {
  // Resizable sidebar width with localStorage persistence
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('copilot_sidebar_width');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) {
          return parsed;
        }
      }
    }
    return DEFAULT_WIDTH;
  });

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartXRef = useRef<number>(0);
  const startWidthRef = useRef<number>(DEFAULT_WIDTH);

  // Waypoint edit state (which waypoint is expanded for inline editing)
  const [editingWaypointId, setEditingWaypointId] = useState<string | null>(null);

  // AI Co-Pilot Alert Modal state
  const [selectedWaypointForAi, setSelectedWaypointForAi] = useState<Waypoint | null>(null);
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [batchProgress, setBatchProgress] = useState<string | null>(null);

  // Drag resizing handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartXRef.current = e.clientX;
    startWidthRef.current = sidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - dragStartXRef.current;
      const nextWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta));
      setSidebarWidth(nextWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('copilot_sidebar_width', String(sidebarWidth));
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, sidebarWidth]);

  const handleDoubleClickResize = () => {
    setSidebarWidth(DEFAULT_WIDTH);
    localStorage.setItem('copilot_sidebar_width', String(DEFAULT_WIDTH));
  };

  const formatDuration = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours === 0) return `${minutes}m`;
    return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  };

  const handleApplyAiAlert = (waypointId: string, alert: CopilotAlert) => {
    onUpdateWaypoint(waypointId, {
      notification: {
        title: alert.title,
        message: alert.message,
        speech: alert.speech,
      },
      trigger_radius_miles: alert.recommended_trigger_radius_miles,
    });
  };

  const handleBatchGenerateAll = async () => {
    if (waypoints.length === 0 || isBatchGenerating) return;

    setIsBatchGenerating(true);
    setBatchProgress(`Generating alerts for ${waypoints.length} stops...`);

    try {
      const contexts: WaypointContext[] = cascadeResult.stops.map((stop) => {
        const original = waypoints.find((w) => w.id === stop.id);
        return {
          id: stop.id,
          name: stop.name,
          type: stop.type,
          targetTime: stop.arrivalTime,
          formattedTime: stop.arrivalShortTime,
          approachHighway: original?.approachHighway,
          notes: original?.notes,
        };
      });

      const batchResult = await generateBatchCopilotAlerts(contexts);
      for (const [wpId, alert] of Object.entries(batchResult.alerts)) {
        onUpdateWaypoint(wpId, {
          notification: {
            title: alert.title,
            message: alert.message,
            speech: alert.speech,
          },
          trigger_radius_miles: alert.recommended_trigger_radius_miles,
        });
      }
      setBatchProgress(`Created alerts for all ${Object.keys(batchResult.alerts).length} stops!`);
      setTimeout(() => setBatchProgress(null), 3000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Batch generation failed';
      setBatchProgress(`Error: ${msg}`);
      setTimeout(() => setBatchProgress(null), 4000);
    } finally {
      setIsBatchGenerating(false);
    }
  };

  if (isCollapsed) {
    return (
      <div className="relative z-20 flex flex-col items-center py-3 px-1.5 bg-slate-900 border-r border-slate-800 shadow-xl">
        <button
          onClick={() => setIsCollapsed(false)}
          className="p-2 bg-slate-800 hover:bg-slate-700 text-sky-400 hover:text-white rounded-lg transition-colors cursor-pointer"
          title="Expand itinerary panel"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
        <div className="mt-4 [writing-mode:vertical-lr] text-xs font-semibold text-slate-400 uppercase tracking-widest flex items-center gap-2">
          <span>Itinerary Stops</span>
          <span className="px-1.5 py-0.5 rounded-full bg-slate-800 text-sky-400 font-mono text-[10px]">
            {waypoints.length}
          </span>
        </div>
      </div>
    );
  }

  return (
    <aside
      style={{ width: `${sidebarWidth}px` }}
      className="relative h-full flex flex-col bg-slate-900 border-r border-slate-800 text-slate-100 shrink-0 z-20 shadow-xl select-none"
    >
      {/* Sidebar Header: Actions & Controls */}
      <div className="p-3 border-b border-slate-800 bg-slate-900/90 backdrop-blur-sm">
        {/* Row 1: Title, Count Badge, and Utility Icons */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-sm font-bold text-white tracking-tight whitespace-nowrap">
              Route Stops
            </h2>
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-sky-400 font-mono font-semibold border border-slate-700/60 flex items-center gap-1 shrink-0">
              {isLoadingRoute && <Loader2 className="w-3 h-3 animate-spin text-amber-400" />}
              <span>{waypoints.length}</span>
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={onResetSample}
              className="p-1.5 text-slate-400 hover:text-sky-400 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
              title="Reset to sample route"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>

            {waypoints.length > 0 && (
              <button
                onClick={onClearAll}
                className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                title="Clear all stops"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}

            <button
              onClick={() => setIsCollapsed(true)}
              className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
              title="Collapse sidebar to maximize map view"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Row 2: Dedicated 3-Column Primary Action Bar */}
        <div className="grid grid-cols-3 gap-1.5 mt-2.5">
          <button
            onClick={onFocusAddStop}
            className="flex items-center justify-center gap-1.5 py-1.5 px-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-medium transition-colors shadow-sm cursor-pointer whitespace-nowrap"
            title="Add a new stop by searching"
          >
            <Plus className="w-3.5 h-3.5 shrink-0" />
            <span>Add Stop</span>
          </button>

          {onOpenScoutForDay ? (
            <button
              onClick={onOpenScoutForDay}
              className="flex items-center justify-center gap-1.5 py-1.5 px-2 bg-slate-800 hover:bg-slate-750 text-cyan-300 rounded-lg text-xs font-medium transition-colors border border-slate-700/70 cursor-pointer whitespace-nowrap"
              title="Open Route Scout to discuss this day's leg, scenic stops, or meal breaks"
            >
              <Compass className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              <span>Scout Leg</span>
            </button>
          ) : (
            <div />
          )}

          {waypoints.length > 0 ? (
            <button
              onClick={handleBatchGenerateAll}
              disabled={isBatchGenerating}
              className="flex items-center justify-center gap-1.5 py-1.5 px-2 bg-slate-800 hover:bg-slate-750 text-amber-300 rounded-lg text-xs font-medium transition-colors border border-slate-700/70 cursor-pointer disabled:opacity-50 whitespace-nowrap"
              title="Generate Co-Pilot audio alerts for all stops"
            >
              {isBatchGenerating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400 shrink-0" />
              ) : (
                <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              )}
              <span>AI Alerts</span>
            </button>
          ) : (
            <div />
          )}
        </div>

        {batchProgress && (
          <div className="mt-2 text-[11px] text-sky-300 font-mono text-center bg-sky-950/50 border border-sky-800/60 rounded-lg py-1 px-2 animate-pulse">
            {batchProgress}
          </div>
        )}
      </div>

      {/* Stops Timeline List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {cascadeResult.stops.length === 0 ? (
          <div className="text-center py-12 px-4 border border-dashed border-slate-800 rounded-2xl bg-slate-950/30">
            <MapPin className="w-10 h-10 mx-auto text-slate-600 mb-3" />
            <h3 className="text-sm font-semibold text-slate-200">No stops added yet</h3>
            <p className="text-xs text-slate-400 mt-1 max-w-xs mx-auto leading-relaxed">
              Use the search bar in the top header, click anywhere on the map, or load the sample itinerary to get started.
            </p>
            <div className="mt-5 flex items-center justify-center gap-2">
              <button
                onClick={onFocusAddStop}
                className="px-3.5 py-1.5 text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white rounded-xl shadow-md transition-colors cursor-pointer flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add First Stop</span>
              </button>
              <button
                onClick={onResetSample}
                className="px-3.5 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl border border-slate-700 transition-colors cursor-pointer"
              >
                Load Sample Route
              </button>
            </div>
          </div>
        ) : (
          cascadeResult.stops.map((stop: ScheduledStop, idx: number) => {
            const isFirst = idx === 0;
            const isLast = idx === cascadeResult.stops.length - 1;
            const isEditing = editingWaypointId === stop.id;
            const originalWp = waypoints.find((w) => w.id === stop.id);

            return (
              <React.Fragment key={stop.id}>
                {/* State / Timezone Boundary Banner */}
                {stop.isTimezoneBoundaryCrossing && (
                  <div className="py-1 px-3 bg-amber-950/60 border border-amber-600/50 rounded-xl text-xs text-amber-200 flex items-center justify-between shadow-sm">
                    <span className="font-semibold text-[11px]">
                      State Line Crossing &bull; Timezone Shift ({stop.timezoneShiftHours && stop.timezoneShiftHours > 0 ? `+${stop.timezoneShiftHours}` : stop.timezoneShiftHours}h)
                    </span>
                    <span className="font-mono text-[10px] uppercase font-bold bg-amber-900/80 px-1.5 py-0.5 rounded">
                      {stop.timezoneAbbreviation}
                    </span>
                  </div>
                )}

                {/* Waypoint Card */}
                <div
                  className={`rounded-xl border transition-all ${
                    isEditing
                      ? 'bg-slate-800/95 border-sky-500/80 shadow-lg ring-1 ring-sky-500/20'
                      : 'bg-slate-800/70 border-slate-700/60 hover:border-slate-600 hover:bg-slate-800/90 shadow-sm'
                  }`}
                >
                  {/* Card Main Row (Always Visible) */}
                  <div className="p-3">
                    <div className="flex items-start justify-between gap-2.5">
                      {/* Left: Sequence Pin + Info */}
                      <div className="flex items-start gap-2.5 min-w-0 flex-1">
                        <div
                          className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0 mt-0.5 shadow-sm pin-${stop.type}`}
                        >
                          {idx + 1}
                        </div>

                        <div className="min-w-0 flex-1">
                          {/* Stop Title */}
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-bold text-white truncate">
                              {stop.name}
                            </span>
                            <span className="text-[10px] text-slate-400 capitalize bg-slate-900/60 px-1.5 py-0.2 rounded border border-slate-800 shrink-0">
                              {stop.type.replace(/_/g, ' ')}
                            </span>
                          </div>

                          {/* Time & Dwell Summary */}
                          <div className="flex items-center gap-2 mt-1 text-xs text-slate-300">
                            <div className="flex items-center gap-1 font-mono font-semibold text-slate-200">
                              <Clock className="w-3 h-3 text-sky-400" />
                              <span>{stop.arrivalShortTime}</span>
                              {stop.dwell_minutes > 0 && (
                                <>
                                  <span className="text-slate-500">&rarr;</span>
                                  <span>{stop.departureShortTime}</span>
                                </>
                              )}
                            </div>

                            <span className="text-slate-600">&bull;</span>
                            <span className="text-[11px] text-slate-400 font-mono">
                              {stop.dwell_minutes > 0 ? `${stop.dwell_minutes}m dwell` : 'Pass-through'}
                            </span>
                          </div>

                          {/* Co-Pilot Alert Status Tag (if configured) */}
                          {stop.notification && !isEditing && (
                            <div
                              onClick={() => setEditingWaypointId(stop.id)}
                              className="mt-1.5 flex items-center gap-1.5 text-[11px] text-emerald-300 bg-emerald-950/40 border border-emerald-800/40 rounded-lg px-2 py-0.5 cursor-pointer hover:bg-emerald-950/70 transition-colors w-fit"
                              title="Click to view or edit AI Co-Pilot announcement"
                            >
                              <Sparkles className="w-3 h-3 text-emerald-400 shrink-0" />
                              <span className="font-medium truncate max-w-[200px]">
                                &ldquo;{stop.notification.title}&rdquo;
                              </span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Right: Actions */}
                      <div className="flex items-center gap-0.5 shrink-0">
                        {!isFirst && (
                          <button
                            onClick={() => onMoveWaypoint(idx, 'up')}
                            className="text-slate-400 hover:text-sky-300 p-1 rounded-lg hover:bg-slate-700/60 transition-colors"
                            title="Move stop earlier"
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {!isLast && (
                          <button
                            onClick={() => onMoveWaypoint(idx, 'down')}
                            className="text-slate-400 hover:text-sky-300 p-1 rounded-lg hover:bg-slate-700/60 transition-colors"
                            title="Move stop later"
                          >
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                        )}

                        <button
                          onClick={() =>
                            setEditingWaypointId(isEditing ? null : stop.id)
                          }
                          className={`p-1 rounded-lg transition-colors ${
                            isEditing
                              ? 'bg-sky-600 text-white shadow-sm'
                              : 'text-slate-400 hover:text-slate-100 hover:bg-slate-700/60'
                          }`}
                          title={isEditing ? 'Close editor' : 'Edit stop details'}
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>

                        <button
                          onClick={() => onDeleteWaypoint(stop.id)}
                          className="text-slate-500 hover:text-rose-400 p-1 rounded-lg hover:bg-slate-700/60 transition-colors"
                          title="Remove stop"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Inline Expanded Editor */}
                  {isEditing && (
                    <div className="px-3.5 pb-3.5 pt-2 border-t border-slate-700/70 bg-slate-900/60 rounded-b-xl space-y-3">
                      {/* Name & Type Fields */}
                      <div className="space-y-2">
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                            Stop Name
                          </label>
                          <input
                            type="text"
                            value={stop.name}
                            onChange={(e) =>
                              onUpdateWaypoint(stop.id, { name: e.target.value })
                            }
                            placeholder="Waypoint name"
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                            Stop Category
                          </label>
                          <select
                            value={stop.type}
                            onChange={(e) =>
                              onUpdateWaypoint(stop.id, {
                                type: e.target.value as WaypointType,
                              })
                            }
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-500"
                          >
                            {STOP_TYPE_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      {/* Dwell Duration Editor */}
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <label className="text-[11px] font-semibold text-slate-300">
                            Dwell / Stop Duration
                          </label>
                          <span className="text-xs font-mono font-bold text-sky-400">
                            {stop.dwell_minutes} minutes
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1">
                          {DWELL_PRESETS.map((minutes) => (
                            <button
                              key={minutes}
                              onClick={() =>
                                onUpdateWaypoint(stop.id, { dwell_minutes: minutes })
                              }
                              className={`px-2 py-1 rounded-md text-xs font-mono transition-all ${
                                stop.dwell_minutes === minutes
                                  ? 'bg-sky-600 text-white font-bold'
                                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                              }`}
                            >
                              {minutes === 0 ? '0m' : `${minutes}m`}
                            </button>
                          ))}
                          <div className="flex items-center gap-1 ml-auto">
                            <input
                              type="number"
                              min="0"
                              max="480"
                              step="5"
                              value={stop.dwell_minutes}
                              onChange={(e) =>
                                onUpdateWaypoint(stop.id, {
                                  dwell_minutes: Math.max(0, parseInt(e.target.value, 10) || 0),
                                })
                              }
                              className="w-14 bg-slate-800 border border-slate-700 rounded-md px-1.5 py-0.5 text-center text-xs font-mono text-white focus:outline-none focus:border-sky-500"
                            />
                            <span className="text-[11px] text-slate-400">min</span>
                          </div>
                        </div>
                      </div>

                      {/* AI Co-Pilot Alert Configuration */}
                      <div className="pt-2 border-t border-slate-800 space-y-2">
                        <div className="text-[11px] font-semibold text-slate-300">
                          Co-Pilot In-Car Announcement
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          {onOpenScoutForWaypoint && (
                            <button
                              onClick={() => {
                                const currentWp = originalWp
                                  ? { ...originalWp, target_time: stop.arrivalTime }
                                  : {
                                      ...stop,
                                      target_time: stop.arrivalTime,
                                    };
                                onOpenScoutForWaypoint(currentWp);
                              }}
                              className="flex items-center justify-center gap-1.5 py-1.5 px-2 bg-slate-800 hover:bg-slate-750 text-cyan-300 rounded-lg text-xs font-medium transition-all border border-slate-700/80 cursor-pointer whitespace-nowrap shadow-sm"
                              title="Ask Route Scout about this stop (accessibility, tribal land, photo spots)"
                            >
                              <Compass className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                              <span>Ask Scout</span>
                            </button>
                          )}
                          <button
                            onClick={() => {
                              const currentWp = originalWp
                                ? { ...originalWp, target_time: stop.arrivalTime }
                                : {
                                    ...stop,
                                    target_time: stop.arrivalTime,
                                  };
                              setSelectedWaypointForAi(currentWp);
                            }}
                            className={`flex items-center justify-center gap-1.5 py-1.5 px-2 bg-gradient-to-r from-sky-600 to-indigo-600 hover:from-sky-500 hover:to-indigo-500 text-white rounded-lg text-xs font-medium transition-all shadow-sm cursor-pointer whitespace-nowrap ${
                              !onOpenScoutForWaypoint ? 'col-span-2' : ''
                            }`}
                          >
                            <Sparkles className="w-3.5 h-3.5 text-amber-300 shrink-0" />
                            <span>{stop.notification ? 'Edit Alert & Voice' : 'Generate Alert'}</span>
                          </button>
                        </div>

                        {stop.notification ? (
                          <div className="p-2.5 bg-slate-950/80 border border-slate-800 rounded-xl space-y-1">
                            <div className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                              <span>Heads-Up Card:</span>
                              <span className="text-white font-normal truncate">
                                &ldquo;{stop.notification.title}&rdquo;
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-400 italic line-clamp-2">
                              TTS: &ldquo;{stop.notification.speech}&rdquo;
                            </div>
                            <div className="pt-1 flex items-center justify-between text-[10px] text-slate-400">
                              <span>Trigger Distance:</span>
                              <span className="font-mono text-sky-400 font-semibold">
                                {stop.trigger_radius_miles} miles before stop
                              </span>
                            </div>
                          </div>
                        ) : (
                          <p className="text-[11px] text-slate-400 italic">
                            No audio announcement configured yet. Click generate above to create one.
                          </p>
                        )}
                      </div>

                      {/* Alert Trigger Radius Selector */}
                      <div className="pt-2 border-t border-slate-800">
                        <div className="flex items-center justify-between mb-1.5">
                          <label className="text-[11px] font-semibold text-slate-300">
                            Heads-Up Alert Distance
                          </label>
                          <span className="text-xs font-mono font-bold text-sky-400">
                            {stop.trigger_radius_miles} miles before
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1">
                          {RADIUS_PRESETS.map((r) => (
                            <button
                              key={r}
                              type="button"
                              onClick={() =>
                                onUpdateWaypoint(stop.id, { trigger_radius_miles: r })
                              }
                              className={`px-2 py-1 rounded-md text-xs font-mono transition-all ${
                                (stop.trigger_radius_miles || 2.0) === r
                                  ? 'bg-sky-600 text-white font-bold'
                                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                              }`}
                            >
                              {r} mi
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Done Button */}
                      <div className="pt-1 flex justify-end">
                        <button
                          onClick={() => setEditingWaypointId(null)}
                          className="flex items-center gap-1 px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium transition-colors"
                        >
                          <Check className="w-3 h-3 text-emerald-400" />
                          <span>Done</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Drive segment connector */}
                {!isLast && (
                  <div className="px-4 py-0.5 flex items-center gap-2 text-[11px] text-slate-400 font-mono">
                    <div className="w-0.5 h-4 bg-slate-700/80 ml-3" />
                    <span className="text-slate-400">
                      Drive{' '}
                      {formatDuration(
                        cascadeResult.stops[idx + 1].driveDurationFromPreviousSeconds
                      )}{' '}
                      &bull; {cascadeResult.stops[idx + 1].driveDistanceMilesFromPrevious} mi
                    </span>
                  </div>
                )}
              </React.Fragment>
            );
          })
        )}
      </div>

      {/* Resize Handle Divider on the right edge */}
      <div
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClickResize}
        className={`absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-sky-500/70 transition-colors z-30 ${
          isDragging ? 'bg-sky-500 shadow-md' : 'bg-transparent'
        }`}
        title="Drag to resize panel, double-click to reset"
      />

      {/* AI Co-Pilot Alert Modal */}
      <AiAlertModal
        isOpen={!!selectedWaypointForAi}
        waypoint={selectedWaypointForAi}
        onClose={() => setSelectedWaypointForAi(null)}
        onApply={handleApplyAiAlert}
      />
    </aside>
  );
};
