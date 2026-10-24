import { AI_UNAVAILABLE_SCOUT_MESSAGE, AI_UNAVAILABLE_TOOLTIP, AI_UNAVAILABLE_SHORT } from '../constants/aiCopy';
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Compass,
  Send,
  Plus,
  Check,
  Copy,
  RotateCcw,
  X,
  ChevronDown,
  Eye,
  Loader2,
  Sparkles,
  MapPin,
  Calendar,
  Layers,
  AlertCircle,
  Volume2,
  Search,
  Terminal,
  Globe,
  ChevronRight,
} from 'lucide-react';
import type {
  ScoutScope,
  ScoutSuggestion,
  ScoutMessage,
  ScoutActivity,
  ScoutTripContext,
  ScoutChatRequest,
} from '../types/scout';
import type { AiModelOption } from '../types/ai';
import type { ParsedTrip, ParsedDay } from '../engine/itineraryParser';
import type { Waypoint, WaypointType } from '../types/routing';
import type { ScheduledStop } from '../engine/types';
import type { ScoutPreviewPin } from './MapCanvas';
import { chatWithScoutStream, fetchScoutQuickPrompts } from '../services/api';

export interface RouteScoutDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  trip: ParsedTrip;
  activeDayIndex: number;
  activeDay: ParsedDay;
  waypoints: Waypoint[];
  scheduledStops?: ScheduledStop[];
  scope: ScoutScope;
  onChangeScope: (newScope: ScoutScope) => void;
  onAddWaypoint: (suggestion: ScoutSuggestion) => void;
  onUpdateWaypoint: (targetWaypointId: string, updates: Partial<Waypoint>) => void;
  onPreviewCoordinate: (pin: ScoutPreviewPin | null) => void;
  activePreviewPin?: ScoutPreviewPin | null;
  aiAvailable?: boolean;
  aiModels?: AiModelOption[];
  selectedModelId?: string;
  onSelectModel?: (modelId: string) => void;
  itineraryId?: string;
}

const DEFAULT_DRAWER_WIDTH = 400;
const MIN_DRAWER_WIDTH = 320;
const MAX_DRAWER_WIDTH = 640;

function getScopeKey(scope: ScoutScope, activeDayIndex: number): string {
  if (scope.type === 'waypoint') {
    return `wp:${scope.waypointId || 'unknown'}`;
  }
  return `day:${scope.dayNumber ?? activeDayIndex + 1}`;
}

function cleanStreamingText(raw: string): { content: string; thought?: string } {
  // Strip thinking/reasoning XML tags before stripping JSON blocks
  const withoutThinking = raw
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<(?:thinking|think)>[\s\S]*$/gi, '');

  const withoutJson = withoutThinking.replace(/```(?:json:suggestions|json)?[\s\S]*?(?:```|$)/i, '').trim();

  // Strip leading harness messages (e.g. "Wait for the background task to complete.")
  const leadingHarnessRegex = /^(?:Wait for the (?:background )?task to complete\.?|Waiting for (?:background )?task\.?|Wait for the command to finish\.?|Let me inspect[^.\n]*\.\s*)\s*/gi;
  const strippedLeading = withoutJson.replace(leadingHarnessRegex, '').trim();

  // Strip trailing meta-commentary about JSON / candidate cards below
  const trailingHarnessRegex = /\n+(?:I have (?:framed|attached|included|provided|appended|added) this as a candidate (?:update|stop|suggestion)[^\n]*|I have (?:appended|included|generated|provided) the (?:JSON|structured|candidate)[^\n]*|See the candidate (?:card|update|suggestion) below[^\n]*)\.?\s*$/gi;
  const stripped = strippedLeading.replace(trailingHarnessRegex, '').trim();

  const multiLineRegex = /^((?:I (?:have launched|am checking|am inspecting|will analyze|will inspect|will check|have initiated|need to inspect)[^\n]+(?:\n+|$))+)\n*([\s\S]*)$/i;
  const match = stripped.match(multiLineRegex);
  if (match && match[1] && match[2] && match[2].trim().length > 0) {
    return {
      thought: match[1].trim(),
      content: match[2].trim(),
    };
  }
  return { content: stripped };
}

// Interactive activity log showing abstracted tool execution, web lookups, and commands
function InvestigationActivityLog({ activities }: { activities: ScoutActivity[] }) {
  const [isExpanded, setIsExpanded] = useState(true);

  if (!activities || activities.length === 0) return null;

  const completedCount = activities.filter((a) => a.state === 'done').length;

  return (
    <div className="w-full mb-2 bg-slate-900/90 border border-slate-750/70 rounded-xl overflow-hidden text-[11px] shadow-sm select-none">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-2.5 py-1.5 bg-slate-800/80 hover:bg-slate-750/80 transition-colors text-left cursor-pointer"
      >
        <div className="flex items-center gap-1.5 text-cyan-400 font-mono text-[10px] font-bold uppercase tracking-wider">
          <Sparkles className="w-3 h-3 text-cyan-400 shrink-0" />
          <span>Investigation Activity ({completedCount}/{activities.length})</span>
        </div>
        <div className="flex items-center gap-1 text-slate-400 text-[10px]">
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="p-2 space-y-1.5 border-t border-slate-800/80 font-mono text-[10px]">
          {activities.map((act) => (
            <div key={act.id} className="flex items-start gap-2 text-slate-300">
              {act.state === 'active' ? (
                <Loader2 className="w-3 h-3 animate-spin text-cyan-400 shrink-0 mt-0.5" />
              ) : act.state === 'error' ? (
                <AlertCircle className="w-3 h-3 text-rose-400 shrink-0 mt-0.5" />
              ) : (
                <Check className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  {act.type === 'search' && <Search className="w-2.5 h-2.5 text-sky-400 shrink-0" />}
                  {act.type === 'command' && <Terminal className="w-2.5 h-2.5 text-amber-400 shrink-0" />}
                  {act.type === 'tool' && <Globe className="w-2.5 h-2.5 text-teal-400 shrink-0" />}
                  <span
                    className={`truncate ${
                      act.state === 'active' ? 'text-cyan-200 font-semibold' : 'text-slate-300'
                    }`}
                  >
                    {act.label}
                  </span>
                  {act.durationSeconds !== undefined && (
                    <span className="text-slate-500 shrink-0 text-[9px]">
                      ({act.durationSeconds.toFixed(1)}s)
                    </span>
                  )}
                </div>
                {act.detail && act.state === 'active' && (
                  <div className="text-slate-400 text-[9px] truncate pl-4">
                    {act.detail}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Markdown formatter for assistant responses powered by react-markdown + remark-gfm
function FormattedAssistantText({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-sm text-slate-200 leading-relaxed select-text cursor-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h2 className="text-base font-bold text-white mt-3.5 mb-1.5 border-b border-slate-750 pb-1">
              {children}
            </h2>
          ),
          h2: ({ children }) => (
            <h3 className="text-sm font-bold text-white mt-3 mb-1">{children}</h3>
          ),
          h3: ({ children }) => (
            <h4 className="text-xs font-bold uppercase tracking-wider text-cyan-300 mt-2.5 mb-1 flex items-center gap-1.5">
              <span className="w-1 h-3 bg-cyan-400 rounded-full shrink-0" />
              <span>{children}</span>
            </h4>
          ),
          h4: ({ children }) => (
            <h5 className="text-xs font-bold text-cyan-300 uppercase tracking-wider mt-2 mb-0.5">
              {children}
            </h5>
          ),
          p: ({ children }) => <p className="my-1.5 leading-relaxed">{children}</p>,
          strong: ({ children }) => (
            <strong className="text-white font-semibold">{children}</strong>
          ),
          em: ({ children }) => <em className="text-slate-200 italic">{children}</em>,
          code: ({ children }) => (
            <code className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-750 font-mono text-xs text-cyan-200">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="p-2 rounded-lg bg-slate-900 border border-slate-750 overflow-x-auto text-xs font-mono my-1.5 text-cyan-200">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-cyan-500/70 pl-2.5 py-0.5 my-1 bg-slate-900/50 rounded-r text-slate-300 italic">
              {children}
            </blockquote>
          ),
          ul: ({ children }) => (
            <ul className="list-disc list-inside space-y-1.5 my-1.5 pl-1 marker:text-cyan-400">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-inside space-y-1.5 my-1.5 pl-1 marker:text-cyan-400 marker:font-mono">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="text-slate-200 leading-relaxed">{children}</li>
          ),
          hr: () => <hr className="border-slate-700/80 my-2" />,
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="min-w-full text-left border-collapse border border-slate-750 text-xs">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-slate-700 px-2 py-1 bg-slate-800 font-bold text-white">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-slate-800 px-2 py-1 text-slate-300">
              {children}
            </td>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan-400 hover:text-cyan-300 underline"
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const RouteScoutDrawer: React.FC<RouteScoutDrawerProps> = ({
  isOpen,
  onClose,
  trip,
  activeDayIndex,
  activeDay,
  waypoints,
  scheduledStops,
  scope,
  onChangeScope,
  onAddWaypoint,
  onUpdateWaypoint,
  onPreviewCoordinate,
  activePreviewPin,
  aiAvailable = true,
  aiModels = [],
  selectedModelId,
  onSelectModel,
  itineraryId,
}) => {
  // Drawer width with localStorage persistence
  const [drawerWidth, setDrawerWidth] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('copilot_scout_width');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= MIN_DRAWER_WIDTH && parsed <= MAX_DRAWER_WIDTH) {
          return parsed;
        }
      }
    }
    return DEFAULT_DRAWER_WIDTH;
  });

  const [isDragging, setIsDragging] = useState(false);
  const dragStartXRef = useRef<number>(0);
  const startWidthRef = useRef<number>(DEFAULT_DRAWER_WIDTH);

  // Stream sequence & abort controller refs for async race and cancel safety
  const activeStreamAbortRef = useRef<AbortController | null>(null);
  const streamSeqRef = useRef<number>(0);

  // Derive stable itinerary identity (R6)
  const currentItineraryId = itineraryId || 'default-itinerary';
  const lastItineraryIdRef = useRef(currentItineraryId);

  // Active turn tracking for prompt cleanup on interrupt / scope-away / close (R7)
  const activeTurnRef = useRef<{ convKey: string; assistantMsgId: string } | null>(null);

  // Multi-turn conversations keyed by itinerary and scope (`<itinerary>:<scope>`)
  const [conversations, setConversations] = useState<Record<string, ScoutMessage[]>>({});
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [activeAssistantMsgId, setActiveAssistantMsgId] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Helper to abort in-flight work and prune empty assistant placeholder messages (R7)
  const cancelActiveTurn = useCallback(() => {
    streamSeqRef.current += 1;
    activeStreamAbortRef.current?.abort();
    activeStreamAbortRef.current = null;
    setIsLoading(false);
    setActiveAssistantMsgId(null);

    const activeTurn = activeTurnRef.current;
    activeTurnRef.current = null;
    if (!activeTurn) {
      return;
    }

    setConversations((prev) => {
      const list = prev[activeTurn.convKey];
      if (!list) return prev;

      const filtered = list.filter((m) => {
        if (m.id === activeTurn.assistantMsgId) {
          const hasProse = Boolean(m.content && m.content.trim());
          const hasSuggestions = Boolean(m.suggestions && m.suggestions.length > 0);
          if (!hasProse && !hasSuggestions) {
            return false;
          }
        }
        return true;
      });

      if (filtered.length === list.length) {
        return prev;
      }
      return {
        ...prev,
        [activeTurn.convKey]: filtered,
      };
    });
  }, []);

  // Timer while analyzing to provide continuous feedback
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    if (isLoading) {
      setElapsedSeconds(0);
      interval = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);
    } else {
      setElapsedSeconds(0);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isLoading]);

  // Track added and updated suggestions for UI feedback
  const [addedSuggestionIds, setAddedSuggestionIds] = useState<Set<string>>(new Set());
  const [updatedSuggestionIds, setUpdatedSuggestionIds] = useState<Set<string>>(new Set());

  // Copy-to-clipboard state
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  // Scope dropdown
  const [isScopeDropdownOpen, setIsScopeDropdownOpen] = useState(false);
  const scopeDropdownRef = useRef<HTMLDivElement>(null);

  // Quick prompt chips
  const [quickPrompts, setQuickPrompts] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-expanding textarea height adjustment (clamped between 38px and 120px)
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      const scrollH = inputRef.current.scrollHeight;
      const newHeight = Math.min(Math.max(scrollH, 38), 120);
      inputRef.current.style.height = `${newHeight}px`;
    }
  }, [inputText]);

  const handleCopyMessage = async (msgId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(msgId);
      setTimeout(() => {
        setCopiedMessageId((prev) => (prev === msgId ? null : prev));
      }, 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  // Invalidate in-flight streams and reset conversation state on itinerary replacement
  useEffect(() => {
    if (lastItineraryIdRef.current !== currentItineraryId) {
      lastItineraryIdRef.current = currentItineraryId;
      cancelActiveTurn();
      setConversations({});
      setErrorMessage(null);
      setAddedSuggestionIds(new Set());
      setUpdatedSuggestionIds(new Set());
    }
  }, [currentItineraryId, cancelActiveTurn]);

  // Drawer close cleanup: abort in-flight work and prune empty assistant placeholder (R7)
  useEffect(() => {
    if (!isOpen) {
      cancelActiveTurn();
    }
  }, [isOpen, cancelActiveTurn]);

  // Unmount cleanup
  useEffect(() => {
    return () => {
      cancelActiveTurn();
    };
  }, [cancelActiveTurn]);

  const scoutModels = useMemo(
    () => (aiModels || []).filter((m) => m.role === 'scout' || m.role === 'both'),
    [aiModels]
  );
  const hasSelectedModel = Boolean(
    selectedModelId && scoutModels.some((m) => m.id === selectedModelId)
  );

  const currentScopeKey = useMemo(
    () => getScopeKey(scope, activeDayIndex),
    [scope, activeDayIndex]
  );
  const lastScopeKeyRef = useRef(currentScopeKey);

  // Scope switch cleanup: abort in-flight work and prune empty assistant placeholder (R7)
  useEffect(() => {
    if (lastScopeKeyRef.current !== currentScopeKey) {
      lastScopeKeyRef.current = currentScopeKey;
      cancelActiveTurn();
      setErrorMessage(null);
    }
  }, [currentScopeKey, cancelActiveTurn]);

  const conversationKey = `${currentItineraryId}:${currentScopeKey}`;
  const currentMessages = useMemo(
    () => conversations[conversationKey] || [],
    [conversations, conversationKey]
  );

  // Load quick prompts when scope changes
  useEffect(() => {
    let isCancelled = false;
    const loadPrompts = async () => {
      try {
        const result = await fetchScoutQuickPrompts(scope);
        if (!isCancelled) {
          setQuickPrompts(result);
        }
      } catch {
        if (!isCancelled) {
          // Fallback prompts
          setQuickPrompts(
            scope.type === 'waypoint'
              ? [
                  'Is the coordinate directly on the highway without exiting?',
                  'Verify if this is an authentic commercial location or off-route',
                  'Check parking, fuel pumps & restroom accessibility',
                  'Recommended dwell time for this stop',
                ]
              : [
                  'Where should we stop for lunch along this leg?',
                  'Audit route for off-highway detours and broken coordinates',
                  'Verify all drive-by waypoints stay on the highway',
                  'Check fuel stops: verify gas stations, pumps & restrooms',
                ]
          );
        }
      }
    };
    loadPrompts();
    return () => {
      isCancelled = true;
    };
  }, [scope.type, scope.waypointName]);

  // Reconcile scope if focused waypoint does not exist in active day waypoints
  useEffect(() => {
    if (scope.type === 'waypoint' && waypoints.length > 0) {
      const exists = waypoints.some((w) => w.id === scope.waypointId);
      if (!exists) {
        onChangeScope({
          type: 'day',
          dayNumber: activeDay.dayNumber,
          dayTitle: activeDay.title,
        });
      }
    }
  }, [waypoints, scope.type, scope.waypointId, activeDay.dayNumber, activeDay.title, onChangeScope]);

  // Auto-scroll to bottom when messages update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentMessages, isLoading]);

  // Drag resizing for right-hand drawer (dragging left increases width)
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartXRef.current = e.clientX;
    startWidthRef.current = drawerWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const deltaX = dragStartXRef.current - e.clientX;
      const newWidth = Math.min(
        Math.max(startWidthRef.current + deltaX, MIN_DRAWER_WIDTH),
        MAX_DRAWER_WIDTH
      );
      setDrawerWidth(newWidth);
    };

    const handleMouseUp = () => {
      if (isDragging) {
        setIsDragging(false);
        document.body.style.cursor = 'default';
        document.body.style.userSelect = 'auto';
        localStorage.setItem('copilot_scout_width', drawerWidth.toString());
      }
    };

    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, drawerWidth]);

  // Close scope dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        scopeDropdownRef.current &&
        !scopeDropdownRef.current.contains(e.target as Node)
      ) {
        setIsScopeDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Send message to Route Scout
  const handleSendMessage = async (textToSend?: string) => {
    const messageContent = (textToSend ?? inputText).trim();
    if (!messageContent || isLoading || !hasSelectedModel || !aiAvailable) return;

    setErrorMessage(null);
    setInputText('');

    const seq = ++streamSeqRef.current;
    activeStreamAbortRef.current?.abort();
    const abortController = new AbortController();
    activeStreamAbortRef.current = abortController;

    const userMessage: ScoutMessage = {
      id: `msg_u_${Date.now()}`,
      role: 'user',
      content: messageContent,
      timestamp: Date.now(),
    };

    const assistantMsgId = `msg_a_${Date.now()}`;
    const initialAssistantMessage: ScoutMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };

    const startedItineraryId = currentItineraryId;
    const targetConvKey = conversationKey;
    activeTurnRef.current = { convKey: targetConvKey, assistantMsgId };
    setActiveAssistantMsgId(assistantMsgId);

    // Update conversation with user message and placeholder assistant message
    const updatedHistory = [...currentMessages, userMessage];
    setConversations((prev) => ({
      ...prev,
      [targetConvKey]: [...updatedHistory, initialAssistantMessage],
    }));

    setIsLoading(true);

    try {
      const calcDistanceMiles = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
        const R = 3958.8; // miles
        const dLat = ((lat2 - lat1) * Math.PI) / 180;
        const dLon = ((lon2 - lon1) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos((lat1 * Math.PI) / 180) *
            Math.cos((lat2 * Math.PI) / 180) *
            Math.sin(dLon / 2) *
            Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return Number((R * c).toFixed(1));
      };

      const focusedWpIndex =
        scope.type === 'waypoint'
          ? waypoints.findIndex((w) => w.id === scope.waypointId)
          : -1;
      const focusedWp = focusedWpIndex >= 0 ? waypoints[focusedWpIndex] : undefined;

      const precedingWp =
        focusedWpIndex > 0 ? waypoints[focusedWpIndex - 1] : undefined;
      const followingWp =
        focusedWpIndex >= 0 && focusedWpIndex < waypoints.length - 1
          ? waypoints[focusedWpIndex + 1]
          : undefined;

      const precedingRef =
        precedingWp && focusedWp
          ? {
              id: precedingWp.id,
              name: precedingWp.name,
              type: precedingWp.type,
              distanceMiles: calcDistanceMiles(
                precedingWp.lat,
                precedingWp.lng,
                focusedWp.lat,
                focusedWp.lng
              ),
            }
          : undefined;

      const followingRef =
        followingWp && focusedWp
          ? {
              id: followingWp.id,
              name: followingWp.name,
              type: followingWp.type,
              distanceMiles: calcDistanceMiles(
                focusedWp.lat,
                focusedWp.lng,
                followingWp.lat,
                followingWp.lng
              ),
            }
          : undefined;

      const tripContext: ScoutTripContext = {
        tripName: trip.tripName,
        date: activeDay.date,
        origin: activeDay.origin,
        destination: activeDay.destination,
        departureTime: activeDay.departureTime,
        corridor:
          activeDay.origin && activeDay.destination
            ? `${activeDay.origin} → ${activeDay.destination}`
            : undefined,
        waypoints: waypoints.map((w, idx) => {
          const stop = scheduledStops?.[idx];
          const legDriveSec = stop?.driveDurationFromPreviousSeconds ?? 0;
          const legDistMi = stop?.driveDistanceMilesFromPrevious ?? 0;
          const driveSpeedMph =
            legDriveSec > 0 && legDistMi > 0
              ? Number((legDistMi / (legDriveSec / 3600)).toFixed(1))
              : undefined;

          return {
            id: w.id,
            name: w.name,
            type: w.type,
            lat: w.lat,
            lng: w.lng,
            target_time: w.target_time,
            dwell_minutes: w.dwell_minutes,
            trigger_radius_miles: w.trigger_radius_miles,
            notes: w.notes,
            place_name: w.place_name,
            notification: w.notification,
            address: w.address,
            google_place_id: w.google_place_id,
            is_route_anchor: w.is_route_anchor,
            drive_duration_minutes: idx === 0 ? 0 : Math.round(legDriveSec / 60),
            drive_distance_miles: idx === 0 ? 0 : legDistMi,
            drive_speed_mph: driveSpeedMph,
            timezone: stop?.timezone || w.timezone,
          };
        }),
        focusedWaypoint: focusedWp
          ? (() => {
              const stop = focusedWpIndex >= 0 ? scheduledStops?.[focusedWpIndex] : undefined;
              const legDriveSec = stop?.driveDurationFromPreviousSeconds ?? 0;
              const legDistMi = stop?.driveDistanceMilesFromPrevious ?? 0;
              const driveSpeedMph =
                legDriveSec > 0 && legDistMi > 0
                  ? Number((legDistMi / (legDriveSec / 3600)).toFixed(1))
                  : undefined;
              return {
                id: focusedWp.id,
                name: focusedWp.name,
                type: focusedWp.type,
                lat: focusedWp.lat,
                lng: focusedWp.lng,
                target_time: focusedWp.target_time,
                dwell_minutes: focusedWp.dwell_minutes,
                trigger_radius_miles: focusedWp.trigger_radius_miles,
                notes: focusedWp.notes,
                place_name: focusedWp.place_name,
                notification: focusedWp.notification,
                address: focusedWp.address,
                google_place_id: focusedWp.google_place_id,
                is_route_anchor: focusedWp.is_route_anchor,
                drive_duration_minutes: focusedWpIndex === 0 ? 0 : Math.round(legDriveSec / 60),
                drive_distance_miles: focusedWpIndex === 0 ? 0 : legDistMi,
                drive_speed_mph: driveSpeedMph,
                timezone: stop?.timezone || focusedWp.timezone,
              };
            })()
          : undefined,
        focusedWaypointIndex: focusedWpIndex >= 0 ? focusedWpIndex + 1 : undefined,
        totalWaypoints: waypoints.length,
        precedingWaypoint: precedingRef,
        followingWaypoint: followingRef,
      };

      const request: ScoutChatRequest = {
        scope,
        messages: updatedHistory.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        tripContext,
        sessionId: `scout_${startedItineraryId}_${currentScopeKey}`,
        modelId: selectedModelId,
      };

      let accumulatedRaw = '';
      let currentThought: string | undefined = undefined;
      let accumulatedSuggestions: ScoutSuggestion[] = [];

      await chatWithScoutStream(
        request,
        (event) => {
          if (seq !== streamSeqRef.current || currentItineraryId !== startedItineraryId) return;
          if (event.event === 'activity') {
          const act = event.data;
          currentThought = act.label;
          setConversations((prev) => {
            const list = prev[targetConvKey] || [];
            return {
              ...prev,
              [targetConvKey]: list.map((m) => {
                if (m.id !== assistantMsgId) return m;
                const existing = m.activities || [];
                const idx = existing.findIndex((a) => a.id === act.id);
                let nextActivities: ScoutActivity[];
                if (idx >= 0) {
                  nextActivities = [...existing];
                  nextActivities[idx] = act;
                } else {
                  nextActivities = [...existing, act];
                }
                return {
                  ...m,
                  thought: act.label,
                  activities: nextActivities,
                };
              }),
            };
          });
        } else if (event.event === 'thought') {
          currentThought = event.data.text;
          setConversations((prev) => {
            const list = prev[targetConvKey] || [];
            return {
              ...prev,
              [targetConvKey]: list.map((m) =>
                m.id === assistantMsgId ? { ...m, thought: currentThought } : m
              ),
            };
          });
        } else if (event.event === 'delta') {
          accumulatedRaw += event.data.text;
          const { content: cleanedContent, thought: detectedThought } =
            cleanStreamingText(accumulatedRaw);
          const effectiveThought = detectedThought || currentThought;

          setConversations((prev) => {
            const list = prev[targetConvKey] || [];
            return {
              ...prev,
              [targetConvKey]: list.map((m) =>
                m.id === assistantMsgId
                  ? {
                      ...m,
                      content: cleanedContent,
                      thought: effectiveThought,
                    }
                  : m
              ),
            };
          });
        } else if (event.event === 'suggestions') {
          accumulatedSuggestions = event.data.suggestions;
          setConversations((prev) => {
            const list = prev[targetConvKey] || [];
            return {
              ...prev,
              [targetConvKey]: list.map((m) =>
                m.id === assistantMsgId
                  ? { ...m, suggestions: accumulatedSuggestions }
                  : m
              ),
            };
          });
        } else if (event.event === 'done') {
          activeTurnRef.current = null;
          setActiveAssistantMsgId(null);
          const finalResp = event.data;
          setConversations((prev) => {
            const list = prev[targetConvKey] || [];
            return {
              ...prev,
              [targetConvKey]: list.map((m) =>
                m.id === assistantMsgId
                  ? {
                      ...m,
                      engine: finalResp.engine,
                      content: finalResp.reply,
                      thought: finalResp.thought || m.thought,
                      suggestions:
                        finalResp.suggestions.length > 0
                          ? finalResp.suggestions
                          : m.suggestions,
                      activities: finalResp.activities || m.activities,
                    }
                  : m
              ),
            };
          });
        }
      },
      abortController.signal
    );
    } catch (err: unknown) {
      if (seq !== streamSeqRef.current || currentItineraryId !== startedItineraryId) return;
      activeTurnRef.current = null;
      setActiveAssistantMsgId(null);
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : 'Route Scout request failed';
      setErrorMessage(msg);
      // Remove empty assistant message if it failed before receiving content or suggestions
      setConversations((prev) => {
        const list = prev[targetConvKey] || [];
        return {
          ...prev,
          [targetConvKey]: list.filter(
            (m) =>
              !(
                m.id === assistantMsgId &&
                !m.content.trim() &&
                (!m.suggestions || m.suggestions.length === 0)
              )
          ),
        };
      });
    } finally {
      if (seq === streamSeqRef.current && currentItineraryId === startedItineraryId) {
        setIsLoading(false);
        activeTurnRef.current = null;
        setActiveAssistantMsgId(null);
        if (activeStreamAbortRef.current === abortController) {
          activeStreamAbortRef.current = null;
        }
      }
    }
  };

  // Clear conversation for current scope
  const handleClearChat = () => {
    cancelActiveTurn();
    setConversations((prev) => ({
      ...prev,
      [conversationKey]: [],
    }));
    setErrorMessage(null);
  };

  // Suggestion action handlers
  const handleAddSuggestion = (suggestion: ScoutSuggestion) => {
    onAddWaypoint(suggestion);
    setAddedSuggestionIds((prev) => new Set([...prev, suggestion.id]));
  };

  const handleUpdateSuggestion = (suggestion: ScoutSuggestion) => {
    const targetId = suggestion.targetWaypointId || scope.waypointId;
    if (!targetId) return;

    onUpdateWaypoint(targetId, {
      ...(suggestion.newId ? { id: suggestion.newId } : {}),
      name: suggestion.name,
      type: suggestion.type as WaypointType,
      lat: suggestion.lat,
      lng: suggestion.lng,
      dwell_minutes: suggestion.dwell_minutes,
      trigger_radius_miles: suggestion.trigger_radius_miles,
      ...(suggestion.place_name ? { place_name: suggestion.place_name } : {}),
      ...(suggestion.address ? { address: suggestion.address } : {}),
      ...(suggestion.google_place_id ? { google_place_id: suggestion.google_place_id } : {}),
      ...(suggestion.is_route_anchor !== undefined ? { is_route_anchor: suggestion.is_route_anchor } : {}),
      ...(suggestion.notification ? { notification: suggestion.notification } : {}),
    });
    setUpdatedSuggestionIds((prev) => new Set([...prev, suggestion.id]));
  };

  const handleTogglePreview = (suggestion: ScoutSuggestion) => {
    const isCurrentlyPreviewed =
      activePreviewPin &&
      Math.abs(activePreviewPin.lat - suggestion.lat) < 0.0001 &&
      Math.abs(activePreviewPin.lng - suggestion.lng) < 0.0001;

    if (isCurrentlyPreviewed) {
      onPreviewCoordinate(null);
    } else {
      onPreviewCoordinate({
        lat: suggestion.lat,
        lng: suggestion.lng,
        name: suggestion.name,
      });
    }
  };

  if (!isOpen) {
    return null;
  }

  const activeWaypoint =
    scope.type === 'waypoint'
      ? waypoints.find((w) => w.id === scope.waypointId)
      : null;

  return (
    <aside
      style={{ width: `${drawerWidth}px` }}
      className="relative h-full flex flex-col bg-slate-900 border-l border-slate-800 text-slate-100 shrink-0 z-20 shadow-2xl animate-fade-in"
    >
      {/* Resizing Drag Handle (Left Edge) */}
      <div
        onMouseDown={handleMouseDown}
        className="absolute top-0 -left-1 w-2.5 h-full cursor-col-resize hover:bg-cyan-500/50 transition-colors z-30 group flex items-center justify-center select-none"
        title="Drag to resize Route Scout panel"
      >
        <div className="w-0.5 h-8 bg-slate-600 group-hover:bg-cyan-400 rounded-full transition-colors" />
      </div>

      {/* Header: Branding, Scope Switcher & Actions */}
      <div className="p-3.5 border-b border-slate-800 bg-slate-900/95 backdrop-blur-md">
        <div className="flex items-center justify-between gap-2">
          {/* Branding */}
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-cyan-600 to-sky-500 flex items-center justify-center shadow-md shadow-cyan-950/40">
              <Compass className="w-4 h-4 text-white" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight flex items-center gap-1.5">
                <span>Route Scout</span>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-cyan-950/70 border border-cyan-800/60 text-cyan-300">
                  AI
                </span>
              </h2>
            </div>
          </div>

          {/* Action Buttons: Clear Chat & Close */}
          <div className="flex items-center gap-1">
            {currentMessages.length > 0 && (
              <button
                onClick={handleClearChat}
                className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                title="Clear chat for this scope"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
              title="Close Route Scout"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Scope Selector Bar */}
        <div className="mt-2.5 relative" ref={scopeDropdownRef}>
          <button
            onClick={() => setIsScopeDropdownOpen(!isScopeDropdownOpen)}
            className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 bg-slate-800/90 hover:bg-slate-800 border border-slate-700/80 rounded-xl text-xs text-left transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2 min-w-0">
              {scope.type === 'day' ? (
                <Calendar className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              ) : (
                <MapPin className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              )}
              <div className="min-w-0">
                <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 block leading-none">
                  {scope.type === 'day' ? 'Day Scope' : 'Waypoint Scope'}
                </span>
                <span className="font-semibold text-white truncate block text-xs mt-0.5">
                  {scope.type === 'day'
                    ? `Day ${scope.dayNumber ?? activeDayIndex + 1}: ${
                        scope.dayTitle || activeDay.title || 'Driving Leg'
                      }`
                    : `Stop: ${scope.waypointName || activeWaypoint?.name || 'Waypoint'}`}
                </span>
              </div>
            </div>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          </button>

          {/* Scope Dropdown Menu */}
          {isScopeDropdownOpen && (
            <div className="absolute left-0 right-0 mt-1.5 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50 overflow-hidden py-1 max-h-64 overflow-y-auto backdrop-blur-md">
              <div className="px-2.5 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Drive Corridor
              </div>
              <button
                onClick={() => {
                  onChangeScope({
                    type: 'day',
                    dayNumber: activeDay.dayNumber,
                    dayTitle: activeDay.title,
                  });
                  setIsScopeDropdownOpen(false);
                }}
                className={`w-full px-2.5 py-1.5 text-xs text-left flex items-center gap-2 transition-colors cursor-pointer ${
                  scope.type === 'day'
                    ? 'bg-cyan-950/60 text-cyan-300 font-semibold border-l-2 border-cyan-400'
                    : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Calendar className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                <span className="truncate">
                  Day {activeDay.dayNumber}: {activeDay.title}
                </span>
              </button>

              {waypoints.length > 0 && (
                <>
                  <div className="px-2.5 py-1 mt-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider border-t border-slate-800">
                    Individual Waypoints
                  </div>
                  {waypoints.map((wp, idx) => (
                    <button
                      key={wp.id}
                      onClick={() => {
                        onChangeScope({
                          type: 'waypoint',
                          waypointId: wp.id,
                          waypointName: wp.name,
                        });
                        setIsScopeDropdownOpen(false);
                      }}
                      className={`w-full px-2.5 py-1.5 text-xs text-left flex items-center gap-2 transition-colors cursor-pointer ${
                        scope.type === 'waypoint' && scope.waypointId === wp.id
                          ? 'bg-amber-950/60 text-amber-300 font-semibold border-l-2 border-amber-400'
                          : 'text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      <span className="w-4 h-4 rounded-full bg-slate-800 text-[10px] font-mono font-bold flex items-center justify-center shrink-0">
                        {idx + 1}
                      </span>
                      <span className="truncate">{wp.name}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {/* Model Selector UI in Drawer Header */}
        {scoutModels.length > 0 && (
          <div className="mt-2 flex items-center justify-between gap-2 px-2.5 py-1.5 bg-slate-800/60 border border-slate-700/60 rounded-xl text-xs">
            <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 shrink-0">
              Model
            </span>
            <select
              aria-label="Route Scout AI Model"
              value={hasSelectedModel ? selectedModelId : ''}
              onChange={(e) => onSelectModel?.(e.target.value)}
              disabled={isLoading}
              className="bg-transparent text-xs font-medium text-cyan-300 focus:outline-none truncate cursor-pointer disabled:opacity-50"
            >
              {!hasSelectedModel && (
                <option value="" disabled className="bg-slate-900 text-slate-400">
                  Select model...
                </option>
              )}
              {scoutModels.map((m) => (
                <option key={m.id} value={m.id} className="bg-slate-900 text-slate-100">
                  {m.name} ({m.provider})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {!aiAvailable && (
          <div className="p-3 bg-slate-900/90 border border-slate-800 rounded-2xl text-xs text-slate-300 flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-white">Route Scout Unavailable</span>
              <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                {AI_UNAVAILABLE_SCOUT_MESSAGE}
              </p>
            </div>
          </div>
        )}

        {/* Empty state & Quick Prompts */}
        {currentMessages.length === 0 && (
          <div className="space-y-4 py-2">
            <div className="p-3.5 bg-slate-950/60 border border-slate-800 rounded-2xl">
              <div className="flex items-center gap-2 mb-1.5">
                <Sparkles className="w-4 h-4 text-cyan-400" />
                <h3 className="text-sm font-bold text-white">
                  {scope.type === 'day'
                    ? 'Day Corridor Advisor'
                    : 'Waypoint Verification & Advice'}
                </h3>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                {scope.type === 'day'
                  ? `Ask about overlooks, vetted lunch spots, or fuel stops along Day ${
                      scope.dayNumber ?? activeDayIndex + 1
                    }. Route Scout will inspect the road corridor and provide actionable suggestion cards.`
                  : `Ask about accessibility, tribal land permits, photo spots, or timing for "${
                      scope.waypointName || activeWaypoint?.name || 'this stop'
                    }".`}
              </p>
            </div>

            {/* Quick Prompts */}
            {quickPrompts.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs font-semibold text-slate-400 px-1">
                  Suggested Questions:
                </div>
                <div className="space-y-1.5">
                  {quickPrompts.map((prompt, i) => (
                    <button
                      key={i}
                      onClick={aiAvailable && hasSelectedModel && !isLoading ? () => handleSendMessage(prompt) : undefined}
                      disabled={!aiAvailable || !hasSelectedModel || isLoading}
                      className={`w-full text-left p-2.5 rounded-xl border text-xs transition-all flex items-center justify-between group ${
                        !aiAvailable || !hasSelectedModel || isLoading
                          ? 'bg-slate-850 border-slate-800 text-slate-500 cursor-not-allowed opacity-60'
                          : 'bg-slate-800/70 hover:bg-slate-800 border-slate-700/60 hover:border-cyan-500/50 text-cyan-200 cursor-pointer'
                      }`}
                      title={
                        !aiAvailable
                          ? AI_UNAVAILABLE_TOOLTIP
                          : !hasSelectedModel
                          ? 'Select an AI model in the header to ask Route Scout'
                          : undefined
                      }
                    >
                      <span>{prompt}</span>
                      <Send className="w-3.5 h-3.5 text-cyan-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-2" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Message Thread */}
        {currentMessages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col ${
              msg.role === 'user' ? 'items-end' : 'items-start w-full'
            }`}
          >
            {msg.role === 'user' ? (
              // User message bubble
              <div className="max-w-[85%] bg-gradient-to-r from-sky-600 to-indigo-600 text-white rounded-2xl rounded-tr-sm px-3.5 py-2.5 text-sm shadow-md select-text cursor-text leading-relaxed">
                {msg.content}
              </div>
            ) : (
              // Assistant message bubble
              <div className="w-full space-y-2 select-text cursor-text">
                <div className="w-full bg-slate-850 border border-slate-750 rounded-2xl rounded-tl-sm p-3.5 shadow-md">
                  <div className="flex items-center justify-between gap-1 mb-2 select-none">
                    <div className="flex items-center gap-1.5 text-cyan-400">
                      <Compass className="w-3.5 h-3.5" />
                      <span className="text-[11px] font-bold uppercase tracking-wider">
                        Route Scout
                      </span>
                      {msg.engine && (
                        <span className="text-[9px] font-mono px-1.5 py-0.2 rounded border bg-slate-800 text-slate-300 border-slate-700">
                          AI Assistant
                        </span>
                      )}
                    </div>
                    {msg.content && (
                      <button
                        onClick={() => handleCopyMessage(msg.id, msg.content)}
                        className="p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors cursor-pointer"
                        title="Copy response to clipboard"
                      >
                        {copiedMessageId === msg.id ? (
                          <span className="text-[10px] text-emerald-400 flex items-center gap-1 font-mono font-medium">
                            <Check className="w-3 h-3" />
                            <span>Copied</span>
                          </span>
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                      </button>
                    )}
                  </div>

                  {msg.activities && msg.activities.length > 0 ? (
                    <InvestigationActivityLog activities={msg.activities} />
                  ) : msg.thought ? (
                    <div className="mb-2 px-3 py-2 bg-slate-800/80 border border-slate-700/60 rounded-xl text-xs text-slate-300 flex items-start gap-2">
                      <Sparkles className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
                      <div className="leading-snug">
                        <span className="text-[11px] font-bold text-cyan-400 uppercase tracking-wider block font-mono">
                          Scout Investigation
                        </span>
                        <span className="italic text-slate-300">{msg.thought}</span>
                      </div>
                    </div>
                  ) : null}

                  {msg.content ? (
                    <FormattedAssistantText text={msg.content} />
                  ) : isLoading && (activeAssistantMsgId === msg.id || activeTurnRef.current?.assistantMsgId === msg.id) ? (
                    <div className="flex items-center gap-2 text-slate-400 text-xs py-1">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400 shrink-0" />
                      <span>
                        {msg.thought || 'Route Scout is analyzing route geometry & corridor...'}
                        {elapsedSeconds > 1 && (
                          <span className="font-mono text-cyan-400 text-[11px] ml-1.5 font-medium">
                            ({elapsedSeconds}s)
                          </span>
                        )}
                      </span>
                    </div>
                  ) : null}
                </div>

                {/* Structured Suggestion Action Cards */}
                {msg.suggestions && msg.suggestions.length > 0 && (
                  <div className="space-y-2 pt-1">
                    <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider px-1 flex items-center gap-1.5">
                      <Layers className="w-3.5 h-3.5 text-cyan-400" />
                      <span>Actionable Suggestions ({msg.suggestions.length})</span>
                    </div>

                    {msg.suggestions.map((sug) => {
                      const isAdded = addedSuggestionIds.has(sug.id);
                      const isUpdated = updatedSuggestionIds.has(sug.id);
                      const isPreviewed =
                        activePreviewPin &&
                        Math.abs(activePreviewPin.lat - sug.lat) < 0.0001 &&
                        Math.abs(activePreviewPin.lng - sug.lng) < 0.0001;

                      return (
                        <div
                          key={sug.id}
                          className="bg-slate-950/85 border border-slate-800 hover:border-slate-700 rounded-xl p-3 space-y-2 transition-colors shadow-lg"
                        >
                          {/* Card Header: Type Badge & Name */}
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="flex items-center gap-1.5 mb-0.5">
                                <span className="text-[11px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider bg-slate-800 text-cyan-300 font-mono">
                                  {sug.type.replace(/_/g, ' ')}
                                </span>
                                <span className="text-[11px] text-slate-400 font-mono">
                                  {sug.action === 'add_waypoint' ? 'New Stop' : 'Update'}
                                </span>
                              </div>
                              <h4 className="text-sm font-bold text-white leading-snug">
                                {sug.name}
                              </h4>
                            </div>
                          </div>

                          {/* Reason */}
                          <p className="text-xs text-slate-300 leading-relaxed italic">
                            &ldquo;{sug.reason}&rdquo;
                          </p>

                          {/* Metadata row */}
                          <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono bg-slate-900/80 px-2 py-1 rounded-lg">
                            <span>
                              {sug.lat.toFixed(4)}, {sug.lng.toFixed(4)}
                            </span>
                            <div className="flex items-center gap-2">
                              {sug.dwell_minutes !== undefined && (
                                <span>{sug.dwell_minutes}m dwell</span>
                              )}
                              {sug.trigger_radius_miles !== undefined && (
                                <span>{sug.trigger_radius_miles}mi alert</span>
                              )}
                            </div>
                          </div>

                          {/* Sync ID Badge */}
                          {sug.newId && (
                            <div className="flex items-center gap-1.5 text-[11px] text-cyan-300 font-mono px-0.5">
                              <span className="text-slate-400">Sync ID:</span>
                              <span className="bg-slate-900 border border-cyan-800/60 px-1.5 py-0.5 rounded text-cyan-200">
                                {sug.newId}
                              </span>
                            </div>
                          )}

                          {/* Navigation & Address Metadata Badges */}
                          {(sug.is_route_anchor || sug.address || sug.google_place_id || sug.place_name) && (
                            <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono px-0.5">
                              {sug.place_name && sug.place_name !== sug.name && (
                                <span className="inline-flex items-center gap-1 bg-teal-950/70 border border-teal-800/80 text-teal-300 px-1.5 py-0.5 rounded" title={`Google Maps Query: ${sug.place_name}`}>
                                  🗺️ {sug.place_name}
                                </span>
                              )}
                              {sug.is_route_anchor && (sug.type === 'scenic_drive_by' || sug.dwell_minutes === 0) && (
                                <span className="inline-flex items-center gap-1 bg-amber-950/70 border border-amber-800/80 text-amber-300 px-1.5 py-0.5 rounded font-semibold" title="Route-forcing pass-through pin on highway">
                                  ⚓ Route Anchor
                                </span>
                              )}
                              {sug.google_place_id && (
                                <span className="inline-flex items-center gap-1 bg-sky-950/70 border border-sky-800/80 text-sky-300 px-1.5 py-0.5 rounded" title={sug.google_place_id}>
                                  📍 Place ID
                                </span>
                              )}
                              {sug.address && (
                                <span className="text-slate-400 truncate max-w-[240px]" title={sug.address}>
                                  {sug.address}
                                </span>
                              )}
                            </div>
                          )}

                          {/* Alert & Audio Notification Preview */}
                          {sug.notification && (
                            <div className="bg-slate-900/80 border border-slate-800/90 rounded-lg p-2 space-y-1 text-xs">
                              <div className="flex items-center gap-1.5 text-cyan-300 font-semibold text-[11px] uppercase tracking-wider">
                                <Volume2 className="w-3 h-3 text-cyan-400 shrink-0" />
                                <span className="truncate">Alert: {sug.notification.title}</span>
                              </div>
                              {sug.notification.speech && (
                                <p className="text-slate-300 text-[11px] italic leading-snug line-clamp-2">
                                  &ldquo;{sug.notification.speech}&rdquo;
                                </p>
                              )}
                            </div>
                          )}

                          {/* Action Buttons */}
                          <div className="flex items-center gap-1.5 pt-1">
                            {/* Preview on Map */}
                            <button
                              onClick={() => handleTogglePreview(sug)}
                              className={`flex-1 flex items-center justify-center gap-1 py-1 px-2 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                                isPreviewed
                                  ? 'bg-cyan-950/80 border-cyan-500 text-cyan-300'
                                  : 'bg-slate-800 hover:bg-slate-750 border-slate-700 text-slate-200 hover:text-white'
                              }`}
                              title="Preview coordinate on Leaflet map"
                            >
                              <Eye className="w-3 h-3 text-cyan-400" />
                              <span>{isPreviewed ? 'Previewing ★' : 'Preview'}</span>
                            </button>

                            {/* Add to Day Button */}
                            {sug.action === 'add_waypoint' && (
                              <button
                                onClick={() => handleAddSuggestion(sug)}
                                disabled={isAdded}
                                className={`flex-1 flex items-center justify-center gap-1 py-1 px-2 rounded-lg text-xs font-semibold transition-all cursor-pointer disabled:cursor-default ${
                                  isAdded
                                    ? 'bg-emerald-950/80 border border-emerald-600 text-emerald-300'
                                    : 'bg-sky-600 hover:bg-sky-500 text-white shadow-sm'
                                }`}
                              >
                                {isAdded ? (
                                  <>
                                    <Check className="w-3 h-3 text-emerald-400" />
                                    <span>Added ✓</span>
                                  </>
                                ) : (
                                  <>
                                    <Plus className="w-3 h-3" />
                                    <span>Add to Day</span>
                                  </>
                                )}
                              </button>
                            )}

                            {/* Update Waypoint Button */}
                            {sug.action === 'update_waypoint' && (
                              <button
                                onClick={() => handleUpdateSuggestion(sug)}
                                disabled={isUpdated}
                                className={`flex-1 flex items-center justify-center gap-1 py-1 px-2 rounded-lg text-xs font-semibold transition-all cursor-pointer disabled:cursor-default ${
                                  isUpdated
                                    ? 'bg-emerald-950/80 border border-emerald-600 text-emerald-300'
                                    : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm'
                                }`}
                              >
                                {isUpdated ? (
                                  <>
                                    <Check className="w-3 h-3 text-emerald-400" />
                                    <span>Updated ✓</span>
                                  </>
                                ) : (
                                  <>
                                    <Check className="w-3 h-3" />
                                    <span>Update Stop</span>
                                  </>
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Loading Bubble */}
        {isLoading &&
          (!currentMessages.length ||
            currentMessages[currentMessages.length - 1]?.role !== 'assistant') && (
            <div className="flex items-center gap-2 p-3 bg-slate-850/80 border border-slate-800 rounded-2xl text-xs text-cyan-300 animate-pulse">
              <Loader2 className="w-4 h-4 animate-spin text-cyan-400 shrink-0" />
              <span>
                Route Scout is analyzing route geometry &amp; corridor...
                {elapsedSeconds > 1 && (
                  <span className="font-mono text-cyan-400 text-[11px] ml-1.5 font-medium">
                    ({elapsedSeconds}s)
                  </span>
                )}
              </span>
            </div>
          )}

        {/* Error Message */}
        {errorMessage && (
          <div className="p-2.5 bg-rose-950/80 border border-rose-800/80 rounded-xl text-xs text-rose-200 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <span>{errorMessage}</span>
              <button
                onClick={() => handleSendMessage()}
                className="block mt-1 text-[11px] text-rose-300 underline hover:text-white cursor-pointer"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="p-3 border-t border-slate-800 bg-slate-900/95 backdrop-blur-md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSendMessage();
          }}
          className="flex items-end gap-2"
        >
          <div className="relative flex-1">
            <textarea
              ref={inputRef}
              rows={1}
              value={inputText}
              disabled={!aiAvailable || !hasSelectedModel || isLoading}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              placeholder={
                !aiAvailable
                  ? AI_UNAVAILABLE_SHORT
                  : !hasSelectedModel
                  ? 'Select an AI model in the header to ask Route Scout...'
                  : scope.type === 'day'
                  ? 'Ask about stops, food, fuel, or pacing along this leg...'
                  : `Ask about accessibility, photo spots, or dwell time for ${
                      scope.waypointName || 'this stop'
                    }...`
              }
              style={{ minHeight: '42px', maxHeight: '120px' }}
              className={`w-full resize-none overflow-y-auto border rounded-xl px-3.5 py-2.5 text-sm transition-colors focus:outline-none ${
                !aiAvailable || !hasSelectedModel
                  ? 'bg-slate-850 border-slate-800 text-slate-500 placeholder-slate-600 cursor-not-allowed'
                  : 'bg-slate-800 border-slate-700 text-white placeholder-slate-500 focus:border-cyan-500'
              }`}
            />
          </div>
          <button
            type="submit"
            disabled={!aiAvailable || !hasSelectedModel || !inputText.trim() || isLoading}
            className={`p-2.5 rounded-xl shadow-md transition-all shrink-0 ${
              !aiAvailable || !hasSelectedModel
                ? 'bg-slate-850 border border-slate-800 text-slate-600 cursor-not-allowed'
                : 'bg-gradient-to-tr from-cyan-600 to-sky-500 hover:from-cyan-500 hover:to-sky-400 text-white shadow-cyan-950/40 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed'
            }`}
            title={
              !aiAvailable
                ? AI_UNAVAILABLE_TOOLTIP
                : !hasSelectedModel
                ? 'Select an AI model in the header to ask Route Scout'
                : 'Send message to Route Scout'
            }
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </form>
        <div className="mt-1.5 text-[11px] text-slate-500 text-center">
          Press Enter to send &bull; Suggestions can be previewed or added in 1-click
        </div>
      </div>
    </aside>
  );
};
