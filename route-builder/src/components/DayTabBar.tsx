import React from 'react';
import { Calendar, Plus, MapPin, Trash2 } from 'lucide-react';
import type { ParsedDay } from '../engine/itineraryParser';

interface DayTabBarProps {
  days: ParsedDay[];
  activeDayIndex: number;
  onSelectDay: (index: number) => void;
  onAddDay: () => void;
  onDeleteDay?: (index: number) => void;
}

export const DayTabBar: React.FC<DayTabBarProps> = ({
  days,
  activeDayIndex,
  onSelectDay,
  onAddDay,
  onDeleteDay,
}) => {
  if (!days || days.length <= 1) {
    return null;
  }

  return (
    <div className="h-10 bg-slate-950/90 border-b border-slate-800/80 px-4 flex items-center justify-between gap-2 overflow-x-auto select-none shrink-0 z-10 backdrop-blur-sm">
      <div className="flex items-center gap-1.5 min-w-max">
        <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mr-1 flex items-center gap-1">
          <Calendar className="w-3 h-3 text-sky-400" />
          <span>Trip Days:</span>
        </span>

        {days.map((day, idx) => {
          const isActive = idx === activeDayIndex;
          const stopCount = day.waypoints?.length || 0;

          return (
            <div
              key={day.dayNumber || idx}
              className={`flex items-center rounded-lg text-xs transition-all ${
                isActive
                  ? 'bg-sky-600 text-white font-semibold shadow-sm'
                  : 'bg-slate-900/80 hover:bg-slate-850 text-slate-300 hover:text-white border border-slate-800'
              }`}
            >
              <button
                onClick={() => onSelectDay(idx)}
                className="flex items-center gap-2 pl-2.5 pr-1.5 py-1 cursor-pointer"
                title={`Switch to Day ${day.dayNumber}: ${day.title} (${day.date})`}
              >
                <span className="font-bold">Day {day.dayNumber}</span>
                {day.date && (
                  <span className={`text-[11px] font-mono ${isActive ? 'text-sky-100' : 'text-slate-400'}`}>
                    {day.date.slice(5)}
                  </span>
                )}
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono font-medium ${
                    isActive
                      ? 'bg-sky-700/80 text-sky-100'
                      : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {stopCount} {stopCount === 1 ? 'stop' : 'stops'}
                </span>
              </button>

              {/* Delete Day button - always visible when more than 1 day */}
              {days.length > 1 && onDeleteDay && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Delete Day ${day.dayNumber} (${day.title || day.date})?`)) {
                      onDeleteDay(idx);
                    }
                  }}
                  className={`p-1 mr-1.5 rounded transition-colors cursor-pointer ${
                    isActive
                      ? 'text-sky-200 hover:text-white hover:bg-sky-700/80'
                      : 'text-slate-500 hover:text-rose-400 hover:bg-slate-800'
                  }`}
                  title={`Delete Day ${day.dayNumber}`}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}

        {/* Add Day Button */}
        <button
          onClick={onAddDay}
          className="flex items-center gap-1 px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-sky-300 border border-dashed border-slate-700 hover:border-sky-500/60 rounded-lg text-xs font-medium transition-all cursor-pointer ml-1"
          title="Add a new day to this road trip"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add Day</span>
        </button>
      </div>

      {/* Active Day Title Summary */}
      {days[activeDayIndex] && (
        <div className="hidden lg:flex items-center gap-1.5 text-xs text-slate-400 truncate max-w-sm">
          <MapPin className="w-3 h-3 text-emerald-400 shrink-0" />
          <span className="text-slate-200 font-medium truncate">
            {days[activeDayIndex].title || `Day ${days[activeDayIndex].dayNumber}`}
          </span>
          {days[activeDayIndex].origin && days[activeDayIndex].destination && (
            <span className="text-slate-400 text-[11px] truncate">
              ({days[activeDayIndex].origin.split(',')[0]} &rarr; {days[activeDayIndex].destination.split(',')[0]})
            </span>
          )}
        </div>
      )}
    </div>
  );
};
