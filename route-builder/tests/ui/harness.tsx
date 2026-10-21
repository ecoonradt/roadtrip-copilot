import React from 'react';
import * as renderer from 'react-test-renderer';
import type { ReactTestRenderer, ReactTestInstance } from 'react-test-renderer';
import { beforeEach, afterEach, vi } from 'vitest';
import { calculateTimelineCascade } from '../../src/engine/cascade';
import { formatMultiDayItinerary, type ItineraryExportModel, type MultiDayItineraryV2 } from '../../src/engine/export';
import type { Waypoint, RouteResponse, GeocodeResult } from '../../src/types/routing';
import type { TimelineCascadeResult } from '../../src/engine/types';
import type { ParsedTrip } from '../../src/engine/itineraryParser';

const mockedApi = vi.hoisted(() => ({
  fetchItinerary: vi.fn(),
  fetchRoute: vi.fn(),
  fetchAiStatus: vi.fn(),
  saveItinerary: vi.fn(),
  stageItinerary: vi.fn(),
  fetchAuthStatus: vi.fn(),
  logoutAuth: vi.fn(),
}));
export const api = mockedApi;
export const act = renderer.act;
const create = renderer.create;
vi.mock('../../src/services/api', () => mockedApi);
vi.mock('../../src/components/MapCanvas', () => ({ MapCanvas: (props: Record<string, unknown>) => React.createElement('test-map', props) }));
vi.mock('../../src/components/AppHeader', () => ({ AppHeader: (props: Record<string, unknown>) => React.createElement('test-header', props) }));
vi.mock('../../src/components/TimelineSidebar', () => ({ TimelineSidebar: (props: Record<string, unknown>) => React.createElement('test-sidebar', props) }));
vi.mock('../../src/components/RouteSelectorModal', () => ({ RouteSelectorModal: (props: Record<string, unknown>) => React.createElement('test-selector', props) }));
vi.mock('../../src/components/ExportModal', () => ({ ExportModal: (props: Record<string, unknown>) => React.createElement('test-export', props) }));
vi.mock('../../src/components/RouteScoutDrawer', () => ({ RouteScoutDrawer: (props: Record<string, unknown>) => React.createElement('test-scout', props) }));
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,test' } }));
import { App } from '../../src/App';
import { DayTabBar } from '../../src/components/DayTabBar';

export interface HeaderProps {
  onSaveTrip: () => Promise<void>;
  cascadeResult: TimelineCascadeResult;
  isLoadingRoute: boolean;
  routeError: string | null;
  isDirty: boolean;
  schedulingMode: string;
  targetArrivalTime: string;
  departureTime: string;
  setDepartureTime: (time: string) => void;
  setBaseDate: (date: string) => void;
  setSchedulingMode: (mode: 'forward' | 'backward' | 'adhoc') => void;
  setTargetArrivalTime: (time: string) => void;
}
interface SidebarProps { onUpdateWaypoint: (id: string, update: Partial<Waypoint>) => void; onSelectLocation: (result: GeocodeResult) => void }
interface DayProps { onSelectDay: (index: number) => void; onAddDay: () => void; onDeleteDay: (index: number) => void }
type ModalProps = React.ComponentProps<typeof import('../../src/components/ExportModal')['ExportModal']>;
export function points(day: number): Waypoint[] {
  const base = day === 1 ? 33.1 : 33.6;
  return [
    { id: `d${day}_origin`, name: 'Origin', type: 'origin', lat: base, lng: -112, timezone: 'America/Phoenix', dwell_minutes: 0, trigger_radius_miles: 0.5 },
    { id: `d${day}_stop`, name: 'Scenic stop', type: 'scenic_pull_off', lat: base + 0.1, lng: -112, timezone: 'America/Phoenix', dwell_minutes: 30, trigger_radius_miles: 0.5 },
    { id: `d${day}_dest`, name: 'Destination', type: 'destination', lat: base + 0.2, lng: -112, timezone: 'America/Phoenix', dwell_minutes: 0, trigger_radius_miles: 0.5 },
  ];
}
export function roadResponse(durations = [3600, 1800]): RouteResponse {
  const total = durations.reduce((a, b) => a + b, 0);
  return { geometry: { type: 'LineString', coordinates: [] }, distanceMeters: 100000, distanceMiles: 62, durationSeconds: total, durationMinutes: total / 60, cached: false,
    legs: durations.map(durationSeconds => ({ distanceMeters: 50000, distanceMiles: 31, durationSeconds, durationMinutes: durationSeconds / 60 })) };
}
export function fixture(): MultiDayItineraryV2 {
  return formatMultiDayItinerary({ tripName: 'Scheduling tests', days: [1, 2].map(day => ({ dayNumber: day, date: `2026-10-${String(8 + day).padStart(2, '0')}`, departureTime: '09:00:00', timezone: 'America/Phoenix',
    scheduledStops: calculateTimelineCascade({ baseDate: `2026-10-${String(8 + day).padStart(2, '0')}`, departureTime: '09:00:00', waypoints: points(day), driveDurationsSeconds: [3600, 1800] }).stops })) });
}
const mounted: ReactTestRenderer[] = [];
export function header(app: ReactTestRenderer): HeaderProps { return app.root.findByType('test-header').props as HeaderProps }
export function sidebar(app: ReactTestRenderer): SidebarProps { return app.root.findByType('test-sidebar').props as SidebarProps }
export function tabs(app: ReactTestRenderer): DayProps { return app.root.findByType(DayTabBar).props as DayProps }
export function exportProps(app: ReactTestRenderer): ModalProps { return app.root.findByType('test-export').props as ModalProps }
export function trip(app: ReactTestRenderer): ParsedTrip { return exportProps(app).trip! }
export function selectTrip(app: ReactTestRenderer, next: ParsedTrip): void {
  (app.root.findByType('test-selector').props as { onSelectTrip: (value: ParsedTrip) => void }).onSelectTrip(next);
}
export function mapClick(app: ReactTestRenderer, lat = 33.4, lng = -112): void {
  (app.root.findByType('test-map').props as { onMapClick: (lat: number, lng: number) => void }).onMapClick(lat, lng);
}
export function saved<T extends ItineraryExportModel = MultiDayItineraryV2>(): T { return api.saveItinerary.mock.calls.at(-1)![1] as T }
export async function mountApp(): Promise<ReactTestRenderer> {
  let app!: ReactTestRenderer;
  await act(async () => { app = create(<App />) });
  mounted.push(app);
  await act(async () => { await Promise.resolve() });
  return app;
}
function text(node: ReactTestInstance): string { return node.children.map(child => typeof child === 'string' ? child : text(child)).join('') }
export async function exported<T extends ItineraryExportModel = MultiDayItineraryV2>(props: ModalProps, scope: 'full' | 'day' = 'full'): Promise<T> {
  const { ExportModal } = await vi.importActual<typeof import('../../src/components/ExportModal')>('../../src/components/ExportModal');
  let modal!: ReactTestRenderer;
  await act(async () => { modal = create(<ExportModal {...props} isOpen />) });
  mounted.push(modal);
  if (scope === 'day') {
    const button = modal.root.findAllByType('button').find(item => /Day \d+ Only/.test(text(item)))!;
    await act(async () => { (button.props as { onClick: () => void }).onClick() });
  }
  const button = modal.root.findAllByType('button').find(item => text(item).includes('JSON Preview & File'))!;
  await act(async () => { (button.props as { onClick: () => void }).onClick() });
  return JSON.parse(text(modal.root.findByType('pre'))) as T;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  api.fetchItinerary.mockResolvedValue(fixture());
  api.fetchRoute.mockImplementation((coords: Array<{ lat: number; lng: number }>) => Promise.resolve(roadResponse(coords.length === 4 ? [3600, 1800, 1200] : [3600, 1800])));
  api.fetchAiStatus.mockResolvedValue({ available: false });
  api.fetchAuthStatus.mockResolvedValue({ authEnabled: false, authenticated: true, authorized: true, user: null });
  api.logoutAuth.mockResolvedValue(undefined);
  api.saveItinerary.mockResolvedValue({ success: true, fileName: 'test.json' });
  api.stageItinerary.mockResolvedValue({ downloadUrl: 'http://localhost:3001/test.json' });
  const entries = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value) });
  const location = { href: 'http://localhost:5173/?route=test.json&day=0', search: '?route=test.json&day=0' };
  vi.stubGlobal('window', { location, history: { replaceState: (_state: unknown, _title: string, url: string) => { location.href = url; location.search = new URL(url).search } }, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('alert', vi.fn());
});
afterEach(async () => {
  for (const app of mounted) await act(async () => app.unmount());
  mounted.length = 0; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});
