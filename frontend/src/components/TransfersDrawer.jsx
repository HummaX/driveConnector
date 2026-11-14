import React, { useState } from 'react';
import { ArrowDownCircle, ChevronDown, ChevronUp, Activity, CheckCircle, AlertTriangle } from 'lucide-react';

export default function TransfersDrawer({ transfers }) {
  const [isOpen, setIsOpen] = useState(true);

  const transferList = Object.values(transfers);
  if (transferList.length === 0) return null;

  const activeCount = transferList.filter(t => t.status === 'DOWNLOADING').length;

  return (
    <div className="fixed bottom-4 right-4 z-40 w-96 max-w-[calc(100vw-2rem)] bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden transition-all animate-slide-up">
      {/* Header */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between px-4 py-3 bg-slate-950/80 cursor-pointer border-b border-slate-800/60 select-none hover:bg-slate-950"
      >
        <div className="flex items-center space-x-2.5">
          <span className="relative flex h-2.5 w-2.5">
            {activeCount > 0 ? (
              <>
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-sky-500"></span>
              </>
            ) : (
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
            )}
          </span>
          <span className="text-xs font-semibold text-white">
            Live Transfers ({transferList.length})
          </span>
        </div>
        <div className="text-slate-400 hover:text-white">
          {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
        </div>
      </div>

      {/* Content */}
      {isOpen && (
        <div className="p-3 max-h-72 overflow-y-auto space-y-3">
          {transferList.map((transfer) => {
            const isCompleted = transfer.status === 'DOWNLOAD_COMPLETE';
            const isFailed = transfer.status === 'FAILED';

            return (
              <div
                key={transfer.video_id}
                className="bg-slate-950/60 border border-slate-800/80 rounded-lg p-2.5 space-y-2 text-xs"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="truncate flex-1">
                    <p className="font-medium text-white truncate text-xs" title={transfer.title}>
                      {transfer.title}
                    </p>
                    <span className="text-[10px] text-slate-400">
                      {transfer.source}
                    </span>
                  </div>
                  <div>
                    {isCompleted ? (
                      <span className="flex items-center space-x-1 text-[11px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full font-medium">
                        <CheckCircle className="w-3 h-3" />
                        <span>Ready</span>
                      </span>
                    ) : isFailed ? (
                      <span className="flex items-center space-x-1 text-[11px] text-red-400 bg-red-500/10 px-2 py-0.5 rounded-full font-medium">
                        <AlertTriangle className="w-3 h-3" />
                        <span>Failed</span>
                      </span>
                    ) : (
                      <span className="text-[11px] text-sky-400 font-mono font-semibold">
                        {transfer.percentage}%
                      </span>
                    )}
                  </div>
                </div>

                {/* Progress bar */}
                {!isCompleted && !isFailed && (
                  <>
                    <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                      <div
                        className="bg-sky-500 h-full transition-all duration-300 rounded-full"
                        style={{ width: `${transfer.percentage}%` }}
                      />
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono">
                      <span>{transfer.speed_mbs} MB/s</span>
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
