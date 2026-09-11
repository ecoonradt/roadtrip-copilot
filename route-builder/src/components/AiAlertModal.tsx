import React, { useState, useEffect, useMemo } from 'react';
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
} from 'lucide-react';
import type { Waypoint } from '../types/routing';
import type { WaypointContext, CopilotAlert, AiEngineType } from '../types/ai';
import { generateCopilotAlert } from '../services/api';
import { defaultAiQueue } from '../services/aiQueue';

interface AiAlertModalProps {
  isOpen: boolean;
  waypoint: Waypoint | null;
  onClose: () => void;
  onApply: (waypointId: string, alert: CopilotAlert) => void;
}

export const AiAlertModal: React.FC<AiAlertModalProps> = ({
  isOpen,
  waypoint,
  onClose,
  onApply,
}) => {
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [speech, setSpeech] = useState('');
  const [radius, setRadius] = useState<number>(2.0);
  const [engine, setEngine] = useState<AiEngineType>('template');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [showEditor, setShowEditor] = useState(false);

  // Initialize or prefill state whenever waypoint opens
  useEffect(() => {
    if (!waypoint || !isOpen) {
      return;
    }

    if (waypoint.notification) {
      setTitle(waypoint.notification.title);
      setMessage(waypoint.notification.message);
      setSpeech(waypoint.notification.speech);
      setRadius(waypoint.trigger_radius_miles || 2.0);
      setEngine('template');
    } else {
      // Trigger fresh generation
      handleGenerate();
    }
  }, [waypoint?.id, isOpen]);

  // Clean up speech synthesis on close or unmount
  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const wordCount = useMemo(() => {
    return speech.trim().split(/\s+/).filter(Boolean).length;
  }, [speech]);

  const estSpeechSeconds = useMemo(() => {
    return Math.round(wordCount / 2.3);
  }, [wordCount]);

  const handleToggleSpeak = () => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return;
    }

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

  const handleGenerate = async () => {
    if (!waypoint) return;

    setIsLoading(true);
    setError(null);

    const context: WaypointContext = {
      id: waypoint.id,
      name: waypoint.name,
      type: waypoint.type,
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

  const handleApply = () => {
    if (!waypoint) return;

    onApply(waypoint.id, {
      title,
      message,
      speech,
      recommended_trigger_radius_miles: radius,
    });
    onClose();
  };

  if (!isOpen || !waypoint) {
    return null;
  }

  const radiusTip =
    radius >= 3.0
      ? 'Interstate / Open Highway (High Speed)'
      : radius >= 1.5
      ? 'Scenic Byway / Pull-off (Moderate Speed)'
      : 'Destination / Urban / Parking Approach';

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="w-full max-w-2xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-slate-950/80 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-sky-500/20 text-sky-400">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-white truncate max-w-md">
                  {waypoint.name}
                </h2>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono">
                  {waypoint.type}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                AI Co-Pilot Android Auto Card & TTS Audio Speech Generator
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded border ${
                engine === 'agy'
                  ? 'bg-emerald-950 text-emerald-300 border-emerald-700/60'
                  : engine === 'cloud'
                  ? 'bg-purple-950 text-purple-300 border-purple-700/60'
                  : 'bg-slate-800 text-slate-300 border-slate-700'
              }`}
            >
              {engine === 'agy' ? 'agy CLI (Local)' : engine === 'cloud' ? 'Gemini API' : 'Deterministic Fallback'}
            </span>
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {error && (
            <div className="p-3 bg-rose-950/80 border border-rose-800 rounded-xl text-xs text-rose-200">
              <span className="font-bold">Error:</span> {error}
            </div>
          )}

          {/* Android Auto Heads-Up Card Preview */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
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
          </div>

          {/* Spoken TTS Audio Script Preview */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
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
                onClick={handleToggleSpeak}
                disabled={!speech}
                className={`p-2.5 rounded-xl transition-colors shrink-0 flex items-center justify-center ${
                  isSpeaking
                    ? 'bg-amber-500 text-slate-950 hover:bg-amber-400'
                    : 'bg-slate-800 text-amber-400 hover:bg-slate-700'
                }`}
                title={isSpeaking ? 'Stop speaking preview' : 'Play TTS audio preview'}
              >
                {isSpeaking ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
              </button>

              <div className="min-w-0 flex-1">
                <p className="text-sm text-slate-200 italic leading-relaxed">
                  &ldquo;{speech || 'Approaching your scheduled road trip stop.'}&rdquo;
                </p>
                <div className="mt-2 text-[11px] text-slate-400 flex items-center gap-1">
                  <Info className="w-3 h-3 text-sky-400" />
                  <span>Ducks Spotify car audio during utterance, restoring volume on completion.</span>
                </div>
              </div>
            </div>
          </div>

          {/* Trigger Radius Slider */}
          <div className="p-3.5 rounded-xl bg-slate-800/60 border border-slate-700/70 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-sky-400" />
                Recommended Geofence Trigger Radius
              </span>
              <span className="text-xs font-mono font-bold text-sky-400 bg-sky-950/80 border border-sky-800 px-2 py-0.5 rounded">
                {radius.toFixed(1)} miles
              </span>
            </div>

            <input
              type="range"
              min="0.3"
              max="6.0"
              step="0.1"
              value={radius}
              onChange={(e) => setRadius(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-sky-500"
            />

            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>0.3 mi (Urban)</span>
              <span className="text-slate-300 font-medium">{radiusTip}</span>
              <span>6.0 mi (Highway Vista)</span>
            </div>
          </div>

          {/* Collapsible Manual Edit Panel */}
          <div className="border border-slate-800 rounded-xl overflow-hidden">
            <button
              onClick={() => setShowEditor((prev) => !prev)}
              className="w-full px-3.5 py-2 bg-slate-800/40 hover:bg-slate-800/80 text-left text-xs font-semibold text-slate-300 flex items-center justify-between transition-colors"
            >
              <span>Fine-tune Copilot Copy & Scripts</span>
              <span className="text-[11px] text-sky-400">{showEditor ? 'Hide' : 'Edit'}</span>
            </button>

            {showEditor && (
              <div className="p-3.5 bg-slate-900/60 space-y-3 border-t border-slate-800">
                <div>
                  <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
                    <label>Card Title (max 30 characters)</label>
                    <span className={title.length > 30 ? 'text-rose-400' : 'text-slate-500'}>
                      {title.length}/30
                    </span>
                  </div>
                  <input
                    type="text"
                    maxLength={30}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-xs text-white focus:outline-none focus:border-sky-500"
                  />
                </div>

                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Notification Message (max 2 lines)
                  </label>
                  <textarea
                    rows={2}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-xs text-white focus:outline-none focus:border-sky-500 resize-none"
                  />
                </div>

                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Spoken Audio Prompt (15-25 words)
                  </label>
                  <textarea
                    rows={2}
                    value={speech}
                    onChange={(e) => setSpeech(e.target.value)}
                    className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-xs text-white focus:outline-none focus:border-sky-500 resize-none"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3.5 bg-slate-950/80 border-t border-slate-800 flex items-center justify-between">
          <button
            onClick={handleGenerate}
            disabled={isLoading}
            className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50"
          >
            {isLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5 text-sky-400" />
            )}
            <span>{isLoading ? 'Generating...' : 'Regenerate Alert'}</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3.5 py-2 bg-transparent hover:bg-slate-800 text-slate-400 hover:text-white rounded-xl text-xs font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              disabled={isLoading || !title.trim()}
              className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm disabled:opacity-50"
            >
              <Check className="w-4 h-4" />
              <span>Apply to Waypoint</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
