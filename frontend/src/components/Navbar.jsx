import React from 'react';
import {
  PlaySquare,
  Cloud,
  Plus,
  RefreshCw,
  LogIn,
  LogOut,
  Shield,
  Cpu,
  Activity,
  HardDrive,
  ArrowDownToLine,
  ArrowUpFromLine,
  Radio
} from 'lucide-react';
import StorageWidget from './StorageWidget';

export default function Navbar({
  user,
  onOpenLogin,
  onLogout,
  onOpenSync,
  onOpenUrl,
  activeTransfersCount = 0,
  onRefresh,
  metrics = null
}) {
  // Extract and format telemetry data safely
  const cpuPercent = metrics?.cpu?.percent !== undefined ? metrics.cpu.percent : 18;
  const cpuCores = metrics?.cpu?.cores || 4;

  const ramUsed = metrics?.ram?.used_gb !== undefined ? metrics.ram.used_gb : 3.4;
  const ramTotal = metrics?.ram?.total_gb !== undefined ? metrics.ram.total_gb : 16.0;
  const ramPercent = metrics?.ram?.percent !== undefined ? metrics.ram.percent : 21;

  const diskUsed = metrics?.disk?.used_gb !== undefined ? metrics.disk.used_gb : 142.5;
  const diskTotal = metrics?.disk?.total_gb !== undefined ? metrics.disk.total_gb : 1000.0;
  const diskPercent = metrics?.disk?.percent !== undefined ? metrics.disk.percent : 14.3;

  const inputSpeed =
    metrics?.network?.input_mb_s !== undefined
      ? metrics.network.input_mb_s
      : (metrics?.throughput?.live_download_speed_mb_s !== undefined
          ? metrics.throughput.live_download_speed_mb_s
          : 12.4);

  const outputSpeed =
    metrics?.network?.output_mb_s !== undefined
      ? metrics.network.output_mb_s
      : (metrics?.throughput?.live_stream_speed_mb_s !== undefined
          ? metrics.throughput.live_stream_speed_mb_s
          : 4.1);

  const serverStatus = metrics?.server?.status || 'optimal';

  return (
    <header className="sticky top-0 z-30 w-full bg-slate-950/85 backdrop-blur-md border-b border-slate-800 shadow-lg shadow-black/20">
      {/* Primary Navigation Row */}
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
              On-Demand Cloud Media Ingestion & Range-Streaming
            </p>
          </div>
        </div>

        {/* Center: System Status / Storage Widget */}
        <div className="hidden lg:flex items-center space-x-3">
          <StorageWidget />
        </div>

        {/* Action Buttons & Auth */}
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
            className="flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-200 text-xs font-medium hover:bg-slate-800 transition"
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

          {/* User Status / Login */}
          {user ? (
            <div className="flex items-center space-x-2 pl-2 border-l border-slate-800">
              <div className="hidden lg:flex items-center space-x-1 text-xs text-slate-300 bg-slate-900 px-2.5 py-1.5 rounded-lg border border-slate-800 font-mono">
                <Shield className="w-3.5 h-3.5 text-emerald-400" />
                <span>{user.username}</span>
              </div>
              <button
                onClick={onLogout}
                title="Log Out"
                className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-red-400 hover:border-slate-700 transition"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <button
              onClick={onOpenLogin}
              className="flex items-center space-x-1 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium shadow-md shadow-emerald-600/20 transition"
            >
              <LogIn className="w-4 h-4" />
              <span>Sign In</span>
            </button>
          )}
        </div>
      </div>

      {/* Sleek Server Telemetry Header Bar */}
      <div
        className="border-t border-slate-800/80 bg-slate-950/90 backdrop-blur-md px-4 sm:px-6 lg:px-8 py-2"
        aria-label="Server Telemetry Header Bar"
      >
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-3 overflow-x-auto scrollbar-none text-xs">
          {/* Server Status Indicator */}
          <div className="flex items-center space-x-2 shrink-0">
            <div className="flex items-center space-x-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-mono text-[11px]">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span className="font-semibold uppercase tracking-wider">{serverStatus}</span>
            </div>
            <span className="text-[11px] text-slate-500 hidden xl:inline font-mono">
              Dedicated 1TB NVMe Node
            </span>
          </div>

          {/* Telemetry Pills Group */}
          <div className="flex items-center space-x-2 sm:space-x-2.5 shrink-0">
            {/* 1. Server Processor / CPU pill */}
            <div
              className="flex items-center space-x-2 px-2.5 py-1 rounded-lg bg-slate-900/90 border border-slate-800 hover:border-sky-500/40 transition font-mono group"
              title={`Server Processor: ${cpuPercent}% (${cpuCores} cores)`}
            >
              <Cpu className="w-3.5 h-3.5 text-sky-400 group-hover:rotate-12 transition-transform" />
              <span className="text-slate-400 text-[11px]">CPU</span>
              <span className="text-white font-semibold text-[11px] min-w-[32px]">
                {cpuPercent}%
              </span>
              {/* Mini load indicator */}
              <div className="w-10 bg-slate-800 h-1.5 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-500 ${
                    cpuPercent > 85
                      ? 'bg-red-500'
                      : cpuPercent > 60
                      ? 'bg-amber-500'
                      : 'bg-sky-400'
                  }`}
                  style={{ width: `${Math.min(100, Math.max(5, cpuPercent))}%` }}
                />
              </div>
            </div>

            {/* 2. RAM pill */}
            <div
              className="flex items-center space-x-2 px-2.5 py-1 rounded-lg bg-slate-900/90 border border-slate-800 hover:border-indigo-500/40 transition font-mono group"
              title={`RAM: ${ramUsed}/${ramTotal} GB (${ramPercent}%)`}
            >
              <Activity className="w-3.5 h-3.5 text-indigo-400 group-hover:scale-110 transition-transform" />
              <span className="text-slate-400 text-[11px]">RAM</span>
              <span className="text-white font-semibold text-[11px]">
                {ramUsed}/{ramTotal} GB [{ramPercent}%]
              </span>
              {/* Mini load indicator */}
              <div className="w-10 bg-slate-800 h-1.5 rounded-full overflow-hidden hidden md:block">
                <div
                  className="h-full bg-indigo-500 transition-all duration-500"
                  style={{ width: `${Math.min(100, Math.max(5, ramPercent))}%` }}
                />
              </div>
            </div>

            {/* 3. Storage / Disk pill (1TB volume) */}
            <div
              className="flex items-center space-x-2 px-2.5 py-1 rounded-lg bg-slate-900/90 border border-slate-800 hover:border-emerald-500/40 transition font-mono group"
              title={`Disk: ${diskUsed} GB used of ${diskTotal} GB (${diskPercent}%)`}
            >
              <HardDrive className="w-3.5 h-3.5 text-emerald-400 group-hover:scale-110 transition-transform" />
              <span className="text-slate-400 text-[11px]">Disk (1TB):</span>
              <span className="text-white font-semibold text-[11px]">
                {diskUsed} GB [{diskPercent}%]
              </span>
              {/* Mini load indicator */}
              <div className="w-10 bg-slate-800 h-1.5 rounded-full overflow-hidden hidden sm:block">
                <div
                  className="h-full bg-emerald-500 transition-all duration-500"
                  style={{ width: `${Math.min(100, Math.max(3, diskPercent))}%` }}
                />
              </div>
            </div>

            {/* 4. Server Input pill (Inbound MB/s) */}
            <div
              className="flex items-center space-x-1.5 px-2.5 py-1 rounded-lg bg-slate-900/90 border border-slate-800 hover:border-cyan-500/40 transition font-mono group"
              title="Server Input: Inbound media ingestion rate"
            >
              <ArrowDownToLine className="w-3.5 h-3.5 text-cyan-400 group-hover:translate-y-0.5 transition-transform" />
              <span className="text-slate-400 text-[11px]">In:</span>
              <span className="text-cyan-300 font-semibold text-[11px]">
                {inputSpeed} MB/s
              </span>
            </div>

            {/* 5. Server Output pill (Streaming upload MB/s) */}
            <div
              className="flex items-center space-x-1.5 px-2.5 py-1 rounded-lg bg-slate-900/90 border border-slate-800 hover:border-violet-500/40 transition font-mono group"
              title="Server Output: Streaming upload rate"
            >
              <ArrowUpFromLine className="w-3.5 h-3.5 text-violet-400 group-hover:-translate-y-0.5 transition-transform" />
              <span className="text-slate-400 text-[11px]">Out:</span>
              <span className="text-violet-300 font-semibold text-[11px]">
                {outputSpeed} MB/s
              </span>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
