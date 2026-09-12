import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { MapCanvas } from './components/MapCanvas';
import { TimelineSidebar } from './components/TimelineSidebar';
import { AppHeader } from './components/AppHeader';
import { ExportModal } from './components/ExportModal';
import { fetchRoute } from './services/api';
import type { Waypoint, RouteResponse, GeocodeResult } from './types/routing';
import {
  calculateTimelineCascade,
  calculateBackwardSchedule,
} from './engine/cascade';
import { generateGoogleMapsUrls } from './engine/googleMapsUrl';

// Initial sample route from Day 1 of the PHX -> ABQ trip
const INITIAL_SAMPLE_WAYPOINTS: Waypoint[] = [
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
    id: 'wp_flagstaff_hotel',
    name: 'Little America Hotel Flagstaff',
    type: 'lodging',
    lat: 35.1878,
    lng: -111.6152,
    target_time: '18:15:00',
    dwell_minutes: 0,
    trigger_radius_miles: 0.5,
    notification: {
      title: 'Arrival: Little America Flagstaff',
      message: 'Check-in and evening rest in Flagstaff ponderosa pines.',
      speech: 'We have reached our destination for the night: Little America Hotel in Flagstaff.',
    },
  },
];

export function App() {
  const [waypoints, setWaypoints] = useState<Waypoint[]>(INITIAL_SAMPLE_WAYPOINTS);
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [isLoadingRoute, setIsLoadingRoute] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);

  // Scheduling state
  const [baseDate, setBaseDate] = useState<string>('2026-10-09');
  const [departureTime, setDepartureTime] = useState<string>('14:30:00');
  const [schedulingMode, setSchedulingMode] = useState<'forward' | 'backward'>('forward');
  const [targetArrivalTime, setTargetArrivalTime] = useState<string>('18:00:00');

  // Export Modal state
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);

  // Search input ref for programmatic focus from "+ Add Stop"
  const searchInputRef = useRef<HTMLInputElement>(null);

  const coordKey = waypoints.map((w) => `${w.lat.toFixed(6)},${w.lng.toFixed(6)}`).join(';');

  // Compute OSRM route whenever coordinate sequence changes
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

  // Compute timeline cascade (forward or backward mode)
  const { cascadeResult, backwardInfo } = useMemo(() => {
    if (waypoints.length === 0) {
      return {
        cascadeResult: calculateTimelineCascade({
          baseDate,
          departureTime: '14:30:00',
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
        departureTime: '14:30:00',
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
    setWaypoints((prev) => [...prev, newWaypoint]);
  }, []);

  const handleFocusAddStop = useCallback(() => {
    if (searchInputRef.current) {
      searchInputRef.current.focus();
      searchInputRef.current.select();
    }
  }, []);

  const handleMapClick = useCallback((lat: number, lng: number) => {
    setWaypoints((prev) => {
      const stopNum = prev.length + 1;
      const newWaypoint: Waypoint = {
        id: `wp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        name: `Stop ${stopNum} (${lat.toFixed(3)}, ${lng.toFixed(3)})`,
        type: 'scenic_pull_off',
        lat,
        lng,
        dwell_minutes: 15,
        trigger_radius_miles: 2.0,
      };
      return [...prev, newWaypoint];
    });
  }, []);

  const handleDeleteWaypoint = useCallback((id: string) => {
    setWaypoints((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const handleUpdateWaypoint = useCallback((id: string, updates: Partial<Waypoint>) => {
    setWaypoints((prev) =>
      prev.map((w) => (w.id === id ? { ...w, ...updates } : w))
    );
  }, []);

  const handleMoveWaypoint = useCallback((index: number, direction: 'up' | 'down') => {
    setWaypoints((prev) => {
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= prev.length) return prev;
      const next = [...prev];
      const temp = next[index];
      next[index] = next[targetIndex];
      next[targetIndex] = temp;
      return next;
    });
  }, []);

  const handleResetSample = useCallback(() => {
    setWaypoints(INITIAL_SAMPLE_WAYPOINTS);
  }, []);

  const handleClearAll = useCallback(() => {
    setWaypoints([]);
    setRoute(null);
  }, []);

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
        setBaseDate={setBaseDate}
        departureTime={departureTime}
        setDepartureTime={setDepartureTime}
        schedulingMode={schedulingMode}
        setSchedulingMode={setSchedulingMode}
        targetArrivalTime={targetArrivalTime}
        setTargetArrivalTime={setTargetArrivalTime}
        backwardInfo={backwardInfo}
        cascadeResult={cascadeResult}
        googleMapsRoute={googleMapsRoute}
        onOpenExportModal={() => setIsExportModalOpen(true)}
      />

      {/* Main App Workspace: Left Waypoints Panel + Right Map Canvas */}
      <div className="flex flex-1 w-full h-[calc(100vh-3.5rem)] overflow-hidden">
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
    </div>
  );
}

export default App;
