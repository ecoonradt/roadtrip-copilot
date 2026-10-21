import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ShieldAlert } from 'lucide-react';
import { MapCanvas, type ScoutPreviewPin } from './components/MapCanvas';
import { TimelineSidebar } from './components/TimelineSidebar';
import { AppHeader } from './components/AppHeader';
import { DayTabBar } from './components/DayTabBar';
import { RouteSelectorModal } from './components/RouteSelectorModal';
import { ExportModal } from './components/ExportModal';
import { RouteScoutDrawer } from './components/RouteScoutDrawer';
import { AuthGateScreen } from './components/AuthGateScreen';
import {
  fetchRoute,
  fetchItinerary,
  saveItinerary,
  fetchAiStatus,
  generateDayTitle,
  fetchAuthStatus,
  logoutAuth,
  ApiError,
} from './services/api';
import type { Waypoint, WaypointType, RouteResponse, GeocodeResult } from './types/routing';
import type { AuthStatusResponse } from './types/auth';
import type { ScoutScope, ScoutSuggestion } from './types/scout';
import {
  calculateTimelineCascade,
  calculateBackwardSchedule,
  detectTimezone,
  DEFAULT_TIMEZONE,
} from './engine/cascade';
import { generateGoogleMapsUrls } from './engine/googleMapsUrl';
import type { SchedulingMode, TimelineCascadeResult } from './engine/types';
import {
  parseItineraryJson,
  serializeTripToItineraryJson,
  getDaySchedulingMode,
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

function getInitialRouteInfo(): { file: string; day: number } {
  if (typeof window === 'undefined') return { file: 'sample_itinerary.json', day: 0 };
  const params = new URLSearchParams(window.location.search);
  const routeParam = params.get('route');
  const dayParam = params.get('day');
  const savedRoute = localStorage.getItem('copilot_active_file');
  const savedDay = localStorage.getItem('copilot_active_day');

  const file = routeParam || savedRoute || 'sample_itinerary.json';
  const day = dayParam !== null ? parseInt(dayParam, 10) : savedDay !== null ? parseInt(savedDay, 10) : 0;
  return { file, day: isNaN(day) ? 0 : day };
}

export function App() {
  const [trip, setTrip] = useState<ParsedTrip>(INITIAL_FALLBACK_TRIP);
  const [activeDayIndex, setActiveDayIndex] = useState<number>(() => getInitialRouteInfo().day);
  const [isInitializing, setIsInitializing] = useState<boolean>(true);

  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [routeCoordKey, setRouteCoordKey] = useState('');
  const [tripRevision, setTripRevision] = useState(0);
  const tripRevisionRef = useRef(0);
  const [isLoadingRoute, setIsLoadingRoute] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);

  // Scheduling mode
  const [schedulingMode, setSchedulingMode] = useState<SchedulingMode>('forward');
  const [targetArrivalTime, setTargetArrivalTime] = useState<string>('18:00:00');

  // Modal dialog states
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isRouteSelectorOpen, setIsRouteSelectorOpen] = useState(false);

  // Route Scout conversational assistant states
  const [isScoutOpen, setIsScoutOpen] = useState(false);
  const [scoutScope, setScoutScope] = useState<ScoutScope>({
    type: 'day',
    dayNumber: 1,
    dayTitle: 'Drive Corridor',
  });
  const [scoutPreviewPin, setScoutPreviewPin] = useState<ScoutPreviewPin | null>(null);

  // Selected waypoint synchronization (e.g. clicked on map)
  const [selectedWaypointId, setSelectedWaypointId] = useState<string | null>(null);

  // Save states
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [lastSavedTripJson, setLastSavedTripJson] = useState<string>('');

  // AI availability readiness state
  const [aiAvailable, setAiAvailable] = useState<boolean>(true);
  const aiSeqRef = useRef<number>(0);

  const checkAiAvailability = useCallback(async () => {
    const seq = ++aiSeqRef.current;
    try {
      const status = await fetchAiStatus();
      if (seq === aiSeqRef.current) {
        setAiAvailable(status.available);
      }
    } catch {
      if (seq === aiSeqRef.current) {
        setAiAvailable(false);
      }
    }
  }, []);

  useEffect(() => {
    checkAiAvailability();
  }, [checkAiAvailability]);

  // Authentication state (null while determining initial session status to prevent flashing UI)
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const authSeqRef = useRef(0);
  const authMountedRef = useRef(false);
  const cancelAuthCheckRef = useRef<(() => void) | null>(null);

  const invalidateAuthCheck = useCallback(() => {
    authSeqRef.current += 1;
    cancelAuthCheckRef.current?.();
    cancelAuthCheckRef.current = null;
  }, []);

  const refreshAuthStatus = useCallback(async (): Promise<AuthStatusResponse | null> => {
    if (!authMountedRef.current) return null;
    invalidateAuthCheck();
    const seq = authSeqRef.current;
    const controller = new AbortController();
    setAuthStatus(null);
    setIsConnecting(false);

    const connectingTimer = setTimeout(() => {
      if (seq === authSeqRef.current) setIsConnecting(true);
    }, 750);
    const timeoutError = new Error(
      'The connection to Roadtrip Co-Pilot timed out. Please check your connection and retry.'
    );
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        reject(timeoutError);
        controller.abort();
      }, 15_000);
    });
    const cancelled = new Promise<null>((resolve) => {
      cancelAuthCheckRef.current = () => {
        clearTimeout(connectingTimer);
        clearTimeout(deadlineTimer);
        resolve(null);
        controller.abort();
      };
    });

    try {
      // Race the entire operation, including its body, even if a transport ignores abort.
      const status = await Promise.race([fetchAuthStatus(controller.signal), deadline, cancelled]);
      if (seq !== authSeqRef.current || !status) return null;
      setAuthStatus(status);
      return status;
    } catch (err: unknown) {
      if (seq !== authSeqRef.current) return null;
      const status: AuthStatusResponse = {
        authEnabled: true,
        authenticated: false,
        authorized: false,
        user: null,
        message: err instanceof Error && err === timeoutError
          ? err.message
          : 'Unable to connect to Roadtrip Co-Pilot server. Please check your connection and retry.',
      };
      setAuthStatus(status);
      return status;
    } finally {
      clearTimeout(connectingTimer);
      clearTimeout(deadlineTimer);
      if (seq === authSeqRef.current) {
        cancelAuthCheckRef.current = null;
        setIsConnecting(false);
      }
    }
  }, [invalidateAuthCheck]);

  useEffect(() => {
    authMountedRef.current = true;
    void refreshAuthStatus();
    return () => {
      authMountedRef.current = false;
      invalidateAuthCheck();
    };
  }, [refreshAuthStatus, invalidateAuthCheck]);

  const handleLogout = useCallback(async () => {
    const seq = authSeqRef.current;
    try {
      await logoutAuth();
      if (!authMountedRef.current) return;
      invalidateAuthCheck();
      setIsConnecting(false);
      setAuthStatus({
        authEnabled: true,
        authenticated: false,
        authorized: false,
        user: null,
      });
    } catch (err: unknown) {
      if (!authMountedRef.current || seq !== authSeqRef.current) return;
      const msg = err instanceof Error ? err.message : 'Logout failed';
      setAuthStatus((prev) =>
        prev
          ? {
              ...prev,
              message: `Failed to sign out (${msg}). Please try again.`,
            }
          : null
      );
    }
  }, [invalidateAuthCheck]);

  // Generation counter to guard against superseded loadInitialTrip requests overwriting newer state/edits
  const loadTripSeqRef = useRef<number>(0);

  const invalidatePendingInitialLoad = useCallback(() => {
    loadTripSeqRef.current += 1;
    setIsInitializing(false);
  }, []);

  // Auto-load active itinerary on initial mount (from URL or localStorage, fallback to sample_itinerary.json)
  const loadInitialTrip = useCallback(async () => {
    const seq = ++loadTripSeqRef.current;
    setIsInitializing(true);
    const { file, day } = getInitialRouteInfo();
    try {
      const raw = await fetchItinerary(file);
      if (seq !== loadTripSeqRef.current) return;
      if (raw) {
        const parsed = parseItineraryJson(raw, file);
        setTrip(parsed);
        setLastSavedTripJson(JSON.stringify(parsed));
        const validDay = Math.max(0, Math.min(day, (parsed.days?.length || 1) - 1));
        setActiveDayIndex(validDay);
        setRoute(null);
        setSchedulingMode(getDaySchedulingMode(parsed.days[validDay], parsed.isAdHoc));
        setTargetArrivalTime(parsed.days[validDay].targetArrivalTime || '18:00:00');
        localStorage.setItem('copilot_active_file', file);
        localStorage.setItem('copilot_active_day', String(validDay));
        const url = new URL(window.location.href);
        url.searchParams.set('route', file);
        url.searchParams.set('day', String(validDay));
        window.history.replaceState({}, '', url.toString());
        setIsInitializing(false);
        return;
      }
    } catch {
      if (seq !== loadTripSeqRef.current) return;
      // If specified file fails to load (e.g. was deleted), try fallback sample_itinerary.json
      if (file !== 'sample_itinerary.json') {
        try {
          const fallbackRaw = await fetchItinerary('sample_itinerary.json');
          if (seq !== loadTripSeqRef.current) return;
          if (fallbackRaw) {
            const parsed = parseItineraryJson(fallbackRaw, 'sample_itinerary.json');
            setTrip(parsed);
            setLastSavedTripJson(JSON.stringify(parsed));
            setActiveDayIndex(0);
            setRoute(null);
            setSchedulingMode(getDaySchedulingMode(parsed.days[0], parsed.isAdHoc));
            setTargetArrivalTime(parsed.days[0].targetArrivalTime || '18:00:00');
            localStorage.setItem('copilot_active_file', 'sample_itinerary.json');
            localStorage.setItem('copilot_active_day', '0');
            const url = new URL(window.location.href);
            url.searchParams.set('route', 'sample_itinerary.json');
            url.searchParams.set('day', '0');
            window.history.replaceState({}, '', url.toString());
            setIsInitializing(false);
            return;
          }
        } catch {
          if (seq !== loadTripSeqRef.current) return;
          // Fall back to INITIAL_FALLBACK_TRIP
        }
      }
    }
    if (seq !== loadTripSeqRef.current) return;
    setLastSavedTripJson(JSON.stringify(INITIAL_FALLBACK_TRIP));
    setRoute(null);
    setIsInitializing(false);
  }, []);

  useEffect(() => {
    loadInitialTrip();
  }, [loadInitialTrip]);

  const retryInitialization = useCallback(async () => {
    if (cancelAuthCheckRef.current) return;
    const pendingStatus = refreshAuthStatus();
    const seq = authSeqRef.current;
    const status = await pendingStatus;
    if (seq !== authSeqRef.current || !status) return;
    if (!status.authEnabled || (status.authenticated && status.authorized)) {
      void loadInitialTrip();
      void checkAiAvailability();
    }
  }, [refreshAuthStatus, loadInitialTrip, checkAiAvailability]);

  // Current active day data
  const currentDay = useMemo(() => {
    return trip.days[activeDayIndex] || trip.days[0] || {
      dayNumber: 1,
      date: new Date().toISOString().slice(0, 10),
      title: trip.tripName,
      departureTime: '09:00:00',
      waypoints: [],
    };
  }, [trip.days, activeDayIndex, trip.tripName]);

  const waypoints = currentDay.waypoints || [];
  const baseDate = currentDay.date;
  const departureTime = currentDay.departureTime || '09:00:00';

  // Sync day number and title into Scout scope, or reset to day scope if focused waypoint does not exist on active day
  useEffect(() => {
    if (scoutScope.type === 'day') {
      setScoutScope((prev) => ({
        ...prev,
        dayNumber: currentDay.dayNumber,
        dayTitle: currentDay.title,
      }));
    } else if (scoutScope.type === 'waypoint') {
      const waypointExists = (currentDay.waypoints || []).some(
        (w) => w.id === scoutScope.waypointId
      );
      if (!waypointExists) {
        setScoutScope({
          type: 'day',
          dayNumber: currentDay.dayNumber,
          dayTitle: currentDay.title,
        });
      }
    }
  }, [currentDay.dayNumber, currentDay.title, currentDay.waypoints, scoutScope.type, scoutScope.waypointId]);

  const coordKey = waypoints.map((w) => `${w.lat.toFixed(6)},${w.lng.toFixed(6)}`).join(';');

  // Compute OSRM route whenever coordinate sequence of the active day changes
  useEffect(() => {
    if (isInitializing || waypoints.length < 2) {
      if (!isInitializing) {
        setRoute(null);
        setRouteError(null);
        setIsLoadingRoute(false);
      }
      return;
    }

    const currentDayIdx = activeDayIndex;
    const currentCoordKey = coordKey;
    const requestedRevision = tripRevisionRef.current;
    let isSubscribed = true;

    const updateRoute = async () => {
      setIsLoadingRoute(true);
      setRouteError(null);
      setRoute(null);
      try {
        const coords = waypoints.map((w) => ({ lat: w.lat, lng: w.lng }));
        const routeData = await fetchRoute(coords);
        if (isSubscribed) {
          setRoute(routeData);
          setRouteCoordKey(currentCoordKey);
        }

        // Regardless of active day tab, commit the resolved road cascade to this day's waypoints
        setTrip((prevTrip) => {
          if (requestedRevision !== tripRevisionRef.current) return prevTrip;
          const targetDay = prevTrip.days[currentDayIdx];
          if (!targetDay) return prevTrip;
          const targetCoordKey = (targetDay.waypoints || []).map((w) => `${w.lat.toFixed(6)},${w.lng.toFixed(6)}`).join(';');
          if (targetCoordKey !== currentCoordKey) return prevTrip;

          const durations = routeData.legs?.map((l) => l.durationSeconds);
          const distances = routeData.legs?.map((l) => l.distanceMiles);
          const effectiveMode = getDaySchedulingMode(targetDay, prevTrip.isAdHoc);

          let cascade: TimelineCascadeResult;
          let computedDepartureTime = targetDay.departureTime || '09:00:00';
          let computedDate = targetDay.date;

          if (effectiveMode === 'backward') {
            const targetArrival = targetDay.targetArrivalTime || '18:00:00';
            const backwardRes = calculateBackwardSchedule({
              baseDate: targetDay.date,
              targetArrivalTime: targetArrival.length === 5 ? `${targetArrival}:00` : targetArrival,
              waypoints: targetDay.waypoints,
              driveDurationsSeconds: durations,
              driveDistancesMiles: distances,
            });
            cascade = backwardRes.cascadeResult;
            computedDepartureTime = backwardRes.requiredDepartureTime;
            computedDate = backwardRes.cascadeResult.stops[0]?.localDate || targetDay.date;
          } else {
            const isAdHocDay = effectiveMode === 'adhoc';
            cascade = calculateTimelineCascade({
              baseDate: targetDay.date,
              departureTime: targetDay.departureTime || '09:00:00',
              waypoints: targetDay.waypoints,
              driveDurationsSeconds: durations,
              driveDistancesMiles: distances,
              isAdHoc: isAdHocDay,
            });
          }
          if (cascade.isRouted !== true) return prevTrip;

          const updatedWaypoints = targetDay.waypoints.map((w, idx) => {
            const stop = cascade.stops[idx];
            return {
              ...w,
              target_time: effectiveMode === 'adhoc' ? undefined : (stop?.arrivalTime || w.target_time),
              offset_minutes_from_start: stop?.offsetMinutesFromStart ?? w.offset_minutes_from_start,
              timezone: stop?.timezone || w.timezone,
            };
          });

          const nextDays = [...prevTrip.days];
          nextDays[currentDayIdx] = {
            ...targetDay,
            date: computedDate,
            departureTime: computedDepartureTime,
            waypoints: updatedWaypoints,
          };
          return { ...prevTrip, days: nextDays };
        });
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
  }, [coordKey, isInitializing, activeDayIndex, tripRevision]);

  // Extract pairwise driving durations and distances from OSRM route
  const { driveDurationsSeconds, driveDistancesMiles } = useMemo(() => {
    if (!route?.legs || route.legs.length === 0 || routeCoordKey !== coordKey) {
      return { driveDurationsSeconds: undefined, driveDistancesMiles: undefined };
    }
    return {
      driveDurationsSeconds: route.legs.map((l) => l.durationSeconds),
      driveDistancesMiles: route.legs.map((l) => l.distanceMiles),
    };
  }, [route, routeCoordKey, coordKey]);

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

      const isAdHoc = schedulingMode === 'adhoc';
      const formattedDep = departureTime.length === 5 ? `${departureTime}:00` : departureTime;
      const result = calculateTimelineCascade({
        baseDate,
        departureTime: formattedDep,
        waypoints,
        driveDurationsSeconds,
        driveDistancesMiles,
        isAdHoc,
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
        isAdHoc: schedulingMode === 'adhoc',
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
      waypoints.map((w) => ({
        lat: w.lat,
        lng: w.lng,
        name: w.name,
        placeName: w.place_name,
        address: w.address,
        placeId: w.google_place_id,
        isRouteAnchor: w.is_route_anchor,
        type: w.type,
        dwellMinutes: w.dwell_minutes,
      }))
    );
  }, [waypoints]);

  // Helper to mutate the active day's waypoints
  const updateCurrentDayWaypoints = useCallback((newWaypoints: Waypoint[] | ((prev: Waypoint[]) => Waypoint[])) => {
    invalidatePendingInitialLoad();
    setTrip((prev) => {
      const nextDays = [...prev.days];
      const current = nextDays[activeDayIndex];
      if (!current) return prev;

      const resolved = typeof newWaypoints === 'function' ? newWaypoints(current.waypoints || []) : newWaypoints;
      let invalidFrom = resolved.length;
      resolved.forEach((waypoint, index) => {
        const old = current.waypoints[index];
        if (!old || old.lat !== waypoint.lat || old.lng !== waypoint.lng || old.timezone !== waypoint.timezone) {
          invalidFrom = Math.min(invalidFrom, index);
        } else if (old.dwell_minutes !== waypoint.dwell_minutes) {
          invalidFrom = Math.min(invalidFrom, index + 1);
        }
      });
      const updated = resolved.map((waypoint, index) => index < invalidFrom ? waypoint : {
        ...waypoint, target_time: undefined, offset_minutes_from_start: undefined,
      });
      const originTz = resolved[0]?.lat !== undefined && resolved[0]?.lng !== undefined
        ? (resolved[0].timezone || detectTimezone(resolved[0].lat, resolved[0].lng, current.timezone || DEFAULT_TIMEZONE))
        : current.timezone;

      nextDays[activeDayIndex] = {
        ...current,
        timezone: originTz || current.timezone || DEFAULT_TIMEZONE,
        waypoints: updated,
      };
      return { ...prev, days: nextDays };
    });
  }, [activeDayIndex]);

  const handleSelectLocation = useCallback((result: GeocodeResult) => {
    const isFirstStop = waypoints.length === 0;
    const resolvedType: WaypointType = isFirstStop ? 'origin' : (result.category || 'scenic_pull_off');
    const defaultDwell = isFirstStop ? 0 : (resolvedType === 'meal' ? 45 : resolvedType === 'lodging' ? 0 : 15);

    const newWaypoint: Waypoint = {
      id: `wp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: result.name || result.displayName.split(',')[0].trim(),
      type: resolvedType,
      lat: result.lat,
      lng: result.lng,
      timezone: detectTimezone(result.lat, result.lng, currentDay.timezone || DEFAULT_TIMEZONE),
      dwell_minutes: defaultDwell,
      trigger_radius_miles: 2.0,
      ...(result.placeName ? { place_name: result.placeName } : {}),
      ...(result.address ? { address: result.address } : {}),
    };
    updateCurrentDayWaypoints([...waypoints, newWaypoint]);
  }, [updateCurrentDayWaypoints, waypoints, currentDay.timezone]);

  const handleMapClick = useCallback((lat: number, lng: number) => {
    const isFirstStop = waypoints.length === 0;
    const stopNum = waypoints.length + 1;
    const newWaypoint: Waypoint = {
      id: `wp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: isFirstStop ? 'Origin' : `Stop ${stopNum} (${lat.toFixed(3)}, ${lng.toFixed(3)})`,
      type: isFirstStop ? 'origin' : 'scenic_pull_off',
      lat,
      lng,
      timezone: detectTimezone(lat, lng, currentDay.timezone || DEFAULT_TIMEZONE),
      dwell_minutes: isFirstStop ? 0 : 15,
      trigger_radius_miles: 2.0,
    };
    updateCurrentDayWaypoints([...waypoints, newWaypoint]);
  }, [updateCurrentDayWaypoints, waypoints, currentDay.timezone]);

  const handleDeleteWaypoint = useCallback((id: string) => {
    updateCurrentDayWaypoints(waypoints.filter((w) => w.id !== id));
  }, [updateCurrentDayWaypoints, waypoints]);

  const handleUpdateWaypoint = useCallback((id: string, updates: Partial<Waypoint>) => {
    updateCurrentDayWaypoints((prevWaypoints) =>
      prevWaypoints.map((w) => {
        if (w.id !== id) return w;
        const updated = { ...w, ...updates };
        if (
          (updates.lat !== undefined || updates.lng !== undefined) &&
          updates.timezone === undefined
        ) {
          updated.timezone = detectTimezone(updated.lat, updated.lng, updated.timezone || currentDay.timezone || DEFAULT_TIMEZONE);
        }
        return updated;
      })
    );
    if (updates.id && updates.id !== id) {
      if (selectedWaypointId === id) {
        setSelectedWaypointId(updates.id);
      }
    }
    if (updates.id || updates.name) {
      setScoutScope((prev) => {
        if (prev.type === 'waypoint' && prev.waypointId === id) {
          return {
            ...prev,
            ...(updates.id ? { waypointId: updates.id } : {}),
            ...(updates.name ? { waypointName: updates.name } : {}),
          };
        }
        return prev;
      });
    }
  }, [updateCurrentDayWaypoints, selectedWaypointId, currentDay.timezone]);

  const handleBatchUpdateWaypoints = useCallback((updatesMap: Record<string, Partial<Waypoint>>) => {
    updateCurrentDayWaypoints((prevWaypoints) =>
      prevWaypoints.map((w) => (updatesMap[w.id] ? { ...w, ...updatesMap[w.id] } : w))
    );
  }, [updateCurrentDayWaypoints]);

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

  // Route Scout interaction handlers
  const handleOpenScoutForDay = useCallback(() => {
    setScoutScope({
      type: 'day',
      dayNumber: currentDay.dayNumber,
      dayTitle: currentDay.title,
    });
    setIsScoutOpen(true);
  }, [currentDay.dayNumber, currentDay.title]);

  const handleOpenScoutForWaypoint = useCallback((wp: Waypoint) => {
    setScoutScope({
      type: 'waypoint',
      waypointId: wp.id,
      waypointName: wp.name,
    });
    setIsScoutOpen(true);
  }, []);

  const handleToggleScout = useCallback(() => {
    const willOpen = !isScoutOpen;
    setIsScoutOpen(willOpen);
    if (willOpen && scoutScope.type === 'waypoint') {
      const waypointExists = (currentDay.waypoints || []).some(
        (w) => w.id === scoutScope.waypointId
      );
      if (!waypointExists) {
        setScoutScope({
          type: 'day',
          dayNumber: currentDay.dayNumber,
          dayTitle: currentDay.title,
        });
      }
    }
  }, [isScoutOpen, currentDay.dayNumber, currentDay.title, currentDay.waypoints, scoutScope.type, scoutScope.waypointId]);

  const handleAddWaypointFromScout = useCallback(
    (suggestion: ScoutSuggestion) => {
      const newWp: Waypoint = {
        id: suggestion.newId || `wp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        name: suggestion.name,
        type: (suggestion.type as WaypointType) || 'scenic_pull_off',
        lat: suggestion.lat,
        lng: suggestion.lng,
        timezone: detectTimezone(suggestion.lat, suggestion.lng, currentDay.timezone || DEFAULT_TIMEZONE),
        dwell_minutes: suggestion.dwell_minutes ?? 15,
        trigger_radius_miles: suggestion.trigger_radius_miles ?? 1.5,
        target_time: '12:00:00',
        notes: suggestion.reason,
        place_name: suggestion.place_name,
        address: suggestion.address,
        google_place_id: suggestion.google_place_id,
        is_route_anchor: suggestion.is_route_anchor,
        notification: suggestion.notification,
      };

      const updated = [...waypoints];
      if (suggestion.insertAfterWaypointId) {
        const insertIdx = updated.findIndex(
          (w) => w.id === suggestion.insertAfterWaypointId
        );
        if (insertIdx !== -1) {
          updated.splice(insertIdx + 1, 0, newWp);
        } else if (
          updated.length > 1 &&
          updated[updated.length - 1].type === 'destination'
        ) {
          updated.splice(updated.length - 1, 0, newWp);
        } else {
          updated.push(newWp);
        }
      } else {
        if (
          updated.length > 1 &&
          updated[updated.length - 1].type === 'destination'
        ) {
          updated.splice(updated.length - 1, 0, newWp);
        } else {
          updated.push(newWp);
        }
      }

      updateCurrentDayWaypoints(updated);

      // Clear preview pin if it matches this suggestion
      setScoutPreviewPin((prev) => {
        if (
          prev &&
          Math.abs(prev.lat - suggestion.lat) < 0.0001 &&
          Math.abs(prev.lng - suggestion.lng) < 0.0001
        ) {
          return null;
        }
        return prev;
      });
    },
    [updateCurrentDayWaypoints, waypoints, currentDay.timezone]
  );

  const handleRenameTrip = useCallback((name: string) => {
    invalidatePendingInitialLoad();
    const trimmed = name.trim();
    if (!trimmed) return;
    setTrip((prev) => (prev.tripName === trimmed ? prev : { ...prev, tripName: trimmed }));
  }, [invalidatePendingInitialLoad]);

  const handleRenameDay = useCallback((index: number, title: string) => {
    invalidatePendingInitialLoad();
    const trimmed = title.trim();
    setTrip((prev) => {
      const current = prev.days[index];
      if (!current || current.title === trimmed) return prev;
      const nextDays = [...prev.days];
      nextDays[index] = { ...current, title: trimmed || `Day ${current.dayNumber}` };
      return { ...prev, days: nextDays };
    });
  }, [invalidatePendingInitialLoad]);

  const handleSuggestDayTitle = useCallback(async (index: number) => {
    const day = trip.days[index];
    if (!day || day.waypoints.length === 0) return;
    const { title } = await generateDayTitle(
      day.dayNumber,
      day.waypoints.map((w) => ({ name: w.name, type: w.type }))
    );
    handleRenameDay(index, title);
  }, [trip.days, handleRenameDay]);

  const handleSetBaseDate = useCallback((newDate: string) => {
    invalidatePendingInitialLoad();
    setTrip((prev) => {
      const nextDays = [...prev.days];
      const current = nextDays[activeDayIndex];
      if (!current) return prev;
      nextDays[activeDayIndex] = { ...current, date: newDate, waypoints: current.waypoints.map((w) => ({ ...w, target_time: undefined, offset_minutes_from_start: undefined })) };
      return { ...prev, days: nextDays };
    });
  }, [activeDayIndex, invalidatePendingInitialLoad]);

  const handleSetDepartureTime = useCallback((newTime: string) => {
    invalidatePendingInitialLoad();
    setTrip((prev) => {
      const nextDays = [...prev.days];
      const current = nextDays[activeDayIndex];
      if (!current) return prev;
      nextDays[activeDayIndex] = { ...current, departureTime: newTime, waypoints: current.waypoints.map((w) => ({ ...w, target_time: undefined, offset_minutes_from_start: undefined })) };
      return { ...prev, days: nextDays };
    });
  }, [activeDayIndex, invalidatePendingInitialLoad]);

  const handleSetSchedulingMode = useCallback((mode: SchedulingMode) => {
    invalidatePendingInitialLoad();
    setSchedulingMode(mode);
    setTrip((prev) => {
      const nextDays = prev.days.map((d, idx) =>
        idx === activeDayIndex ? {
          ...d, schedulingMode: mode, isAdHoc: mode === 'adhoc',
          waypoints: getDaySchedulingMode(d, prev.isAdHoc) === mode ? d.waypoints : d.waypoints.map((w) => ({
            ...w, target_time: undefined,
            offset_minutes_from_start: mode === 'adhoc' ? w.offset_minutes_from_start : undefined,
          })),
        } : d
      );
      return {
        ...prev,
        isAdHoc: !prev.isMultiDay && mode === 'adhoc',
        days: nextDays,
      };
    });
  }, [activeDayIndex, invalidatePendingInitialLoad]);

  const handleSetTargetArrivalTime = useCallback((newTime: string) => {
    invalidatePendingInitialLoad();
    setTargetArrivalTime(newTime);
    setTrip((prev) => {
      const nextDays = [...prev.days];
      const current = nextDays[activeDayIndex];
      if (!current) return prev;
      nextDays[activeDayIndex] = {
        ...current, targetArrivalTime: newTime,
        waypoints: getDaySchedulingMode(current, prev.isAdHoc) === 'backward'
          ? current.waypoints.map((w) => ({ ...w, target_time: undefined, offset_minutes_from_start: undefined }))
          : current.waypoints,
      };
      return { ...prev, days: nextDays };
    });
  }, [activeDayIndex]);

  // Helper to snapshot active day's live cascade and schedule into trip model
  const getSynchronizedTrip = useCallback((sourceTrip: ParsedTrip = trip): ParsedTrip => {
    const isAdHoc = schedulingMode === 'adhoc';
    const computedDepartureTime = backwardInfo?.requiredDepartureTime || (departureTime.length === 5 ? `${departureTime}:00` : departureTime);
    const computedBaseDate = backwardInfo ? (cascadeResult?.stops[0]?.localDate || baseDate) : baseDate;
    const isRouteReady = waypoints.length <= 1 || (cascadeResult?.isRouted === true && !routeError && !isLoadingRoute);

    const updatedDays = sourceTrip.days.map((d, dIdx) => {
      if (dIdx === activeDayIndex && cascadeResult?.stops?.length === d.waypoints.length) {
        const originTz = cascadeResult.stops[0]?.timezone || d.waypoints[0]?.timezone || d.timezone;
        return {
          ...d,
          date: isRouteReady ? computedBaseDate : d.date,
          departureTime: isRouteReady ? computedDepartureTime : d.departureTime,
          timezone: originTz || d.timezone || DEFAULT_TIMEZONE,
          isAdHoc,
          schedulingMode,
          targetArrivalTime: schedulingMode === 'backward' ? targetArrivalTime : d.targetArrivalTime,
          waypoints: d.waypoints.map((w, wIdx) => {
            const stop = cascadeResult.stops[wIdx];
            const targetTime = isAdHoc
              ? undefined
              : (!isRouteReady ? w.target_time : (stop?.arrivalTime || w.target_time));
            const offsetMin = (!isRouteReady ? w.offset_minutes_from_start : (stop?.offsetMinutesFromStart ?? w.offset_minutes_from_start));

            return {
              ...w,
              target_time: targetTime,
              offset_minutes_from_start: offsetMin,
              timezone: stop?.timezone || w.timezone,
            };
          }),
        };
      }
      return d;
    });

    return { ...sourceTrip, days: updatedDays, isAdHoc: !sourceTrip.isMultiDay && isAdHoc };
  }, [trip, activeDayIndex, cascadeResult, schedulingMode, targetArrivalTime, backwardInfo, departureTime, baseDate, isLoadingRoute, routeError, waypoints.length]);

  // Multi-day operations
  const handleSelectDay = useCallback((index: number) => {
    if (index === activeDayIndex) return;

    // Snapshot the active day's live cascade and schedule before switching tabs
    const synchronized = getSynchronizedTrip();
    setTrip(synchronized);

    setActiveDayIndex(index);
    setRoute(null);
    const targetDay = synchronized.days[index];
    if (targetDay) {
      setSchedulingMode(getDaySchedulingMode(targetDay, synchronized.isAdHoc));
      setTargetArrivalTime(targetDay.targetArrivalTime || '18:00:00');
      setScoutScope({
        type: 'day',
        dayNumber: targetDay.dayNumber,
        dayTitle: targetDay.title,
      });
    }
    localStorage.setItem('copilot_active_day', String(index));
    const url = new URL(window.location.href);
    url.searchParams.set('day', String(index));
    const fileName = synchronized.fileName || localStorage.getItem('copilot_active_file');
    if (fileName) {
      url.searchParams.set('route', fileName);
    }
    window.history.replaceState({}, '', url.toString());
  }, [activeDayIndex, getSynchronizedTrip]);

  const handleAddDay = useCallback(() => {
    invalidatePendingInitialLoad();
    // Snapshot the active day's live cascade and schedule before adding a new day
    const synchronized = getSynchronizedTrip();

    const lastDay = synchronized.days[synchronized.days.length - 1];
    const nextDayNum = synchronized.days.length + 1;
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
      timezone: lastDay?.timezone || DEFAULT_TIMEZONE,
      schedulingMode: 'forward',
      isAdHoc: false,
      waypoints: initialWps,
    };

    const nextTrip: ParsedTrip = {
      ...synchronized,
      isMultiDay: true,
      isAdHoc: false,
      days: [...synchronized.days, newDay],
    };

    setTrip(nextTrip);
    const nextIdx = synchronized.days.length;
    setActiveDayIndex(nextIdx);
    setSchedulingMode('forward');
    setTargetArrivalTime('18:00:00');
    setRoute(null);
    setScoutScope({
      type: 'day',
      dayNumber: nextDayNum,
      dayTitle: `Day ${nextDayNum}`,
    });
    localStorage.setItem('copilot_active_day', String(nextIdx));
    const url = new URL(window.location.href);
    url.searchParams.set('day', String(nextIdx));
    const fileName = synchronized.fileName || localStorage.getItem('copilot_active_file');
    if (fileName) {
      url.searchParams.set('route', fileName);
    }
    window.history.replaceState({}, '', url.toString());
  }, [getSynchronizedTrip, invalidatePendingInitialLoad]);

  const handleDeleteDay = useCallback((index: number) => {
    if (trip.days.length <= 1) return;
    invalidatePendingInitialLoad();
    const synchronized = getSynchronizedTrip();
    const days = synchronized.days.filter((_, i) => i !== index).map((d, i) => ({ ...d, dayNumber: i + 1 }));
    const nextIdx = index < activeDayIndex
      ? activeDayIndex - 1
      : Math.min(activeDayIndex, trip.days.length - 2);
    setTrip({ ...synchronized, days });
    setActiveDayIndex(nextIdx);
    setSchedulingMode(getDaySchedulingMode(days[nextIdx], synchronized.isAdHoc));
    setTargetArrivalTime(days[nextIdx].targetArrivalTime || '18:00:00');
    localStorage.setItem('copilot_active_day', String(nextIdx));
    const url = new URL(window.location.href);
    url.searchParams.set('day', String(nextIdx));
    const fileName = trip.fileName || localStorage.getItem('copilot_active_file');
    if (fileName) {
      url.searchParams.set('route', fileName);
    }
    window.history.replaceState({}, '', url.toString());
  }, [activeDayIndex, trip.days.length, trip.fileName, getSynchronizedTrip, invalidatePendingInitialLoad]);

  const handleSelectTrip = useCallback((newTrip: ParsedTrip) => {
    invalidatePendingInitialLoad();
    tripRevisionRef.current += 1;
    setTripRevision(tripRevisionRef.current);
    setTrip(newTrip);
    setLastSavedTripJson(JSON.stringify(newTrip));
    setActiveDayIndex(0);
    setRoute(null);
    setSchedulingMode(newTrip.days[0] ? getDaySchedulingMode(newTrip.days[0], newTrip.isAdHoc) : 'forward');
    setTargetArrivalTime(newTrip.days[0]?.targetArrivalTime || '18:00:00');
    const fileName = newTrip.fileName || `${newTrip.tripName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.json`;
    localStorage.setItem('copilot_active_file', fileName);
    localStorage.setItem('copilot_active_day', '0');
    const url = new URL(window.location.href);
    url.searchParams.set('route', fileName);
    url.searchParams.set('day', '0');
    window.history.replaceState({}, '', url.toString());
  }, [invalidatePendingInitialLoad]);

  const handleDeleteTrip = useCallback(
    async (deletedFile: string) => {
      const activeFile = trip.fileName || localStorage.getItem('copilot_active_file');
      if (activeFile === deletedFile) {
        try {
          const fallbackRaw = await fetchItinerary('sample_itinerary.json');
          const parsed = parseItineraryJson(fallbackRaw, 'sample_itinerary.json');
          handleSelectTrip(parsed);
        } catch {
          handleSelectTrip(INITIAL_FALLBACK_TRIP);
        }
      }
    },
    [trip.fileName, handleSelectTrip]
  );

  const handleSaveTrip = useCallback(async () => {
    setIsSaving(true);
    const savedRevision = tripRevisionRef.current;
    try {
      const updatedTrip = getSynchronizedTrip();
      const serialized = serializeTripToItineraryJson(updatedTrip, { preserveTargetTimes: true });
      const fileName = updatedTrip.fileName || `${updatedTrip.tripName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.json`;
      const saveRes = await saveItinerary(fileName, serialized, { ifMatch: updatedTrip.etag });
      const snapshot = { ...updatedTrip, fileName, etag: saveRes.etag || updatedTrip.etag };
      setTrip(snapshot);
      if (savedRevision !== tripRevisionRef.current) return;
      setLastSavedTripJson(JSON.stringify(snapshot));
      setSaveSuccess(true);
      localStorage.setItem('copilot_active_file', fileName);
      const url = new URL(window.location.href);
      url.searchParams.set('route', fileName);
      window.history.replaceState({}, '', url.toString());
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (err: unknown) {
      const isConflict =
        (err instanceof ApiError && err.status === 412) ||
        (Boolean(err) && typeof err === 'object' && (err as { status?: number }).status === 412);
      const msg = err instanceof Error ? err.message : 'Save failed';
      if (isConflict || msg.includes('412') || msg.toLowerCase().includes('precondition')) {
        alert('Conflict detected: This itinerary has been modified elsewhere. Please reload the itinerary or save under a new name to avoid overwriting changes.');
      } else {
        alert(`Save error: ${msg}`);
      }
    } finally {
      setIsSaving(false);
    }
  }, [getSynchronizedTrip]);

  // Dirty state tracking (indicates unsaved changes)
  const isDirty = useMemo(() => {
    if (!lastSavedTripJson) return false;
    try {
      const parsedSaved = JSON.parse(lastSavedTripJson) as ParsedTrip;
      const savedDay = parsedSaved.days[activeDayIndex];
      const savedMode = savedDay ? getDaySchedulingMode(savedDay, parsedSaved.isAdHoc) : 'forward';
      if (schedulingMode !== savedMode) return true;
    } catch {
      // ignore
    }
    return JSON.stringify(trip) !== lastSavedTripJson;
  }, [trip, lastSavedTripJson, schedulingMode, activeDayIndex]);

  // Warn user before closing/refreshing tab with unsaved changes
  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  // Render solid dark automotive blue background while session status is determining to prevent UI flash
  if (!authStatus) {
    return (
      <div className="min-h-screen w-screen bg-slate-950 flex items-center justify-center">
        {isConnecting && (
          <p role="status" className="text-sm text-slate-400">
            Connecting to Roadtrip Co-Pilot…
          </p>
        )}
      </div>
    );
  }

  if (authStatus.authEnabled && (!authStatus.authenticated || !authStatus.authorized)) {
    return (
      <AuthGateScreen
        status={authStatus}
        onLogout={handleLogout}
        onRetry={retryInitialization}
      />
    );
  }

  return (
    <div className="flex flex-col w-screen h-screen overflow-hidden bg-slate-950">
      {authStatus.message && (
        <div
          role="alert"
          className="bg-red-950/90 border-b border-red-700/80 px-4 py-2 text-xs text-red-200 flex items-center justify-between shrink-0"
        >
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-red-400 shrink-0" />
            <span>{authStatus.message}</span>
          </div>
          <button
            type="button"
            onClick={() =>
              setAuthStatus((prev) => (prev ? { ...prev, message: undefined } : null))
            }
            className="text-red-400 hover:text-red-200 text-xs font-semibold ml-4 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}
      {/* Top Application Header: Branding, Search, Schedule, Telemetry & Export */}
      <AppHeader
        route={route}
        isLoadingRoute={isLoadingRoute}
        routeError={routeError}
        baseDate={baseDate}
        setBaseDate={handleSetBaseDate}
        departureTime={departureTime}
        setDepartureTime={handleSetDepartureTime}
        schedulingMode={schedulingMode}
        setSchedulingMode={handleSetSchedulingMode}
        targetArrivalTime={targetArrivalTime}
        setTargetArrivalTime={handleSetTargetArrivalTime}
        backwardInfo={backwardInfo}
        cascadeResult={cascadeResult}
        googleMapsRoute={googleMapsRoute}
        onOpenExportModal={() => setIsExportModalOpen(true)}
        currentTripName={trip.tripName}
        onRenameTrip={handleRenameTrip}
        onOpenRouteSelector={() => setIsRouteSelectorOpen(true)}
        onSaveTrip={handleSaveTrip}
        isSaving={isSaving}
        saveSuccess={saveSuccess}
        isDirty={isDirty}
        onToggleScout={handleToggleScout}
        isScoutOpen={isScoutOpen}
        aiAvailable={aiAvailable}
        authEnabled={authStatus.authEnabled}
        authUser={authStatus.user}
        onLogout={handleLogout}
      />

      {/* Multi-Day Leg Switcher Bar (Visible for multi-day itineraries) */}
      <DayTabBar
        days={trip.days}
        activeDayIndex={activeDayIndex}
        onSelectDay={handleSelectDay}
        onAddDay={handleAddDay}
        onDeleteDay={handleDeleteDay}
        onRenameDay={handleRenameDay}
        onSuggestDayTitle={handleSuggestDayTitle}
        aiAvailable={aiAvailable}
      />

      {/* Main App Workspace: Left Waypoints Panel + Middle Map Canvas + Right Route Scout */}
      <div className="flex flex-1 w-full overflow-hidden">
        {/* Resizable Waypoints & Timeline Sidebar */}
        <TimelineSidebar
          waypoints={waypoints}
          cascadeResult={cascadeResult}
          isLoadingRoute={isLoadingRoute}
          onDeleteWaypoint={handleDeleteWaypoint}
          onUpdateWaypoint={handleUpdateWaypoint}
          onBatchUpdateWaypoints={handleBatchUpdateWaypoints}
          onMoveWaypoint={handleMoveWaypoint}
          onResetSample={handleResetSample}
          onClearAll={handleClearAll}
          onSelectLocation={handleSelectLocation}
          onOpenScoutForDay={handleOpenScoutForDay}
          onOpenScoutForWaypoint={handleOpenScoutForWaypoint}
          selectedWaypointId={selectedWaypointId}
          onSelectWaypoint={setSelectedWaypointId}
          aiAvailable={aiAvailable}
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
            activeDayIndex={activeDayIndex}
            isInitializing={isInitializing}
            onMapClick={handleMapClick}
            onDeleteWaypoint={handleDeleteWaypoint}
            onSelectWaypoint={(id) => setSelectedWaypointId(id)}
            onOpenScoutForWaypoint={handleOpenScoutForWaypoint}
            scoutPreviewPin={scoutPreviewPin}
            onClearScoutPreviewPin={() => setScoutPreviewPin(null)}
            isScoutOpen={isScoutOpen}
            aiAvailable={aiAvailable}
          />
        </main>

        {/* Route Scout AI Assistant Drawer */}
        <RouteScoutDrawer
          isOpen={isScoutOpen}
          onClose={() => setIsScoutOpen(false)}
          trip={trip}
          activeDayIndex={activeDayIndex}
          activeDay={currentDay}
          waypoints={waypoints}
          scheduledStops={cascadeResult.stops}
          scope={scoutScope}
          onChangeScope={setScoutScope}
          onAddWaypoint={handleAddWaypointFromScout}
          onUpdateWaypoint={handleUpdateWaypoint}
          onPreviewCoordinate={setScoutPreviewPin}
          activePreviewPin={scoutPreviewPin}
          aiAvailable={aiAvailable}
        />
      </div>

      {/* Route Selector & Manager Modal */}
      <RouteSelectorModal
        isOpen={isRouteSelectorOpen}
        onClose={() => setIsRouteSelectorOpen(false)}
        onSelectTrip={handleSelectTrip}
        currentFileName={trip.fileName}
        onDeleteTrip={handleDeleteTrip}
      />

      {/* Export & Phone Handoff Modal */}
      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        trip={getSynchronizedTrip()}
        activeDayIndex={activeDayIndex}
        activeDayCascade={cascadeResult}
        waypoints={waypoints}
        scheduledStops={cascadeResult.stops}
        tripName={trip.tripName}
        baseDate={baseDate}
        departureTime={departureTime}
        googleMapsRoute={googleMapsRoute}
        isAdHoc={schedulingMode === 'adhoc'}
        fileName={trip.fileName}
      />
    </div>
  );
}

export default App;
