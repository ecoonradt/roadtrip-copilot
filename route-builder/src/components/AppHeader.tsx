import React, { useState, useRef, useEffect } from 'react';
import {
  Compass,
  Navigation,
  Clock,
  Timer,
  Share2,
  ExternalLink,
  Copy,
  Check,
  Calendar,
  ChevronDown,
  FolderOpen,
  Save,
  Loader2,
} from 'lucide-react';
import type { RouteResponse } from '../types/routing';
import type {
  TimelineCascadeResult,
  BackwardScheduleResult,
  GoogleMapsRouteResult,
} from '../engine/types';

interface AppHeaderProps {
  route: RouteResponse | null;
  isLoadingRoute: boolean;
  routeError: string | null;
  baseDate: string;
  setBaseDate: (date: string) => void;
  departureTime: string;
  setDepartureTime: (time: string) => void;
  schedulingMode: 'forward' | 'backward';
  setSchedulingMode: (mode: 'forward' | 'backward') => void;
  targetArrivalTime: string;
  setTargetArrivalTime: (time: string) => void;
  backwardInfo: BackwardScheduleResult | null;
  cascadeResult: TimelineCascadeResult;
  googleMapsRoute: GoogleMapsRouteResult;
  onOpenExportModal: () => void;
  currentTripName?: string;
  onOpenRouteSelector?: () => void;
  onSaveTrip?: () => void;
  isSaving?: boolean;
  saveSuccess?: boolean;
  isDirty?: boolean;
  onToggleScout?: () => void;
  isScoutOpen?: boolean;
  aiAvailable?: boolean;
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  route,
  isLoadingRoute,
  routeError,
  baseDate,
  setBaseDate,
  departureTime,
  setDepartureTime,
  schedulingMode,
  setSchedulingMode,
  targetArrivalTime,
  setTargetArrivalTime,
  backwardInfo,
  cascadeResult,
  googleMapsRoute,
  onOpenExportModal,
  currentTripName = 'Phoenix to Albuquerque Road Trip',
  onOpenRouteSelector,
  onSaveTrip,
  isSaving = false,
  saveSuccess = false,
  isDirty = false,
  onToggleScout,
  isScoutOpen = false,
  aiAvailable = true,
}) => {
  const [isSchedulePopoverOpen, setIsSchedulePopoverOpen] = useState(false);
  const [isMapsDropdownOpen, setIsMapsDropdownOpen] = useState(false);
  const [copiedLegIndex, setCopiedLegIndex] = useState<number | null>(null);

  const scheduleDropdownRef = useRef<HTMLDivElement>(null);
  const mapsDropdownRef = useRef<HTMLDivElement>(null);

  // Close popovers on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        scheduleDropdownRef.current &&
        !scheduleDropdownRef.current.contains(target)
      ) {
        setIsSchedulePopoverOpen(false);
      }
      if (
        mapsDropdownRef.current &&
        !mapsDropdownRef.current.contains(target)
      ) {
        setIsMapsDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const formatDuration = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours === 0) return `${minutes}m`;
    return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  };

  const handleCopyUrl = async (url: string, legIdx: number) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedLegIndex(legIdx);
      setTimeout(() => setCopiedLegIndex(null), 2500);
    } catch {
      setCopiedLegIndex(null);
    }
  };

  const totalDistance =
    cascadeResult.totalDistanceMiles > 0
      ? cascadeResult.totalDistanceMiles
      : route?.distanceMiles || 0;

  const totalDriveSecs = cascadeResult.totalDriveSeconds || 0;
  const totalTripSecs = cascadeResult.totalTripSeconds || 0;

  return (
    <header className="h-14 bg-slate-900 border-b border-slate-800 px-4 flex items-center justify-between gap-3 text-slate-100 shrink-0 z-30 shadow-md">
      {/* Left: Brand Logo & Status */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center shadow-md shadow-sky-500/20">
            <Compass className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-white flex items-center gap-1.5 leading-none">
              Roadtrip Co-Pilot
            </h1>
            <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-slate-400">
              <span
                className={`inline-block w-2 h-2 rounded-full ${
                  isLoadingRoute
                    ? 'bg-amber-400 animate-pulse'
                    : routeError
                    ? 'bg-rose-500'
                    : 'bg-emerald-400'
                }`}
              />
              <span className="text-[10px]">
                {isLoadingRoute
                  ? 'Calculating...'
                  : routeError
                  ? 'Routing Warning'
                  : route?.cached
                  ? 'Route Ready (Cached)'
                  : 'Route Ready'}
              </span>
            </div>
          </div>
        </div>

        {/* Route / Trip Selector Trigger */}
        {onOpenRouteSelector && (
          <button
            onClick={onOpenRouteSelector}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-850 hover:bg-slate-800 text-slate-200 border border-slate-700/80 rounded-xl text-xs font-medium transition-colors cursor-pointer shadow-sm ml-1"
            title="Switch itinerary, import JSON file, or start a new route"
          >
            <FolderOpen className="w-3.5 h-3.5 text-sky-400 shrink-0" />
            <span className="font-semibold text-white truncate max-w-[130px] sm:max-w-[190px]">
              {currentTripName}
            </span>
            <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" />
          </button>
        )}
      </div>

      {/* Right Controls: Schedule, Telemetry, Maps & Export */}
      <div className="flex items-center gap-2.5 shrink-0">
        {/* Schedule Popover Trigger */}
        <div className="relative" ref={scheduleDropdownRef}>
          <button
            onClick={() => setIsSchedulePopoverOpen(!isSchedulePopoverOpen)}
            className="flex items-center gap-2 px-2.5 py-1.5 bg-slate-800/90 hover:bg-slate-800 border border-slate-700/80 rounded-xl text-xs text-slate-200 transition-colors shadow-sm cursor-pointer"
            title="Configure departure date and time"
          >
            <Calendar className="w-3.5 h-3.5 text-sky-400" />
            <span className="font-mono text-[11px]">
              {baseDate} &bull;{' '}
              {schedulingMode === 'forward'
                ? departureTime.slice(0, 5)
                : `By ${targetArrivalTime.slice(0, 5)}`}
            </span>
            <ChevronDown className="w-3 h-3 text-slate-400" />
          </button>

          {/* Schedule Configuration Dropdown */}
          {isSchedulePopoverOpen && (
            <div className="absolute right-0 mt-2 w-72 p-3.5 bg-slate-900/98 border border-slate-700 rounded-xl shadow-2xl z-50 backdrop-blur-md space-y-3">
              <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                <span className="text-xs font-semibold text-white">Trip Schedule</span>
                {/* Mode Selector */}
                <div className="flex bg-slate-800 p-0.5 rounded-lg text-[11px]">
                  <button
                    onClick={() => setSchedulingMode('forward')}
                    className={`px-2 py-0.5 rounded-md transition-all ${
                      schedulingMode === 'forward'
                        ? 'bg-sky-600 text-white font-medium'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Depart At
                  </button>
                  <button
                    onClick={() => setSchedulingMode('backward')}
                    className={`px-2 py-0.5 rounded-md transition-all ${
                      schedulingMode === 'backward'
                        ? 'bg-indigo-600 text-white font-medium'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                    title="Reverse-schedule from destination deadline"
                  >
                    Catch-Up
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Trip Date</label>
                  <input
                    type="date"
                    value={baseDate}
                    onChange={(e) => setBaseDate(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 text-slate-100 text-xs rounded-lg px-2.5 py-1.5 font-mono focus:outline-none focus:border-sky-500"
                  />
                </div>

                {schedulingMode === 'forward' ? (
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Departure Time</label>
                    <input
                      type="time"
                      step="60"
                      value={departureTime.slice(0, 5)}
                      onChange={(e) => setDepartureTime(`${e.target.value}:00`)}
                      className="w-full bg-slate-800 border border-slate-700 text-slate-100 text-xs rounded-lg px-2.5 py-1.5 font-mono focus:outline-none focus:border-sky-500"
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
                      className="w-full bg-slate-800 border border-indigo-500/70 text-indigo-100 text-xs rounded-lg px-2.5 py-1.5 font-mono focus:outline-none focus:border-indigo-400"
                    />
                  </div>
                )}
              </div>

              {schedulingMode === 'backward' && backwardInfo && (
                <div className="p-2 bg-indigo-950/70 border border-indigo-700/60 rounded-lg text-xs text-indigo-200 flex items-start gap-2">
                  <Timer className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold text-white">
                      Must Depart: {backwardInfo.requiredDepartureTime.slice(0, 5)} ({backwardInfo.originTimezone.split('/')[1]})
                    </div>
                    <div className="text-[10px] text-indigo-300 mt-0.5">
                      To reach destination by {targetArrivalTime.slice(0, 5)} ({backwardInfo.destinationTimezone.split('/')[1]}).
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Route Telemetry KPIs */}
        {totalDistance > 0 && (
          <div className="hidden md:flex items-center gap-2 bg-slate-800/80 px-2.5 py-1 rounded-xl border border-slate-700/70 text-xs font-mono">
            <div className="flex items-center gap-1 text-slate-200" title="Total Drive Distance">
              <Navigation className="w-3 h-3 text-sky-400" />
              <span>{totalDistance} mi</span>
            </div>
            <span className="text-slate-600">&bull;</span>
            <div className="flex items-center gap-1 text-slate-300" title="Total Driving Time">
              <Clock className="w-3 h-3 text-sky-400" />
              <span>{formatDuration(totalDriveSecs)} drive</span>
            </div>
            {totalTripSecs > totalDriveSecs && (
              <>
                <span className="text-slate-600 hidden xl:inline">&bull;</span>
                <div className="hidden xl:flex items-center gap-1 text-slate-400" title="Total Elapsed Time (Drive + Stops)">
                  <Timer className="w-3 h-3 text-indigo-400" />
                  <span>{formatDuration(totalTripSecs)} total</span>
                </div>
              </>
            )}
          </div>
        )}

        {/* Google Maps Turn-by-Turn Button or Dropdown */}
        {googleMapsRoute.legs.length > 0 && (
          <div className="relative" ref={mapsDropdownRef}>
            {googleMapsRoute.legs.length === 1 ? (
              <div className="flex items-center gap-1 bg-slate-800/90 border border-slate-700/80 rounded-xl p-0.5">
                <a
                  href={googleMapsRoute.legs[0].url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium transition-colors shadow-sm"
                  title="Open navigation in Google Maps"
                >
                  <span>Google Maps</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
                <button
                  onClick={() => handleCopyUrl(googleMapsRoute.legs[0].url, 0)}
                  className="px-2 py-1 text-slate-300 hover:text-white rounded-lg hover:bg-slate-700 text-xs transition-colors"
                  title="Copy Google Maps navigation link"
                >
                  {copiedLegIndex === 0 ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            ) : (
              <div>
                <button
                  onClick={() => setIsMapsDropdownOpen(!isMapsDropdownOpen)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded-xl text-xs font-medium transition-colors shadow-sm cursor-pointer"
                  title="View Google Maps multi-leg links"
                >
                  <span>Google Maps ({googleMapsRoute.totalLegs} Legs)</span>
                  <ChevronDown className="w-3 h-3" />
                </button>

                {isMapsDropdownOpen && (
                  <div className="absolute right-0 mt-2 w-72 p-2.5 bg-slate-900/98 border border-slate-700 rounded-xl shadow-2xl z-50 backdrop-blur-md space-y-2">
                    <div className="text-[11px] font-semibold text-slate-400 px-1">
                      Multi-Leg Navigation Links (&le; 9 stops each)
                    </div>
                    {googleMapsRoute.legs.map((leg) => (
                      <div
                        key={leg.legIndex}
                        className="bg-slate-800/90 border border-slate-700/80 rounded-lg p-2 flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-white truncate">
                            {leg.title}
                          </div>
                          <div className="text-[10px] text-slate-400 font-mono">
                            {leg.waypointCount} points
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <a
                            href={leg.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs flex items-center gap-1"
                          >
                            <span>Open</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                          <button
                            onClick={() => handleCopyUrl(leg.url, leg.legIndex)}
                            className="p-1 text-slate-300 hover:text-white rounded hover:bg-slate-700"
                            title="Copy link"
                          >
                            {copiedLegIndex === leg.legIndex ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Route Scout Assistant Toggle */}
        {onToggleScout && (
          <button
            onClick={aiAvailable ? onToggleScout : undefined}
            disabled={!aiAvailable}
            className={`flex items-center gap-1.5 py-1.5 px-3 rounded-xl text-xs font-semibold border transition-all ${
              !aiAvailable
                ? 'bg-slate-850 border-slate-800 text-slate-500 cursor-not-allowed opacity-60'
                : isScoutOpen
                ? 'bg-cyan-950/80 border-cyan-500 text-cyan-300 shadow-sm shadow-cyan-950/50 cursor-pointer'
                : 'bg-slate-800 hover:bg-slate-750 text-slate-300 border-slate-700/80 hover:text-cyan-300 cursor-pointer'
            }`}
            title={
              !aiAvailable
                ? 'Route Scout is unavailable. An active AI engine or API key is required.'
                : isScoutOpen
                ? 'Close Route Scout assistant'
                : 'Open Route Scout assistant'
            }
          >
            <Compass
              className={`w-3.5 h-3.5 ${
                !aiAvailable
                  ? 'text-slate-500'
                  : isScoutOpen
                  ? 'text-cyan-400 animate-pulse'
                  : 'text-cyan-400'
              }`}
            />
            <span>Route Scout</span>
          </button>
        )}

        {/* Quick Save to File */}
        {onSaveTrip && (
          <button
            onClick={onSaveTrip}
            disabled={isSaving}
            className={`flex items-center gap-1.5 py-1.5 px-3 rounded-xl text-xs font-semibold border transition-all cursor-pointer disabled:opacity-50 ${
              saveSuccess
                ? 'bg-emerald-950/80 border-emerald-600 text-emerald-300'
                : isDirty
                ? 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border-amber-500/60 shadow-sm shadow-amber-950/40'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700/80'
            }`}
            title={
              isDirty
                ? 'Unsaved changes! Click to save to route file on disk'
                : 'All changes saved to route file on disk'
            }
          >
            {isSaving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
            ) : saveSuccess ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : isDirty ? (
              <Save className="w-3.5 h-3.5 text-amber-400" />
            ) : (
              <Save className="w-3.5 h-3.5 text-slate-400" />
            )}
            <span>{saveSuccess ? 'Saved!' : isDirty ? 'Save *' : 'Save'}</span>
            {isDirty && !saveSuccess && (
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" title="Unsaved changes" />
            )}
          </button>
        )}

        {/* Primary CTA: Export & Sync */}
        <button
          onClick={onOpenExportModal}
          className="flex items-center gap-1.5 py-1.5 px-3 bg-gradient-to-r from-sky-600 to-indigo-600 hover:from-sky-500 hover:to-indigo-500 text-white rounded-xl text-xs font-semibold shadow-md shadow-sky-950/40 transition-all cursor-pointer"
          title="Export itinerary, 1-Click ADB Push, or QR code handoff"
        >
          <Share2 className="w-3.5 h-3.5" />
          <span>Export &amp; Sync</span>
        </button>
      </div>
    </header>
  );
};
