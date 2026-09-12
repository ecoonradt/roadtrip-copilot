import React, { useState, useEffect, useRef } from 'react';
import { Search, Loader2, MapPin, X } from 'lucide-react';
import { searchLocation } from '../services/api';
import type { GeocodeResult } from '../types/routing';

interface SearchBarProps {
  onSelectLocation: (result: GeocodeResult) => void;
  placeholder?: string;
  className?: string;
}

export const SearchBar = React.forwardRef<HTMLInputElement, SearchBarProps>(({
  onSelectLocation,
  placeholder = "Search place or address (e.g. Flagstaff, AZ)...",
  className = "w-full max-w-md",
}, ref) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const internalInputRef = useRef<HTMLInputElement>(null);

  React.useImperativeHandle(ref, () => internalInputRef.current as HTMLInputElement);

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
    <div ref={containerRef} className={`relative ${className}`}>
      <div className="relative flex items-center shadow-md rounded-xl overflow-hidden bg-slate-800/95 border border-slate-700/80 backdrop-blur-md focus-within:border-sky-500/80 focus-within:ring-1 focus-within:ring-sky-500/30 transition-all">
        <div className="pl-3.5 text-slate-400">
          {isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin text-sky-400" />
          ) : (
            <Search className="w-4 h-4 text-slate-400" />
          )}
        </div>
        <input
          ref={internalInputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="w-full py-2 px-3 bg-transparent text-xs text-slate-100 placeholder-slate-400 focus:outline-none"
        />
        {query && (
          <button
            onClick={handleClear}
            className="pr-3 text-slate-400 hover:text-slate-200 transition-colors"
            title="Clear search"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Results dropdown */}
      {isOpen && (
        <div className="absolute z-[1050] left-0 right-0 mt-1.5 bg-slate-900/98 border border-slate-700/90 rounded-xl shadow-2xl overflow-hidden max-h-72 overflow-y-auto backdrop-blur-md">
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
              className="w-full text-left px-3.5 py-2.5 hover:bg-slate-800/90 border-b border-slate-800/60 last:border-0 flex items-start gap-2.5 transition-colors group cursor-pointer"
            >
              <MapPin className="w-4 h-4 text-sky-400 mt-0.5 shrink-0 group-hover:scale-110 transition-transform" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-slate-100 truncate">
                  {item.displayName.split(',')[0]}
                </div>
                <div className="text-[11px] text-slate-400 truncate">
                  {item.displayName}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

SearchBar.displayName = 'SearchBar';
