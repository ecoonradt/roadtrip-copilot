import React from 'react';
import { Compass, ShieldAlert, LogOut } from 'lucide-react';
import type { AuthStatusResponse } from '../types/auth';

export interface AuthGateScreenProps {
  status: AuthStatusResponse;
  onLogout: () => Promise<void> | void;
  onRetry?: () => Promise<void> | void;
}

export const AuthGateScreen: React.FC<AuthGateScreenProps> = ({
  status,
  onLogout,
  onRetry,
}) => {
  const isUnauthorized = status.authenticated && !status.authorized;

  return (
    <div className="min-h-screen w-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6 select-none">
      <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
        {/* Brand Header */}
        <div className="flex flex-col items-center text-center mb-6">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-sky-500/20 mb-3">
            <Compass className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-white">Roadtrip Co-Pilot</h1>
          <p className="text-xs text-slate-400 mt-1">Route Builder Web Studio</p>
        </div>

        {isUnauthorized ? (
          /* Case B: Authenticated but Not Authorized (403 Private Preview) */
          <div className="space-y-5">
            <div className="bg-amber-950/60 border border-amber-700/70 rounded-xl p-4 text-amber-200 space-y-2">
              <div className="flex items-center gap-2 font-semibold text-sm text-amber-100">
                <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
                <span>Private Preview — Access Restricted</span>
              </div>
              <p className="text-xs leading-relaxed text-amber-200/90">
                {status.message ||
                  'Roadtrip Co-Pilot is currently in private preview. Your Google account is not on the authorized allowlist.'}
              </p>
            </div>

            {status.user && (
              <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-3 flex items-center gap-3">
                {status.user.picture ? (
                  <img
                    src={status.user.picture}
                    alt={status.user.name || status.user.email}
                    className="w-9 h-9 rounded-full border border-slate-600 object-cover"
                  />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-slate-700 flex items-center justify-center text-slate-300 font-medium text-sm">
                    {status.user.name
                      ? status.user.name.charAt(0).toUpperCase()
                      : status.user.email.charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  {status.user.name && (
                    <div className="text-xs font-medium text-slate-200 truncate">
                      {status.user.name}
                    </div>
                  )}
                  <div
                    className="text-xs text-slate-400 truncate"
                    title={status.user.email}
                  >
                    {status.user.email}
                  </div>
                </div>
              </div>
            )}

            <button
              onClick={() => {
                void onLogout();
              }}
              type="button"
              className="bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 py-2.5 px-4 rounded-xl w-full font-medium text-sm transition-colors cursor-pointer flex items-center justify-center gap-2"
            >
              <LogOut className="w-4 h-4 text-slate-300" />
              <span>Sign Out & Use Another Account</span>
            </button>
          </div>
        ) : (
          /* Case A: Unauthenticated / Connection Issue */
          <div className="space-y-5">
            {status.message && (
              <div className="bg-amber-950/60 border border-amber-700/70 rounded-xl p-4 text-amber-200 space-y-2">
                <div className="flex items-center gap-2 font-semibold text-sm text-amber-100">
                  <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>Connection Issue</span>
                </div>
                <p className="text-xs leading-relaxed text-amber-200/90">
                  {status.message}
                </p>
                {onRetry && (
                  <button
                    type="button"
                    onClick={() => {
                      void onRetry();
                    }}
                    className="mt-1 text-xs font-semibold text-amber-300 hover:text-amber-200 underline cursor-pointer"
                  >
                    Retry Connection
                  </button>
                )}
              </div>
            )}

            <div className="text-center space-y-1.5">
              <h2 className="text-base font-semibold text-slate-100">Sign in to continue</h2>
              <p className="text-xs text-slate-400 leading-relaxed">
                Sign in with your authorized Google account to plan routes, sync itineraries, and use Route Scout.
              </p>
            </div>

            <div className="pt-2">
              <a
                href="/api/auth/google"
                className="bg-white hover:bg-slate-100 text-slate-900 font-semibold py-2.5 px-4 rounded-xl flex items-center justify-center gap-2.5 w-full transition-colors shadow-md cursor-pointer text-sm"
              >
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
                  <path
                    fill="#4285F4"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                  />
                </svg>
                <span>Continue with Google</span>
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
