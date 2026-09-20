import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Bot,
  Volume2,
  VolumeX,
  Sliders,
  Check,
  RefreshCw,
  Loader2,
  Car,
  Bell,
  Navigation,
  Info,
  MapPin,
  Clock,
  Sparkles,
  AlertCircle,
} from 'lucide-react';
import type { Waypoint, WaypointType } from '../types/routing';
import type { WaypointContext, CopilotAlert, AiEngineType } from '../types/ai';
import { generateCopilotAlert } from '../services/api';
import { defaultAiQueue } from '../services/aiQueue';

export const STOP_TYPE_OPTIONS: { value: WaypointType; label: string }[] = [
  { value: 'origin', label: 'Origin (Departure)' },
  { value: 'destination', label: 'Destination' },
  { value: 'lodging', label: 'Lodging / Hotel' },
  { value: 'meal', label: 'Meal / Dining' },
  { value: 'fuel', label: 'Fuel / Rest Area' },
  { value: 'scenic_pull_off', label: 'Scenic Pull-Off' },
  { value: 'scenic_drive_by', label: 'Scenic Drive-By' },
];

const DWELL_PRESETS = [0, 15, 30, 45, 60, 90, 120];
const RADIUS_PRESETS = [0.5, 1.0, 1.5, 2.0, 3.0, 5.0];

type ModalEngineState = AiEngineType | 'saved';

export interface EditWaypointModalProps {
  isOpen: boolean;
  waypoint: Waypoint | null;
  initialTab?: 'details' | 'alert';
  isFirst?: boolean;
  isLast?: boolean;
  onClose: () => void;
  onSave: (waypointId: string, updates: Partial<Waypoint>) => void;
  onApply?: (waypointId: string, alert: CopilotAlert) => void;
  aiAvailable?: boolean;
}

/**
 * Parses Google Maps URL or Place ID inputs, extracting the Place ID and establishment name.
 */
export function parseGoogleMapsPlaceInput(input: string): { placeId?: string; placeName?: string } {
  if (!input) return {};
  const trimmed = input.trim();

  // 1. Direct Place ID
  if (/^ChIJ[A-Za-z0-9_-]{20,40}$/.test(trimmed)) {
    return { placeId: trimmed };
  }

  let placeName: string | undefined;
  const placeNameMatch = trimmed.match(/\/maps\/place\/([^/@?]+)/);
  if (placeNameMatch && placeNameMatch[1]) {
    try {
      placeName = decodeURIComponent(placeNameMatch[1].replace(/\+/g, ' '));
    } catch {
      // Ignore decode failure
    }
  }

  // 2. Google Maps URL with hex pair !1s0x...:0x... (take the last match, which is the POI entity)
  const allHexMatches = [...trimmed.matchAll(/!1s(0x[0-9a-fA-F]+):(0x[0-9a-fA-F]+)/g)];
  if (allHexMatches.length > 0) {
    const lastMatch = allHexMatches[allHexMatches.length - 1];
    try {
      const b1 = BigInt(lastMatch[1]);
      const b2 = BigInt(lastMatch[2]);
      const buf = new Uint8Array(20);
      buf[0] = 0x0a;
      buf[1] = 0x12;
      buf[2] = 0x09;
      new DataView(buf.buffer).setBigUint64(3, b1, true);
      buf[11] = 0x11;
      new DataView(buf.buffer).setBigUint64(12, b2, true);
      const pid = btoa(String.fromCharCode(...buf))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      return { placeId: pid, placeName };
    } catch {
      // Ignore conversion error
    }
  }

  // 3. Google Maps URL with query param ?q=place_id:ChIJ... or &query_place_id=ChIJ...
  const pidParamMatch = trimmed.match(/(?:place_id|query_place_id)[:=](ChIJ[A-Za-z0-9_-]{20,40})/);
  if (pidParamMatch) {
    return { placeId: pidParamMatch[1], placeName };
  }

  return { placeName };
}

export const EditWaypointModal: React.FC<EditWaypointModalProps> = ({
  isOpen,
  waypoint,
  initialTab = 'details',
  isFirst = false,
  isLast = false,
  onClose,
  onSave,
  onApply,
  aiAvailable = true,
}) => {
  const [activeTab, setActiveTab] = useState<'details' | 'alert'>(initialTab);

  // Stop Details State
  const [name, setName] = useState('');
  const [placeName, setPlaceName] = useState('');
  const [type, setType] = useState<WaypointType>('scenic_pull_off');
  const [dwellMinutes, setDwellMinutes] = useState<number>(0);
  const [address, setAddress] = useState('');
  const [googlePlaceId, setGooglePlaceId] = useState('');
  const [isRouteAnchor, setIsRouteAnchor] = useState(false);

  // Alert & Audio State
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [speech, setSpeech] = useState('');
  const [radius, setRadius] = useState<number>(2.0);
  const [engine, setEngine] = useState<ModalEngineState>('saved');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);

  // Synchronize state when modal opens with a new waypoint
  useEffect(() => {
    if (!waypoint || !isOpen) return;

    setActiveTab(initialTab);
    setName(waypoint.name || '');
    setPlaceName(waypoint.place_name || '');
    const currentType = waypoint.type || 'scenic_pull_off';
    setType(currentType);
    const isOvernightOrFinalDest = isLast && (currentType === 'lodging' || currentType === 'destination');
    setDwellMinutes(isOvernightOrFinalDest ? 0 : (waypoint.dwell_minutes ?? 0));
    setAddress(waypoint.address || '');
    setGooglePlaceId(waypoint.google_place_id || '');
    setIsRouteAnchor(Boolean(waypoint.is_route_anchor));

    if (waypoint.notification) {
      setTitle(waypoint.notification.title);
      setMessage(waypoint.notification.message);
      setSpeech(waypoint.notification.speech);
      setRadius(waypoint.trigger_radius_miles || 2.0);
      setEngine('saved');
    } else {
      setTitle('');
      setMessage('');
      setSpeech('');
      setRadius(waypoint.trigger_radius_miles || 2.0);
      setEngine('saved');
    }
  }, [waypoint?.id, isOpen, initialTab, isLast]);

  // Clean up speech synthesis on close or unmount
  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const wordCount = useMemo(() => {
    return speech.trim().split(/\s+/).filter(Boolean).length;
  }, [speech]);

  const estSpeechSeconds = useMemo(() => {
    return Math.round(wordCount / 2.3);
  }, [wordCount]);

  const handleToggleSpeak = () => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(speech);
    utterance.rate = 1.0;
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
    setIsSpeaking(true);
  };

  const handleGenerateAlert = async () => {
    if (!waypoint) return;

    setIsLoading(true);
    setError(null);

    const context: WaypointContext = {
      id: waypoint.id,
      name: name || waypoint.name,
      type: type || waypoint.type,
      targetTime: waypoint.target_time,
      formattedTime: waypoint.target_time,
      approachHighway: waypoint.approachHighway,
      notes: waypoint.notes,
    };

    try {
      const result = await defaultAiQueue.enqueue(() => generateCopilotAlert(context));
      setTitle(result.title);
      setMessage(result.message);
      setSpeech(result.speech);
      setRadius(result.recommended_trigger_radius_miles);
      setEngine(result.engine);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Generation failed';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = () => {
    if (!waypoint) return;

    const isOvernightOrFinalDest = isLast && (type === 'lodging' || type === 'destination');
    const finalDwell = isOvernightOrFinalDest ? 0 : dwellMinutes;

    const updates: Partial<Waypoint> = {
      name: name.trim() || waypoint.name,
      place_name: placeName.trim() || undefined,
      type,
      dwell_minutes: finalDwell,
      address: address.trim() || undefined,
      google_place_id: googlePlaceId.trim() || undefined,
      is_route_anchor: isRouteAnchor,
      trigger_radius_miles: radius,
    };

    if (title.trim()) {
      const alert: CopilotAlert = {
        title: title.trim(),
        message: message.trim(),
        speech: speech.trim(),
        recommended_trigger_radius_miles: radius,
      };
      updates.notification = alert;
      onApply?.(waypoint.id, alert);
    }

    onSave(waypoint.id, updates);
    onClose();
  };

  if (!isOpen || !waypoint) return null;

  const radiusTip =
    radius >= 3.0
      ? 'Interstate / Open Highway (High Speed)'
      : radius >= 1.5
      ? 'Scenic Byway / Pull-off (Moderate Speed)'
      : 'Destination / Urban / Parking Approach';

  const modalContent = (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-[2000] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150"
    >
      <div className="w-full max-w-2xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-4 bg-slate-950/90 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-sky-500/15 text-sky-400 border border-sky-500/20">
              <MapPin className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white truncate max-w-md">
                  {name || waypoint.name}
                </h2>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono capitalize">
                  {type.replace(/_/g, ' ')}
                </span>
                {isFirst && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-950/80 border border-emerald-800 text-emerald-300 font-medium">
                    🟢 Origin
                  </span>
                )}
                {isLast && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-950/80 border border-amber-800 text-amber-300 font-medium">
                    🌙 Final Stop
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Waypoint details, Google Maps routing parameters & in-car audio alerts
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center border-b border-slate-800 bg-slate-950/50 px-5 pt-1 gap-2">
          <button
            onClick={() => setActiveTab('details')}
            className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
              activeTab === 'details'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <MapPin className="w-3.5 h-3.5" />
            <span>Stop & Navigation</span>
          </button>
          <button
            onClick={() => setActiveTab('alert')}
            className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
              activeTab === 'alert'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>In-Car Alert & Audio</span>
            {title ? (
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
            ) : (
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-400">
                Optional
              </span>
            )}
          </button>
        </div>

        {/* Body Content */}
        <div className="p-5 overflow-y-auto space-y-5 flex-1">
          {error && (
            <div className="p-3 bg-rose-950/80 border border-rose-800 rounded-xl text-xs text-rose-200">
              <span className="font-bold">Error:</span> {error}
            </div>
          )}

          {activeTab === 'details' ? (
            /* TAB 1: Stop Details & Navigation Precision */
            <div className="space-y-4">
              {/* Name & Category Row */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    Stop Name
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Oak Creek Vista Overlook"
                    className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    Stop Category
                  </label>
                  <select
                    value={type}
                    onChange={(e) => {
                      const newType = e.target.value as WaypointType;
                      setType(newType);
                      if (isLast && (newType === 'lodging' || newType === 'destination')) {
                        setDwellMinutes(0);
                      }
                    }}
                    className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-sky-500"
                  >
                    {STOP_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Dwell Duration */}
              <div className="p-3.5 bg-slate-950/60 border border-slate-800 rounded-xl space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-sky-400" />
                    <span className="text-xs font-semibold text-slate-300">
                      Planned Dwell / Stop Duration
                    </span>
                  </div>
                  <span className="text-xs font-mono font-bold text-sky-400 bg-sky-950/70 border border-sky-800/80 px-2 py-0.5 rounded">
                    {dwellMinutes} minutes
                  </span>
                </div>

                {isLast && (
                  <div className="p-2.5 bg-amber-950/30 border border-amber-800/50 rounded-lg text-xs text-amber-200/90 flex items-start gap-2">
                    <span className="text-amber-400 text-sm">🌙</span>
                    <div>
                      <span className="font-semibold text-amber-300">Final Destination / Overnight Stay:</span>{' '}
                      Keeping dwell at 0m marks this as the day&apos;s end without scheduling a false departure time.
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-1.5">
                  {DWELL_PRESETS.map((minutes) => (
                    <button
                      key={minutes}
                      type="button"
                      onClick={() => setDwellMinutes(minutes)}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-mono transition-all cursor-pointer ${
                        dwellMinutes === minutes
                          ? 'bg-sky-600 text-white font-bold shadow-sm'
                          : 'bg-slate-800 text-slate-300 hover:bg-slate-750'
                      }`}
                    >
                      {minutes === 0 ? '0m' : `${minutes}m`}
                    </button>
                  ))}
                  <div className="flex items-center gap-1.5 ml-auto">
                    <input
                      type="number"
                      min="0"
                      max="480"
                      step="5"
                      value={dwellMinutes}
                      onChange={(e) =>
                        setDwellMinutes(Math.max(0, parseInt(e.target.value, 10) || 0))
                      }
                      className="w-16 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-center text-xs font-mono text-white focus:outline-none focus:border-sky-500"
                    />
                    <span className="text-xs text-slate-400">minutes</span>
                  </div>
                </div>
              </div>

              {/* Google Maps Precision & Entity Binding */}
              <div className="p-4 bg-slate-950/80 border border-slate-800 rounded-xl space-y-3.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                    <Navigation className="w-3.5 h-3.5 text-sky-400" />
                    Google Maps Precision & Entity Binding
                  </span>
                  <span className="text-[11px] text-slate-400">
                    Ensures navigation pins resolve to exact businesses
                  </span>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Google Maps Establishment Name (Optional)
                    </label>
                    <input
                      type="text"
                      value={placeName}
                      onChange={(e) => setPlaceName(e.target.value)}
                      placeholder="e.g. Maverik (clean establishment name without notes)"
                      className="w-full bg-slate-900 border border-slate-700/80 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500"
                    />
                    <p className="text-[11px] text-slate-400 mt-1">
                      Clean establishment title used for Google Maps navigation. Allows keeping your custom waypoint title (e.g. &quot;Maverik (West Main St)&quot;) while preventing ambiguous search prompts in Google Maps.
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Physical Street Address / Search Query
                    </label>
                    <input
                      type="text"
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      placeholder="e.g. 2515 E Butler Ave, Flagstaff, AZ 86004"
                      className="w-full bg-slate-900 border border-slate-700/80 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500"
                    />
                    <p className="text-[11px] text-slate-400 mt-1">
                      Combined with the place name in Google Maps URLs so in-car navigation displays the establishment title.
                    </p>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-semibold text-slate-300">
                        Google Place ID (Optional)
                      </label>
                      {googlePlaceId && (
                        <button
                          type="button"
                          onClick={() => setGooglePlaceId('')}
                          className="text-[11px] text-rose-400 hover:text-rose-300 transition-colors cursor-pointer"
                        >
                          Clear Place ID
                        </button>
                      )}
                    </div>
                    <input
                      type="text"
                      value={googlePlaceId}
                      onChange={(e) => {
                        const val = e.target.value;
                        const parsed = parseGoogleMapsPlaceInput(val);
                        if (parsed.placeId) {
                          setGooglePlaceId(parsed.placeId);
                          if (parsed.placeName && !placeName) {
                            setPlaceName(parsed.placeName);
                          }
                        } else {
                          setGooglePlaceId(val);
                        }
                      }}
                      placeholder="Paste Google Maps URL or enter Place ID (e.g. ChIJCR3fWhuQO4cRxCLXXbAfCxQ)"
                      className="w-full bg-slate-900 border border-slate-700/80 rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-sky-500"
                    />
                    <p className="text-[11px] text-slate-400 mt-1">
                      Optional Google Maps Place ID. You can paste a full Google Maps place URL here to automatically extract the Place ID and establishment title.
                    </p>
                  </div>

                  {/* Verification & Testing Actions */}
                  <div className="pt-1 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => {
                        const cleanPName = placeName.trim() || (name.includes('/') ? name.split('/').pop()!.trim() : name.trim());
                        const q = address.trim() && cleanPName ? `${cleanPName}, ${address.trim()}` : (address.trim() || cleanPName);
                        if (!q) return;
                        const url = googlePlaceId.trim()
                          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}&query_place_id=${encodeURIComponent(googlePlaceId.trim())}`
                          : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
                        window.open(url, '_blank', 'noopener,noreferrer');
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-750 text-sky-400 hover:text-sky-300 rounded-lg text-xs font-medium transition-colors border border-slate-700/80 cursor-pointer"
                      title="Test this address and Place ID in Google Maps in a new tab to verify it resolves without error"
                    >
                      <Navigation className="w-3.5 h-3.5" />
                      <span>Test on Google Maps ↗</span>
                    </button>
                    <span className="text-[10px] text-slate-500">
                      Verifies address / place ID in browser
                    </span>
                  </div>

                  {/* Route-Forcing Anchor Toggle */}
                  <div className="pt-2 border-t border-slate-800/80">
                    {isFirst || isLast ? (
                      <div className="p-2.5 bg-slate-900/60 border border-slate-800 rounded-xl text-[11px] text-slate-400">
                        <span className="font-semibold text-slate-300">
                          ⚓ Route Anchor not applicable:
                        </span>{' '}
                        {isFirst
                          ? 'Origin is automatically the start of navigation.'
                          : 'Destination is automatically the arrival point.'}
                      </div>
                    ) : (
                      <label className="flex items-start gap-2.5 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={isRouteAnchor}
                          onChange={(e) => setIsRouteAnchor(e.target.checked)}
                          className="mt-0.5 w-4 h-4 rounded bg-slate-900 border-slate-700 text-sky-600 focus:ring-0 cursor-pointer"
                        />
                        <div>
                          <span className="text-xs font-bold text-amber-300">
                            ⚓ Route-Forcing Anchor (Pass-Through Pin)
                          </span>
                          <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                            Includes this point in exported Google Maps navigation links to force routing along specific corridors (e.g. scenic AZ-179 / AZ-89A) without generating an in-car stop.
                          </p>
                        </div>
                      </label>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* TAB 2: In-Car Alert & Audio Configuration */
            <div className="space-y-4">
              {!aiAvailable && (
                <div className="p-3 bg-slate-900/90 border border-slate-800 rounded-xl text-xs text-slate-300 flex items-start gap-2.5">
                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold text-white">AI Co-Pilot Script Generator Unavailable</span>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                      An active AI engine or API key is required to automatically generate alerts. You can still manually author or edit heads-up card text and spoken phonetic audio scripts below.
                    </p>
                  </div>
                </div>
              )}

              {/* AI Generation Control */}
              <div className="flex items-center justify-between p-3 bg-slate-950/60 border border-slate-800 rounded-xl">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-sky-500/20 text-sky-400">
                    <Bot className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="text-xs font-semibold text-slate-200">
                      AI Co-Pilot Script Generator
                    </span>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span
                        className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded border ${
                          engine === 'saved'
                            ? 'bg-sky-950/80 text-sky-300 border-sky-700/60'
                            : !aiAvailable
                            ? 'bg-slate-800 text-slate-400 border-slate-700'
                            : 'bg-emerald-950 text-emerald-300 border-emerald-700/60'
                        }`}
                      >
                        {engine === 'saved'
                          ? 'Saved Itinerary Alert'
                          : !aiAvailable
                          ? 'Manual Alert'
                          : 'AI Generated'}
                      </span>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={aiAvailable ? handleGenerateAlert : undefined}
                  disabled={!aiAvailable || isLoading}
                  title={
                    !aiAvailable
                      ? 'AI alert generation is unavailable. An active AI engine or API key is required.'
                      : title
                      ? 'Regenerate script with AI'
                      : 'Generate script with AI'
                  }
                  className={`px-3.5 py-2 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-colors shadow-sm ${
                    !aiAvailable
                      ? 'bg-slate-850 border border-slate-800 text-slate-500 cursor-not-allowed opacity-60'
                      : 'bg-gradient-to-r from-sky-600 to-indigo-600 hover:from-sky-500 hover:to-indigo-500 text-white cursor-pointer'
                  }`}
                >
                  {isLoading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-white" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5 text-white" />
                  )}
                  <span>{isLoading ? 'Generating...' : title ? 'Regenerate Script' : 'Generate Alert'}</span>
                </button>
              </div>

              {/* Android Auto Heads-Up Card Preview & Editing */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                    <Car className="w-3.5 h-3.5 text-sky-400" />
                    Android Auto Heads-Up Display Preview
                  </span>
                  <span className="text-[11px] text-slate-400">Overlaid on Google Maps</span>
                </div>

                <div className="p-4 rounded-xl bg-slate-950 border border-slate-700/90 shadow-lg space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                        <Navigation className="w-3.5 h-3.5" />
                      </div>
                      <span className="text-xs font-bold text-emerald-400 tracking-wide">
                        Co-Pilot: {title || 'Waypoint Ahead'}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 text-[11px] text-slate-500">
                      <Bell className="w-3 h-3" />
                      <span>Now</span>
                    </div>
                  </div>

                  <p className="text-sm text-slate-200 whitespace-pre-line leading-relaxed font-sans pl-8">
                    {message || 'Approaching scheduled waypoint. Follow local road signs.'}
                  </p>

                  <div className="flex items-center gap-2 pt-2 border-t border-slate-800/80 pl-8">
                    <span className="text-[11px] px-2.5 py-1 bg-slate-800 text-slate-300 rounded-md">
                      Dismiss
                    </span>
                    <span className="text-[11px] px-2.5 py-1 bg-sky-600/30 text-sky-300 border border-sky-500/40 rounded-md">
                      Acknowledge
                    </span>
                  </div>
                </div>

                {/* Inline Editing for Card */}
                <div className="grid grid-cols-1 gap-2.5 pt-1">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[11px] font-semibold text-slate-300">
                        Card Title (max 30 chars)
                      </label>
                      <span
                        className={`text-[10px] font-mono ${
                          title.length > 30 ? 'text-rose-400 font-bold' : 'text-slate-500'
                        }`}
                      >
                        {title.length}/30
                      </span>
                    </div>
                    <input
                      type="text"
                      maxLength={30}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="e.g. Scenic Overlook Ahead"
                      className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700/80 rounded-lg text-xs text-white focus:outline-none focus:border-sky-500"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                      Notification Message (concise 1–2 lines)
                    </label>
                    <textarea
                      rows={2}
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder="Upcoming scenic overlook on right with panoramic canyon views."
                      className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700/80 rounded-lg text-xs text-white focus:outline-none focus:border-sky-500 resize-none"
                    />
                  </div>
                </div>
              </div>

              {/* Spoken TTS Audio Script Preview & Editing */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                    <Volume2 className="w-3.5 h-3.5 text-amber-400" />
                    Offline TTS Audio Announcement (Ducks Music)
                  </span>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span
                      className={`font-mono px-1.5 py-0.5 rounded ${
                        wordCount >= 15 && wordCount <= 25
                          ? 'bg-emerald-950 text-emerald-300'
                          : 'bg-amber-950 text-amber-300'
                      }`}
                    >
                      {wordCount} words (~{estSpeechSeconds}s)
                    </span>
                    <span className="text-slate-500">Target: 15–25 words</span>
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-700/80 flex items-start gap-3">
                  <button
                    type="button"
                    onClick={handleToggleSpeak}
                    disabled={!speech}
                    className={`p-2.5 rounded-xl transition-colors shrink-0 flex items-center justify-center cursor-pointer ${
                      isSpeaking
                        ? 'bg-amber-500 text-slate-950 hover:bg-amber-400'
                        : 'bg-slate-800 text-amber-400 hover:bg-slate-750'
                    } disabled:opacity-40`}
                    title={isSpeaking ? 'Stop speaking preview' : 'Play TTS audio preview'}
                  >
                    {isSpeaking ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                  </button>

                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-slate-200 italic leading-relaxed">
                      &ldquo;{speech || 'Approaching your scheduled road trip stop.'}&rdquo;
                    </p>
                    <div className="mt-2 text-[11px] text-slate-400 flex items-center gap-1">
                      <Info className="w-3 h-3 text-sky-400" />
                      <span>Ducks Spotify car audio during utterance, restoring volume on completion.</span>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                    Spoken Script Content
                  </label>
                  <textarea
                    rows={2}
                    value={speech}
                    onChange={(e) => setSpeech(e.target.value)}
                    placeholder="Approaching Oak Creek Vista in two miles. Prepare to turn right into the overlook parking area."
                    className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700/80 rounded-lg text-xs text-white focus:outline-none focus:border-sky-500 resize-none"
                  />
                </div>
              </div>

              {/* Geofence Trigger Radius */}
              <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                    <Sliders className="w-3.5 h-3.5 text-sky-400" />
                    Heads-Up Alert Distance (Geofence Trigger)
                  </span>
                  <span className="text-xs font-mono font-bold text-sky-400 bg-sky-950/80 border border-sky-800 px-2 py-0.5 rounded">
                    {radius.toFixed(1)} miles before stop
                  </span>
                </div>

                <input
                  type="range"
                  min="0.3"
                  max="6.0"
                  step="0.1"
                  value={radius}
                  onChange={(e) => setRadius(parseFloat(e.target.value))}
                  className="w-full accent-sky-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                />

                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>0.3 mi (City / Overlook)</span>
                  <span className="text-sky-300/80 italic">{radiusTip}</span>
                  <span>6.0 mi (Interstate)</span>
                </div>

                <div className="flex flex-wrap gap-1.5 pt-1">
                  {RADIUS_PRESETS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setRadius(r)}
                      className={`px-2 py-1 rounded text-xs font-mono transition-colors cursor-pointer ${
                        Math.abs(radius - r) < 0.05
                          ? 'bg-sky-600 text-white font-bold'
                          : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                      }`}
                    >
                      {r.toFixed(1)} mi
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3.5 bg-slate-950/90 border-t border-slate-800 flex items-center justify-between">
          <div className="text-xs text-slate-400">
            {activeTab === 'details' ? (
              <span>Coordinates: {waypoint.lat.toFixed(4)}, {waypoint.lng.toFixed(4)}</span>
            ) : (
              <span>Audio ducking active when trigger radius is crossed</span>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-transparent hover:bg-slate-800 text-slate-400 hover:text-white rounded-xl text-xs font-medium transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm cursor-pointer"
            >
              <Check className="w-4 h-4" />
              <span>Save Waypoint</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modalContent, document.body) : modalContent;
};

/**
 * Backward compatibility alias for AiAlertModal
 */
export const AiAlertModal = EditWaypointModal;
