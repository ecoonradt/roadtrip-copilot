import { AI_UNAVAILABLE_TOOLTIP } from '../constants/aiCopy';
import React, { useState, useEffect, useRef } from 'react';
import {
  Clock,
  MapPin,
  Trash2,
  ArrowUp,
  ArrowDown,
  Sparkles,
  Loader2,
  Plus,
  X,
  Edit2,
  Check,
  ChevronLeft,
  ChevronRight,
  Compass,
  Navigation,
} from 'lucide-react';

import type { Waypoint, WaypointType, GeocodeResult } from '../types/routing';
import type { WaypointContext, AiModelOption } from '../types/ai';
import type { TimelineCascadeResult, ScheduledStop } from '../engine/types';
import { SearchBar } from './SearchBar';
import { EditWaypointModal } from './EditWaypointModal';
import { generateBatchCopilotAlerts } from '../services/api';

interface TimelineSidebarProps {
  waypoints: Waypoint[];
  cascadeResult: TimelineCascadeResult;
  isLoadingRoute: boolean;
  onDeleteWaypoint: (id: string) => void;
  onUpdateWaypoint: (id: string, updates: Partial<Waypoint>) => void;
  onBatchUpdateWaypoints?: (updates: Record<string, Partial<Waypoint>>) => void;
  onMoveWaypoint: (index: number, direction: 'up' | 'down') => void;
  onClearAll: () => void;
  onSelectLocation: (result: GeocodeResult) => void;
  onOpenScoutForDay?: () => void;
  onOpenScoutForWaypoint?: (waypoint: Waypoint) => void;
  selectedWaypointId?: string | null;
  onSelectWaypoint?: (id: string | null) => void;
  aiAvailable?: boolean;
  aiModels?: AiModelOption[];
  selectedModelId?: string;
  onSelectModel?: (modelId: string) => void;
}

const STOP_TYPE_OPTIONS: Array<{ value: WaypointType; label: string }> = [
  { value: 'origin', label: 'Origin' },
  { value: 'scenic_pull_off', label: 'Scenic Pull-off' },
  { value: 'scenic_drive_by', label: 'Scenic Drive-by' },
  { value: 'meal', label: 'Meal / Food' },
  { value: 'fuel', label: 'Fuel / Charging' },
  { value: 'lodging', label: 'Hotel / Lodging' },
  { value: 'stop', label: 'Stop (Generic / Errand)' },
  { value: 'destination', label: 'Destination' },
];

const DEFAULT_WIDTH = 440;
const MIN_WIDTH = 320;
const MAX_WIDTH = 680;

export const TimelineSidebar: React.FC<TimelineSidebarProps> = ({
  waypoints,
  cascadeResult,
  isLoadingRoute,
  onDeleteWaypoint,
  onUpdateWaypoint,
  onBatchUpdateWaypoints,
  onMoveWaypoint,
  onClearAll,
  onSelectLocation,
  onOpenScoutForDay,
  onOpenScoutForWaypoint,
  selectedWaypointId,
  onSelectWaypoint,
  aiAvailable = true,
  aiModels,
  selectedModelId,
  onSelectModel,
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

  // Add stop inline drawer state
  const [isAddStopOpen, setIsAddStopOpen] = useState(false);

  // Close Add Stop inline panel on Escape key
  useEffect(() => {
    if (!isAddStopOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsAddStopOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isAddStopOpen]);

  // Waypoint edit state (which waypoint is expanded for inline editing)
  const [editingWaypointId, setEditingWaypointId] = useState<string | null>(null);

  // Synchronize editing / expanded state when a waypoint is selected (e.g. from map)
  useEffect(() => {
    if (selectedWaypointId) {
      setEditingWaypointId(selectedWaypointId);
      setIsCollapsed(false);
      setTimeout(() => {
        const el = document.getElementById(`waypoint-card-${selectedWaypointId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }, 60);
    }
  }, [selectedWaypointId]);

  // Edit Waypoint / AI Co-Pilot Alert Modal state
  const [selectedModal, setSelectedModal] = useState<{
    waypoint: Waypoint;
    initialTab: 'details' | 'alert';
    isFirst: boolean;
    isLast: boolean;
  } | null>(null);
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

  const formatDisplayTime = (timeStr?: string): string => {
    if (!timeStr || timeStr === 'Start' || timeStr.startsWith('+')) return timeStr || '';
    const match = timeStr.match(/^(\d{1,2}):(\d{2})/);
    if (!match) return timeStr;
    const hours = parseInt(match[1], 10);
    const minutes = match[2];
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const hours12 = hours % 12 || 12;
    return `${hours12}:${minutes} ${ampm}`;
  };

  const handleBatchGenerateAll = async () => {
    if (waypoints.length === 0 || isBatchGenerating) return;

    setIsBatchGenerating(true);
    setBatchProgress(`Generating alerts for ${waypoints.length} stops...`);

    try {
      const eligibleStops = cascadeResult.stops.filter((stop) => stop.type !== 'stop');

      if (eligibleStops.length === 0) {
        setBatchProgress('No alert-eligible stops to generate (generic stops are silent).');
        setTimeout(() => setBatchProgress(null), 3000);
        setIsBatchGenerating(false);
        return;
      }

      setBatchProgress(`Generating alerts for ${eligibleStops.length} stops...`);

      const contexts: WaypointContext[] = eligibleStops.map((stop) => {
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

      const batchResult = await generateBatchCopilotAlerts(contexts, {
        modelId: selectedModelId || undefined,
      });
      const updatesMap: Record<string, Partial<Waypoint>> = {};
      for (const [wpId, alert] of Object.entries(batchResult.alerts)) {
        updatesMap[wpId] = {
          notification: {
            title: alert.title,
            message: alert.message,
            speech: alert.speech,
          },
          trigger_radius_miles: alert.recommended_trigger_radius_miles,
        };
      }

      if (onBatchUpdateWaypoints) {
        onBatchUpdateWaypoints(updatesMap);
      } else {
        for (const [wpId, updates] of Object.entries(updatesMap)) {
          onUpdateWaypoint(wpId, updates);
        }
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
      <div className="p-3 border-b border-slate-800 bg-slate-900/95 backdrop-blur-sm relative z-30">
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
            onClick={() => setIsAddStopOpen((prev) => !prev)}
            className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-medium transition-all shadow-sm cursor-pointer whitespace-nowrap ${
              isAddStopOpen
                ? 'bg-sky-500 text-white ring-2 ring-sky-400/40 shadow-sky-500/20'
                : 'bg-sky-600 hover:bg-sky-500 text-white'
            }`}
            title={isAddStopOpen ? 'Close add stop panel' : 'Add a new stop by searching'}
          >
            {isAddStopOpen ? (
              <X className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <Plus className="w-3.5 h-3.5 shrink-0" />
            )}
            <span>{isAddStopOpen ? 'Close' : 'Add Stop'}</span>
          </button>

          {onOpenScoutForDay ? (
            <button
              onClick={aiAvailable ? onOpenScoutForDay : undefined}
              disabled={!aiAvailable}
              className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-medium transition-colors border whitespace-nowrap ${
                !aiAvailable
                  ? 'bg-slate-850 border-slate-800 text-slate-500 cursor-not-allowed opacity-60'
                  : 'bg-slate-800 hover:bg-slate-750 text-cyan-300 border-slate-700/70 cursor-pointer'
              }`}
              title={
                !aiAvailable
                  ? AI_UNAVAILABLE_TOOLTIP
                  : "Open Route Scout to discuss this day's leg, scenic stops, or meal breaks"
              }
            >
              <Compass
                className={`w-3.5 h-3.5 shrink-0 ${
                  !aiAvailable ? 'text-slate-500' : 'text-cyan-400'
                }`}
              />
              <span>Scout Leg</span>
            </button>
          ) : (
            <div />
          )}

          {waypoints.length > 0 ? (
            <button
              onClick={aiAvailable ? handleBatchGenerateAll : undefined}
              disabled={!aiAvailable || isBatchGenerating}
              className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-medium transition-colors border whitespace-nowrap ${
                !aiAvailable
                  ? 'bg-slate-850 border-slate-800 text-slate-500 cursor-not-allowed opacity-60'
                  : 'bg-slate-800 hover:bg-slate-750 text-amber-300 border-slate-700/70 cursor-pointer disabled:opacity-50'
              }`}
              title={
                !aiAvailable
                  ? AI_UNAVAILABLE_TOOLTIP
                  : 'Generate Co-Pilot audio alerts for all stops'
              }
            >
              {isBatchGenerating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400 shrink-0" />
              ) : (
                <Sparkles
                  className={`w-3.5 h-3.5 shrink-0 ${
                    !aiAvailable ? 'text-slate-500' : 'text-amber-400'
                  }`}
                />
              )}
              <span>AI Alerts</span>
            </button>
          ) : (
            <div />
          )}
        </div>

        {/* Inline Add Stop Panel */}
        {isAddStopOpen && (
          <div className="mt-2.5 p-2.5 bg-slate-950/80 border border-sky-500/40 rounded-xl space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-sky-400 uppercase tracking-wider flex items-center gap-1.5">
                <MapPin className="w-3 h-3 text-sky-400" />
                <span>Add New Stop</span>
              </span>
              <span className="text-[10px] text-slate-400 font-mono">ESC to cancel</span>
            </div>
            <SearchBar
              onSelectLocation={(result) => {
                onSelectLocation(result);
                setIsAddStopOpen(false);
              }}
              placeholder="Search place or address..."
              className="w-full"
            />
            <p className="text-[10px] text-slate-400 leading-tight">
              Type to search for any place, or click directly anywhere on the map to drop a stop.
            </p>
          </div>
        )}

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
              Click Add Stop above, or click anywhere on the map to drop your first stop.
            </p>
            <div className="mt-5 flex items-center justify-center gap-2">
              <button
                onClick={() => setIsAddStopOpen(true)}
                className="px-3.5 py-1.5 text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white rounded-xl shadow-md transition-colors cursor-pointer flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add First Stop</span>
              </button>
            </div>
          </div>
        ) : (
          cascadeResult.stops.map((stop: ScheduledStop, idx: number) => {
            const isFirst = idx === 0;
            const isLast = idx === cascadeResult.stops.length - 1;
            const isEditing = editingWaypointId === stop.id;
            const originalWp = waypoints.find((w) => w.id === stop.id);
            const isOvernight = isLast && (stop.type === 'lodging' || stop.type === 'destination');
            const modalWp: Waypoint = {
              ...(originalWp || stop),
              target_time: stop.arrivalTime,
              dwell_minutes: isOvernight ? 0 : (originalWp?.dwell_minutes ?? stop.dwell_minutes),
            };

            const hasActiveAlert = Boolean(
              stop.type !== 'stop' &&
                stop.notification &&
                (stop.notification.speech?.trim() ||
                  stop.notification.message?.trim() ||
                  (stop.notification.title?.trim() &&
                    stop.notification.title.trim().toLowerCase() !== stop.name.trim().toLowerCase()))
            );

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
                  id={`waypoint-card-${stop.id}`}
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
                            {!isFirst && !isLast && (originalWp?.dwell_minutes === 0 || originalWp?.type === 'scenic_drive_by') && (
                              originalWp?.is_route_anchor ? (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onUpdateWaypoint(stop.id, { is_route_anchor: false });
                                  }}
                                  className="text-[11px] text-amber-300 bg-amber-950/70 hover:bg-amber-900/80 border border-amber-800/80 px-1.5 py-0.5 rounded font-semibold shrink-0 transition-colors cursor-pointer"
                                  title="Route-Forcing Anchor in Google Maps. Click to switch to In-Car Audio Only."
                                >
                                  ⚓ Anchor
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onUpdateWaypoint(stop.id, { is_route_anchor: true, dwell_minutes: 0 });
                                  }}
                                  className="text-[11px] text-slate-300 bg-slate-900/90 hover:bg-slate-800 border border-slate-700/80 px-1.5 py-0.5 rounded font-medium shrink-0 transition-colors cursor-pointer"
                                  title="In-car spoken audio cue only. Click to make Route Anchor in Google Maps."
                                >
                                  🚗 Audio
                                </button>
                              )
                            )}
                            <span className="text-[11px] text-slate-400 capitalize bg-slate-900/60 px-1.5 py-0.5 rounded border border-slate-800 shrink-0">
                              {stop.type.replace(/_/g, ' ')}
                            </span>
                          </div>

                          {/* Time & Dwell Summary */}
                          {(() => {
                            const isFixedTime = Boolean(
                              stop.arrivalShortTime &&
                                stop.arrivalShortTime !== 'Start' &&
                                !stop.arrivalShortTime.startsWith('+')
                            );

                            return (
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1 text-xs text-slate-300">
                                <div className="flex items-center gap-1 font-mono text-slate-200">
                                  <Clock className="w-3 h-3 text-sky-400 shrink-0" />
                                  {isFixedTime ? (
                                    isFirst ? (
                                      <span className="flex items-center gap-1">
                                        <span className="text-[10px] font-sans font-bold uppercase tracking-wider text-slate-400">
                                          Dep
                                        </span>
                                        <span className="font-semibold text-slate-100">
                                          {formatDisplayTime(stop.arrivalShortTime)}
                                        </span>
                                      </span>
                                    ) : (
                                      <span className="flex items-center gap-1">
                                        <span
                                          className={`text-[10px] font-sans font-bold uppercase tracking-wider ${
                                            isLast ? 'text-emerald-400' : 'text-sky-400'
                                          }`}
                                        >
                                          ETA
                                        </span>
                                        <span className="font-semibold text-slate-100">
                                          {formatDisplayTime(stop.arrivalShortTime)}
                                        </span>
                                      </span>
                                    )
                                  ) : (
                                    <span className="font-semibold text-slate-100">
                                      {stop.arrivalShortTime}
                                    </span>
                                  )}

                                  {isLast ? (
                                    <>
                                      <span className="text-slate-500">&bull;</span>
                                      <span className="text-amber-300 font-normal whitespace-nowrap">
                                        {stop.type === 'lodging' ? '🌙 Overnight Stay' : '🏁 Final Stop'}
                                      </span>
                                    </>
                                  ) : stop.dwell_minutes > 0 ? (
                                    <>
                                      <span className="text-slate-500">&rarr;</span>
                                      {isFixedTime && (
                                        <span className="text-[10px] font-sans font-bold uppercase tracking-wider text-slate-400">
                                          Dep
                                        </span>
                                      )}
                                      <span className="text-slate-300">
                                        {formatDisplayTime(stop.departureShortTime)}
                                      </span>
                                    </>
                                  ) : null}
                                </div>

                                {!isLast && stop.dwell_minutes > 0 && (
                                  <div className="flex items-center gap-1 text-[11px] text-slate-400 font-mono">
                                    <span className="text-slate-600">&bull;</span>
                                    <span>{stop.dwell_minutes}m dwell</span>
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                          {/* Co-Pilot Alert Status Tag (if configured) */}
                          {hasActiveAlert && !isEditing && (
                            <div
                              onClick={() => {
                                setSelectedModal({
                                  waypoint: modalWp,
                                  initialTab: 'alert',
                                  isFirst,
                                  isLast,
                                });
                              }}
                              className="mt-1.5 flex items-center gap-1.5 text-[11px] text-emerald-300 bg-emerald-950/40 border border-emerald-800/40 rounded-lg px-2 py-0.5 cursor-pointer hover:bg-emerald-950/70 transition-colors w-fit"
                              title="Click to view or edit AI Co-Pilot announcement"
                            >
                              <Sparkles className="w-3 h-3 text-emerald-400 shrink-0" />
                              <span className="font-medium truncate max-w-[200px]">
                                &ldquo;{stop.notification?.title}&rdquo;
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
                          onClick={() => {
                            const next = isEditing ? null : stop.id;
                            setEditingWaypointId(next);
                            onSelectWaypoint?.(next);
                          }}
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

                  {/* Inline Expanded Editor (Streamlined for quick scannability) */}
                  {isEditing && (
                    <div className="px-3.5 pb-3 pt-2.5 border-t border-slate-700/70 bg-slate-900/60 rounded-b-xl space-y-2.5">
                      {/* Name Field */}
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

                      {/* Category & Quick Dwell Row */}
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                            Stop Category
                          </label>
                          <select
                            value={stop.type}
                            onChange={(e) => {
                              const newType = e.target.value as WaypointType;
                              const updates: Partial<Waypoint> = { type: newType };
                              if (isLast && (newType === 'lodging' || newType === 'destination')) {
                                updates.dwell_minutes = 0;
                              } else if (newType === 'scenic_drive_by') {
                                updates.dwell_minutes = 0;
                              } else if (newType === 'stop') {
                                updates.dwell_minutes = stop.dwell_minutes > 0 ? stop.dwell_minutes : 15;
                                updates.notification = undefined;
                                updates.is_route_anchor = false;
                              }
                              onUpdateWaypoint(stop.id, updates);
                            }}
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-500"
                          >
                            {STOP_TYPE_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                            Dwell Duration
                          </label>
                          {isLast ? (
                            <div className="px-2 py-1.5 bg-amber-950/40 border border-amber-800/60 rounded-lg text-xs text-amber-300 font-mono flex items-center justify-between">
                              <span className="whitespace-nowrap">
                                {stop.type === 'lodging' ? '🌙 Overnight' : '🏁 Final Stop'}
                              </span>
                              <span className="text-[11px] text-amber-400/80">0m</span>
                            </div>
                          ) : (
                            <select
                              value={stop.dwell_minutes}
                              onChange={(e) => {
                                const newDwell = parseInt(e.target.value, 10) || 0;
                                const updates: Partial<Waypoint> = { dwell_minutes: newDwell };
                                if (newDwell > 0 && originalWp?.is_route_anchor) {
                                  updates.is_route_anchor = false;
                                }
                                onUpdateWaypoint(stop.id, updates);
                              }}
                              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-sky-500"
                            >
                              {[0, 15, 30, 45, 60, 90, 120].map((m) => (
                                <option key={m} value={m}>
                                  {m === 0 ? '0 min (Pass-through)' : `${m} minutes`}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      </div>

                      {/* Google Maps Navigation Role (Intermediate stops only) */}
                      {!isFirst && !isLast && (
                        <div className="p-2.5 bg-slate-950/60 border border-slate-800 rounded-lg space-y-1.5">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                              <Navigation className="w-3.5 h-3.5 text-sky-400" />
                              Google Maps Navigation Role
                            </span>
                            <span className="text-[11px] text-slate-500">1-click toggle</span>
                          </div>

                          {(stop.dwell_minutes === 0 || stop.type === 'scenic_drive_by') ? (
                            <>
                              <div className="grid grid-cols-2 gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => onUpdateWaypoint(stop.id, { is_route_anchor: true, dwell_minutes: 0 })}
                                  className={`px-2 py-1.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                                    originalWp?.is_route_anchor
                                      ? 'bg-amber-950/80 border border-amber-600 text-amber-200 shadow-sm'
                                      : 'bg-slate-800/90 border border-slate-700/80 text-slate-400 hover:text-slate-200 hover:bg-slate-750'
                                  }`}
                                  title="Forces Google Maps to navigate along this scenic road instead of an interstate"
                                >
                                  <span>⚓ Maps Route Anchor</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => onUpdateWaypoint(stop.id, { is_route_anchor: false })}
                                  className={`px-2 py-1.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                                    !originalWp?.is_route_anchor
                                      ? 'bg-sky-950/80 border border-sky-600 text-sky-200 shadow-sm'
                                      : 'bg-slate-800/90 border border-slate-700/80 text-slate-400 hover:text-slate-200 hover:bg-slate-750'
                                  }`}
                                  title="Excluded from Google Maps navigation; app speaks offline audio alert"
                                >
                                  <span>🚗 Audio Only</span>
                                </button>
                              </div>
                              <p className="text-[11px] text-slate-400 leading-tight">
                                {originalWp?.is_route_anchor
                                  ? '⚓ Included in Google Maps to force this scenic highway corridor.'
                                  : '🚗 Co-Pilot speaks upcoming scenic notes; excluded from Google Maps navigation.'}
                              </p>
                            </>
                          ) : (
                            <div className="flex items-center justify-between px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-[11px]">
                              <span className="text-slate-300 flex items-center gap-1.5">
                                <span className="text-emerald-400 font-bold">✓</span>
                                <span className="font-semibold">Physical Stop</span>
                              </span>
                              <span className="text-[11px] text-slate-400">
                                Automatically included as Google Maps destination
                              </span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Status Chips Row */}
                      <div className="flex flex-wrap items-center gap-1.5 py-0.5 text-[11px]">
                        {originalWp?.place_name && (
                          <span
                            onClick={() => {
                              setSelectedModal({
                                waypoint: modalWp,
                                initialTab: 'details',
                                isFirst,
                                isLast,
                              });
                            }}
                            className="px-2 py-0.5 rounded bg-teal-950/70 text-teal-300 border border-teal-800/60 font-mono text-[11px] cursor-pointer hover:bg-teal-900/80 transition-colors truncate max-w-[180px]"
                            title={`Google Maps Establishment Name: ${originalWp.place_name}. Click to view or edit.`}
                          >
                            🗺️ {originalWp.place_name}
                          </span>
                        )}

                        {originalWp?.address ? (
                          <span
                            onClick={() => {
                              setSelectedModal({
                                waypoint: modalWp,
                                initialTab: 'details',
                                isFirst,
                                isLast,
                              });
                            }}
                            className="px-2 py-0.5 rounded bg-slate-800/90 text-slate-300 border border-slate-700/80 truncate max-w-[200px] cursor-pointer hover:bg-slate-750 transition-colors"
                            title={`Click to edit address: ${originalWp.address}`}
                          >
                            📍 {originalWp.address}
                          </span>
                        ) : (
                          <span
                            onClick={() => {
                              setSelectedModal({
                                waypoint: modalWp,
                                initialTab: 'details',
                                isFirst,
                                isLast,
                              });
                            }}
                            className="px-2 py-0.5 rounded bg-slate-800/50 text-slate-500 border border-slate-800 cursor-pointer hover:text-slate-300 transition-colors"
                            title="Click to set physical street address"
                          >
                            + Add address
                          </span>
                        )}

                        {originalWp?.google_place_id ? (
                          <span
                            onClick={() => {
                              setSelectedModal({
                                waypoint: modalWp,
                                initialTab: 'details',
                                isFirst,
                                isLast,
                              });
                            }}
                            className="px-2 py-0.5 rounded bg-emerald-950/70 text-emerald-300 border border-emerald-800/60 font-mono text-[11px] cursor-pointer hover:bg-emerald-900/80 transition-colors"
                            title={`Google Place ID: ${originalWp.google_place_id}. Click to view or clear.`}
                          >
                            ✓ Place ID
                          </span>
                        ) : (
                          <span
                            onClick={() => {
                              setSelectedModal({
                                waypoint: modalWp,
                                initialTab: 'details',
                                isFirst,
                                isLast,
                              });
                            }}
                            className="px-2 py-0.5 rounded bg-amber-950/40 text-amber-400/80 border border-amber-900/50 text-[11px] cursor-pointer hover:bg-amber-900/60 transition-colors"
                            title="No Google Place ID configured. Click to add or verify."
                          >
                            No Place ID
                          </span>
                        )}

                        {stop.type === 'stop' ? (
                          <span
                            onClick={() => {
                              setSelectedModal({
                                waypoint: modalWp,
                                initialTab: 'alert',
                                isFirst,
                                isLast,
                              });
                            }}
                            className="px-2 py-0.5 rounded bg-slate-800/50 text-slate-400 border border-slate-700/60 text-[11px] cursor-pointer hover:bg-slate-750"
                            title="Silent generic stop. Click to view arrival distance."
                          >
                            Silent stop
                          </span>
                        ) : hasActiveAlert ? (
                          <span
                            className="px-2 py-0.5 rounded bg-sky-950/70 text-sky-300 border border-sky-800/60 truncate max-w-[180px] cursor-pointer hover:bg-sky-900/80"
                            onClick={() => {
                              setSelectedModal({
                                waypoint: modalWp,
                                initialTab: 'alert',
                                isFirst,
                                isLast,
                              });
                            }}
                            title="Click to view or edit AI Co-Pilot announcement"
                          >
                            🔔 {stop.notification?.title}
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded bg-slate-800/50 text-slate-500 border border-slate-800 text-[11px]">
                            No audio alert
                          </span>
                        )}
                      </div>

                      {/* Action Buttons Row */}
                      <div className="pt-2 border-t border-slate-800 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          {onOpenScoutForWaypoint && (
                            <button
                              type="button"
                              onClick={
                                aiAvailable
                                  ? () => {
                                      onOpenScoutForWaypoint(modalWp);
                                    }
                                  : undefined
                              }
                              disabled={!aiAvailable}
                              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                                !aiAvailable
                                  ? 'bg-slate-850 border-slate-800 text-slate-500 cursor-not-allowed opacity-60'
                                  : 'bg-slate-800 hover:bg-slate-750 text-cyan-300 border-slate-700/80 cursor-pointer'
                              }`}
                              title={
                                !aiAvailable
                                  ? AI_UNAVAILABLE_TOOLTIP
                                  : 'Ask Route Scout about this stop'
                              }
                            >
                              <Compass
                                className={`w-3.5 h-3.5 ${
                                  !aiAvailable ? 'text-slate-500' : 'text-cyan-400'
                                }`}
                              />
                              <span>Ask Scout</span>
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => {
                              setSelectedModal({
                                waypoint: modalWp,
                                initialTab: 'details',
                                isFirst,
                                isLast,
                              });
                            }}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-semibold transition-colors shadow-sm cursor-pointer"
                            title="Open comprehensive edit dialog for address, place ID, audio alert and trigger distance"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                            <span>Edit Full Details & Audio</span>
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={() => {
                            setEditingWaypointId(null);
                            onSelectWaypoint?.(null);
                          }}
                          className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg text-xs font-medium transition-colors cursor-pointer"
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

      {/* Edit Waypoint / AI Co-Pilot Alert Modal */}
      {selectedModal && (
        <EditWaypointModal
          isOpen={Boolean(selectedModal)}
          waypoint={selectedModal.waypoint}
          initialTab={selectedModal.initialTab}
          isFirst={selectedModal.isFirst}
          isLast={selectedModal.isLast}
          onClose={() => setSelectedModal(null)}
          onSave={(waypointId, updates) => onUpdateWaypoint(waypointId, updates)}
          aiAvailable={aiAvailable}
          aiModels={aiModels}
          selectedModelId={selectedModelId}
          onSelectModel={onSelectModel}
        />
      )}
    </aside>
  );
};
