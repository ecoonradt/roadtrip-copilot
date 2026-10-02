import React, { useEffect, useMemo, useRef } from 'react';
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import L from 'leaflet';
import { X, Compass, Trash2, Maximize2 } from 'lucide-react';
import type { Waypoint, RouteResponse } from '../types/routing';

export interface ScoutPreviewPin {
  lat: number;
  lng: number;
  name: string;
}

export interface MapCanvasProps {
  waypoints: Waypoint[];
  route: RouteResponse | null;
  activeDayIndex?: number;
  isInitializing?: boolean;
  onMapClick?: (lat: number, lng: number) => void;
  onDeleteWaypoint?: (id: string) => void;
  onSelectWaypoint?: (id: string) => void;
  onOpenScoutForWaypoint?: (waypoint: Waypoint) => void;
  scoutPreviewPin?: ScoutPreviewPin | null;
  onClearScoutPreviewPin?: () => void;
  isScoutOpen?: boolean;
  aiAvailable?: boolean;
}

// Custom DivIcon generator with sequence number and type color
function createWaypointIcon(sequenceNumber: number, type: string): L.DivIcon {
  return L.divIcon({
    className: 'custom-waypoint-marker-wrapper',
    html: `<div class="custom-waypoint-pin pin-${type}"><span>${sequenceNumber}</span></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });
}

// Scout preview animated marker icon
function createScoutPreviewIcon(): L.DivIcon {
  return L.divIcon({
    className: 'custom-scout-preview-marker-wrapper',
    html: `<div class="scout-preview-pin"><span>★</span></div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16],
  });
}

// Camera fly-to controller when a Scout preview coordinate is selected
const ScoutPreviewFlyTo: React.FC<{
  previewPin?: ScoutPreviewPin | null;
}> = ({ previewPin }) => {
  const map = useMap();
  useEffect(() => {
    if (previewPin) {
      map.flyTo([previewPin.lat, previewPin.lng], 13, { duration: 1.2 });
    }
  }, [map, previewPin]);
  return null;
};

// Map container resize listener ensuring Leaflet dimensions synchronize dynamically
const MapResizeHandler: React.FC<{ isScoutOpen?: boolean }> = ({ isScoutOpen }) => {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    if (!container) return;

    const ro = new ResizeObserver(() => {
      map.invalidateSize({ pan: false });
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
    };
  }, [map]);

  useEffect(() => {
    // Invalidate size immediately and after layout settles when Route Scout opens or closes
    map.invalidateSize({ pan: false });
    const timer = setTimeout(() => {
      map.invalidateSize({ pan: false });
    }, 150);
    return () => clearTimeout(timer);
  }, [map, isScoutOpen]);

  return null;
};

// Auto-adjust map viewport to contain all waypoints and route path (signature-gated to preserve zoom on save)
const MapViewportManager: React.FC<{
  waypoints: Waypoint[];
  routeCoordinates: [number, number][];
  activeDayIndex?: number;
  isInitializing?: boolean;
  isScoutOpen?: boolean;
}> = ({
  waypoints,
  routeCoordinates,
  activeDayIndex = 0,
  isInitializing = false,
  isScoutOpen = false,
}) => {
  const map = useMap();
  const lastSignatureRef = useRef<string>('');
  const prevIsScoutOpenRef = useRef<boolean>(isScoutOpen);

  useEffect(() => {
    if (isInitializing || waypoints.length === 0) {
      return;
    }

    // Detect if Route Scout just opened (transition from false to true)
    const scoutJustOpened = !prevIsScoutOpenRef.current && isScoutOpen;
    prevIsScoutOpenRef.current = isScoutOpen;

    // Generate a spatial signature based on active day, waypoint coordinates, and route geometry
    const coordsSignature = waypoints
      .map((w) => `${w.lat.toFixed(5)},${w.lng.toFixed(5)}`)
      .join(';');

    const routeSignature =
      routeCoordinates.length > 0
        ? `${routeCoordinates.length}:${routeCoordinates[0][0].toFixed(3)},${routeCoordinates[0][1].toFixed(3)}->${routeCoordinates[routeCoordinates.length - 1][0].toFixed(3)},${routeCoordinates[routeCoordinates.length - 1][1].toFixed(3)}`
        : 'none';

    const currentSignature = `day:${activeDayIndex}|coords:${coordsSignature}|route:${routeSignature}`;

    // Preserve user zoom and pan if the day, route geometry, and coordinates have not changed,
    // UNLESS Route Scout just opened (in which case the map must re-center to fit the resized viewport).
    if (currentSignature === lastSignatureRef.current && !scoutJustOpened) {
      return;
    }

    lastSignatureRef.current = currentSignature;

    const performFit = () => {
      map.invalidateSize({ pan: false });
      if (routeCoordinates.length > 0) {
        const bounds = L.latLngBounds(routeCoordinates);
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
      } else {
        const bounds = L.latLngBounds(waypoints.map((w) => [w.lat, w.lng]));
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
      }
    };

    if (scoutJustOpened) {
      // Re-center immediately and after layout settles when the right drawer opens
      performFit();
      const timer = setTimeout(performFit, 160);
      return () => clearTimeout(timer);
    } else {
      performFit();
    }
  }, [map, waypoints, routeCoordinates, activeDayIndex, isInitializing, isScoutOpen]);

  return null;
};

// 1-Click floating "Fit Route" control to re-frame the trip at any time
const FitRouteButton: React.FC<{
  waypoints: Waypoint[];
  routeCoordinates: [number, number][];
}> = ({ waypoints, routeCoordinates }) => {
  const map = useMap();
  const buttonRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = buttonRef.current;
    if (!el) return;

    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);

    const stopNative = (e: Event) => {
      e.stopPropagation();
    };

    el.addEventListener('click', stopNative);
    el.addEventListener('mousedown', stopNative);
    el.addEventListener('mouseup', stopNative);
    el.addEventListener('pointerdown', stopNative);
    el.addEventListener('pointerup', stopNative);
    el.addEventListener('touchstart', stopNative);
    el.addEventListener('touchend', stopNative);

    return () => {
      el.removeEventListener('click', stopNative);
      el.removeEventListener('mousedown', stopNative);
      el.removeEventListener('mouseup', stopNative);
      el.removeEventListener('pointerdown', stopNative);
      el.removeEventListener('pointerup', stopNative);
      el.removeEventListener('touchstart', stopNative);
      el.removeEventListener('touchend', stopNative);
    };
  }, []);

  if (waypoints.length === 0) return null;

  const handleFit = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    map.invalidateSize({ pan: false });
    if (routeCoordinates.length > 0) {
      const bounds = L.latLngBounds(routeCoordinates);
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    } else if (waypoints.length > 0) {
      const bounds = L.latLngBounds(waypoints.map((w) => [w.lat, w.lng]));
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
    }
  };

  const handleStopPropagation = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
  };

  return (
    <div
      ref={buttonRef}
      className="leaflet-control absolute top-4 left-4 z-[1000] pointer-events-auto"
      onClick={handleStopPropagation}
      onMouseDown={handleStopPropagation}
      onMouseUp={handleStopPropagation}
      onDoubleClick={handleStopPropagation}
    >
      <button
        type="button"
        onClick={handleFit}
        onMouseDown={handleStopPropagation}
        onMouseUp={handleStopPropagation}
        onDoubleClick={handleStopPropagation}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-slate-900/90 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-700/80 shadow-xl backdrop-blur-md text-xs font-medium transition-all cursor-pointer select-none"
        title="Fit route to screen"
        aria-label="Fit route to screen"
      >
        <Maximize2 className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
        <span>Fit Route</span>
      </button>
    </div>
  );
};

// Map click listener helper
const MapClickHandler: React.FC<{
  onMapClick?: (lat: number, lng: number) => void;
}> = ({ onMapClick }) => {
  useMapEvents({
    click: (e) => {
      if (onMapClick) {
        onMapClick(e.latlng.lat, e.latlng.lng);
      }
    },
  });
  return null;
};

export const MapCanvas: React.FC<MapCanvasProps> = ({
  waypoints,
  route,
  activeDayIndex = 0,
  isInitializing = false,
  onMapClick,
  onDeleteWaypoint,
  onSelectWaypoint,
  onOpenScoutForWaypoint,
  scoutPreviewPin,
  onClearScoutPreviewPin,
  isScoutOpen,
  aiAvailable = true,
}) => {
  // Convert GeoJSON [lon, lat] pairs to Leaflet [lat, lon]
  const polylineCoords = useMemo<[number, number][]>(() => {
    if (!route || !route.geometry || !route.geometry.coordinates) {
      return [];
    }
    return route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  }, [route]);

  // Default center around current waypoints or Arizona / New Mexico corridor
  const defaultCenter = useMemo<[number, number]>(() => {
    if (waypoints.length > 0) {
      return [waypoints[0].lat, waypoints[0].lng];
    }
    return [34.8, -111.8];
  }, [waypoints]);

  return (
    <div className="relative w-full h-full">
      {/* Floating preview banner when a coordinate is previewed from Route Scout */}
      {scoutPreviewPin && (
        <div className="absolute top-4 right-4 z-[1000] flex items-center gap-2 bg-slate-900/90 border border-cyan-500/60 rounded-xl px-3 py-1.5 text-xs text-cyan-200 shadow-xl backdrop-blur-md">
          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping shrink-0" />
          <span className="font-medium truncate max-w-[220px]">
            Previewing: {scoutPreviewPin.name}
          </span>
          {onClearScoutPreviewPin && (
            <button
              onClick={onClearScoutPreviewPin}
              className="ml-1 p-0.5 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition-colors cursor-pointer"
              title="Close preview"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      <MapContainer
        center={defaultCenter}
        zoom={7}
        className="w-full h-full"
        zoomControl={false}
      >
        {/* OpenStreetMap Standard Tile Layer */}
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
        />

        <MapResizeHandler isScoutOpen={isScoutOpen} />
        <MapViewportManager
          waypoints={waypoints}
          routeCoordinates={polylineCoords}
          activeDayIndex={activeDayIndex}
          isInitializing={isInitializing}
          isScoutOpen={isScoutOpen}
        />
        <FitRouteButton
          waypoints={waypoints}
          routeCoordinates={polylineCoords}
        />
        <MapClickHandler onMapClick={onMapClick} />
        <ScoutPreviewFlyTo previewPin={scoutPreviewPin} />

        {/* OSRM Route Driving Polyline */}
        {polylineCoords.length > 0 && (
          <>
            {/* Dark contrast casing for route line */}
            <Polyline
              positions={polylineCoords}
              pathOptions={{
                color: '#0369a1',
                weight: 8,
                opacity: 0.7,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
            {/* Primary vibrant route line */}
            <Polyline
              positions={polylineCoords}
              pathOptions={{
                color: '#38bdf8',
                weight: 5,
                opacity: 0.95,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
          </>
        )}

        {/* Waypoint Pins */}
        {waypoints.map((waypoint, index) => (
          <Marker
            key={waypoint.id}
            position={[waypoint.lat, waypoint.lng]}
            icon={createWaypointIcon(index + 1, waypoint.type)}
            eventHandlers={{
              click: () => {
                onSelectWaypoint?.(waypoint.id);
              },
            }}
          >
            <Popup className="custom-leaflet-popup">
              <div className="min-w-[210px] max-w-[260px] text-slate-100 space-y-2">
                <div className="flex items-center justify-between gap-2 pr-4">
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider bg-slate-800 text-cyan-300 font-mono border border-slate-700">
                    Stop #{index + 1} &bull; {waypoint.type.replace(/_/g, ' ')}
                  </span>
                </div>

                <h4 className="font-bold text-sm text-white leading-snug">
                  {waypoint.name}
                </h4>

                <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono bg-slate-950/60 px-2 py-1 rounded-lg border border-slate-800">
                  <span>
                    {waypoint.lat.toFixed(4)}, {waypoint.lng.toFixed(4)}
                  </span>
                  <span>{waypoint.dwell_minutes}m dwell</span>
                </div>

                <div className="flex items-center gap-1.5 pt-1">
                  {onOpenScoutForWaypoint && (
                    <button
                      onClick={aiAvailable ? () => onOpenScoutForWaypoint(waypoint) : undefined}
                      disabled={!aiAvailable}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-semibold shadow-md transition-all ${
                        !aiAvailable
                          ? 'bg-slate-850 text-slate-500 cursor-not-allowed border border-slate-700/60 opacity-60 shadow-none'
                          : 'bg-gradient-to-tr from-cyan-600 to-sky-500 hover:from-cyan-500 hover:to-sky-400 text-white shadow-cyan-950/40 cursor-pointer'
                      }`}
                      title={
                        !aiAvailable
                          ? 'Route Scout is unavailable. An active AI engine or API key is required.'
                          : 'Open Route Scout for this stop'
                      }
                    >
                      <Compass
                        className={`w-3.5 h-3.5 ${
                          !aiAvailable ? 'text-slate-500' : 'text-white'
                        }`}
                      />
                      <span>Ask Scout</span>
                    </button>
                  )}

                  {onDeleteWaypoint && (
                    <button
                      onClick={() => onDeleteWaypoint(waypoint.id)}
                      className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded-lg border border-slate-800 transition-colors cursor-pointer"
                      title="Remove waypoint"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </Popup>
          </Marker>
        ))}

        {/* Temporary Scout Preview Pin */}
        {scoutPreviewPin && (
          <Marker
            position={[scoutPreviewPin.lat, scoutPreviewPin.lng]}
            icon={createScoutPreviewIcon()}
          >
            <Popup className="custom-leaflet-popup" autoPan={false}>
              <div className="min-w-[200px] text-slate-100 space-y-1.5 pr-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider bg-cyan-950/80 text-cyan-300 font-mono border border-cyan-800/60">
                    Route Scout Preview
                  </span>
                  {onClearScoutPreviewPin && (
                    <button
                      onClick={onClearScoutPreviewPin}
                      className="text-[11px] text-slate-400 hover:text-white cursor-pointer"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
                <h4 className="font-bold text-sm text-white leading-snug">
                  {scoutPreviewPin.name}
                </h4>
                <div className="text-[11px] text-slate-400 font-mono bg-slate-950/60 px-2 py-1 rounded-lg border border-slate-800">
                  {scoutPreviewPin.lat.toFixed(4)}, {scoutPreviewPin.lng.toFixed(4)}
                </div>
              </div>
            </Popup>
          </Marker>
        )}
      </MapContainer>
    </div>
  );
};
