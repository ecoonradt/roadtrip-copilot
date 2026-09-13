import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { MapCanvas } from './components/MapCanvas';
import { TimelineSidebar } from './components/TimelineSidebar';
import { AppHeader } from './components/AppHeader';
import { DayTabBar } from './components/DayTabBar';
import { RouteSelectorModal } from './components/RouteSelectorModal';
import { ExportModal } from './components/ExportModal';
import { fetchRoute, fetchItinerary, saveItinerary } from './services/api';
import type { Waypoint, RouteResponse, GeocodeResult } from './types/routing';
import {
  calculateTimelineCascade,
  calculateBackwardSchedule,
} from './engine/cascade';
import { generateGoogleMapsUrls } from './engine/googleMapsUrl';
import {
  parseItineraryJson,
  serializeTripToItineraryJson,
  type ParsedTrip,
  type ParsedDay,
} from './engine/itineraryParser';

// Fallback initial route from sample itinerary if offline or initial load
const INITIAL_FALLBACK_TRIP: ParsedTrip = {
  fileName: 'sample_itinerary.json',
  tripName: 'Scenic Southwest: Phoenix to Flagstaff',
  isMultiDay: true,
  dates: { start: '2026-10-09', end: '2026-10-09' },
  days: [
    {
      dayNumber: 1,
      date: '2026-10-09',
      title: 'Red Rock Entry & Oak Creek Canyon Switchbacks',
      departureTime: '14:30:00',
      timezone: 'America/Phoenix',
      origin: 'Phoenix Sky Harbor International Airport (PHX)',
      destination: 'Flagstaff, AZ',
      waypoints: [
        {
          id: 'wp_phx_rental',
          name: 'PHX Rental Car Facility',
          type: 'origin',
          lat: 33.4357,
          lng: -112.0152,
          target_time: '14:30:00',
          dwell_minutes: 0,
          trigger_radius_miles: 0.5,
          notification: {
            title: 'Road Trip Begins!',
            message: 'Departing PHX via I-17 N towards Sedona.',
            speech: 'Welcome to Arizona. We are departing Phoenix heading north on I-17 toward Sedona.',
          },
        },
        {
          id: 'wp_sedona_bell_rock',
          name: 'Sedona Red Rock Vistas (Bell Rock)',
          type: 'scenic_pull_off',
          lat: 34.8010,
          lng: -111.7645,
          target_time: '16:30:00',
          dwell_minutes: 30,
          trigger_radius_miles: 3.0,
          notification: {
            title: 'Approaching Sedona Red Rocks',
            message: 'Target arrival: 4:30 PM. Recommended 30-min stop for red rock vistas.',
            speech: 'Approaching Sedona on Highway 179. Pull-offs for Bell Rock and Courthouse Butte coming up in two miles.',
          },
        },
        {
          id: 'wp_flagstaff_destination',
          name: 'Flagstaff Historic Downtown & Visitor Center',
          type: 'destination',
          lat: 35.1982,
          lng: -111.6465,
          target_time: '18:15:00',
          dwell_minutes: 0,
          trigger_radius_miles: 1.0,
          notification: {
            title: 'Arrival in Flagstaff',
            message: 'Arrived in historic Flagstaff. Explore downtown Route 66 and local dining.',
            speech: 'Arriving in Flagstaff. Welcome to historic Route 66 and the downtown district.',
          },
        },
      ],
    },
  ],
};

export function App() {
  const [trip, setTrip] = useState<ParsedTrip>(INITIAL_FALLBACK_TRIP);
  const [activeDayIndex, setActiveDayIndex] = useState<number>(0);

  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [isLoadingRoute, setIsLoadingRoute] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);

  // Scheduling mode
  const [schedulingMode, setSchedulingMode] = useState<'forward' | 'backward'>('forward');
  const [targetArrivalTime, setTargetArrivalTime] = useState<string>('18:00:00');

  // Modal dialog states
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isRouteSelectorOpen, setIsRouteSelectorOpen] = useState(false);

  // Save states
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Search input ref for programmatic focus from "+ Add Stop"
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Auto-load workspace sample_itinerary.json on initial mount
  useEffect(() => {
    let isSubscribed = true;
    const loadDefaultTrip = async () => {
      try {
        const raw = await fetchItinerary('sample_itinerary.json');
        if (isSubscribed && raw) {
          const parsed = parseItineraryJson(raw, 'sample_itinerary.json');
          setTrip(parsed);
          setActiveDayIndex(0);
        }
      } catch {
        // Fall back to INITIAL_FALLBACK_TRIP
      }
    };

    loadDefaultTrip();

    return () => {
      isSubscribed = false;
    };
  }, []);

  // Current active day data
  const currentDay = useMemo(() => {
    return trip.days[activeDayIndex] || trip.days[0] || {
      dayNumber: 1,
      date: new Date().toISOString().slice(0, 10),
      title: trip.tripName,
      departureTime: '09:00:00',
      waypoints: [],
    };
  }, [trip.days, activeDayIndex]);

  const waypoints = currentDay.waypoints || [];
  const baseDate = currentDay.date;
  const departureTime = currentDay.departureTime || '09:00:00';

  const coordKey = waypoints.map((w) => `${w.lat.toFixed(6)},${w.lng.toFixed(6)}`).join(';');

  // Compute OSRM route whenever coordinate sequence of the active day changes
  useEffect(() => {
    if (waypoints.length < 2) {
      setRoute(null);
      setRouteError(null);
      setIsLoadingRoute(false);
      return;
    }

    let isSubscribed = true;
    const updateRoute = async () => {
      setIsLoadingRoute(true);
      setRouteError(null);
      try {
        const coords = waypoints.map((w) => ({ lat: w.lat, lng: w.lng }));
        const routeData = await fetchRoute(coords);
        if (isSubscribed) {
          setRoute(routeData);
        }
      } catch (err: unknown) {
        if (isSubscribed) {
          const msg = err instanceof Error ? err.message : 'Failed to calculate route';
          setRouteError(msg);
          console.error('Route calculation error:', err);
        }
      } finally {
        if (isSubscribed) {
          setIsLoadingRoute(false);
        }
      }
    };

    updateRoute();

    return () => {
      isSubscribed = false;
    };
  }, [coordKey]);

  // Extract pairwise driving durations and distances from OSRM route
  const { driveDurationsSeconds, driveDistancesMiles } = useMemo(() => {
    if (!route?.legs || route.legs.length === 0) {
      return { driveDurationsSeconds: undefined, driveDistancesMiles: undefined };
    }
    return {
      driveDurationsSeconds: route.legs.map((l) => l.durationSeconds),
      driveDistancesMiles: route.legs.map((l) => l.distanceMiles),
    };
  }, [route]);

  // Compute timeline cascade (forward or backward mode) for current active day
  const { cascadeResult, backwardInfo } = useMemo(() => {
    if (waypoints.length === 0) {
      return {
        cascadeResult: calculateTimelineCascade({
          baseDate,
          departureTime: '09:00:00',
          waypoints: [],
        }),
        backwardInfo: null,
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
      };
    } catch {
      const fallbackResult = calculateTimelineCascade({
        baseDate,
        departureTime: '09:00:00',
        waypoints,
      });
      return {
        cascadeResult: fallbackResult,
        backwardInfo: null,
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

  // Helper to mutate the active day's waypoints
  const updateCurrentDayWaypoints = useCallback((newWaypoints: Waypoint[]) => {
    setTrip((prev) => {
      const nextDays = [...prev.days];
      const current = nextDays[activeDayIndex];
      if (!current) return prev;

      nextDays[activeDayIndex] = {
        ...current,
        waypoints: newWaypoints,
      };
      return { ...prev, days: nextDays };
    });
  }, [activeDayIndex]);

  const handleSelectLocation = useCallback((result: GeocodeResult) => {
    const newWaypoint: Waypoint = {
      id: `wp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: result.displayName.split(',')[0],
      type: 'scenic_pull_off',
      lat: result.lat,
      lng: result.lng,
      dwell_minutes: 15,
      trigger_radius_miles: 2.0,
    };
    updateCurrentDayWaypoints([...waypoints, newWaypoint]);
  }, [updateCurrentDayWaypoints, waypoints]);

  const handleFocusAddStop = useCallback(() => {
    if (searchInputRef.current) {
      searchInputRef.current.focus();
      searchInputRef.current.select();
    }
  }, []);

  const handleMapClick = useCallback((lat: number, lng: number) => {
    const stopNum = waypoints.length + 1;
    const newWaypoint: Waypoint = {
      id: `wp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: `Stop ${stopNum} (${lat.toFixed(3)}, ${lng.toFixed(3)})`,
      type: 'scenic_pull_off',
      lat,
      lng,
      dwell_minutes: 15,
      trigger_radius_miles: 2.0,
    };
    updateCurrentDayWaypoints([...waypoints, newWaypoint]);
  }, [updateCurrentDayWaypoints, waypoints]);

  const handleDeleteWaypoint = useCallback((id: string) => {
    updateCurrentDayWaypoints(waypoints.filter((w) => w.id !== id));
  }, [updateCurrentDayWaypoints, waypoints]);

  const handleUpdateWaypoint = useCallback((id: string, updates: Partial<Waypoint>) => {
    updateCurrentDayWaypoints(
      waypoints.map((w) => (w.id === id ? { ...w, ...updates } : w))
    );
  }, [updateCurrentDayWaypoints, waypoints]);

  const handleMoveWaypoint = useCallback((index: number, direction: 'up' | 'down') => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= waypoints.length) return;
    const next = [...waypoints];
    const temp = next[index];
    next[index] = next[targetIndex];
    next[targetIndex] = temp;
    updateCurrentDayWaypoints(next);
  }, [updateCurrentDayWaypoints, waypoints]);

  const handleResetSample = useCallback(() => {
    updateCurrentDayWaypoints(INITIAL_FALLBACK_TRIP.days[0].waypoints);
  }, [updateCurrentDayWaypoints]);

  const handleClearAll = useCallback(() => {
    updateCurrentDayWaypoints([]);
    setRoute(null);
  }, [updateCurrentDayWaypoints]);

  const handleSetBaseDate = useCallback((newDate: string) => {
    setTrip((prev) => {
      const nextDays = [...prev.days];
      const current = nextDays[activeDayIndex];
      if (!current) return prev;
      nextDays[activeDayIndex] = { ...current, date: newDate };
      return { ...prev, days: nextDays };
    });
  }, [activeDayIndex]);

  const handleSetDepartureTime = useCallback((newTime: string) => {
    setTrip((prev) => {
      const nextDays = [...prev.days];
      const current = nextDays[activeDayIndex];
      if (!current) return prev;
      nextDays[activeDayIndex] = { ...current, departureTime: newTime };
      return { ...prev, days: nextDays };
    });
  }, [activeDayIndex]);

  // Multi-day operations
  const handleSelectDay = (index: number) => {
    setActiveDayIndex(index);
  };

  const handleAddDay = useCallback(() => {
    setTrip((prev) => {
      const lastDay = prev.days[prev.days.length - 1];
      const nextDayNum = prev.days.length + 1;
      let nextDate = new Date().toISOString().slice(0, 10);
      if (lastDay?.date) {
        const d = new Date(lastDay.date);
        d.setDate(d.getDate() + 1);
        nextDate = d.toISOString().slice(0, 10);
      }

      const initialWps: Waypoint[] = [];
      if (lastDay && lastDay.waypoints.length > 0) {
        const prevDest = lastDay.waypoints[lastDay.waypoints.length - 1];
        initialWps.push({
          ...prevDest,
          id: `wp_day${nextDayNum}_origin_${Date.now()}`,
          type: 'origin',
          dwell_minutes: 0,
          target_time: '09:00:00',
        });
      }

      const newDay: ParsedDay = {
        dayNumber: nextDayNum,
        date: nextDate,
        title: `Day ${nextDayNum}`,
        departureTime: '09:00:00',
        timezone: lastDay?.timezone || 'America/Phoenix',
        waypoints: initialWps,
      };

      return {
        ...prev,
        isMultiDay: true,
        days: [...prev.days, newDay],
      };
    });
    setActiveDayIndex(trip.days.length);
  }, [trip.days]);

  const handleDeleteDay = useCallback((index: number) => {
    setTrip((prev) => {
      if (prev.days.length <= 1) return prev;
      const filtered = prev.days.filter((_, i) => i !== index);
      const reindexed = filtered.map((d, i) => ({ ...d, dayNumber: i + 1 }));
      return { ...prev, days: reindexed };
    });
    setActiveDayIndex((prev) => Math.min(prev, Math.max(0, trip.days.length - 2)));
  }, [trip.days.length]);

  const handleSelectTrip = useCallback((newTrip: ParsedTrip) => {
    setTrip(newTrip);
    setActiveDayIndex(0);
    setRoute(null);
  }, []);

  const handleSaveTrip = useCallback(async () => {
    setIsSaving(true);
    try {
      const serialized = serializeTripToItineraryJson(trip);
      const fileName = trip.fileName || `${trip.tripName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.json`;
      await saveItinerary(fileName, serialized);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      alert(`Save error: ${msg}`);
    } finally {
      setIsSaving(false);
    }
  }, [trip]);

  return (
    <div className="flex flex-col w-screen h-screen overflow-hidden bg-slate-950">
      {/* Top Application Header: Branding, Search, Schedule, Telemetry & Export */}
      <AppHeader
        searchRef={searchInputRef}
        onSelectLocation={handleSelectLocation}
        route={route}
        isLoadingRoute={isLoadingRoute}
        routeError={routeError}
        baseDate={baseDate}
        setBaseDate={handleSetBaseDate}
        departureTime={departureTime}
        setDepartureTime={handleSetDepartureTime}
        schedulingMode={schedulingMode}
        setSchedulingMode={setSchedulingMode}
        targetArrivalTime={targetArrivalTime}
        setTargetArrivalTime={setTargetArrivalTime}
        backwardInfo={backwardInfo}
        cascadeResult={cascadeResult}
        googleMapsRoute={googleMapsRoute}
        onOpenExportModal={() => setIsExportModalOpen(true)}
        currentTripName={trip.tripName}
        onOpenRouteSelector={() => setIsRouteSelectorOpen(true)}
        onSaveTrip={handleSaveTrip}
        isSaving={isSaving}
        saveSuccess={saveSuccess}
      />

      {/* Multi-Day Leg Switcher Bar (Visible for multi-day itineraries) */}
      <DayTabBar
        days={trip.days}
        activeDayIndex={activeDayIndex}
        onSelectDay={handleSelectDay}
        onAddDay={handleAddDay}
        onDeleteDay={handleDeleteDay}
      />

      {/* Main App Workspace: Left Waypoints Panel + Right Map Canvas */}
      <div className="flex flex-1 w-full overflow-hidden">
        {/* Resizable Waypoints & Timeline Sidebar */}
        <TimelineSidebar
          waypoints={waypoints}
          cascadeResult={cascadeResult}
          isLoadingRoute={isLoadingRoute}
          onDeleteWaypoint={handleDeleteWaypoint}
          onUpdateWaypoint={handleUpdateWaypoint}
          onMoveWaypoint={handleMoveWaypoint}
          onResetSample={handleResetSample}
          onClearAll={handleClearAll}
          onFocusAddStop={handleFocusAddStop}
        />

        {/* Interactive Map Area */}
        <main className="relative flex-1 h-full overflow-hidden bg-slate-950">
          {/* Subtle Route Warning Banner if Routing Service Failed */}
          {routeError && (
            <div className="absolute top-4 left-4 z-[1000] max-w-md p-3 text-xs bg-rose-950/90 text-rose-200 border border-rose-800/80 rounded-xl shadow-xl backdrop-blur-md">
              <span className="font-bold">Routing Warning: </span>
              {routeError}
            </div>
          )}

          {/* Leaflet Map Canvas */}
          <MapCanvas
            waypoints={waypoints}
            route={route}
            onMapClick={handleMapClick}
            onDeleteWaypoint={handleDeleteWaypoint}
          />
        </main>
      </div>

      {/* Route Selector & Manager Modal */}
      <RouteSelectorModal
        isOpen={isRouteSelectorOpen}
        onClose={() => setIsRouteSelectorOpen(false)}
        onSelectTrip={handleSelectTrip}
        currentFileName={trip.fileName}
      />

      {/* Export & Phone Handoff Modal */}
      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        waypoints={waypoints}
        scheduledStops={cascadeResult.stops}
        tripName={`${trip.tripName}${trip.isMultiDay ? ` - Day ${currentDay.dayNumber}` : ''}`}
        baseDate={baseDate}
        departureTime={departureTime}
        googleMapsRoute={googleMapsRoute}
      />
    </div>
  );
}

export default App;
