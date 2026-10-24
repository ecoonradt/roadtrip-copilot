import { AI_UNAVAILABLE_ALERT_MESSAGE, AI_UNAVAILABLE_TOOLTIP } from '../constants/aiCopy';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Volume2,
  VolumeX,
  Sliders,
  Check,
  Loader2,
  Car,
  Navigation,
  Info,
  MapPin,
  Clock,
  Sparkles,
  AlertCircle,
  Trash2,
} from 'lucide-react';
import type { Waypoint, WaypointType } from '../types/routing';
import type { WaypointContext, CopilotAlert, AiModelOption } from '../types/ai';
import { generateCopilotAlert } from '../services/api';
import { defaultAiQueue } from '../services/aiQueue';

export const STOP_TYPE_OPTIONS: { value: WaypointType; label: string }[] = [
  { value: 'origin', label: 'Origin (Departure)' },
  { value: 'destination', label: 'Destination' },
  { value: 'lodging', label: 'Lodging / Hotel' },
  { value: 'meal', label: 'Meal / Dining' },
  { value: 'fuel', label: 'Fuel / Rest Area' },
  { value: 'stop', label: 'Stop (Generic / Errand)' },
  { value: 'scenic_pull_off', label: 'Scenic Pull-Off' },
  { value: 'scenic_drive_by', label: 'Scenic Drive-By' },
];

const DWELL_PRESETS = [0, 15, 30, 45, 60, 90, 120];
const RADIUS_PRESETS = [0.5, 1.0, 1.5, 2.0, 3.0, 5.0];

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
  aiModels?: AiModelOption[];
  selectedModelId?: string;
  onSelectModel?: (modelId: string) => void;
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
  aiModels = [],
  selectedModelId,
  onSelectModel,
}) => {
  const [activeTab, setActiveTab] = useState<'details' | 'alert'>(initialTab);

  // Request sequence guard to prevent stale responses overwriting newer state/stops
  const genSeqRef = useRef<number>(0);

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
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const copywriterModels = useMemo(
    () => (aiModels || []).filter((m) => m.role === 'copywriter' || m.role === 'both'),
    [aiModels]
  );
  const hasSelectedModel = Boolean(
    selectedModelId && copywriterModels.some((m) => m.id === selectedModelId)
  );

  // Synchronize state when modal opens with a new waypoint
  useEffect(() => {
    genSeqRef.current += 1;
    setIsLoading(false);
    setError(null);
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
    } else {
      setTitle('');
      setMessage('');
      setSpeech('');
      setRadius(waypoint.trigger_radius_miles || 2.0);
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
    if (!waypoint || !hasSelectedModel || isLoading) return;

    const seq = ++genSeqRef.current;
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
      const result = await defaultAiQueue.enqueue(() =>
        generateCopilotAlert(context, { modelId: selectedModelId })
      );
      if (seq !== genSeqRef.current) return;
      setTitle(result.title);
      setMessage(result.message);
      setSpeech(result.speech);
      setRadius(result.recommended_trigger_radius_miles);
    } catch (err: unknown) {
      if (seq !== genSeqRef.current) return;
      const msg = err instanceof Error ? err.message : 'Generation failed';
      setError(msg);
    } finally {
      if (seq === genSeqRef.current) {
        setIsLoading(false);
      }
    }
  };

  // Determine whether an in-car alert is meaningfully configured
  const hasActiveAlert = useMemo(() => {
    if (type === 'stop') return false;
    const currentName = (name || waypoint?.name || '').trim().toLowerCase();
    const currentTitle = title.trim();
    const hasSpeech = Boolean(speech.trim());
    const hasMessage = Boolean(message.trim());
    const hasDistinctTitle = Boolean(currentTitle && currentTitle.toLowerCase() !== currentName);
    return hasSpeech || hasMessage || hasDistinctTitle;
  }, [type, speech, message, title, name, waypoint?.name]);

  const handleClearAlert = () => {
    setTitle('');
    setMessage('');
    setSpeech('');
  };

  const handleSave = () => {
    if (!waypoint) return;

    const isSilentStop = type === 'stop';
    const isOvernightOrFinalDest = isLast && (type === 'lodging' || type === 'destination');
    const finalDwell = isOvernightOrFinalDest ? 0 : isSilentStop ? (dwellMinutes > 0 ? dwellMinutes : 15) : dwellMinutes;

    const updates: Partial<Waypoint> = {
      name: name.trim() || waypoint.name,
      place_name: placeName.trim() || undefined,
      type,
      dwell_minutes: finalDwell,
      address: address.trim() || undefined,
      google_place_id: googlePlaceId.trim() || undefined,
      is_route_anchor: isSilentStop ? false : isRouteAnchor,
      trigger_radius_miles: radius,
    };

    if (!isSilentStop && hasActiveAlert) {
      const alert: CopilotAlert = {
        title: title.trim() || name.trim() || waypoint.name,
        message: message.trim(),
        speech: speech.trim(),
        recommended_trigger_radius_miles: radius,
      };
      updates.notification = alert;
      onApply?.(waypoint.id, alert);
    } else {
      updates.notification = undefined;
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
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-bold text-white truncate max-w-[260px] sm:max-w-md">
                  {name || waypoint.name}
                </h2>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono capitalize whitespace-nowrap shrink-0">
                  {type.replace(/_/g, ' ')}
                </span>
                {isFirst && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-950/80 border border-emerald-800 text-emerald-300 font-medium whitespace-nowrap shrink-0">
                    🟢 Origin
                  </span>
                )}
                {isLast && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-950/80 border border-amber-800 text-amber-300 font-medium whitespace-nowrap shrink-0">
                    {type === 'lodging' ? '🌙 Overnight Stay' : '🏁 Final Stop'}
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
            {hasActiveAlert ? (
              <span className="w-2 h-2 rounded-full bg-emerald-400" title="In-car alert armed" />
            ) : (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                {type === 'stop' ? 'Silent' : 'None'}
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
                      } else if (newType === 'scenic_drive_by') {
                        setDwellMinutes(0);
                      } else if (newType === 'stop') {
                        setDwellMinutes((prev) => (prev > 0 ? prev : 15));
                        setTitle('');
                        setMessage('');
                        setSpeech('');
                        setIsRouteAnchor(false);
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
                    <span className="text-amber-400 text-sm">{type === 'lodging' ? '🌙' : '🏁'}</span>
                    <div>
                      <span className="font-semibold text-amber-300">{type === 'lodging' ? 'Overnight Stay:' : 'Final Stop:'}</span>{' '}
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
                    <span className="text-[11px] text-slate-500">
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
              {type === 'stop' ? (
                <div className="p-3 bg-slate-900/90 border border-slate-700/80 rounded-xl text-xs text-slate-300 flex items-start gap-2.5">
                  <div className="p-1 rounded-md bg-slate-800 text-slate-400 shrink-0 mt-0.5">
                    <VolumeX className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="font-semibold text-white">Silent Stop (No In-Car Voice or Heads-Up Cards)</span>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                      Generic stops do not trigger Android Auto heads-up popups or duck car audio while driving. Your scheduled arrival time, dwell time cascade, and Google Maps navigation route remain active.
                    </p>
                  </div>
                </div>
              ) : !hasActiveAlert ? (
                <div className="p-3 bg-slate-900/80 border border-slate-800 rounded-xl text-xs text-slate-300 flex items-start gap-2.5">
                  <div className="p-1 rounded-md bg-slate-800 text-slate-400 shrink-0 mt-0.5">
                    <VolumeX className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="font-semibold text-white">No In-Car Alert Configured</span>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                      This stop will not duck music or trigger in-car spoken announcements. You can author an announcement below or click &ldquo;Generate with AI&rdquo; to add one.
                    </p>
                  </div>
                </div>
              ) : null}

              {type !== 'stop' && (
                <>
                  {!aiAvailable && (
                <div className="p-3 bg-slate-950/60 border border-slate-800 rounded-xl text-xs text-slate-300 flex items-start gap-2.5">
                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold text-white">AI Script Generation Unavailable</span>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                      {AI_UNAVAILABLE_ALERT_MESSAGE}
                    </p>
                  </div>
                </div>
              )}

              {/* CARD 1: Android Auto Heads-Up Display */}
              <div className="p-4 bg-slate-950/80 border border-slate-800 rounded-xl space-y-3.5">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                      <Car className="w-3.5 h-3.5 text-sky-400" />
                      Android Auto Heads-Up Display
                    </span>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Overlaid on Google Maps when approaching stop
                    </p>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    {copywriterModels.length > 0 && (
                      <select
                        aria-label="Copywriter AI Model"
                        value={hasSelectedModel ? selectedModelId : ''}
                        onChange={(e) => onSelectModel?.(e.target.value)}
                        disabled={isLoading}
                        className="bg-slate-900 border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs text-sky-400 focus:outline-none cursor-pointer disabled:opacity-50"
                      >
                        {!hasSelectedModel && (
                          <option value="" disabled className="bg-slate-900 text-slate-400">
                            Select model...
                          </option>
                        )}
                        {copywriterModels.map((m) => (
                          <option key={m.id} value={m.id} className="bg-slate-900 text-slate-100">
                            {m.name} ({m.provider})
                          </option>
                        ))}
                      </select>
                    )}

                    {(title || message || speech) && (
                      <button
                        type="button"
                        onClick={handleClearAlert}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border border-slate-700/80 bg-slate-800 hover:bg-rose-950/40 hover:border-rose-800/60 text-slate-400 hover:text-rose-300 cursor-pointer"
                        title="Clear alert text and spoken script for this stop"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Clear Alert</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={aiAvailable && hasSelectedModel ? handleGenerateAlert : undefined}
                      disabled={!aiAvailable || !hasSelectedModel || isLoading}
                      title={
                        !aiAvailable
                          ? AI_UNAVAILABLE_TOOLTIP
                          : !hasSelectedModel
                          ? 'Select an AI model to generate alert'
                          : title
                          ? 'Regenerate script and alert with AI'
                          : 'Generate script and alert with AI'
                      }
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border shadow-sm ${
                        !aiAvailable
                          ? 'bg-slate-900 border-slate-800 text-slate-500 cursor-not-allowed opacity-60'
                          : 'bg-slate-800 hover:bg-slate-750 border-slate-700/80 text-sky-400 hover:text-sky-300 cursor-pointer'
                      }`}
                    >
                      {isLoading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5 text-sky-400" />
                      )}
                      <span>{isLoading ? 'Generating...' : title ? 'Regenerate with AI' : 'Generate with AI'}</span>
                    </button>
                  </div>
                </div>

                <div className="space-y-3">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-semibold text-slate-300">
                        Card Title (max 30 chars)
                      </label>
                      <span
                        className={`text-[11px] font-mono ${
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
                      placeholder="e.g. Newton Plaza Ahead"
                      className="w-full bg-slate-900 border border-slate-700/80 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500"
                    />
                    <p className="text-[11px] text-slate-400 mt-1">
                      Short headline displayed in the in-car heads-up banner over Google Maps.
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Notification Message (concise 1–2 lines)
                    </label>
                    <textarea
                      rows={2}
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder="e.g. Target arrival: +4m. Prepare to turn into Newton Plaza for your scheduled meal stop."
                      className="w-full bg-slate-900 border border-slate-700/80 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 resize-none"
                    />
                    <p className="text-[11px] text-slate-400 mt-1">
                      Concise instruction or arrival notice shown on the vehicle display.
                    </p>
                  </div>
                </div>
              </div>

              {/* CARD 2: Spoken Audio Announcement */}
              <div className="p-4 bg-slate-950/80 border border-slate-800 rounded-xl space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                    <Volume2 className="w-3.5 h-3.5 text-amber-400" />
                    Spoken Audio Announcement (TTS)
                  </span>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span
                      className={`font-mono px-2 py-0.5 rounded text-xs border ${
                        wordCount >= 15 && wordCount <= 25
                          ? 'bg-emerald-950 text-emerald-300 border-emerald-800/60'
                          : 'bg-amber-950 text-amber-300 border-amber-800/60'
                      }`}
                    >
                      {wordCount} words (~{estSpeechSeconds}s)
                    </span>
                    <span className="text-slate-500">Target: 15–25 words</span>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Spoken Script Content
                  </label>
                  <textarea
                    rows={3}
                    value={speech}
                    onChange={(e) => setSpeech(e.target.value)}
                    placeholder="e.g. Approaching Newton Plaza in four minutes. Prepare to slow down and turn right into the shopping center for dining."
                    className="w-full bg-slate-900 border border-slate-700/80 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 resize-none leading-relaxed"
                  />
                </div>

                <div className="flex items-center justify-between pt-0.5">
                  <button
                    type="button"
                    onClick={handleToggleSpeak}
                    disabled={!speech.trim()}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border border-slate-700/80 cursor-pointer ${
                      isSpeaking
                        ? 'bg-amber-500 text-slate-950 hover:bg-amber-400 font-semibold'
                        : 'bg-slate-800 text-amber-400 hover:text-amber-300 hover:bg-slate-750'
                    } disabled:opacity-40 disabled:cursor-not-allowed`}
                    title={isSpeaking ? 'Stop speaking preview' : 'Play TTS audio preview'}
                  >
                    {isSpeaking ? (
                      <>
                        <VolumeX className="w-3.5 h-3.5" />
                        <span>Stop Preview</span>
                      </>
                    ) : (
                      <>
                        <Volume2 className="w-3.5 h-3.5" />
                        <span>Listen Preview</span>
                      </>
                    )}
                  </button>

                    <div className="text-[11px] text-slate-400 flex items-center gap-1">
                      <Info className="w-3 h-3 text-sky-400" />
                      <span>Ducks Spotify car audio during utterance, restoring volume on completion.</span>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* CARD 3: Alert Distance (Geofence Trigger) */}
            <div className="p-3.5 bg-slate-950/60 border border-slate-800 rounded-xl space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5 text-sky-400" />
                  <span className="text-xs font-semibold text-slate-300">
                    {type === 'stop'
                      ? 'Milestone Arrival Distance (Geofence Trigger)'
                      : 'Heads-Up Alert Distance (Geofence Trigger)'}
                  </span>
                </div>
                <span className="text-xs font-mono font-bold text-sky-400 bg-sky-950/70 border border-sky-800/80 px-2 py-0.5 rounded">
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
                <span className="text-sky-300/80 italic">
                  {type === 'stop' ? 'Milestone arrival detection radius' : radiusTip}
                </span>
                <span>6.0 mi (Interstate)</span>
              </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {RADIUS_PRESETS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setRadius(r)}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-mono transition-all cursor-pointer ${
                        Math.abs(radius - r) < 0.05
                          ? 'bg-sky-600 text-white font-bold shadow-sm'
                          : 'bg-slate-800 text-slate-300 hover:bg-slate-750'
                      }`}
                    >
                      {r.toFixed(1)} mi
                    </button>
                  ))}
                  <div className="flex items-center gap-1.5 ml-auto">
                    <input
                      type="number"
                      min="0.3"
                      max="6.0"
                      step="0.1"
                      value={radius}
                      onChange={(e) =>
                        setRadius(
                          Math.max(
                            0.3,
                            Math.min(6.0, parseFloat(parseFloat(e.target.value).toFixed(1)) || 0.3)
                          )
                        )
                      }
                      className="w-16 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-center text-xs font-mono text-white focus:outline-none focus:border-sky-500"
                    />
                    <span className="text-xs text-slate-400">miles</span>
                  </div>
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
            ) : hasActiveAlert ? (
              <span className="text-emerald-400 flex items-center gap-1.5">
                <Volume2 className="w-3.5 h-3.5" />
                <span>Audio ducking active when trigger radius is crossed</span>
              </span>
            ) : (
              <span className="text-slate-400 flex items-center gap-1.5">
                <VolumeX className="w-3.5 h-3.5 text-slate-500" />
                <span>Silent milestone &bull; Car audio will not be interrupted</span>
              </span>
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
