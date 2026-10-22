import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  FolderOpen,
  Upload,
  Plus,
  Check,
  AlertCircle,
  Loader2,
  FileText,
  Trash2,
} from 'lucide-react';
import {
  fetchItineraryList,
  fetchItinerary,
  deleteItinerary,
  type ItineraryMetadataSummary,
} from '../services/api';
import { parseItineraryJson, type ParsedTrip } from '../engine/itineraryParser';
import { DEFAULT_TIMEZONE } from '../engine/cascade';

interface RouteSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTrip: (trip: ParsedTrip, options?: { unsaved?: boolean }) => void;
  currentFileName?: string;
  onDeleteTrip?: (fileName: string) => void;
}

export const RouteSelectorModal: React.FC<RouteSelectorModalProps> = ({
  isOpen,
  onClose,
  onSelectTrip,
  currentFileName,
  onDeleteTrip,
}) => {
  const [activeTab, setActiveTab] = useState<'workspace' | 'import' | 'new'>('workspace');
  const [workspaceRoutes, setWorkspaceRoutes] = useState<ItineraryMetadataSummary[]>([]);
  const [isLoadingRoutes, setIsLoadingRoutes] = useState(false);
  const [loadingRouteName, setLoadingRouteName] = useState<string | null>(null);
  const [confirmDeleteFile, setConfirmDeleteFile] = useState<string | null>(null);
  const [isDeletingFile, setIsDeletingFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Generation counter to guard against superseded workspace route selections
  const selectSeqRef = useRef<number>(0);

  // Import state
  const [importedJson, setImportedJson] = useState<string | null>(null);
  const [importFileName, setImportFileName] = useState<string>('');
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // New trip state
  const [newTripName, setNewTripName] = useState('My Road Trip');
  const [newTripDate, setNewTripDate] = useState(new Date().toISOString().slice(0, 10));

  // Load workspace routes on modal open
  useEffect(() => {
    if (!isOpen) return;

    let isSubscribed = true;
    const loadRoutes = async () => {
      setIsLoadingRoutes(true);
      setError(null);
      try {
        const data = await fetchItineraryList();
        if (isSubscribed) {
          setWorkspaceRoutes(data.itineraries || []);
        }
      } catch (err: unknown) {
        if (isSubscribed) {
          const msg = err instanceof Error ? err.message : 'Failed to fetch itineraries';
          setError(msg);
        }
      } finally {
        if (isSubscribed) {
          setIsLoadingRoutes(false);
        }
      }
    };

    loadRoutes();

    return () => {
      isSubscribed = false;
    };
  }, [isOpen]);

  // Invalidate in-flight workspace selections whenever the modal opens or closes
  // (keyed on isOpen only: onClose is an inline callback and changes identity every render)
  useEffect(() => {
    selectSeqRef.current += 1;
  }, [isOpen]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) {
      setConfirmDeleteFile(null);
      setIsDeletingFile(null);
      return;
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSelectWorkspaceRoute = async (summary: ItineraryMetadataSummary) => {
    const seq = ++selectSeqRef.current;
    setLoadingRouteName(summary.fileName);
    setError(null);
    try {
      const raw = await fetchItinerary(summary.fileName);
      if (seq !== selectSeqRef.current) return;
      const parsed = parseItineraryJson(raw, summary.fileName);
      onSelectTrip(parsed);
      onClose();
    } catch (err: unknown) {
      if (seq !== selectSeqRef.current) return;
      const msg = err instanceof Error ? err.message : 'Failed to load route file';
      setError(msg);
    } finally {
      if (seq === selectSeqRef.current) {
        setLoadingRouteName(null);
      }
    }
  };

  const handleDeleteRoute = async (fileName: string) => {
    setIsDeletingFile(fileName);
    setError(null);
    try {
      const targetRoute = workspaceRoutes.find((r) => r.fileName === fileName);
      await deleteItinerary(fileName, { ifMatch: targetRoute?.etag });
      setWorkspaceRoutes((prev) => prev.filter((r) => r.fileName !== fileName));
      setConfirmDeleteFile(null);
      if (onDeleteTrip) {
        onDeleteTrip(fileName);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to delete route file';
      setError(msg);
    } finally {
      setIsDeletingFile(null);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportFileName(file.name);
    setImportError(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        setImportedJson(text);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to read file';
        setImportError(msg);
      }
    };
    reader.onerror = () => setImportError('File reading error');
    reader.readAsText(file);
  };

  const handleConfirmImport = () => {
    if (!importedJson) return;
    try {
      const raw = JSON.parse(importedJson) as unknown;
      const parsed = parseItineraryJson(raw, importFileName, { isImport: true });
      onSelectTrip(parsed, { unsaved: true });
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid JSON itinerary structure';
      setImportError(msg);
    }
  };

  const handleCreateNewTrip = () => {
    const freshTrip: ParsedTrip = {
      tripName: newTripName.trim() || 'New Road Trip',
      isMultiDay: false,
      dates: { start: newTripDate, end: newTripDate },
      days: [
        {
          dayNumber: 1,
          date: newTripDate,
          title: newTripName.trim() || 'Day 1',
          departureTime: '09:00:00',
          timezone: DEFAULT_TIMEZONE,
          waypoints: [],
        },
      ],
    };
    onSelectTrip(freshTrip, { unsaved: true });
    onClose();
  };

  const modalContent = (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      className="fixed inset-0 z-[1200] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200"
    >
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl max-w-xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden text-slate-100">
        {/* Modal Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/90">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-sky-600/20 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <FolderOpen className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white leading-snug">
                Open &amp; Manage Itineraries
              </h2>
              <p className="text-xs text-slate-400">
                Load existing workspace routes, import local JSON files, or start fresh
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 bg-slate-950/60 px-4 pt-2 gap-2 text-xs">
          <button
            onClick={() => setActiveTab('workspace')}
            className={`flex items-center gap-1.5 px-3 py-2 border-b-2 font-medium transition-all cursor-pointer ${
              activeTab === 'workspace'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span>Workspace Routes</span>
          </button>

          <button
            onClick={() => setActiveTab('import')}
            className={`flex items-center gap-1.5 px-3 py-2 border-b-2 font-medium transition-all cursor-pointer ${
              activeTab === 'import'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Import JSON File</span>
          </button>

          <button
            onClick={() => setActiveTab('new')}
            className={`flex items-center gap-1.5 px-3 py-2 border-b-2 font-medium transition-all cursor-pointer ${
              activeTab === 'new'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Blank Route</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-4 flex-1 overflow-y-auto space-y-3">
          {error && (
            <div className="p-3 bg-rose-950/70 border border-rose-800/80 rounded-xl text-xs text-rose-300 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Tab 1: Workspace Routes */}
          {activeTab === 'workspace' && (
            <div className="space-y-2.5">
              {isLoadingRoutes ? (
                <div className="py-12 flex flex-col items-center justify-center text-slate-400 gap-2">
                  <Loader2 className="w-6 h-6 animate-spin text-sky-400" />
                  <span className="text-xs">Scanning workspace for itinerary files...</span>
                </div>
              ) : workspaceRoutes.length === 0 ? (
                <div className="py-10 text-center text-slate-400 text-xs">
                  No itinerary JSON files found in workspace. Use "Import JSON File" to upload one.
                </div>
              ) : (
                workspaceRoutes.map((route) => {
                  const isCurrent = currentFileName === route.fileName;
                  const isLoading = loadingRouteName === route.fileName;

                  return (
                    <div
                      key={route.fileName}
                      className={`p-3.5 rounded-xl border transition-all flex items-center justify-between gap-3 ${
                        isCurrent
                          ? 'bg-sky-950/40 border-sky-600/70 ring-1 ring-sky-500/20'
                          : 'bg-slate-800/70 border-slate-700/60 hover:border-slate-600 hover:bg-slate-800/90'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="text-xs font-bold text-white truncate">
                            {route.tripName}
                          </h3>
                          <span
                            className={`text-[10px] px-1.5 py-0.2 rounded font-mono font-medium ${
                              route.isMultiDay
                                ? 'bg-indigo-950 text-indigo-300 border border-indigo-800/60'
                                : 'bg-slate-900 text-slate-400 border border-slate-800'
                            }`}
                          >
                            {route.isMultiDay ? `${route.dayCount} Days` : 'Single Route'}
                          </span>
                          {isCurrent && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-950 text-emerald-300 border border-emerald-800/50 font-medium">
                              Active
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-400 font-mono">
                          <span className="text-slate-300">{route.fileName}</span>
                          <span>&bull;</span>
                          <span>{route.totalCheckpoints} stops</span>
                          {route.dates && (
                            <>
                              <span>&bull;</span>
                              <span>{route.dates.start} &rarr; {route.dates.end}</span>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {confirmDeleteFile === route.fileName ? (
                          <div className="flex items-center gap-1 bg-rose-950/80 border border-rose-800/80 rounded-lg p-0.5 animate-in fade-in duration-150">
                            <button
                              onClick={() => handleDeleteRoute(route.fileName)}
                              disabled={isDeletingFile === route.fileName}
                              className="px-2 py-1 rounded-md text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
                              title="Confirm permanently deleting this itinerary"
                            >
                              {isDeletingFile === route.fileName ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Trash2 className="w-3 h-3" />
                              )}
                              <span>Delete?</span>
                            </button>
                            <button
                              onClick={() => setConfirmDeleteFile(null)}
                              disabled={isDeletingFile === route.fileName}
                              className="px-2 py-1 rounded-md text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
                              title="Cancel"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <>
                            {!route.isProtected && (
                              <button
                                onClick={() => setConfirmDeleteFile(route.fileName)}
                                className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer"
                                title={`Delete ${route.tripName}`}
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </>
                        )}

                        <button
                          onClick={() => handleSelectWorkspaceRoute(route)}
                          disabled={isLoading || isDeletingFile === route.fileName}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all shadow-sm flex items-center gap-1.5 cursor-pointer disabled:opacity-50 ${
                            isCurrent
                              ? 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                              : 'bg-sky-600 hover:bg-sky-500 text-white'
                          }`}
                        >
                          {isLoading ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : isCurrent ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <FolderOpen className="w-3.5 h-3.5" />
                          )}
                          <span>{isCurrent ? 'Reload' : 'Open'}</span>
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* Tab 2: Import Local JSON */}
          {activeTab === 'import' && (
            <div className="space-y-4">
              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-slate-700 hover:border-sky-500/70 rounded-2xl p-8 text-center cursor-pointer transition-colors bg-slate-950/40 hover:bg-slate-950/60"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  onChange={handleFileChange}
                  className="hidden"
                />
                <Upload className="w-10 h-10 mx-auto text-slate-500 mb-2.5 group-hover:text-sky-400" />
                <div className="text-sm font-semibold text-slate-200">
                  Click to select an itinerary JSON file
                </div>
                <div className="text-xs text-slate-400 mt-1">
                  Supports both multi-day itineraries and single-route files
                </div>
              </div>

              {importFileName && (
                <div className="p-3 bg-slate-800/80 border border-slate-700 rounded-xl flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <FileText className="w-4 h-4 text-sky-400 shrink-0" />
                    <span className="text-xs font-medium text-white truncate font-mono">
                      {importFileName}
                    </span>
                  </div>
                  <button
                    onClick={handleConfirmImport}
                    className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-semibold shadow-sm transition-colors cursor-pointer"
                  >
                    Load This File
                  </button>
                </div>
              )}

              {importError && (
                <div className="p-3 bg-rose-950/70 border border-rose-800/80 rounded-xl text-xs text-rose-300 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>{importError}</span>
                </div>
              )}
            </div>
          )}

          {/* Tab 3: New Blank Route */}
          {activeTab === 'new' && (
            <div className="space-y-3.5 p-2">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Trip / Route Name
                </label>
                <input
                  type="text"
                  value={newTripName}
                  onChange={(e) => setNewTripName(e.target.value)}
                  placeholder="e.g. Pacific Coast Highway Tour"
                  className="w-full bg-slate-800 border border-slate-700 text-slate-100 text-xs rounded-xl px-3 py-2 font-medium focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Start Date
                </label>
                <input
                  type="date"
                  value={newTripDate}
                  onChange={(e) => setNewTripDate(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 text-slate-100 text-xs rounded-xl px-3 py-2 font-mono focus:outline-none focus:border-sky-500"
                />
              </div>

              <div className="pt-3">
                <button
                  onClick={handleCreateNewTrip}
                  className="w-full py-2.5 px-4 bg-sky-600 hover:bg-sky-500 text-white rounded-xl text-xs font-semibold shadow-md transition-colors flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Create Blank Itinerary</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modalContent, document.body) : modalContent;
};
