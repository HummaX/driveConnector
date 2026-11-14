import React, { useState } from 'react';
import { 
  PlaySquare, Cloud, Plus, RefreshCw, LogOut, Shield, 
  Cpu, HardDrive, ArrowDownRight, ArrowUpRight, Activity, Database,
  CheckCircle2, Radio
} from 'lucide-react';

export default function Navbar({
  user,
  onLogout,
  onOpenSync,
  onOpenUrl,
  onOpenMongoDb,
  metrics,
  activeTransfersCount = 0,
  onRefresh
}) {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const cpu = metrics?.cpu || { percent: 0, cores: 1, frequency_mhz: 0 };
  const ram = metrics?.ram || { total_gb: 16, used_gb: 0, percent: 0 };
  const disk = metrics?.disk || { total_gb: 1000, used_gb: 0, percent: 0 };
  const net = metrics?.network || { input_mb_s: 0, output_mb_s: 0 };

  const handleRefreshClick = async () => {
    setIsRefreshing(true);
    if (onRefresh) {
      await onRefresh();
    }
    setTimeout(() => setIsRefreshing(false), 600);
  };

  const getLoadStatusColor = (pct) => {
    if (pct >= 85) return 'bg-red-500';
    if (pct >= 65) return 'bg-amber-400';
    return 'bg-emerald-400';
  };

  return (
    <header className="sticky top-0 z-30 w-full bg-[#0d1117]/95 backdrop-blur-xl border-b border-[#30363d]/80 shadow-lg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-3">
        {/* Brand */}
        <div className="flex items-center space-x-3 shrink-0">
          <div className="p-2 rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white shadow-md shadow-sky-500/20 border border-sky-400/20">
            <PlaySquare className="w-5 h-5 fill-white" />
          </div>
          <div className="flex flex-col">
            <div className="flex items-center space-x-2">
              <span className="text-base font-bold text-white tracking-tight">DriveConnector</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/25 uppercase font-medium">
                1TB NVMe
              </span>
            </div>
            <span className="text-[10px] text-slate-400 hidden xl:inline font-mono">
              Self-Hosted Media Engine • Node 01
            </span>
          </div>
        </div>

        {/* Center: Executive Hardware Telemetry Strip */}
        <div className="hidden md:flex items-center space-x-2 text-xs font-mono select-none">
          {/* CPU Pill */}
          <div 
            className="flex items-center space-x-2 bg-[#161b22]/90 border border-[#30363d]/70 px-2.5 py-1.5 rounded-lg hover:border-slate-600 transition"
            title={`Processor: ${cpu.cores} Cores @ ${cpu.frequency_mhz || 'Auto'} MHz`}
          >
            <div className="flex items-center space-x-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${getLoadStatusColor(cpu.percent)}`} />
              <Cpu className="w-3.5 h-3.5 text-sky-400" />
            </div>
            <div className="flex items-baseline space-x-1">
              <span className="text-slate-400 text-[10px]">CPU</span>
              <span className="text-white font-semibold">{cpu.percent}%</span>
            </div>
            <div className="w-10 bg-slate-800 h-1 rounded-full overflow-hidden">
              <div 
                className={`h-full transition-all duration-500 ${
                  cpu.percent >= 85 ? 'bg-red-500' : cpu.percent >= 65 ? 'bg-amber-400' : 'bg-sky-400'
                }`}
                style={{ width: `${Math.min(100, cpu.percent)}%` }} 
              />
            </div>
          </div>

          {/* RAM Pill */}
          <div 
            className="flex items-center space-x-2 bg-[#161b22]/90 border border-[#30363d]/70 px-2.5 py-1.5 rounded-lg hover:border-slate-600 transition"
            title={`System Memory: ${ram.used_gb} GB used of ${ram.total_gb} GB total`}
          >
            <Activity className="w-3.5 h-3.5 text-indigo-400" />
            <div className="flex items-baseline space-x-1">
              <span className="text-slate-400 text-[10px]">RAM</span>
              <span className="text-white font-semibold">{ram.used_gb}G</span>
              <span className="text-slate-500 text-[10px]">/ {ram.total_gb}G</span>
            </div>
            <div className="w-10 bg-slate-800 h-1 rounded-full overflow-hidden">
              <div 
                className="h-full bg-indigo-500 transition-all duration-500" 
                style={{ width: `${Math.min(100, ram.percent)}%` }} 
              />
            </div>
          </div>

          {/* NVMe Storage Pill */}
          <div 
            className="flex items-center space-x-2 bg-[#161b22]/90 border border-[#30363d]/70 px-2.5 py-1.5 rounded-lg hover:border-slate-600 transition"
            title={`High-Speed NVMe Storage: ${disk.used_gb} GB used / ${disk.total_gb} GB total`}
          >
            <HardDrive className="w-3.5 h-3.5 text-emerald-400" />
            <div className="flex items-baseline space-x-1">
              <span className="text-slate-400 text-[10px]">Disk</span>
              <span className="text-white font-semibold">{disk.used_gb}G</span>
              <span className="text-emerald-400/90 text-[10px] font-medium">({disk.percent}%)</span>
            </div>
            <div className="w-10 bg-slate-800 h-1 rounded-full overflow-hidden">
              <div 
                className="h-full bg-emerald-500 transition-all duration-500" 
                style={{ width: `${Math.min(100, disk.percent)}%` }} 
              />
            </div>
          </div>

          {/* Network Throughput Pill */}
          <div 
            className="hidden lg:flex items-center space-x-2.5 bg-[#161b22]/90 border border-[#30363d]/70 px-2.5 py-1.5 rounded-lg text-[10px] hover:border-slate-600 transition"
            title="Real-time Network I/O Throughput"
          >
            <div className="flex items-center space-x-1 text-sky-400">
              <ArrowDownRight className="w-3 h-3" />
              <span className="font-semibold">{net.input_mb_s} MB/s</span>
            </div>
            <span className="text-slate-700">|</span>
            <div className="flex items-center space-x-1 text-emerald-400">
              <ArrowUpRight className="w-3 h-3" />
              <span className="font-semibold">{net.output_mb_s} MB/s</span>
            </div>
          </div>
        </div>

        {/* Action Buttons & Auth */}
        <div className="flex items-center space-x-2 shrink-0">
          {/* Refresh button with animation */}
          <button
            onClick={handleRefreshClick}
            disabled={isRefreshing}
            title="Refresh Telemetry & Catalog"
            className="p-2 rounded-lg bg-[#161b22] border border-[#30363d] text-slate-300 hover:text-white hover:border-slate-600 transition active:scale-95"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-sky-400' : ''}`} />
          </button>

          {/* MongoDB UI Button */}
          {user && (
            <button
              onClick={onOpenMongoDb}
              title="Open MongoDB Live Explorer"
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-[#161b22] border border-emerald-500/30 hover:border-emerald-500/60 text-emerald-400 text-xs font-medium hover:bg-emerald-950/30 transition shadow-sm"
            >
              <Database className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">MongoDB</span>
            </button>
          )}

          {/* Sync Drive Button */}
          <button
            onClick={onOpenSync}
            title="Sync Google Drive Catalog"
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-[#161b22] border border-[#30363d] hover:border-slate-600 text-slate-200 text-xs font-medium hover:bg-[#21262d] transition shadow-sm"
          >
            <Cloud className="w-3.5 h-3.5 text-sky-400" />
            <span className="hidden sm:inline">Sync Drive</span>
          </button>

          {/* Add URL Button (GitHub Green Action) */}
          <button
            onClick={onOpenUrl}
            title="Ingest Media from External URL"
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-[#238636] hover:bg-[#2ea043] text-white text-xs font-semibold border border-[#2ea043]/50 shadow-sm transition active:scale-95"
          >
            <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
            <span>Add URL</span>
          </button>

          {/* User Status / Log Out */}
          {user && (
            <div className="flex items-center space-x-1.5 pl-2 border-l border-[#30363d]">
              <div className="hidden sm:flex items-center space-x-1.5 text-xs text-slate-300 bg-[#161b22] px-2.5 py-1.5 rounded-lg border border-[#30363d] font-mono">
                <Shield className="w-3 h-3 text-emerald-400" />
                <span className="font-semibold text-slate-200">{user.username}</span>
              </div>
              <button
                onClick={onLogout}
                title="Log Out of Control Panel"
                className="p-2 rounded-lg bg-[#161b22] border border-[#30363d] text-slate-400 hover:text-red-400 hover:border-red-500/30 transition"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
