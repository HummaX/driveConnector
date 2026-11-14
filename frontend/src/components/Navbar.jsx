import React from 'react';
import { 
  PlaySquare, Cloud, Plus, RefreshCw, LogIn, LogOut, Shield, 
  Cpu, HardDrive, ArrowDownRight, ArrowUpRight, Activity, Database
} from 'lucide-react';

export default function Navbar({
  user,
  onOpenLogin,
  onLogout,
  onOpenSync,
  onOpenUrl,
  onOpenMongoDb,
  metrics,
  activeTransfersCount,
  onRefresh
}) {
  const cpu = metrics?.cpu || { percent: 0, cores: 1, frequency_mhz: 0 };
  const ram = metrics?.ram || { total_gb: 16, used_gb: 0, percent: 0 };
  const disk = metrics?.disk || { total_gb: 1000, used_gb: 0, percent: 0 };
  const net = metrics?.network || { input_mb_s: 0, output_mb_s: 0 };

  const getLoadColor = (pct) => {
    if (pct >= 85) return 'text-red-400 bg-red-500/10 border-red-500/20';
    if (pct >= 65) return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
    return 'text-sky-400 bg-sky-500/10 border-sky-500/20';
  };

  const getBarColor = (pct) => {
    if (pct >= 85) return 'bg-red-500';
    if (pct >= 65) return 'bg-amber-500';
    return 'bg-sky-500';
  };

  return (
    <header className="sticky top-0 z-30 w-full bg-slate-950/90 backdrop-blur-md border-b border-slate-800/80 shadow-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-3">
        {/* Brand */}
        <div className="flex items-center space-x-3 shrink-0">
          <div className="p-2 rounded-xl bg-gradient-to-tr from-sky-500 to-indigo-600 text-white shadow-lg shadow-sky-500/25">
            <PlaySquare className="w-5 h-5 fill-white" />
          </div>
          <div>
            <h1 className="text-base font-bold text-white tracking-tight flex items-center space-x-2">
              <span>DriveConnector</span>
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
                1TB NVMe
              </span>
            </h1>
            <p className="text-[10px] text-slate-400 hidden xl:block">
              Dedicated Media Ingestion & High-Speed Streaming
            </p>
          </div>
        </div>

        {/* Center: Real-Time Hardware Telemetry Header */}
        <div className="hidden md:flex items-center space-x-2 text-xs font-mono">
          {/* Server Processor (CPU) */}
          <div className="flex items-center space-x-2 bg-slate-900/80 border border-slate-800 px-2.5 py-1.5 rounded-lg">
            <Cpu className="w-3.5 h-3.5 text-sky-400" />
            <div className="flex flex-col">
              <div className="flex items-center space-x-1 text-[10px]">
                <span className="text-slate-400">CPU</span>
                <span className="text-white font-semibold">{cpu.percent}%</span>
              </div>
              <div className="w-12 bg-slate-800 h-1 rounded-full overflow-hidden mt-0.5">
                <div 
                  className={`h-full transition-all duration-500 ${getBarColor(cpu.percent)}`} 
                  style={{ width: `${Math.min(100, cpu.percent)}%` }} 
                />
              </div>
            </div>
          </div>

          {/* RAM Utilization */}
          <div className="flex items-center space-x-2 bg-slate-900/80 border border-slate-800 px-2.5 py-1.5 rounded-lg">
            <Activity className="w-3.5 h-3.5 text-indigo-400" />
            <div className="flex flex-col">
              <div className="flex items-center space-x-1 text-[10px]">
                <span className="text-slate-400">RAM</span>
                <span className="text-white font-semibold">{ram.used_gb}G</span>
                <span className="text-slate-500">[{ram.percent}%]</span>
              </div>
              <div className="w-14 bg-slate-800 h-1 rounded-full overflow-hidden mt-0.5">
                <div 
                  className="h-full bg-indigo-500 transition-all duration-500" 
                  style={{ width: `${Math.min(100, ram.percent)}%` }} 
                />
              </div>
            </div>
          </div>

          {/* 1TB Storage Disk */}
          <div className="flex items-center space-x-2 bg-slate-900/80 border border-slate-800 px-2.5 py-1.5 rounded-lg">
            <HardDrive className="w-3.5 h-3.5 text-emerald-400" />
            <div className="flex flex-col">
              <div className="flex items-center space-x-1 text-[10px]">
                <span className="text-slate-400">Disk</span>
                <span className="text-white font-semibold">{disk.used_gb}G</span>
                <span className="text-slate-500">/{disk.total_gb}G</span>
              </div>
              <div className="w-14 bg-slate-800 h-1 rounded-full overflow-hidden mt-0.5">
                <div 
                  className="h-full bg-emerald-500 transition-all duration-500" 
                  style={{ width: `${Math.min(100, disk.percent)}%` }} 
                />
              </div>
            </div>
          </div>

          {/* Network Throughput (Inbound & Outbound) */}
          <div className="hidden lg:flex items-center space-x-2.5 bg-slate-900/80 border border-slate-800 px-3 py-1.5 rounded-lg text-[10px]">
            <div className="flex items-center space-x-1 text-sky-400">
              <ArrowDownRight className="w-3 h-3" />
              <span className="text-slate-400">In:</span>
              <span className="font-semibold">{net.input_mb_s} MB/s</span>
            </div>
            <span className="text-slate-700">|</span>
            <div className="flex items-center space-x-1 text-emerald-400">
              <ArrowUpRight className="w-3 h-3" />
              <span className="text-slate-400">Out:</span>
              <span className="font-semibold">{net.output_mb_s} MB/s</span>
            </div>
          </div>
        </div>

        {/* Action Buttons & Auth */}
        <div className="flex items-center space-x-2 shrink-0">
          <button
            onClick={onRefresh}
            title="Refresh Catalog & Metrics"
            className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:border-slate-700 transition"
          >
            <RefreshCw className="w-4 h-4" />
          </button>

          {/* MongoDB UI Button */}
          {user && (
            <button
              onClick={onOpenMongoDb}
              title="Open MongoDB Explorer"
              className="flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-emerald-950/40 border border-emerald-800/60 hover:border-emerald-600 text-emerald-400 text-xs font-semibold hover:bg-emerald-900/40 transition"
            >
              <Database className="w-4 h-4" />
              <span className="hidden sm:inline">MongoDB UI</span>
            </button>
          )}

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

          {/* User Status / Log Out */}
          {user && (
            <div className="flex items-center space-x-1.5 pl-2 border-l border-slate-800">
              <div className="hidden sm:flex items-center space-x-1 text-xs text-slate-300 bg-slate-900 px-2.5 py-1.5 rounded-lg border border-slate-800 font-mono">
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
          )}
        </div>
      </div>
    </header>
  );
}
