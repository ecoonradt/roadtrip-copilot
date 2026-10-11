import React, { useState, useEffect } from 'react';
import { Pencil } from 'lucide-react';

interface InlineEditProps {
  value: string;
  onCommit: (value: string) => void;
  tooltip: string;
  className?: string;
  maxLength?: number;
}

/** Click-to-edit text: Enter/blur commits, Escape cancels. */
export const InlineEdit: React.FC<InlineEditProps> = ({ value, onCommit, tooltip, className = '', maxLength = 80 }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  const commit = () => {
    setEditing(false);
    if (draft.trim() !== value) onCommit(draft);
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        maxLength={maxLength}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') { setDraft(value); setEditing(false); }
        }}
        className={`bg-slate-900 border border-sky-500/60 rounded px-1.5 py-0.5 text-xs text-white outline-none w-56 ${className}`}
      />
    );
  }
  return (
    <button
      onClick={() => setEditing(true)}
      title={tooltip}
      className="group flex items-center gap-1 min-w-0 cursor-pointer"
    >
      <span className={`truncate ${className}`}>{value}</span>
      <Pencil className="w-3 h-3 text-slate-500 group-hover:text-sky-400 shrink-0" />
    </button>
  );
};
