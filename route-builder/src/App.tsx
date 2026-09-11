import { useState, useEffect, useCallback } from 'react';
import { MapCanvas } from './components/MapCanvas';
import { TimelineSidebar } from './components/TimelineSidebar';
import { SearchBar } from './components/SearchBar';
import { fetchRoute } from './services/api';
import type { Waypoint, RouteResponse, GeocodeResult } from './types/routing';

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

  // Compute OSRM route whenever waypoints change
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

  const handleMapClick = useCallback((lat: number, lng: number) => {
    const newWaypoint: Waypoint = {
      id: `wp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: `Dropped Pin (${lat.toFixed(4)}, ${lng.toFixed(4)})`,
      type: 'scenic_pull_off',
      lat,
      lng,
      dwell_minutes: 15,
      trigger_radius_miles: 2.0,
    };
    setWaypoints((prev) => [...prev, newWaypoint]);
  }, []);

  const handleDeleteWaypoint = useCallback((id: string) => {
    setWaypoints((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const handleResetSample = useCallback(() => {
    setWaypoints(INITIAL_SAMPLE_WAYPOINTS);
  }, []);

  const handleClearAll = useCallback(() => {
    setWaypoints([]);
    setRoute(null);
  }, []);

  return (
    <div className="flex w-screen h-screen overflow-hidden bg-slate-900">
      {/* Sidebar with Route & Waypoint Management */}
      <TimelineSidebar
        waypoints={waypoints}
        route={route}
        isLoadingRoute={isLoadingRoute}
        onDeleteWaypoint={handleDeleteWaypoint}
        onResetSample={handleResetSample}
        onClearAll={handleClearAll}
      />

      {/* Main Map Canvas Area */}
      <main className="relative flex-1 h-full overflow-hidden bg-slate-950">
        {/* Floating Top Header / Search Bar */}
        <div className="absolute top-4 left-4 z-[1000] flex items-center gap-3">
          <SearchBar onSelectLocation={handleSelectLocation} />
        </div>

        {/* Route Calculation Error Banner */}
        {routeError && (
          <div className="absolute top-20 left-4 z-[1000] max-w-md p-3 text-xs bg-rose-950/90 text-rose-200 border border-rose-800/80 rounded-xl shadow-xl backdrop-blur-md">
            <span className="font-bold">Routing Warning: </span>
            {routeError}
          </div>
        )}

        {/* Interactive Leaflet Map */}
        <MapCanvas
          waypoints={waypoints}
          route={route}
          onMapClick={handleMapClick}
          onDeleteWaypoint={handleDeleteWaypoint}
        />
      </main>
    </div>
  );
}

export default App;
