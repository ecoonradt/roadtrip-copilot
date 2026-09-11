import React, { useState, useMemo } from 'react';
import {
  Clock,
  Compass,
  MapPin,
  Trash2,
  Navigation,
  ExternalLink,
  Copy,
  Check,
  ArrowUp,
  ArrowDown,
  RotateCcw,
  Globe,
  AlertCircle,
  Timer,
  ChevronRight,
  Sparkles,
  Loader2,
  Share2,
} from 'lucide-react';

import type { Waypoint, RouteResponse } from '../types/routing';
import type { WaypointContext, CopilotAlert } from '../types/ai';
import {
  calculateTimelineCascade,
  calculateBackwardSchedule,
} from '../engine/cascade';
import { generateGoogleMapsUrls } from '../engine/googleMapsUrl';
import type { ScheduledStop } from '../engine/types';
import { AiAlertModal } from './AiAlertModal';
import { ExportModal } from './ExportModal';
import { generateBatchCopilotAlerts } from '../services/api';


interface TimelineSidebarProps {
  waypoints: Waypoint[];
  route: RouteResponse | null;
  isLoadingRoute: boolean;
  onDeleteWaypoint: (id: string) => void;
  onUpdateWaypoint: (id: string, updates: Partial<Waypoint>) => void;
  onMoveWaypoint: (index: number, direction: 'up' | 'down') => void;
  onResetSample: () => void;
  onClearAll: () => void;
}

export const TimelineSidebar: React.FC<TimelineSidebarProps> = ({
  waypoints,
  route,
  isLoadingRoute,
  onDeleteWaypoint,
  onUpdateWaypoint,
  onMoveWaypoint,
  onResetSample,
  onClearAll,
}) => {
  // Timeline scheduling controls state
  const [baseDate, setBaseDate] = useState<string>('2026-10-09');
  const [departureTime, setDepartureTime] = useState<string>('14:30:00');
  const [schedulingMode, setSchedulingMode] = useState<'forward' | 'backward'>('forward');
  const [targetArrivalTime, setTargetArrivalTime] = useState<string>('18:00:00');

  // Copy feedback state for each leg URL
  const [copiedLegIndex, setCopiedLegIndex] = useState<number | null>(null);

  // AI Co-Pilot Alert Modal & Batch state
  const [selectedWaypointForAi, setSelectedWaypointForAi] = useState<Waypoint | null>(null);
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [batchProgress, setBatchProgress] = useState<string | null>(null);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);


  // Extract pairwise driving durations and distances from OSRM route if available
  const { driveDurationsSeconds, driveDistancesMiles } = useMemo(() => {
    if (!route?.legs || route.legs.length === 0) {
      return { driveDurationsSeconds: undefined, driveDistancesMiles: undefined };
    }
    return {
      driveDurationsSeconds: route.legs.map((l) => l.durationSeconds),
      driveDistancesMiles: route.legs.map((l) => l.distanceMiles),
    };
  }, [route]);

  // Compute deterministic timeline cascade (forward or backward mode)
  const { cascadeResult, backwardInfo, calculationError } = useMemo(() => {
    if (waypoints.length === 0) {
      return {
        cascadeResult: calculateTimelineCascade({
          baseDate,
          departureTime: '14:30:00',
          waypoints: [],
        }),
        backwardInfo: null,
        calculationError: null,
      };
    }

    try {
      if (schedulingMode === 'backward') {
        const result = calculateBackwardSchedule({
          baseDate,
          targetArrivalTime: targetArrivalTime.length === 5 ? `${targetArrivalTime}:00` : targetArrivalTime,
          waypoints,
          driveDurationsSeconds,
          driveDistancesMiles,
        });
        return {
          cascadeResult: result.cascadeResult,
          backwardInfo: result,
          calculationError: null,
        };
      }

      const formattedDep = departureTime.length === 5 ? `${departureTime}:00` : departureTime;
      const result = calculateTimelineCascade({
        baseDate,
        departureTime: formattedDep,
        waypoints,
        driveDurationsSeconds,
        driveDistancesMiles,
      });

      return {
        cascadeResult: result,
        backwardInfo: null,
        calculationError: null,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Calculation error';
      // Fallback to basic forward cascade
      const fallbackResult = calculateTimelineCascade({
        baseDate,
        departureTime: '14:30:00',
        waypoints,
      });
      return {
        cascadeResult: fallbackResult,
        backwardInfo: null,
        calculationError: msg,
      };
    }
  }, [
    baseDate,
    departureTime,
    schedulingMode,
    targetArrivalTime,
    waypoints,
    driveDurationsSeconds,
    driveDistancesMiles,
  ]);

  // Generate Google Maps Navigation URLs with automated chunking
  const googleMapsRoute = useMemo(() => {
    return generateGoogleMapsUrls(
      waypoints.map((w) => ({ lat: w.lat, lng: w.lng, name: w.name }))
    );
  }, [waypoints]);

  // Copy URL to clipboard
  const handleCopyUrl = async (url: string, legIdx: number) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedLegIndex(legIdx);
      setTimeout(() => setCopiedLegIndex(null), 2500);
    } catch {
      // Fallback
      setCopiedLegIndex(null);
    }
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
      setBatchProgress(`Generated ${Object.keys(batchResult.alerts).length} alerts!`);
      setTimeout(() => setBatchProgress(null), 3000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Batch generation failed';
      setBatchProgress(`Error: ${msg}`);
      setTimeout(() => setBatchProgress(null), 4000);
    } finally {
      setIsBatchGenerating(false);
    }
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
              Roadtrip Co-Pilot &bull; Deterministic Timeline Engine
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
          <div className="flex items-center gap-1 text-[11px] font-mono text-slate-400">
            <Globe className="w-3 h-3 text-sky-400" />
            <span>{cascadeResult.timezonesCrossed.join(' • ') || 'America/Phoenix'}</span>
          </div>
        </div>

        {/* 1-Click Export & Phone Sync Button */}
        <button
          onClick={() => setIsExportModalOpen(true)}
          className="w-full mt-2.5 py-2 px-3 bg-gradient-to-r from-sky-600 to-indigo-600 hover:from-sky-500 hover:to-indigo-500 text-white rounded-xl text-xs font-semibold flex items-center justify-center gap-2 shadow-md shadow-sky-950/40 transition-all cursor-pointer"
          title="Open Export, 1-Click ADB Push & Wi-Fi Handoff Modal"
        >
          <Share2 className="w-3.5 h-3.5" />
          <span>Export &amp; Sync to Phone</span>
        </button>
      </div>

      {/* Timeline Controls (Base Date, Departure Time / Catch-up Mode) */}
      <div className="p-3 border-b border-slate-800 bg-slate-950/70 space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
            Schedule Configuration
          </span>
          {/* Mode Toggle */}
          <div className="flex bg-slate-800 p-0.5 rounded-lg border border-slate-700/60 text-xs">
            <button
              onClick={() => setSchedulingMode('forward')}
              className={`px-2 py-0.5 rounded-md transition-all ${
                schedulingMode === 'forward'
                  ? 'bg-sky-600 text-white font-medium shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Depart At
            </button>
            <button
              onClick={() => setSchedulingMode('backward')}
              className={`px-2 py-0.5 rounded-md transition-all ${
                schedulingMode === 'backward'
                  ? 'bg-indigo-600 text-white font-medium shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Reverse-schedule from arrival deadline (Flight Catch-Up)"
            >
              Flight Catch-Up
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Trip Date</label>
            <input
              type="date"
              value={baseDate}
              onChange={(e) => setBaseDate(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 text-slate-100 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-sky-500 font-mono"
            />
          </div>

          {schedulingMode === 'forward' ? (
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">Day Departure</label>
              <input
                type="time"
                step="60"
                value={departureTime.slice(0, 5)}
                onChange={(e) => setDepartureTime(`${e.target.value}:00`)}
                className="w-full bg-slate-800 border border-slate-700 text-slate-100 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-sky-500 font-mono"
              />
            </div>
          ) : (
            <div>
              <label className="block text-[11px] text-indigo-300 font-medium mb-1">
                Target Arrival Deadline
              </label>
              <input
                type="time"
                step="60"
                value={targetArrivalTime.slice(0, 5)}
                onChange={(e) => setTargetArrivalTime(`${e.target.value}:00`)}
                className="w-full bg-slate-800 border border-indigo-500/70 text-indigo-100 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-400 font-mono"
              />
            </div>
          )}
        </div>

        {/* Backward Scheduling Notice Banner */}
        {schedulingMode === 'backward' && backwardInfo && (
          <div className="p-2 bg-indigo-950/70 border border-indigo-700/60 rounded-lg text-xs text-indigo-200 flex items-start gap-2">
            <Timer className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-white">
                Mandatory Departure: {backwardInfo.requiredDepartureTime.slice(0, 5)} ({backwardInfo.originTimezone.split('/')[1]})
              </span>
              <p className="text-[11px] text-indigo-300 mt-0.5 leading-tight">
                To reach {waypoints[waypoints.length - 1]?.name || 'destination'} by {targetArrivalTime.slice(0, 5)} {backwardInfo.destinationTimezone.split('/')[1]}.
              </p>
            </div>
          </div>
        )}

        {calculationError && (
          <div className="p-2 bg-rose-950/70 border border-rose-800/80 rounded-lg text-xs text-rose-300 flex items-center gap-1.5">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{calculationError}</span>
          </div>
        )}
      </div>

      {/* Telemetry KPI Cards */}
      <div className="p-3 grid grid-cols-3 gap-2 border-b border-slate-800 bg-slate-950/40">
        <div className="bg-slate-800/70 p-2 rounded-xl border border-slate-700/60">
          <div className="flex items-center gap-1 text-[11px] text-slate-400 mb-0.5">
            <Navigation className="w-3 h-3 text-sky-400" />
            <span>Drive</span>
          </div>
          <div className="text-sm font-bold text-white font-mono">
            {cascadeResult.totalDistanceMiles > 0
              ? `${cascadeResult.totalDistanceMiles} mi`
              : route
              ? `${route.distanceMiles} mi`
              : '--'}
          </div>
          <div className="text-[10px] text-slate-400">
            {cascadeResult.totalDriveSeconds > 0
              ? formatDuration(cascadeResult.totalDriveSeconds)
              : '--'}
          </div>
        </div>

        <div className="bg-slate-800/70 p-2 rounded-xl border border-slate-700/60">
          <div className="flex items-center gap-1 text-[11px] text-slate-400 mb-0.5">
            <Clock className="w-3 h-3 text-amber-400" />
            <span>Dwell</span>
          </div>
          <div className="text-sm font-bold text-white font-mono">
            {cascadeResult.totalDwellMinutes}m
          </div>
          <div className="text-[10px] text-slate-400">Total stops</div>
        </div>

        <div className="bg-slate-800/70 p-2 rounded-xl border border-slate-700/60">
          <div className="flex items-center gap-1 text-[11px] text-slate-400 mb-0.5">
            <Timer className="w-3 h-3 text-indigo-400" />
            <span>Elapsed</span>
          </div>
          <div className="text-sm font-bold text-white font-mono">
            {cascadeResult.totalTripSeconds > 0
              ? formatDuration(cascadeResult.totalTripSeconds)
              : '--'}
          </div>
          <div className="text-[10px] text-slate-400">Drive + stops</div>
        </div>
      </div>

      {/* Google Maps Turn-by-Turn Navigation Section */}
      <div className="p-3 border-b border-slate-800 bg-slate-900/80">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <Navigation className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-xs font-semibold text-slate-200">
              Google Maps Turn-by-Turn
            </span>
          </div>
          <span className="text-[11px] px-1.5 py-0.2 rounded bg-emerald-950 text-emerald-300 font-mono border border-emerald-800/50">
            {googleMapsRoute.totalLegs} {googleMapsRoute.totalLegs === 1 ? 'Leg' : 'Legs'}
          </span>
        </div>

        {googleMapsRoute.legs.length === 0 ? (
          <div className="text-xs text-slate-500 py-1 text-center">
            Add waypoints to generate navigation links
          </div>
        ) : (
          <div className="space-y-2">
            {googleMapsRoute.legs.map((leg) => (
              <div
                key={leg.legIndex}
                className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-2.5 flex flex-col gap-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-white">
                    {leg.title}
                  </span>
                  <span className="text-[10px] text-slate-400 font-mono">
                    {leg.waypointCount} points ({leg.intermediateWaypoints.length} stops)
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  <a
                    href={leg.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium transition-colors shadow-sm"
                  >
                    <span>Open in Google Maps</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>

                  <button
                    onClick={() => handleCopyUrl(leg.url, leg.legIndex)}
                    className="px-2.5 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
                    title="Copy Google Maps Navigation Link"
                  >
                    {copiedLegIndex === leg.legIndex ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400 text-[11px]">Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span className="text-[11px]">Copy</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            ))}

            {googleMapsRoute.totalLegs > 1 && (
              <p className="text-[11px] text-slate-400 italic">
                Automatically chunked into &le; 9 intermediate stops per leg with continuous handoff for Google Maps limits.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Waypoints Section Header */}
      <div className="px-4 py-2 border-b border-slate-800 bg-slate-900/60 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Waypoints & Cascade
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

        {/* Batch Generate Co-Pilot Alerts Button */}
        {waypoints.length > 0 && (
          <div className="flex flex-col gap-1 pt-1 border-t border-slate-800/80">
            <button
              onClick={handleBatchGenerateAll}
              disabled={isBatchGenerating}
              className="w-full px-2.5 py-1.5 bg-gradient-to-r from-sky-600/30 to-indigo-600/30 hover:from-sky-600/50 hover:to-indigo-600/50 border border-sky-500/40 text-sky-200 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition-all shadow-sm disabled:opacity-50"
              title="Batch generate AI Co-Pilot alerts for all waypoints today"
            >
              {isBatchGenerating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
              ) : (
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              )}
              <span>{isBatchGenerating ? 'Generating Day Alerts...' : 'Batch Generate All Day Alerts'}</span>
            </button>

            {batchProgress && (
              <span className="text-[10px] text-sky-300 font-mono text-center animate-pulse">
                {batchProgress}
              </span>
            )}
          </div>
        )}
      </div>


      {/* Scheduled Waypoints List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {cascadeResult.stops.length === 0 ? (
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
          cascadeResult.stops.map((stop: ScheduledStop, idx: number) => {
            const isFirst = idx === 0;
            const isLast = idx === cascadeResult.stops.length - 1;

            return (
              <React.Fragment key={stop.id}>
                {/* Timezone Boundary Crossing Indicator */}
                {stop.isTimezoneBoundaryCrossing && (
                  <div className="py-1 px-2.5 bg-amber-950/70 border border-amber-600/60 rounded-lg text-[11px] text-amber-200 flex items-center justify-between">
                    <span className="font-semibold">
                      State Border & Timezone Shift ({stop.timezoneShiftHours && stop.timezoneShiftHours > 0 ? `+${stop.timezoneShiftHours}` : stop.timezoneShiftHours} Hour)
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-wider bg-amber-900/60 px-1.5 py-0.5 rounded">
                      {stop.timezoneAbbreviation}
                    </span>
                  </div>
                )}

                <div className="group p-3 rounded-xl bg-slate-800/80 border border-slate-700/70 hover:border-slate-600 transition-all shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <div
                        className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0 shadow-sm pin-${stop.type}`}
                      >
                        {idx + 1}
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-white truncate group-hover:text-sky-300 transition-colors">
                          {stop.name}
                        </h3>
                        <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-slate-400">
                          <span className="font-mono text-[10px] px-1 py-0.2 rounded bg-slate-900 text-slate-400">
                            {stop.timezoneAbbreviation} ({stop.timezoneOffsetStr})
                          </span>
                          <span>&bull;</span>
                          <span className="font-mono">
                            {stop.lat.toFixed(3)}, {stop.lng.toFixed(3)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Actions: Move Up / Down and Delete */}
                    <div className="flex items-center gap-0.5 shrink-0">
                      {!isFirst && (
                        <button
                          onClick={() => onMoveWaypoint(idx, 'up')}
                          className="text-slate-400 hover:text-sky-300 p-1 rounded hover:bg-slate-700 transition-colors"
                          title="Move earlier"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {!isLast && (
                        <button
                          onClick={() => onMoveWaypoint(idx, 'down')}
                          className="text-slate-400 hover:text-sky-300 p-1 rounded hover:bg-slate-700 transition-colors"
                          title="Move later"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => onDeleteWaypoint(stop.id)}
                        className="text-slate-500 hover:text-rose-400 p-1 rounded hover:bg-slate-700 transition-colors"
                        title="Delete waypoint"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Computed Schedule Bar */}
                  <div className="mt-2.5 py-1.5 px-2 bg-slate-900/80 rounded-lg border border-slate-700/50 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1 text-slate-300">
                      <Clock className="w-3 h-3 text-sky-400" />
                      <span className="font-mono font-semibold">
                        Arrive: {stop.arrivalShortTime}
                      </span>
                    </div>

                    <ChevronRight className="w-3 h-3 text-slate-600" />

                    <div className="flex items-center gap-1 text-slate-300">
                      <span className="font-mono font-semibold">
                        Depart: {stop.departureShortTime}
                      </span>
                    </div>
                  </div>

                  {/* Dwell Time Editor */}
                  <div className="mt-2 pt-2 border-t border-slate-700/50 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5 text-slate-400">
                      <span>Dwell:</span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() =>
                            onUpdateWaypoint(stop.id, {
                              dwell_minutes: Math.max(0, stop.dwell_minutes - 15),
                            })
                          }
                          className="px-1.5 py-0.5 bg-slate-700 hover:bg-slate-600 rounded text-[11px] text-slate-200 font-mono"
                          title="Decrease dwell by 15 mins"
                        >
                          -15
                        </button>
                        <input
                          type="number"
                          min="0"
                          max="240"
                          step="5"
                          value={stop.dwell_minutes}
                          onChange={(e) =>
                            onUpdateWaypoint(stop.id, {
                              dwell_minutes: Math.max(0, parseInt(e.target.value, 10) || 0),
                            })
                          }
                          className="w-12 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-center text-xs text-white font-mono focus:outline-none focus:border-sky-500"
                        />
                        <button
                          onClick={() =>
                            onUpdateWaypoint(stop.id, {
                              dwell_minutes: stop.dwell_minutes + 15,
                            })
                          }
                          className="px-1.5 py-0.5 bg-slate-700 hover:bg-slate-600 rounded text-[11px] text-slate-200 font-mono"
                          title="Increase dwell by 15 mins"
                        >
                          +15
                        </button>
                        <span className="text-slate-400 text-[11px]">min</span>
                      </div>
                    </div>

                    <span className="text-[10px] text-slate-500">
                      Ripples {cascadeResult.stops.length - idx - 1} stops
                    </span>
                  </div>

                  {/* AI Co-Pilot Alert Card Integration */}
                  <div className="mt-2.5 pt-2 border-t border-slate-700/50 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <button
                        onClick={() => {
                          const currentWp = waypoints.find((w) => w.id === stop.id) || {
                            ...stop,
                            target_time: stop.arrivalTime,
                          };
                          setSelectedWaypointForAi(currentWp);
                        }}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all ${
                          stop.notification
                            ? 'bg-emerald-950/70 hover:bg-emerald-900 text-emerald-300 border border-emerald-700/60'
                            : 'bg-slate-700/70 hover:bg-slate-700 text-sky-300 hover:text-white border border-slate-600/60'
                        }`}
                        title="Configure AI Co-Pilot Heads-Up Card & Audio Prompt"
                      >
                        <Sparkles
                          className={`w-3.5 h-3.5 ${
                            stop.notification ? 'text-emerald-400' : 'text-amber-400'
                          }`}
                        />
                        <span>
                          {stop.notification ? 'AI Alert Configured' : 'Generate Co-Pilot Alert'}
                        </span>
                      </button>

                      <span className="text-[10px] text-slate-400 font-mono">
                        Radius: {stop.trigger_radius_miles} mi
                      </span>
                    </div>

                    {stop.notification && (
                      <div className="p-2 bg-slate-950/70 border border-slate-800 rounded-lg text-[11px] text-slate-300">
                        <div className="font-semibold text-emerald-400 truncate">
                          Card: &ldquo;{stop.notification.title}&rdquo;
                        </div>
                        <div className="text-slate-400 italic truncate mt-0.5">
                          TTS: &ldquo;{stop.notification.speech}&rdquo;
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Drive to Next Stop Connector */}
                {!isLast && (
                  <div className="px-4 py-1 flex items-center gap-2 text-[11px] text-slate-400 font-mono">
                    <div className="w-0.5 h-4 bg-slate-700 ml-3" />
                    <span>
                      &darr; Drive{' '}
                      {formatDuration(
                        cascadeResult.stops[idx + 1].driveDurationFromPreviousSeconds
                      )}{' '}
                      ({cascadeResult.stops[idx + 1].driveDistanceMilesFromPrevious} mi)
                    </span>
                  </div>
                )}
              </React.Fragment>
            );
          })
        )}
      </div>

      {/* Footer Info */}
      <div className="p-3 border-t border-slate-800 bg-slate-950/60 text-xs text-slate-400 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5 text-sky-400" />
          <span>Deterministic Timeline Engine</span>
        </div>
        <span className="font-mono text-slate-500 text-[10px]">Phase 2C Verified</span>
      </div>

      {/* AI Co-Pilot Alert Modal */}
      <AiAlertModal
        isOpen={!!selectedWaypointForAi}
        waypoint={selectedWaypointForAi}
        onClose={() => setSelectedWaypointForAi(null)}
        onApply={handleApplyAiAlert}
      />

      {/* Export & Phone Handoff Modal */}
      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        waypoints={waypoints}
        scheduledStops={cascadeResult.stops}
        tripName="Roadtrip Co-Pilot Itinerary"
        baseDate={baseDate}
        departureTime={departureTime}
        googleMapsRoute={googleMapsRoute}
      />
    </aside>

  );
};
