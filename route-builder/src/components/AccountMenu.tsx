import React, { useEffect, useId, useRef, useState } from 'react';
import { LogOut } from 'lucide-react';
import type { AuthUser } from '../types/auth';

interface AccountMenuProps {
  user: AuthUser;
  onLogout?: () => void;
}

export const AccountMenu: React.FC<AccountMenuProps> = ({ user, onLogout }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [failedPicture, setFailedPicture] = useState<string | null>(null);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const signOutRef = useRef<HTMLButtonElement>(null);

  const nameParts = user.name.trim().split(/\s+/).filter(Boolean);
  const initials = (nameParts.length > 1
    ? `${nameParts[0].charAt(0)}${nameParts[nameParts.length - 1].charAt(0)}`
    : (nameParts[0] || user.email).charAt(0)
  ).toUpperCase();

  useEffect(() => {
    if (!isOpen) return;
    (signOutRef.current || panelRef.current)?.focus();
    if (typeof document === 'undefined') return;

    const ownerDocument = document;
    const closeOutside = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node | null)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    ownerDocument.addEventListener('pointerdown', closeOutside);
    ownerDocument.addEventListener('focusin', closeOutside);
    ownerDocument.addEventListener('keydown', handleKeyDown);
    return () => {
      ownerDocument.removeEventListener('pointerdown', closeOutside);
      ownerDocument.removeEventListener('focusin', closeOutside);
      ownerDocument.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={rootRef} className="relative shrink-0 pl-1.5 border-l border-slate-800">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Account"
        title="Account"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-controls={panelId}
        onClick={() => setIsOpen((open) => !open)}
        className="w-8 h-8 rounded-full bg-slate-700 border border-slate-600 text-xs font-semibold text-slate-100 flex items-center justify-center cursor-pointer hover:border-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
      >
        <span aria-hidden="true">
          {user.picture && user.picture !== failedPicture ? (
            <img
              src={user.picture}
              alt=""
              onError={() => setFailedPicture(user.picture || null)}
              className="w-7 h-7 rounded-full object-cover"
            />
          ) : initials}
        </span>
      </button>

      {isOpen && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Account"
          tabIndex={-1}
          className="absolute right-0 top-full mt-2 w-72 max-w-[calc(100vw-2rem)] p-3 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50 whitespace-normal focus:outline-none"
        >
          <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
            {user.name && <p className="text-sm font-semibold text-white">{user.name}</p>}
            <p className="text-xs text-slate-400">{user.email}</p>
          </div>
          {onLogout && (
            <button
              ref={signOutRef}
              type="button"
              aria-label="Sign out"
              title="Sign out"
              onClick={() => {
                setIsOpen(false);
                triggerRef.current?.focus();
                onLogout();
              }}
              className="mt-3 w-full flex items-center gap-2 px-2.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-slate-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <LogOut className="w-4 h-4" aria-hidden="true" />
              Sign out
            </button>
          )}
        </div>
      )}
    </div>
  );
};
