import React from 'react';
import {
  HardDrive,
  Cloud,
  CheckCircle2,
  Clock,
  Sparkles,
  ArrowDownToLine,
  ArrowUpFromLine,
  Activity,
  Zap,
  Radio,
  Database
} from 'lucide-react';

function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return 'Just started';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function StatsDashboard({
  metrics = null,
  videos = [],
  transfers = {},
  processingJobs = {},
  activeFilter = 'ALL',
  onFilterChange = null
}) {
  // Safe extraction with fallbacks to client-side state
  const localCountFallback = (videos || []).filter((v) => v.status === 'LOCAL_READY').length;
  const cloudCountFallback = (videos || []).filter((v) => v.status === 'REMOTE_ONLY').length;
  const transferValues = Object.values(transfers || {});
  const inQueueFallback = transferValues.filter(
    (t) => t.status === 'DOWNLOADING' || t.status === 'WAITING'
  ).length;
  const inProcessingFallback = transferValues.filter(
    (t) => t.status === 'PROCESSING'
  ).length + Object.keys(processingJobs || {}).length;

  // Pipeline metrics
  const totalFiles = metrics?.pipeline?.total_files ?? (videos ? videos.length : 0);
  const localFiles = metrics?.pipeline?.local_files ?? localCountFallback;
  const cloudFiles = metrics?.pipeline?.cloud_files ?? cloudCountFallback;
  const inQueue = metrics?.pipeline?.in_queue ?? inQueueFallback;
  const inProcessing = metrics?.pipeline?.in_processing ?? inProcessingFallback;
  const completed = metrics?.pipeline?.completed ?? localFiles;

  // Storage metrics (1TB NVMe volume)
  const diskTotal = metrics?.disk?.total_gb ?? 1000.0;
  const diskUsed = metrics?.disk?.used_gb ?? (localFiles * 2.4).toFixed(1);
  const diskFree = metrics?.disk?.free_gb ?? Math.max(0, diskTotal - Number(diskUsed)).toFixed(1);
  const diskPct = metrics?.disk?.percent ?? Math.min(100, Math.round((Number(diskUsed) / diskTotal) * 100));

  // Network / Throughput
  const downloadSpeed =
    metrics?.throughput?.live_download_speed_mb_s ??
    metrics?.network?.input_mb_s ??
    0.0;
  const streamSpeed =
    metrics?.throughput?.live_stream_speed_mb_s ??
    metrics?.network?.output_mb_s ??
    0.0;
  const totalRxMb = metrics?.network?.total_received_mb ?? 0;
  const totalTxMb = metrics?.network?.total_sent_mb ?? 0;

  // Server health
  const serverStatus = metrics?.server?.status || 'optimal';
  const uptimeStr = formatUptime(metrics?.server?.uptime_seconds);
  const serverOs = metrics?.server?.os || 'Linux';

  const localRatio = totalFiles > 0 ? Math.round((localFiles / totalFiles) * 100) : 0;
  const cloudRatio = totalFiles > 0 ? 100 - localRatio : 0;

  return (
    <section className="space-y-3.5" aria-label="Executive Operations Dashboard">
      {/* Executive Mission Control Status Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 px-1 pb-1">
        <div className="flex items-center space-x-2.5">
          <div className="p-1.5 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-400">
            <Activity className="w-4 h-4 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h2 className="text-sm font-semibold tracking-tight text-white">
                Operations & Streaming Telemetry
              </h2>
              <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center space-x-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping inline-block" />
                <span>{serverStatus}</span>
              </span>
            </div>
            <p className="text-[11px] text-slate-400 font-mono">
              Dedicated Host • {serverOs} • Uptime {uptimeStr}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2 text-[11px] font-mono text-slate-400 self-start sm:self-auto">
          <div className="flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-[#161b22] border border-[#30363d]">
            <Radio className="w-3 h-3 text-emerald-400 animate-pulse" />
            <span>WebSocket Live</span>
          </div>
        </div>
      </div>

      {/* 5-Card Executive Operations Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3.5">
        {/* Card 1: Media Library & Ingestion Distribution (Spans 2 cols on md for balanced 3-col rows) */}
        <div
          onClick={() => onFilterChange && onFilterChange('ALL')}
          className={`group rounded-xl bg-[#0d1117]/80 backdrop-blur-md border p-4 transition-all duration-200 cursor-pointer flex flex-col justify-between shadow-sm hover:shadow-md md:col-span-2 xl:col-span-1 ${
            activeFilter === 'ALL'
              ? 'border-sky-500/50 ring-1 ring-sky-500/20'
              : 'border-[#30363d]/80 hover:border-slate-600'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium text-slate-400 tracking-wide uppercase font-mono">
              Media Catalog
            </span>
            <div className="p-1.5 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20 group-hover:scale-105 transition-transform">
              <Database className="w-3.5 h-3.5" />
            </div>
          </div>

          <div>
            <div className="flex items-baseline space-x-1.5 font-mono">
              <span className="text-2xl font-bold text-white tracking-tight">
                {totalFiles}
              </span>
              <span className="text-xs text-slate-500">items</span>
            </div>

            {/* Split interactive chips */}
            <div className="mt-2.5 flex items-center space-x-1.5 text-[10px] font-mono">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onFilterChange && onFilterChange('LOCAL');
                }}
                className={`px-2 py-0.5 rounded border transition flex items-center space-x-1 ${
                  activeFilter === 'LOCAL'
                    ? 'bg-emerald-500/25 text-emerald-300 border-emerald-500/40 ring-1 ring-emerald-500/30'
                    : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20'
                }`}
                title="Filter Cached on Server"
              >
                <HardDrive className="w-3 h-3" />
                <span>{localFiles} Local</span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onFilterChange && onFilterChange('CLOUD');
                }}
                className={`px-2 py-0.5 rounded border transition flex items-center space-x-1 ${
                  activeFilter === 'CLOUD'
                    ? 'bg-amber-500/25 text-amber-300 border-amber-500/40 ring-1 ring-amber-500/30'
                    : 'bg-amber-500/10 text-amber-400 border-amber-500/20 hover:bg-amber-500/20'
                }`}
                title="Filter Cloud Remote Only"
              >
                <Cloud className="w-3 h-3" />
                <span>{cloudFiles} Cloud</span>
              </button>
            </div>

            {/* Proportional distribution bar */}
            <div className="mt-3 w-full bg-[#21262d] h-1.5 rounded-full overflow-hidden flex">
              <div
                className="bg-emerald-400 transition-all duration-500"
                style={{ width: `${localRatio}%` }}
                title={`${localRatio}% Local on Server`}
              />
              <div
                className="bg-amber-400 transition-all duration-500"
                style={{ width: `${cloudRatio}%` }}
                title={`${cloudRatio}% Cloud Remote`}
              />
            </div>
          </div>
        </div>

        {/* Card 2: Ingestion & FFmpeg Processing Pipeline */}
        <div className="group rounded-xl bg-[#0d1117]/80 backdrop-blur-md border border-[#30363d]/80 hover:border-slate-600 p-4 transition-all duration-200 flex flex-col justify-between shadow-sm hover:shadow-md">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium text-slate-400 tracking-wide uppercase font-mono">
              Ingest Pipeline
            </span>
            <div
              className={`p-1.5 rounded-lg border transition-transform ${
                inQueue > 0 || inProcessing > 0
                  ? 'bg-purple-500/20 border-purple-500/30 text-purple-300 animate-pulse'
                  : 'bg-[#161b22] border-[#30363d] text-slate-400'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
            </div>
          </div>

          <div>
            <div className="flex items-baseline space-x-1.5 font-mono">
              <span className="text-2xl font-bold text-white tracking-tight">
                {inQueue + inProcessing}
              </span>
              <span className="text-xs text-slate-500">active tasks</span>
            </div>

            <div className="mt-2.5 flex items-center space-x-1.5 text-[10px] font-mono">
              <span className="px-2 py-0.5 rounded bg-[#161b22] text-slate-300 border border-[#30363d] flex items-center space-x-1">
                <Clock className="w-3 h-3 text-sky-400" />
                <span>{inQueue} Queue</span>
              </span>
              <span className="px-2 py-0.5 rounded bg-[#161b22] text-slate-300 border border-[#30363d] flex items-center space-x-1">
                <Sparkles className="w-3 h-3 text-purple-400" />
                <span>{inProcessing} Sprites</span>
              </span>
            </div>

            <p className="mt-3 text-[11px] text-slate-500 truncate font-mono">
              {inQueue > 0 ? 'Parallel Stream Download Active' : 'Ingestion Workers Idle'}
            </p>
          </div>
        </div>

        {/* Card 3: 1TB NVMe High-Speed Storage */}
        <div className="group rounded-xl bg-[#0d1117]/80 backdrop-blur-md border border-[#30363d]/80 hover:border-slate-600 p-4 transition-all duration-200 flex flex-col justify-between shadow-sm hover:shadow-md">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium text-slate-400 tracking-wide uppercase font-mono">
              1TB NVMe Disk
            </span>
            <div className="p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 group-hover:scale-105 transition-transform">
              <HardDrive className="w-3.5 h-3.5" />
            </div>
          </div>

          <div>
            <div className="flex items-baseline space-x-1.5 font-mono">
              <span className="text-xl font-bold text-white tracking-tight">{diskUsed}</span>
              <span className="text-xs text-slate-500">/ {diskTotal} GB</span>
              <span className="ml-auto text-xs font-semibold text-emerald-400">
                {diskPct}%
              </span>
            </div>

            {/* Storage Progress Bar */}
            <div className="mt-2.5 w-full bg-[#21262d] h-1.5 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${
                  diskPct > 90
                    ? 'bg-red-500'
                    : diskPct > 75
                    ? 'bg-amber-400'
                    : 'bg-emerald-400'
                }`}
                style={{ width: `${Math.min(100, diskPct)}%` }}
              />
            </div>

            <div className="mt-2.5 flex items-center justify-between text-[10px] font-mono text-slate-500">
              <span>{diskFree} GB free</span>
              <span className="text-emerald-400/80">/mnt/storage</span>
            </div>
          </div>
        </div>

        {/* Card 4: Live I/O Throughput & Bandwidth */}
        <div className="group rounded-xl bg-[#0d1117]/80 backdrop-blur-md border border-[#30363d]/80 hover:border-slate-600 p-4 transition-all duration-200 flex flex-col justify-between shadow-sm hover:shadow-md">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium text-slate-400 tracking-wide uppercase font-mono">
              Throughput I/O
            </span>
            <div className="p-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 group-hover:scale-105 transition-transform">
              <Activity className="w-3.5 h-3.5" />
            </div>
          </div>

          <div>
            <div className="space-y-1 font-mono text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-400 flex items-center space-x-1">
                  <ArrowDownToLine className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Fetch:</span>
                </span>
                <span className="font-bold text-cyan-300">{downloadSpeed} MB/s</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400 flex items-center space-x-1">
                  <ArrowUpFromLine className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Stream:</span>
                </span>
                <span className="font-bold text-emerald-300">{streamSpeed} MB/s</span>
              </div>
            </div>

            <div className="mt-2.5 flex items-center justify-between text-[10px] font-mono text-slate-500 truncate">
              <span>Rx: {totalRxMb} MB</span>
              <span>Tx: {totalTxMb} MB</span>
            </div>
          </div>
        </div>

        {/* Card 5: Streaming Readiness & Seekable Files */}
        <div
          onClick={() => onFilterChange && onFilterChange('LOCAL')}
          className={`group rounded-xl bg-[#0d1117]/80 backdrop-blur-md border p-4 transition-all duration-200 cursor-pointer flex flex-col justify-between shadow-sm hover:shadow-md ${
            activeFilter === 'LOCAL'
              ? 'border-emerald-500/50 ring-1 ring-emerald-500/20'
              : 'border-[#30363d]/80 hover:border-slate-600'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium text-slate-400 tracking-wide uppercase font-mono">
              Stream Ready
            </span>
            <div className="p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 group-hover:scale-105 transition-transform">
              <CheckCircle2 className="w-3.5 h-3.5" />
            </div>
          </div>

          <div>
            <div className="flex items-baseline space-x-1.5 font-mono">
              <span className="text-2xl font-bold text-emerald-400 tracking-tight">
                {completed}
              </span>
              <span className="text-xs text-slate-500">ready</span>
            </div>

            <div className="mt-2.5">
              <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 text-[10px] font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span>Zero-Latency Byte Range</span>
              </span>
            </div>

            <p className="mt-3 text-[11px] text-slate-500 truncate font-mono">
              Instant Plyr Scrubbing
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
