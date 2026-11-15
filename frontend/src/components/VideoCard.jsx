import React, { useState, useRef } from 'react';
import {
  Play, Cloud, Download, Trash2, Clock, CheckCircle2,
  Film, Loader2, Sparkles, Sliders, Subtitles
} from 'lucide-react';

export default function VideoCard({
  video,
  onPlay,
  onDelete,
  onDownload,
  onTranscode,
  onTranscribe,
  processingJob
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const videoRef = useRef(null);

  const activeProc = processingJob || video.processing_info;
  const isLocal = video.status === 'LOCAL_READY' || video.status === 'PROCESSING' || Boolean(video.local_path);
  const isCloud = video.status === 'REMOTE_ONLY' && !video.local_path;
  const isDownloading = video.status === 'DOWNLOADING';
  const isProcessing = video.status === 'PROCESSING' || Boolean(activeProc);

  const formatDuration = (seconds) => {
    if (!seconds || seconds <= 0) return null;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const formatBytes = (bytes) => {
    if (!bytes || bytes <= 0) return '0 MB';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const handleMouseEnter = () => {
    setIsHovered(true);
    if (videoRef.current && isLocal && video.preview_url) {
      videoRef.current.play().catch(() => {});
    }
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
    setShowMenu(false);
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  };

  const handleDelete = async (e) => {
    e.stopPropagation();
    if (window.confirm(`Remove "${video.title}" and cached assets from storage?`)) {
      setIsDeleting(true);
      try {
        await onDelete(video.video_id);
      } finally {
        setIsDeleting(false);
      }
    }
  };

  return (
    <div
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={() => onPlay(video)}
      className="group relative flex flex-col bg-[#0d1117]/80 hover:bg-[#161b22] border border-[#30363d]/80 hover:border-slate-600 rounded-xl overflow-hidden shadow-sm hover:shadow-xl transition-all duration-200 cursor-pointer"
    >
      {/* Media / Thumbnail / Preview Container */}
      <div className="relative aspect-video w-full bg-[#010409] overflow-hidden border-b border-[#30363d]/60">
        {/* Static Poster */}
        {video.poster_url ? (
          <img
            src={video.poster_url}
            alt={video.title}
            className={`w-full h-full object-cover transition-opacity duration-300 ${
              isHovered && isLocal && video.preview_url ? 'opacity-0' : 'opacity-100'
            }`}
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center bg-[#010409] text-slate-700">
            <Film className="w-10 h-10 stroke-[1.2] text-slate-700" />
            <span className="text-[10px] mt-1 font-mono text-slate-600">No Preview</span>
          </div>
        )}

        {/* Hover Animated Preview Loop (Local Ready Videos) */}
        {isLocal && video.preview_url && (
          <video
            ref={videoRef}
            src={video.preview_url}
            muted
            loop
            playsInline
            preload="none"
            className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 pointer-events-none ${
              isHovered ? 'opacity-100' : 'opacity-0'
            }`}
          />
        )}

        {/* Status Badge */}
        <div className="absolute top-2 left-2 z-10 max-w-[85%] truncate">
          {isProcessing && activeProc ? (
            <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-purple-500/30 text-purple-200 border border-purple-500/40 backdrop-blur-md shadow-sm animate-pulse truncate">
              <Loader2 className="w-3 h-3 animate-spin shrink-0" />
              <span className="truncate">
                {activeProc.stage_name || 'Generating Sprites'}: {activeProc.stage_percent || activeProc.percent}% {activeProc.eta_seconds > 0 ? `(${activeProc.eta_seconds}s left)` : ''}
              </span>
            </span>
          ) : isProcessing ? (
            <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-purple-500/20 text-purple-300 border border-purple-500/30 backdrop-blur-md shadow-sm animate-pulse">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Generating Sprites (in progress)</span>
            </span>
          ) : isLocal ? (
            <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-[#238636]/30 text-[#3fb950] border border-[#238636]/50 backdrop-blur-md shadow-sm">
              <CheckCircle2 className="w-3 h-3" />
              <span>Saved on Server</span>
            </span>
          ) : isCloud ? (
            <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-amber-500/20 text-amber-300 border border-amber-500/30 backdrop-blur-md shadow-sm">
              <Cloud className="w-3 h-3" />
              <span>Cloud Remote</span>
            </span>
          ) : isDownloading ? (
            <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-sky-500/20 text-sky-300 border border-sky-500/30 backdrop-blur-md shadow-sm animate-pulse">
              <Download className="w-3 h-3 animate-bounce" />
              <span>Downloading...</span>
            </span>
          ) : null}
        </div>

        {/* Feature Badges (Top Right: Subtitles, Renditions) */}
        <div className="absolute top-2 right-2 z-10 flex items-center space-x-1">
          {video.subtitles_url && (
            <span className="px-1.5 py-0.5 rounded bg-purple-500/30 text-purple-300 border border-purple-500/40 text-[9px] font-mono font-bold backdrop-blur-sm" title="AI Subtitles Available">
              CC
            </span>
          )}
          {video.renditions && Object.keys(video.renditions).length > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-sky-500/30 text-sky-300 border border-sky-500/40 text-[9px] font-mono font-bold backdrop-blur-sm" title="Multi-Resolution Renditions Available">
              {Object.keys(video.renditions).length}Q
            </span>
          )}
        </div>

        {/* Source Badge (Bottom Left) */}
        <div className="absolute bottom-2 left-2 z-10 px-1.5 py-0.5 rounded bg-black/75 backdrop-blur-sm text-[10px] font-mono text-slate-300 flex items-center space-x-1 border border-white/5">
          <span>{video.source === 'GDRIVE' ? 'Google Drive' : 'Direct Link'}</span>
        </div>

        {/* Duration Pill (Bottom Right) */}
        {video.duration_seconds > 0 && (
          <div className="absolute bottom-2 right-2 z-10 px-2 py-0.5 rounded bg-black/80 backdrop-blur-sm text-[10px] font-mono text-white flex items-center space-x-1 border border-white/10">
            <Clock className="w-2.5 h-2.5 text-slate-400" />
            <span>{formatDuration(video.duration_seconds)}</span>
          </div>
        )}

        {/* Hover Play Button Overlay */}
        <div className={`absolute inset-0 flex items-center justify-center bg-black/35 backdrop-blur-[2px] transition-opacity duration-200 ${
          isHovered ? 'opacity-100' : 'opacity-0'
        }`}>
          <div className="p-3.5 rounded-full bg-sky-500 text-white shadow-xl shadow-sky-500/30 transform transition-transform group-hover:scale-110">
            <Play className="w-5 h-5 fill-white translate-x-0.5" />
          </div>
        </div>

        {/* Processing Progress Bar on Card Media */}
        {isProcessing && (
          <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-[#21262d] z-20 overflow-hidden">
            <div
              className="bg-gradient-to-r from-purple-500 to-indigo-500 h-full transition-all duration-300 rounded-full"
              style={{ width: `${activeProc?.stage_percent || activeProc?.percent || 20}%` }}
            />
          </div>
        )}
      </div>

      {/* Card Info */}
      <div className="p-3 flex flex-col flex-1 justify-between gap-3">
        <div>
          <h4 className="text-xs font-semibold text-white line-clamp-2 leading-snug mb-1 group-hover:text-sky-300 transition-colors" title={video.title}>
            {video.title}
          </h4>
          <div className="flex items-center space-x-2 text-[10px] font-mono text-slate-400">
            <span>{formatBytes(video.file_size_bytes)}</span>
            <span>•</span>
            <span className="text-slate-500">{isLocal ? 'NVMe Cached' : 'On-Demand'}</span>
            {activeProc && (
              <>
                <span>•</span>
                <span className="text-purple-400 font-semibold">{activeProc.percent}%</span>
              </>
            )}
          </div>
        </div>

        {/* Action Toolbar */}
        <div className="flex items-center justify-between pt-2 border-t border-[#30363d]/60 text-xs">
          <div className="flex items-center space-x-1.5">
            {isCloud ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDownload(video.video_id);
                }}
                className="flex items-center space-x-1 text-sky-400 hover:text-white font-medium py-1 px-2 rounded-md bg-sky-500/10 hover:bg-sky-500/25 border border-sky-500/25 text-[11px] transition"
              >
                <Download className="w-3 h-3" />
                <span>Fetch to Server</span>
              </button>
            ) : (
              <span className="text-[10px] font-mono text-emerald-400/90 flex items-center space-x-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span>Instant Stream</span>
              </span>
            )}

            {/* Quick Actions (Transcode / Transcribe) */}
            {isLocal && (
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowMenu(!showMenu);
                  }}
                  title="Video Options (Quality & Subtitles)"
                  className="p-1 rounded text-slate-400 hover:text-white hover:bg-[#21262d] transition"
                >
                  <Sliders className="w-3.5 h-3.5" />
                </button>

                {showMenu && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="absolute bottom-full left-0 mb-2 w-48 bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl p-2 z-30 space-y-1 text-xs font-mono animate-fade-in"
                  >
                    {!video.subtitles_url && (
                      <button
                        type="button"
                        onClick={() => {
                          if (onTranscribe) onTranscribe(video.video_id);
                          setShowMenu(false);
                        }}
                        className="w-full text-left px-2 py-1.5 rounded hover:bg-[#21262d] text-purple-300 flex items-center space-x-2 transition"
                      >
                        <Sparkles className="w-3 h-3 text-purple-400" />
                        <span>AI Subtitles</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (onTranscode) onTranscode(video.video_id, '720p', false);
                        setShowMenu(false);
                      }}
                      className="w-full text-left px-2 py-1.5 rounded hover:bg-[#21262d] text-slate-300 hover:text-white flex items-center space-x-2 transition"
                    >
                      <span>Transcode to 720p</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (onTranscode) onTranscode(video.video_id, '480p', false);
                        setShowMenu(false);
                      }}
                      className="w-full text-left px-2 py-1.5 rounded hover:bg-[#21262d] text-slate-300 hover:text-white flex items-center space-x-2 transition"
                    >
                      <span>Transcode to 480p</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={handleDelete}
            disabled={isDeleting}
            title="Delete Video & Assets"
            className="text-slate-500 hover:text-red-400 p-1.5 rounded-md hover:bg-red-500/10 transition"
          >
            {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
