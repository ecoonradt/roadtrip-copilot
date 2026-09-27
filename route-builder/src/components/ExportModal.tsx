import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Smartphone,
  QrCode,
  Download,
  Check,
  AlertTriangle,
  Loader2,
  Share2,
  ExternalLink,
  Copy,
  RefreshCw,
  FileJson,
  Navigation,
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
  fetchDeviceStatus,
  pushItineraryToDevice,
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
  const [copiedLegIndex, setCopiedLegIndex] = useState<number | null>(null);

  // ADB Push State
  const [deviceStatus, setDeviceStatus] = useState<{ connected: boolean; devices: string[] } | null>(null);
  const [isCheckingDevice, setIsCheckingDevice] = useState(false);
  const [isPushingAdb, setIsPushingAdb] = useState(false);
  const [adbResult, setAdbResult] = useState<{ success: boolean; message?: string; error?: string } | null>(null);

  // Wi-Fi QR Code State
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

  // Check ADB device status
  const checkStatus = async () => {
    setIsCheckingDevice(true);
    try {
      const status = await fetchDeviceStatus();
      setDeviceStatus(status);
    } catch {
      setDeviceStatus({ connected: false, devices: [] });
    } finally {
      setIsCheckingDevice(false);
    }
  };

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
      checkStatus();
      setupWifiQr();
      setAdbResult(null);
    }
  }, [isOpen, fileName, itineraryData]);

  // Execute 1-Click ADB Push
  const handleAdbPush = async () => {
    setIsPushingAdb(true);
    setAdbResult(null);
    try {
      const result = await pushItineraryToDevice(itineraryData, fileName);
      setAdbResult(result);
      if (result.success) {
        // Refresh device status
        checkStatus();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'ADB push request failed';
      setAdbResult({ success: false, error: msg });
    } finally {
      setIsPushingAdb(false);
    }
  };

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
                Export & Phone Handoff
              </h2>
              <p className="text-xs text-slate-400">
                1-Click ADB Push, Wi-Fi QR Code Download & Navigation Links
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
            <Smartphone className="w-3.5 h-3.5" />
            <span>Phone Handoff (ADB & Wi-Fi)</span>
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
            <span>JSON Preview & File</span>
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

          {/* TAB 1: PHONE HANDOFF (ADB & WI-FI QR) */}
          {activeTab === 'handoff' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Option A: 1-Click ADB Push */}
              <div className="bg-slate-800/60 border border-slate-700/80 rounded-xl p-4 flex flex-col justify-between space-y-3">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Smartphone className="w-4 h-4 text-sky-400" />
                      <h3 className="text-sm font-bold text-white">1-Click ADB Push</h3>
                    </div>
                    <button
                      onClick={checkStatus}
                      disabled={isCheckingDevice}
                      className="p-1 text-slate-400 hover:text-slate-200 transition-colors"
                      title="Refresh ADB status"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${isCheckingDevice ? 'animate-spin' : ''}`}
                      />
                    </button>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Directly transfers the itinerary file into the Roadtrip Co-Pilot app directory on
                    your connected phone over USB or wireless ADB.
                  </p>

                  {/* Device Connection Badge */}
                  <div className="mt-3 p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 text-xs flex items-center gap-2">
                    {deviceStatus?.connected ? (
                      <>
                        <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                        <span className="text-emerald-300 font-mono font-medium truncate">
                          Connected: {deviceStatus.devices.join(', ')}
                        </span>
                      </>
                    ) : (
                      <>
                        <div className="w-2.5 h-2.5 rounded-full bg-amber-400 shrink-0" />
                        <span className="text-amber-300">
                          {isCheckingDevice ? 'Checking ADB...' : 'No ADB device connected'}
                        </span>
                      </>
                    )}
                  </div>

                  {/* Result Feedback */}
                  {adbResult && (
                    <div
                      className={`mt-3 p-2.5 rounded-lg border text-xs flex items-start gap-2 ${
                        adbResult.success
                          ? 'bg-emerald-950/70 border-emerald-800/80 text-emerald-200'
                          : 'bg-rose-950/70 border-rose-800/80 text-rose-200'
                      }`}
                    >
                      {adbResult.success ? (
                        <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                      )}
                      <div className="leading-snug">
                        {adbResult.success ? adbResult.message : adbResult.error}
                      </div>
                    </div>
                  )}
                </div>

                <button
                  onClick={handleAdbPush}
                  disabled={isPushingAdb || isCheckingDevice}
                  className={`w-full py-2.5 rounded-xl font-semibold text-xs transition-all flex items-center justify-center gap-2 shadow-lg ${
                    deviceStatus?.connected
                      ? 'bg-sky-600 hover:bg-sky-500 text-white shadow-sky-600/25'
                      : 'bg-slate-700 hover:bg-slate-650 text-slate-200 cursor-pointer'
                  }`}
                >
                  {isPushingAdb ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Pushing to Device via ADB...</span>
                    </>
                  ) : (
                    <>
                      <Smartphone className="w-4 h-4" />
                      <span>Push to Phone via ADB</span>
                    </>
                  )}
                </button>
              </div>

              {/* Option B: Wi-Fi QR Code Download */}
              <div className="bg-slate-800/60 border border-slate-700/80 rounded-xl p-4 flex flex-col items-center justify-between text-center space-y-3">
                <div>
                  <div className="flex items-center justify-center gap-2 mb-1">
                    <QrCode className="w-4 h-4 text-indigo-400" />
                    <h3 className="text-sm font-bold text-white">Local Wi-Fi QR Code</h3>
                  </div>
                  <p className="text-xs text-slate-400">
                    Scan with your phone camera while on the same Wi-Fi network to download directly.
                  </p>
                </div>

                {/* QR Code Display */}
                <div className="bg-white p-2 rounded-xl shadow-inner flex items-center justify-center min-h-[160px] min-w-[160px]">
                  {isStaging ? (
                    <div className="flex flex-col items-center gap-2 text-slate-800 text-xs">
                      <Loader2 className="w-6 h-6 animate-spin text-sky-600" />
                      <span>Generating QR...</span>
                    </div>
                  ) : qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt="Wi-Fi Download QR Code"
                      className="w-40 h-40 object-contain rounded-lg"
                    />
                  ) : (
                    <div className="text-rose-600 text-xs p-2">
                      {stagingError || 'Failed to generate QR'}
                    </div>
                  )}
                </div>

                {stagedDownloadUrl && (
                  <div className="w-full">
                    <div className="text-[10px] font-mono text-slate-400 truncate bg-slate-900/80 px-2 py-1 rounded border border-slate-800">
                      {stagedDownloadUrl}
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      Then tap &ldquo;Import Itinerary&rdquo; in the Android app.
                    </p>
                  </div>
                )}
              </div>
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
