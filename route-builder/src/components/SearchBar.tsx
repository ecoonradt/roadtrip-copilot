import React, { useState, useEffect, useRef } from 'react';
import { Search, Loader2, MapPin, X } from 'lucide-react';
import { searchLocation } from '../services/api';
import type { GeocodeResult } from '../types/routing';

interface SearchBarProps {
  onSelectLocation: (result: GeocodeResult) => void;
}

export const SearchBar: React.FC<SearchBarProps> = ({ onSelectLocation }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Debounced search
  useEffect(() => {
    if (!query.trim() || query.trim().length < 3) {
      setResults([]);
      setIsOpen(false);
      setIsLoading(false);
      setError(null);
      return;
    }

    const timer = setTimeout(async () => {
      setIsLoading(true);
      setError(null);
      try {
        const data = await searchLocation(query);
        setResults(data);
        setIsOpen(true);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Search failed';
        setError(msg);
        setResults([]);
        setIsOpen(true);
      } finally {
        setIsLoading(false);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [query]);

  const handleSelect = (result: GeocodeResult) => {
    onSelectLocation(result);
    setQuery('');
    setResults([]);
    setIsOpen(false);
  };

  const handleClear = () => {
    setQuery('');
    setResults([]);
    setIsOpen(false);
    setError(null);
  };

  return (
    <div ref={containerRef} className="relative w-full max-w-md">
      <div className="relative flex items-center shadow-lg rounded-xl overflow-hidden bg-slate-800/95 border border-slate-700/80 backdrop-blur-md">
        <div className="pl-3.5 text-slate-400">
          {isLoading ? (
            <Loader2 className="w-5 h-5 animate-spin text-sky-400" />
          ) : (
            <Search className="w-5 h-5" />
          )}
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search place or address (e.g. Flagstaff, AZ)..."
          className="w-full py-2.5 px-3 bg-transparent text-sm text-slate-100 placeholder-slate-400 focus:outline-none"
        />
        {query && (
          <button
            onClick={handleClear}
            className="pr-3 text-slate-400 hover:text-slate-200 transition-colors"
            title="Clear search"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Results dropdown */}
      {isOpen && (
        <div className="absolute z-50 left-0 right-0 mt-2 bg-slate-800/98 border border-slate-700/80 rounded-xl shadow-2xl overflow-hidden max-h-72 overflow-y-auto backdrop-blur-md">
          {error && (
            <div className="p-3 text-xs text-rose-400 bg-rose-950/40 border-b border-rose-900/30">
              {error}
            </div>
          )}

          {results.length === 0 && !error && !isLoading && (
            <div className="p-3.5 text-xs text-slate-400 text-center">
              No matching locations found
            </div>
          )}

          {results.map((item, index) => (
            <button
              key={`${item.lat}-${item.lng}-${index}`}
              onClick={() => handleSelect(item)}
              className="w-full text-left px-3.5 py-2.5 hover:bg-slate-700/70 border-b border-slate-700/40 last:border-0 flex items-start gap-2.5 transition-colors group"
            >
              <MapPin className="w-4 h-4 text-sky-400 mt-0.5 shrink-0 group-hover:scale-110 transition-transform" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-100 truncate">
                  {item.displayName.split(',')[0]}
                </div>
                <div className="text-xs text-slate-400 truncate">
                  {item.displayName}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
