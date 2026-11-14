import React, { useEffect, useRef, useState } from 'react';
import Plyr from 'plyr';
import { X, DownloadCloud, Activity, CheckCircle, Film } from 'lucide-react';

export default function VideoPlayerModal({ video, token, activeTransfer, onClose, onTriggerDownload }) {
  const playerContainerRef = useRef(null);
  const plyrInstanceRef = useRef(null);
  const [downloadStarted, setDownloadStarted] = useState(false);
  const currentVideoIdRef = useRef(null);

  const isLocal = video.status === 'LOCAL_READY';
  const isDownloading = video.status === 'DOWNLOADING' || (activeTransfer && activeTransfer.status === 'DOWNLOADING');

  // Keyboard Escape listener (UI-09)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Auto-trigger on-demand download if clicked while remote
  useEffect(() => {
    if (video.status === 'REMOTE_ONLY' && !downloadStarted) {
      setDownloadStarted(true);
      if (onTriggerDownload) {
        onTriggerDownload(video.video_id);
      }
    }
  }, [video, downloadStarted, onTriggerDownload]);

  // Stable Plyr initialization (only recreate if video_id changes)
  useEffect(() => {
    if (isLocal && playerContainerRef.current) {
      if (currentVideoIdRef.current !== video.video_id) {
        currentVideoIdRef.current = video.video_id;

        if (plyrInstanceRef.current) {
          plyrInstanceRef.current.destroy();
          plyrInstanceRef.current = null;
        }

        // Pass authenticated JWT token in stream query parameter
        const streamUrl = token 
          ? `/api/stream/${video.video_id}?token=${encodeURIComponent(token)}`
          : `/api/stream/${video.video_id}`;
        const vttUrl = video.vtt_url || `/metadata/${video.video_id}/thumbnails.vtt`;

        const options = {
          autoplay: true,
          controls: [
            'play-large', 'play', 'progress', 'current-time', 'duration',
            'mute', 'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen'
          ],
          previewThumbnails: {
            enabled: Boolean(video.vtt_url),
            src: vttUrl
          },
          keyboard: { focused: true, global: true },
          tooltips: { controls: true, seek: true }
        };

        const plyr = new Plyr(playerContainerRef.current, options);
        plyr.source = {
          type: 'video',
          title: video.title,
          sources: [
            {
              src: streamUrl,
              type: 'video/mp4'
            }
          ]
        };

        plyrInstanceRef.current = plyr;
      }
    }

    return () => {
      if (plyrInstanceRef.current) {
        plyrInstanceRef.current.destroy();
        plyrInstanceRef.current = null;
        currentVideoIdRef.current = null;
      }
    };
  }, [isLocal, video.video_id, token, video.title, video.vtt_url]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-fade-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-5xl bg-[#0d1117] border border-[#30363d] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-[#161b22] border-b border-[#30363d]">
          <div className="flex items-center space-x-3 truncate mr-4">
            <div className="p-2 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20">
              <Film className="w-5 h-5" />
            </div>
            <h3 className="text-base font-semibold text-white truncate" title={video.title}>
              {video.title}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-2 rounded-xl hover:bg-[#21262d] transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Player Viewport */}
        <div className="relative aspect-video w-full bg-black flex items-center justify-center overflow-hidden">
          {isLocal ? (
            <video
              ref={playerContainerRef}
              playsInline
              crossOrigin="anonymous"
              className="w-full h-full object-contain"
            />
          ) : (
            <div className="flex flex-col items-center justify-center p-8 max-w-md w-full text-center space-y-6">
              <div className="relative">
                <div className="w-20 h-20 rounded-2xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400">
                  <DownloadCloud className="w-10 h-10 animate-bounce" />
                </div>
                <div className="absolute -top-1 -right-1 flex h-4 w-4">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-4 w-4 bg-sky-500"></span>
                </div>
              </div>

              <div className="space-y-1">
                <h4 className="text-lg font-bold text-white">Fetching On-Demand From Cloud</h4>
                <p className="text-xs text-slate-400">
                  Streaming directly to 1TB Block Storage. Player will auto-start immediately.
                </p>
              </div>

              {activeTransfer ? (
                <div className="w-full space-y-3 bg-[#010409] border border-[#30363d] p-4 rounded-xl font-mono text-xs">
                  <div className="w-full bg-[#21262d] h-2 rounded-full overflow-hidden">
                    <div
                      className="bg-gradient-to-r from-sky-500 to-indigo-500 h-full transition-all duration-300 rounded-full"
                      style={{ width: `${activeTransfer.percentage || 0}%` }}
                    />
                  </div>

                  <div className="flex justify-between items-center text-slate-300 text-xs">
                    <span className="font-bold text-sky-400 text-sm">
                      {activeTransfer.percentage}%
                    </span>
                    <span>{activeTransfer.speed_mbs} MB/s</span>
                    <span>{activeTransfer.downloaded_str} / {activeTransfer.total_str}</span>
                  </div>

                  <div className="flex justify-between items-center text-[11px] text-slate-500 pt-1 border-t border-[#30363d]/80">
                    <span>Source: {activeTransfer.source}</span>
                    <span>ETA: {activeTransfer.eta_seconds}s</span>
                  </div>
                </div>
              ) : (
                <div className="flex items-center space-x-2 text-xs text-slate-400 bg-[#010409] px-4 py-2 rounded-lg border border-[#30363d]">
                  <Activity className="w-4 h-4 text-sky-400 animate-spin" />
                  <span>Requesting download stream...</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer Info */}
        <div className="px-6 py-3 bg-[#161b22] flex items-center justify-between text-xs text-slate-400 border-t border-[#30363d]">
          <div className="flex items-center space-x-3">
            <span>Storage: <strong className="text-slate-300 font-mono">/mnt/storage/videos/{video.video_id}.mp4</strong></span>
            {video.vtt_url && (
              <span className="flex items-center space-x-1 text-emerald-400">
                <CheckCircle className="w-3.5 h-3.5" />
                <span>Seekbar Thumbnails Active</span>
              </span>
            )}
          </div>
          <div>
            Status: <strong className="text-white uppercase font-mono">{video.status}</strong>
          </div>
        </div>
      </div>
    </div>
  );
}
