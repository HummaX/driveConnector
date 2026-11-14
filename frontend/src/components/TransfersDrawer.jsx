import React, { useState } from 'react';
import { ArrowDownCircle, ChevronDown, ChevronUp, Activity, CheckCircle, AlertTriangle, Radio } from 'lucide-react';

export default function TransfersDrawer({ transfers = {} }) {
  const [isOpen, setIsOpen] = useState(true);

  const transferList = Object.values(transfers || {});
  if (transferList.length === 0) return null;

  const activeCount = transferList.filter(t => t.status === 'DOWNLOADING').length;

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
            <span>Active Transfers</span>
            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
              {transferList.length}
            </span>
          </span>
        </div>
        <div className="text-slate-400 hover:text-white transition">
          {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </div>
      </div>

      {/* Content */}
      {isOpen && (
        <div className="p-3 max-h-72 overflow-y-auto space-y-2.5 text-xs">
          {transferList.map((transfer) => {
            const isCompleted = transfer.status === 'DOWNLOAD_COMPLETE';
            const isFailed = transfer.status === 'FAILED';

            return (
              <div
                key={transfer.video_id}
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
