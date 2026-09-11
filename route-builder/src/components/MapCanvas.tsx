import React, { useEffect, useMemo } from 'react';
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
import type { Waypoint, RouteResponse } from '../types/routing';

interface MapCanvasProps {
  waypoints: Waypoint[];
  route: RouteResponse | null;
  onMapClick?: (lat: number, lng: number) => void;
  onDeleteWaypoint?: (id: string) => void;
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

// Auto-adjust map viewport to contain all waypoints and route path
const MapViewportManager: React.FC<{
  waypoints: Waypoint[];
  routeCoordinates: [number, number][];
}> = ({ waypoints, routeCoordinates }) => {
  const map = useMap();

  useEffect(() => {
    if (waypoints.length === 0) return;

    if (routeCoordinates.length > 0) {
      const bounds = L.latLngBounds(routeCoordinates);
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    } else {
      const bounds = L.latLngBounds(waypoints.map((w) => [w.lat, w.lng]));
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
    }
  }, [map, waypoints, routeCoordinates]);

  return null;
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
  onMapClick,
  onDeleteWaypoint,
}) => {
  // Convert GeoJSON [lon, lat] pairs to Leaflet [lat, lon]
  const polylineCoords = useMemo<[number, number][]>(() => {
    if (!route || !route.geometry || !route.geometry.coordinates) {
      return [];
    }
    return route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  }, [route]);

  // Default center around Arizona / New Mexico road trip corridor
  const defaultCenter: [number, number] = [34.8, -111.8];

  return (
    <div className="relative w-full h-full">
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

        <MapViewportManager waypoints={waypoints} routeCoordinates={polylineCoords} />
        <MapClickHandler onMapClick={onMapClick} />

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
          >
            <Popup className="custom-leaflet-popup">
              <div className="p-1 min-w-[200px] text-slate-900">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-xs font-bold px-1.5 py-0.5 rounded uppercase tracking-wider bg-slate-200 text-slate-700">
                    Stop #{index + 1}
                  </span>
                  <span className="text-xs text-slate-500 font-mono">
                    {waypoint.type}
                  </span>
                </div>
                <h4 className="font-semibold text-sm text-slate-900 leading-snug mb-1">
                  {waypoint.name}
                </h4>
                <div className="text-xs text-slate-600 font-mono mb-2">
                  {waypoint.lat.toFixed(4)}, {waypoint.lng.toFixed(4)}
                </div>
                <div className="flex items-center justify-between text-xs text-slate-600 border-t border-slate-200 pt-2 mb-2">
                  <span>Dwell: {waypoint.dwell_minutes}m</span>
                  <span>Trigger: {waypoint.trigger_radius_miles}mi</span>
                </div>
                {onDeleteWaypoint && (
                  <button
                    onClick={() => onDeleteWaypoint(waypoint.id)}
                    className="w-full py-1 px-2 text-xs font-medium text-rose-600 hover:text-rose-700 hover:bg-rose-50 rounded border border-rose-200 transition-colors"
                  >
                    Remove Waypoint
                  </button>
                )}
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
};
