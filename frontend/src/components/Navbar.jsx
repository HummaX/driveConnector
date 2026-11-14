import React from 'react';
import { PlaySquare, Cloud, Plus, Activity, RefreshCw } from 'lucide-react';
import StorageWidget from './StorageWidget';

export default function Navbar({ onOpenSync, onOpenUrl, activeTransfersCount, onRefresh }) {
  return (
    <header className="sticky top-0 z-30 w-full bg-slate-950/80 backdrop-blur-md border-b border-slate-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
        {/* Brand */}
        <div className="flex items-center space-x-3">
          <div className="p-2 rounded-xl bg-gradient-to-tr from-sky-500 to-indigo-600 text-white shadow-lg shadow-sky-500/20">
            <PlaySquare className="w-5 h-5 fill-white" />
          </div>
          <div>
            <h1 className="text-base font-bold text-white tracking-tight flex items-center space-x-2">
              <span>DriveConnector</span>
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
                1TB Stream
              </span>
            </h1>
            <p className="text-[11px] text-slate-400 hidden sm:block">
              On-Demand Cloud Ingestion & High-Speed Streaming
            </p>
          </div>
        </div>

        {/* Center: Storage Widget */}
        <div className="hidden md:flex items-center">
          <StorageWidget />
        </div>

        {/* Action Buttons */}
        <div className="flex items-center space-x-2.5">
          <button
            onClick={onRefresh}
            title="Refresh Catalog"
            className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:border-slate-700 transition"
          >
            <RefreshCw className="w-4 h-4" />
          </button>

          <button
            onClick={onOpenSync}
            className="flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-200 text-xs font-medium hover:bg-slate-850 transition"
          >
            <Cloud className="w-4 h-4 text-sky-400" />
            <span className="hidden sm:inline">Sync Drive</span>
          </button>

          <button
            onClick={onOpenUrl}
            className="flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium shadow-md shadow-indigo-600/20 transition"
          >
            <Plus className="w-4 h-4" />
            <span>Add URL</span>
          </button>
        </div>
      </div>
    </header>
  );
}
