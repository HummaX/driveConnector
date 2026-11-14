import React, { useState } from 'react';
import { ChevronDown, ChevronUp, CheckCircle, AlertTriangle, Download, Activity, Clock } from 'lucide-react';

export default function TransfersDrawer({ transfers = {}, processingJobs = {} }) {
  const [isOpen, setIsOpen] = useState(true);

  const transferList = Object.values(transfers || {});
  const processingList = Object.values(processingJobs || {});
  const totalTasks = transferList.length + processingList.length;

  if (totalTasks === 0) return null;

  const activeDownloads = transferList.filter(t => t.status === 'DOWNLOADING');
  const activeProcessing = processingList.filter(p => p.percent < 100);
  const activeCount = activeDownloads.length + activeProcessing.length;

  // Compute average progress
  const allActivePcts = [
    ...activeDownloads.map(t => t.percentage || 0),
    ...activeProcessing.map(p => p.percent || 0)
  ];
  const avgPct = allActivePcts.length > 0
    ? Math.round(allActivePcts.reduce((a, b) => a + b, 0) / allActivePcts.length)
    : 100;

  return (
    <div className="fixed bottom-4 right-4 z-40 w-96 max-w-[calc(100vw-2rem)] bg-[#0d1117]/95 border border-[#30363d] rounded-xl shadow-2xl backdrop-blur-xl overflow-hidden transition-all animate-slide-up">
      {/* Header */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between px-4 py-2.5 bg-[#161b22]/90 cursor-pointer border-b border-[#30363d]/80 select-none hover:bg-[#161b22] transition"
      >
        <div className="flex items-center space-x-2.5">
          <span className="relative flex h-2 w-2">
            {activeCount > 0 ? (
              <>
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-sky-500"></span>
              </>
            ) : (
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            )}
          </span>
          <span className="text-xs font-semibold text-white tracking-tight flex items-center space-x-1.5">
            <span>Operations & Transfers</span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20 font-medium">
              {totalTasks}
            </span>
          </span>
        </div>
        <div className="flex items-center space-x-2 text-slate-400 hover:text-white transition">
          {!isOpen && activeCount > 0 && (
            <span className="text-[10px] font-mono text-sky-400 font-semibold">{avgPct}%</span>
          )}
          {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </div>
      </div>

      {/* Minimized Progress Stripe */}
      {!isOpen && activeCount > 0 && (
        <div className="w-full bg-[#21262d] h-1 overflow-hidden">
          <div
            className="bg-sky-500 h-full transition-all duration-300"
            style={{ width: `${avgPct}%` }}
          />
        </div>
      )}

      {/* Content */}
      {isOpen && (
        <div className="p-3 max-h-72 overflow-y-auto space-y-2.5 text-xs">
          {/* Active Background Processing Jobs */}
          {processingList.map((proc) => (
            <div
              key={`proc-${proc.video_id}`}
              className="bg-[#010409] border border-purple-500/30 rounded-lg p-2.5 space-y-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="truncate flex-1">
                  <p className="font-medium text-white truncate text-xs flex items-center space-x-1.5">
                    <Activity className="w-3 h-3 text-purple-400 animate-spin shrink-0" />
                    <span className="truncate">{proc.stage_name || 'Processing'}</span>
                  </p>
                  <span className="text-[10px] font-mono text-purple-300/80 truncate block">
                    {proc.details || `Video ${proc.video_id.slice(0, 8)}`}
                  </span>
                </div>
                <span className="text-[11px] text-purple-400 font-mono font-bold">
                  {proc.percent}%
                </span>
              </div>

              {/* Progress bar */}
              <div className="w-full bg-[#21262d] h-1.5 rounded-full overflow-hidden">
                <div
                  className="bg-gradient-to-r from-purple-500 to-indigo-500 h-full transition-all duration-300 rounded-full"
                  style={{ width: `${proc.percent}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono">
                <span className="text-purple-300">Stage: {proc.stage}</span>
                {proc.eta_seconds > 0 && (
                  <span className="flex items-center space-x-1">
                    <Clock className="w-2.5 h-2.5 text-slate-500" />
                    <span>ETA {proc.eta_seconds}s</span>
                  </span>
                )}
              </div>
            </div>
          ))}

          {/* Active Downloads */}
          {transferList.map((transfer) => {
            const isCompleted = transfer.status === 'DOWNLOAD_COMPLETE';
            const isFailed = transfer.status === 'FAILED';

            return (
              <div
                key={`dl-${transfer.video_id}`}
                className="bg-[#010409] border border-[#30363d]/60 rounded-lg p-2.5 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="truncate flex-1">
                    <p className="font-medium text-white truncate text-xs" title={transfer.title}>
                      {transfer.title}
                    </p>
                    <span className="text-[10px] font-mono text-slate-500">
                      {transfer.source === 'GDRIVE' ? 'Google Drive' : 'Direct Link'}
                    </span>
                  </div>
                  <div>
                    {isCompleted ? (
                      <span className="flex items-center space-x-1 text-[10px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                        <CheckCircle className="w-3 h-3" />
                        <span>Ready</span>
                      </span>
                    ) : isFailed ? (
                      <span className="flex items-center space-x-1 text-[10px] font-mono text-red-400 bg-red-500/10 px-2 py-0.5 rounded border border-red-500/20">
                        <AlertTriangle className="w-3 h-3" />
                        <span>Failed</span>
                      </span>
                    ) : (
                      <span className="text-[11px] text-sky-400 font-mono font-bold">
                        {transfer.percentage}%
                      </span>
                    )}
                  </div>
                </div>

                {/* Progress bar */}
                {!isCompleted && !isFailed && (
                  <>
                    <div className="w-full bg-[#21262d] h-1.5 rounded-full overflow-hidden">
                      <div
                        className="bg-sky-500 h-full transition-all duration-300 rounded-full"
                        style={{ width: `${transfer.percentage}%` }}
                      />
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono">
                      <span className="text-sky-300 font-medium">{transfer.speed_mbs} MB/s</span>
                      <span>{transfer.downloaded_str} / {transfer.total_str}</span>
                      <span>ETA {transfer.eta_seconds}s</span>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
