import React, { useState } from 'react';
import { ChevronDown, ChevronUp, CheckCircle, AlertTriangle, Download, Activity, Clock } from 'lucide-react';

export default function TransfersDrawer({
  transfers = {},
  processingJobs = {},
  onClearCompleted = null,
  onDismiss = null
}) {
  const [isOpen, setIsOpen] = useState(true);

  const transferList = Object.values(transfers || {});
  const processingList = Object.values(processingJobs || {});
  const totalTasks = transferList.length + processingList.length;

  if (totalTasks === 0) return null;

  const isTransferDone = (t) =>
    t.status !== 'FAILED' &&
    ((t.percentage || 0) >= 100 ||
      t.status === 'DOWNLOAD_COMPLETE' ||
      t.status === 'LOCAL_READY' ||
      t.status === 'DONE');

  const activeDownloads = transferList.filter(
    (t) =>
      !isTransferDone(t) &&
      t.status !== 'FAILED' &&
      (t.percentage || 0) < 100 &&
      (t.status === 'DOWNLOADING' || t.status === 'QUEUED' || t.status === 'WAITING')
  );
  const activeProcessing = processingList.filter(
    (p) => (p.percent || 0) < 100 && p.status !== 'COMPLETED' && p.status !== 'FAILED'
  );
  const activeCount = activeDownloads.length + activeProcessing.length;
  const completedCount = transferList.filter(isTransferDone).length;

  // Compute average progress
  const allActivePcts = [
    ...activeDownloads.map((t) => t.percentage || 0),
    ...activeProcessing.map((p) => p.percent || 0)
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
            <span
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border font-medium ${
                activeCount > 0
                  ? 'bg-sky-500/10 text-sky-400 border-sky-500/20'
                  : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
              }`}
            >
              {activeCount > 0 ? `${activeCount} active` : 'Done'}
            </span>
          </span>
        </div>
        <div className="flex items-center space-x-2 text-slate-400 hover:text-white transition">
          {onClearCompleted && completedCount > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClearCompleted();
              }}
              className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#21262d] text-slate-400 hover:text-white border border-[#30363d] transition cursor-pointer"
            >
              Clear
            </button>
          )}
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
                <span className="text-purple-300 truncate max-w-[200px]">{proc.details || `Stage: ${proc.stage}`}</span>
                {proc.eta_seconds > 0 && (
                  <span className="flex items-center space-x-1 text-purple-300 font-semibold shrink-0">
                    <Clock className="w-2.5 h-2.5 text-purple-400" />
                    <span>{proc.eta_seconds}s left</span>
                  </span>
                )}
              </div>
            </div>
          ))}

          {/* Transfers (Active and Completed) */}
          {transferList.map((transfer) => {
            const isCompleted = isTransferDone(transfer);
            const isFailed = transfer.status === 'FAILED';

            return (
              <div
                key={`dl-${transfer.video_id}`}
                className={`bg-[#010409] border rounded-lg p-2.5 space-y-2 transition-all ${
                  isCompleted
                    ? 'border-emerald-500/30'
                    : isFailed
                    ? 'border-red-500/30'
                    : 'border-[#30363d]/60'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="truncate flex-1">
                    <p className="font-medium text-white truncate text-xs flex items-center space-x-1.5" title={transfer.title}>
                      {isCompleted ? (
                        <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      ) : (
                        <Download className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      )}
                      <span className="truncate">{transfer.title}</span>
                    </p>
                    <span className="text-[10px] font-mono text-slate-500">
                      {transfer.source === 'GDRIVE' ? 'Google Drive' : 'Direct Link'}
                    </span>
                  </div>
                  <div>
                    {isCompleted ? (
                      <span className="flex items-center space-x-1 text-[10px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 font-semibold">
                        <CheckCircle className="w-3 h-3 text-emerald-400" />
                        <span>Done</span>
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
                {isCompleted ? (
                  <>
                    <div className="w-full bg-[#21262d] h-1.5 rounded-full overflow-hidden">
                      <div
                        className="bg-emerald-500 h-full transition-all duration-300 rounded-full"
                        style={{ width: '100%' }}
                      />
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono">
                      <span className="text-emerald-400 font-medium flex items-center space-x-1">
                        <CheckCircle className="w-2.5 h-2.5 text-emerald-400" />
                        <span>Completed</span>
                      </span>
                      <span>{transfer.total_str || transfer.downloaded_str || '100%'}</span>
                      {onDismiss ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDismiss(transfer.video_id);
                          }}
                          className="text-slate-500 hover:text-slate-300 transition cursor-pointer"
                        >
                          Dismiss
                        </button>
                      ) : (
                        <span className="text-slate-500">Finished</span>
                      )}
                    </div>
                  </>
                ) : !isFailed ? (
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
                ) : (
                  <div className="text-[10px] text-red-400 font-mono truncate">
                    {transfer.error || 'Transfer failed'}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
