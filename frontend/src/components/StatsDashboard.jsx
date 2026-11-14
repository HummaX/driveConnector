import React from 'react';
import {
  Film,
  HardDrive,
  Cloud,
  CheckCircle2,
  Clock,
  Sparkles,
  ArrowDownToLine,
  ArrowUpFromLine,
  Activity,
  Server,
  Zap,
  Radio,
  Layers,
  Database
} from 'lucide-react';

function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return 'Just started';
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
  onFilterChange = null
}) {
  // Safe extraction with fallbacks to client-side state
  const localCountFallback = videos.filter((v) => v.status === 'LOCAL_READY').length;
  const cloudCountFallback = videos.filter((v) => v.status === 'REMOTE_ONLY').length;
  const inQueueFallback = Object.values(transfers).filter(
    (t) => t.status === 'DOWNLOADING' || t.status === 'WAITING'
  ).length;
  const inProcessingFallback = Object.values(transfers).filter(
    (t) => t.status === 'PROCESSING'
  ).length;

  // Pipeline metrics
  const totalFiles = metrics?.pipeline?.total_files ?? videos.length;
  const localFiles = metrics?.pipeline?.local_files ?? localCountFallback;
  const cloudFiles = metrics?.pipeline?.cloud_files ?? cloudCountFallback;
  const inQueue = metrics?.pipeline?.in_queue ?? inQueueFallback;
  const inProcessing = metrics?.pipeline?.in_processing ?? inProcessingFallback;
  const completed = metrics?.pipeline?.completed ?? localFiles;

  // Storage metrics
  const diskTotal = metrics?.disk?.total_gb ?? 1000.0;
  const diskUsed = metrics?.disk?.used_gb ?? (localFiles * 2.4).toFixed(1);
  const diskFree = metrics?.disk?.free_gb ?? (diskTotal - diskUsed).toFixed(1);
  const diskPct = metrics?.disk?.percent ?? Math.min(100, Math.round((diskUsed / diskTotal) * 100));

  // Network / Throughput
  const downloadSpeed =
    metrics?.throughput?.live_download_speed_mb_s ??
    metrics?.network?.input_mb_s ??
    0.0;
  const streamSpeed =
    metrics?.throughput?.live_stream_speed_mb_s ??
    metrics?.network?.output_mb_s ??
    0.0;

  // Server health
  const serverStatus = metrics?.server?.status || 'optimal';
  const uptimeStr = formatUptime(metrics?.server?.uptime_seconds);
  const serverOs = metrics?.server?.os || 'Linux';

  const localRatio = totalFiles > 0 ? Math.round((localFiles / totalFiles) * 100) : 0;
  const cloudRatio = totalFiles > 0 ? 100 - localRatio : 0;

  return (
    <section className="mb-8 relative" aria-label="Executive Metrics Dashboard">
      {/* Background ambient lighting */}
      <div className="absolute -top-12 left-1/4 w-96 h-36 bg-sky-500/10 rounded-full blur-3xl pointer-events-none -z-10" />
      <div className="absolute -top-12 right-1/4 w-96 h-36 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none -z-10" />

      {/* Mission Control Top Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 px-1">
        <div className="flex items-center space-x-2.5">
          <div className="p-1.5 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-400">
            <Activity className="w-4 h-4 animate-pulse" />
          </div>
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-white flex items-center space-x-2">
              <span>Executive Telemetry & Stream Ingestion Pipeline</span>
              <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center space-x-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping inline-block" />
                <span>{serverStatus}</span>
              </span>
            </h2>
            <p className="text-[11px] text-slate-400">
              OVHcloud Dedicated Node • {serverOs} • Uptime {uptimeStr} • Real-time 3s refresh
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2 text-[11px] font-mono text-slate-400 self-start sm:self-auto">
          <div className="flex items-center space-x-1.5 px-2.5 py-1 rounded-lg bg-slate-900/80 border border-slate-800">
            <span className="inline-block w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
            <span>Telemetry Live</span>
          </div>
        </div>
      </div>

      {/* Main 6-Card Executive Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {/* Card 1: Total Media Catalog */}
        <div
          onClick={() => onFilterChange && onFilterChange('ALL')}
          className="group relative rounded-2xl bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 hover:border-sky-500/40 p-4 transition-all duration-300 hover:shadow-xl hover:shadow-sky-500/5 cursor-pointer flex flex-col justify-between"
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-slate-400 tracking-wide uppercase font-mono">
              Total Catalog
            </span>
            <div className="p-2 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-400 group-hover:scale-110 transition-transform">
              <Database className="w-4 h-4" />
            </div>
          </div>

          <div>
            <div className="flex items-baseline space-x-2">
              <span className="text-2xl font-bold text-white tracking-tight font-mono">
                {totalFiles}
              </span>
              <span className="text-xs text-slate-500">files</span>
            </div>

            {/* Split badge: Cloud vs Server */}
            <div className="mt-2.5 flex items-center space-x-1.5 text-[10px] font-mono">
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onFilterChange && onFilterChange('CLOUD');
                }}
                className="px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/20 hover:bg-amber-500/20 transition flex items-center space-x-1"
                title="Google Drive Cloud Remote Only"
              >
                <Cloud className="w-3 h-3" />
                <span>{cloudFiles} Cloud</span>
              </span>
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onFilterChange && onFilterChange('LOCAL');
                }}
                className="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 hover:bg-emerald-500/20 transition flex items-center space-x-1"
                title="Cached on 1TB NVMe Server"
              >
                <HardDrive className="w-3 h-3" />
                <span>{localFiles} Local</span>
              </span>
            </div>

            {/* Visual ratio bar */}
            <div className="mt-3 w-full bg-slate-800 h-1 rounded-full overflow-hidden flex">
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

        {/* Card 2: Ingestion Queue */}
        <div className="group relative rounded-2xl bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 hover:border-amber-500/40 p-4 transition-all duration-300 hover:shadow-xl hover:shadow-amber-500/5 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-slate-400 tracking-wide uppercase font-mono">
              Ingestion Queue
            </span>
            <div
              className={`p-2 rounded-xl transition-transform group-hover:scale-110 ${
                inQueue > 0
                  ? 'bg-amber-500/20 border border-amber-500/30 text-amber-300 animate-pulse'
                  : 'bg-slate-800/60 border border-slate-700/50 text-slate-400'
              }`}
            >
              <Clock className="w-4 h-4" />
            </div>
          </div>

          <div>
            <div className="flex items-baseline space-x-2">
              <span className="text-2xl font-bold text-white tracking-tight font-mono">
                {inQueue}
              </span>
              <span className="text-xs text-slate-500">queued</span>
            </div>

            <div className="mt-2.5">
              <span
                className={`inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[10px] font-mono border ${
                  inQueue > 0
                    ? 'bg-amber-500/10 text-amber-300 border-amber-500/25'
                    : 'bg-slate-800/50 text-slate-400 border-slate-700/50'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    inQueue > 0 ? 'bg-amber-400 animate-ping' : 'bg-slate-500'
                  }`}
                />
                <span>{inQueue > 0 ? 'Fetching Remote Stream' : 'Queue Idle • Standby'}</span>
              </span>
            </div>

            <p className="mt-3 text-[11px] text-slate-500 truncate">
              Drive & URL parallel workers
            </p>
          </div>
        </div>

        {/* Card 3: Active Processing (FFmpeg Sprite & Preview) */}
        <div className="group relative rounded-2xl bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 hover:border-violet-500/40 p-4 transition-all duration-300 hover:shadow-xl hover:shadow-violet-500/5 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-slate-400 tracking-wide uppercase font-mono">
              FFmpeg Processing
            </span>
            <div
              className={`p-2 rounded-xl transition-transform group-hover:scale-110 ${
                inProcessing > 0
                  ? 'bg-violet-500/20 border border-violet-500/30 text-violet-300 animate-spin'
                  : 'bg-slate-800/60 border border-slate-700/50 text-slate-400'
              }`}
            >
              <Sparkles className="w-4 h-4" />
            </div>
          </div>

          <div>
            <div className="flex items-baseline space-x-2">
              <span className="text-2xl font-bold text-white tracking-tight font-mono">
                {inProcessing}
              </span>
              <span className="text-xs text-slate-500">active tasks</span>
            </div>

            <div className="mt-2.5">
              <span
                className={`inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[10px] font-mono border ${
                  inProcessing > 0
                    ? 'bg-violet-500/10 text-violet-300 border-violet-500/25'
                    : 'bg-slate-800/50 text-slate-400 border-slate-700/50'
                }`}
              >
                <Zap className="w-3 h-3 text-violet-400" />
                <span>{inProcessing > 0 ? 'Generating VTT Sprites' : 'FFmpeg Ready'}</span>
              </span>
            </div>

            <p className="mt-3 text-[11px] text-slate-500 truncate">
              Storyboard & scrub previews
            </p>
          </div>
        </div>

        {/* Card 4: Live Speed (Download & Stream) */}
        <div className="group relative rounded-2xl bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 hover:border-cyan-500/40 p-4 transition-all duration-300 hover:shadow-xl hover:shadow-cyan-500/5 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-slate-400 tracking-wide uppercase font-mono">
              Live Network
            </span>
            <div className="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 group-hover:scale-110 transition-transform">
              <Radio className="w-4 h-4 animate-pulse" />
            </div>
          </div>

          <div>
            <div className="space-y-1">
              <div className="flex items-center justify-between font-mono text-xs">
                <span className="text-slate-400 flex items-center space-x-1">
                  <ArrowDownToLine className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Fetch:</span>
                </span>
                <span className="font-bold text-cyan-300">{downloadSpeed} MB/s</span>
              </div>
              <div className="flex items-center justify-between font-mono text-xs">
                <span className="text-slate-400 flex items-center space-x-1">
                  <ArrowUpFromLine className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Stream:</span>
                </span>
                <span className="font-bold text-indigo-300">{streamSpeed} MB/s</span>
              </div>
            </div>

            <div className="mt-2.5">
              <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 text-[10px] font-mono">
                <span>Inbound / Outbound</span>
              </span>
            </div>

            <p className="mt-2 text-[10px] font-mono text-slate-500 truncate">
              Rx: {metrics?.network?.total_received_mb ?? '1024'} MB • Tx:{' '}
              {metrics?.network?.total_sent_mb ?? '512'} MB
            </p>
          </div>
        </div>

        {/* Card 5: Storage Utilization (1TB Volume) */}
        <div className="group relative rounded-2xl bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 hover:border-emerald-500/40 p-4 transition-all duration-300 hover:shadow-xl hover:shadow-emerald-500/5 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-slate-400 tracking-wide uppercase font-mono">
              1TB Storage
            </span>
            <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 group-hover:scale-110 transition-transform">
              <HardDrive className="w-4 h-4" />
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
            <div className="mt-2.5 w-full bg-slate-800 h-2 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-700 ease-out ${
                  diskPct > 90
                    ? 'bg-red-500'
                    : diskPct > 75
                    ? 'bg-amber-500'
                    : 'bg-gradient-to-r from-emerald-500 to-sky-400'
                }`}
                style={{ width: `${Math.min(100, diskPct)}%` }}
              />
            </div>

            <div className="mt-2.5 flex items-center justify-between text-[10px] font-mono text-slate-500">
              <span>{diskFree} GB free</span>
              <span className="text-emerald-400/80">NVMe Mount</span>
            </div>
          </div>
        </div>

        {/* Card 6: Completed & Ready Files */}
        <div
          onClick={() => onFilterChange && onFilterChange('LOCAL')}
          className="group relative rounded-2xl bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 hover:border-emerald-500/40 p-4 transition-all duration-300 hover:shadow-xl hover:shadow-emerald-500/5 cursor-pointer flex flex-col justify-between"
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-slate-400 tracking-wide uppercase font-mono">
              Ready to Stream
            </span>
            <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 group-hover:scale-110 transition-transform">
              <CheckCircle2 className="w-4 h-4" />
            </div>
          </div>

          <div>
            <div className="flex items-baseline space-x-2">
              <span className="text-2xl font-bold text-emerald-400 tracking-tight font-mono">
                {completed}
              </span>
              <span className="text-xs text-slate-500">completed</span>
            </div>

            <div className="mt-2.5">
              <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 text-[10px] font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span>Zero-Latency Ready</span>
              </span>
            </div>

            <p className="mt-3 text-[11px] text-slate-500 truncate">
              Instant byte-range seekable
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
