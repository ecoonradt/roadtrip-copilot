import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  QrCode,
  Download,
  Check,
  Loader2,
  Share2,
  ExternalLink,
  Copy,
  FileJson,
  Navigation,
  Smartphone,
} from 'lucide-react';
import QRCode from 'qrcode';
import type { Waypoint } from '../types/routing';
import type { ScheduledStop, GoogleMapsRouteResult } from '../engine/types';
import {
  formatMultiDayItinerary,
  formatSingleRouteItinerary,
  exportItineraryToJson,
  downloadItineraryJson,
  type ItineraryExportModel,
} from '../engine/export';
import {
  stageItinerary,
} from '../services/api';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  waypoints: Waypoint[];
  scheduledStops?: ScheduledStop[];
  tripName?: string;
  baseDate?: string;
  departureTime?: string;
  googleMapsRoute?: GoogleMapsRouteResult;
  isAdHoc?: boolean;
  fileName?: string;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  waypoints,
  scheduledStops,
  tripName = 'Roadtrip Co-Pilot Itinerary',
  baseDate = '2026-10-09',
  departureTime = '14:30:00',
  googleMapsRoute,
  isAdHoc = false,
  fileName: initialFileName,
}) => {
  const [activeTab, setActiveTab] = useState<'handoff' | 'gmaps' | 'json'>('handoff');
  const defaultFileName = useMemo(() => {
    if (initialFileName) {
      return initialFileName.endsWith('.json') ? initialFileName : `${initialFileName}.json`;
    }
    const sanitized = (tripName || 'itinerary')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    return `${sanitized || 'itinerary'}.json`;
  }, [initialFileName, tripName]);
  const [fileName, setFileName] = useState(defaultFileName);

  useEffect(() => {
    setFileName(defaultFileName);
  }, [defaultFileName]);
  const [copiedJson, setCopiedJson] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedLegIndex, setCopiedLegIndex] = useState<number | null>(null);

  // Phone QR Code State
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [stagedDownloadUrl, setStagedDownloadUrl] = useState<string | null>(null);
  const [isStaging, setIsStaging] = useState(false);
  const [stagingError, setStagingError] = useState<string | null>(null);

  // Google Maps QR Codes map (legIndex -> dataUrl)
  const [gmapsQrCodes, setGmapsQrCodes] = useState<Record<number, string>>({});

  // Build the formatted V2 Itinerary object
  const itineraryData: ItineraryExportModel = useMemo(() => {
    if (isAdHoc) {
      return formatSingleRouteItinerary({
        tripName,
        waypoints,
        scheduledStops,
        isAdHoc: true,
      });
    }
    return formatMultiDayItinerary({
      tripName,
      startDate: baseDate,
      days: [
        {
          dayNumber: 1,
          date: baseDate,
          departureTime,
          waypoints,
          scheduledStops,
        },
      ],
    });
  }, [tripName, baseDate, departureTime, waypoints, scheduledStops, isAdHoc]);

  const jsonString = useMemo(() => {
    return exportItineraryToJson(itineraryData, 2);
  }, [itineraryData]);

  // Stage itinerary and generate Wi-Fi QR code
  const setupWifiQr = async () => {
    setIsStaging(true);
    setStagingError(null);
    try {
      const { downloadUrl } = await stageItinerary(itineraryData, fileName);
      setStagedDownloadUrl(downloadUrl);

      // Generate QR Code image data URL
      const dataUrl = await QRCode.toDataURL(downloadUrl, {
        width: 220,
        margin: 2,
        color: {
          dark: '#0284c7',
          light: '#ffffff',
        },
      });
      setQrDataUrl(dataUrl);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to generate Wi-Fi QR code';
      setStagingError(msg);
      setQrDataUrl(null);
    } finally {
      setIsStaging(false);
    }
  };

  // Generate QR codes for Google Maps legs
  useEffect(() => {
    if (!googleMapsRoute?.legs || googleMapsRoute.legs.length === 0) return;

    let isMounted = true;
    const generateLegQrs = async () => {
      const codes: Record<number, string> = {};
      for (const leg of googleMapsRoute.legs) {
        try {
          const url = await QRCode.toDataURL(leg.url, {
            width: 200,
            margin: 2,
            color: {
              dark: '#047857',
              light: '#ffffff',
            },
          });
          if (isMounted) codes[leg.legIndex] = url;
        } catch (e) {
          console.error('Failed to generate GMaps QR:', e);
        }
      }
      if (isMounted) setGmapsQrCodes(codes);
    };

    generateLegQrs();
    return () => {
      isMounted = false;
    };
  }, [googleMapsRoute]);

  // Initialize when opened
  useEffect(() => {
    if (isOpen) {
      setupWifiQr();
    }
  }, [isOpen, fileName, itineraryData]);

  // Download locally
  const handleDownloadFile = () => {
    downloadItineraryJson(jsonString, fileName);
  };

  // Copy JSON to clipboard
  const handleCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(jsonString);
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    } catch {
      setCopiedJson(false);
    }
  };

  // Copy Staged Download URL
  const handleCopyUrl = async () => {
    if (!stagedDownloadUrl) return;
    try {
      await navigator.clipboard.writeText(stagedDownloadUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      setCopiedUrl(false);
    }
  };

  // Copy Leg URL
  const handleCopyLegUrl = async (url: string, index: number) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedLegIndex(index);
      setTimeout(() => setCopiedLegIndex(null), 2000);
    } catch {
      setCopiedLegIndex(null);
    }
  };

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

  if (!isOpen) return null;

  const modalContent = (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-150"
    >
      <div className="relative w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden text-slate-100">
        {/* Modal Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-950/80">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-sky-600/20 border border-sky-500/40 flex items-center justify-center text-sky-400">
              <Share2 className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                Export &amp; Phone Handoff
              </h2>
              <p className="text-xs text-slate-400">
                Instant QR Code Sync, Google Maps Links &amp; JSON File Export
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Selection */}
        <div className="flex border-b border-slate-800 bg-slate-950/40 px-4 pt-2 gap-1 text-xs">
          <button
            onClick={() => setActiveTab('handoff')}
            className={`flex items-center gap-1.5 px-3 py-2 border-b-2 font-medium transition-all ${
              activeTab === 'handoff'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <QrCode className="w-3.5 h-3.5" />
            <span>Sync to Phone (QR Code)</span>
          </button>
          <button
            onClick={() => setActiveTab('gmaps')}
            className={`flex items-center gap-1.5 px-3 py-2 border-b-2 font-medium transition-all ${
              activeTab === 'gmaps'
                ? 'border-emerald-500 text-emerald-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Navigation className="w-3.5 h-3.5" />
            <span>Google Maps Navigation</span>
          </button>
          <button
            onClick={() => setActiveTab('json')}
            className={`flex items-center gap-1.5 px-3 py-2 border-b-2 font-medium transition-all ${
              activeTab === 'json'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileJson className="w-3.5 h-3.5" />
            <span>JSON Preview &amp; File</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Filename Input */}
          <div className="bg-slate-850/60 p-3 rounded-xl border border-slate-800 flex items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2">
              <FileJson className="w-4 h-4 text-sky-400 shrink-0" />
              <span className="text-slate-300 font-medium">Export Filename:</span>
            </div>
            <input
              type="text"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              className="bg-slate-800 border border-slate-700 px-2.5 py-1 rounded-lg text-slate-100 font-mono text-xs focus:outline-none focus:border-sky-500 flex-1 max-w-xs"
              placeholder="sample_itinerary.json"
            />
            <button
              onClick={handleDownloadFile}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-medium transition-colors flex items-center gap-1.5 shrink-0"
              title="Download itinerary JSON to your computer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download File</span>
            </button>
          </div>

          {/* TAB 1: PHONE HANDOFF (INSTANT QR SYNC) */}
          {activeTab === 'handoff' && (
            <div className="bg-slate-800/60 border border-slate-700/80 rounded-2xl p-6 flex flex-col items-center text-center space-y-5">
              <div className="space-y-1 max-w-md">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-sky-950/80 border border-sky-800/80 text-sky-300 text-xs font-semibold mb-1">
                  <Smartphone className="w-3.5 h-3.5" />
                  <span>Instant 1-Scan Phone Sync</span>
                </div>
                <h3 className="text-base font-bold text-white">
                  Scan to Load Route into Roadtrip Co-Pilot
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Open the Android app and tap <strong>&ldquo;Scan Route QR&rdquo;</strong> (or scan with your phone camera). The route will automatically download, save, and activate!
                </p>
              </div>

              {/* QR Code Container */}
              <div className="bg-white p-3.5 rounded-2xl shadow-xl flex items-center justify-center min-h-[220px] min-w-[220px] ring-4 ring-sky-500/20">
                {isStaging ? (
                  <div className="flex flex-col items-center gap-2.5 text-slate-800 text-xs p-6">
                    <Loader2 className="w-7 h-7 animate-spin text-sky-600" />
                    <span className="font-medium">Staging route and generating QR...</span>
                  </div>
                ) : qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="Roadtrip Co-Pilot Sync QR Code"
                    className="w-48 h-48 object-contain rounded-lg"
                  />
                ) : (
                  <div className="text-rose-600 text-xs p-4 max-w-xs font-medium">
                    {stagingError || 'Failed to generate sync QR code'}
                  </div>
                )}
              </div>

              {/* Step Walkthrough */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-lg text-left text-xs">
                <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3 flex gap-2.5 items-start">
                  <div className="w-5 h-5 rounded-full bg-sky-600 text-white flex items-center justify-center font-bold text-[11px] shrink-0 mt-0.5">
                    1
                  </div>
                  <div>
                    <div className="font-semibold text-white">Tap &ldquo;Scan Route QR&rdquo;</div>
                    <div className="text-slate-400 text-[11px]">In the Roadtrip Co-Pilot app on your Android phone</div>
                  </div>
                </div>

                <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3 flex gap-2.5 items-start">
                  <div className="w-5 h-5 rounded-full bg-emerald-600 text-white flex items-center justify-center font-bold text-[11px] shrink-0 mt-0.5">
                    2
                  </div>
                  <div>
                    <div className="font-semibold text-white">Instant Activation</div>
                    <div className="text-slate-400 text-[11px]">Downloads &amp; selects the route automatically. Ready to drive!</div>
                  </div>
                </div>
              </div>

              {/* Direct Staged Link */}
              {stagedDownloadUrl && (
                <div className="w-full max-w-lg bg-slate-900/80 p-2.5 rounded-xl border border-slate-800 flex items-center justify-between gap-2 text-xs">
                  <span className="text-slate-400 text-[11px] font-mono truncate pl-1">
                    {stagedDownloadUrl}
                  </span>
                  <button
                    onClick={handleCopyUrl}
                    className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium transition-colors flex items-center gap-1 shrink-0"
                  >
                    {copiedUrl ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy Link</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: GOOGLE MAPS NAVIGATION */}
          {activeTab === 'gmaps' && (
            <div className="space-y-3">
              <div className="text-xs text-slate-400">
                Turn-by-turn navigation links formatted with route-forcing waypoints so Google Maps
                sticks to the scenic route:
              </div>

              {googleMapsRoute?.legs.map((leg) => (
                <div
                  key={leg.legIndex}
                  className="bg-slate-800/80 border border-slate-700 rounded-xl p-3 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-xs font-bold text-white">{leg.title}</h4>
                      <p className="text-[11px] text-slate-400">
                        {leg.waypointCount} total points ({leg.intermediateWaypoints.length} stops)
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => handleCopyLegUrl(leg.url, leg.legIndex)}
                        className="px-2.5 py-1 bg-slate-700 hover:bg-slate-655 text-slate-200 rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
                      >
                        {copiedLegIndex === leg.legIndex ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                            <span className="text-emerald-400">Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>Copy Link</span>
                          </>
                        )}
                      </button>
                      <a
                        href={leg.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
                      >
                        <span>Open</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  </div>

                  {/* QR Code Display for this leg */}
                  <div className="pt-2 border-t border-slate-700/60 flex flex-col items-center gap-2">
                    <div className="bg-white p-2 rounded-xl shadow-md flex items-center justify-center min-h-[144px] min-w-[144px]">
                      {gmapsQrCodes[leg.legIndex] ? (
                        <img
                          src={gmapsQrCodes[leg.legIndex]}
                          alt={`${leg.title} QR Code`}
                          className="w-36 h-36 object-contain"
                        />
                      ) : (
                        <div className="flex flex-col items-center gap-2 text-slate-800 text-xs">
                          <Loader2 className="w-5 h-5 animate-spin text-emerald-600" />
                          <span>Generating QR...</span>
                        </div>
                      )}
                    </div>
                    <p className="text-[11px] text-emerald-400 font-medium">
                      Scan with phone camera to launch Google Maps Navigation immediately!
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* TAB 3: JSON PREVIEW */}
          {activeTab === 'json' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-400 font-mono">
                  Schema v2.0.0 &bull; {'days' in itineraryData ? (itineraryData.days[0]?.checkpoints.length || 0) : (itineraryData.checkpoints.length || 0)} checkpoints
                </span>
                <button
                  onClick={handleCopyJson}
                  className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
                >
                  {copiedJson ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-400">Copied to Clipboard</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy JSON</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="p-3 bg-slate-950 border border-slate-800 rounded-xl text-[11px] font-mono text-sky-300 max-h-80 overflow-y-auto">
                {jsonString}
              </pre>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-3 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span>Schema v2 Verified for Android Auto Co-Pilot</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg font-medium transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modalContent, document.body) : modalContent;
};
