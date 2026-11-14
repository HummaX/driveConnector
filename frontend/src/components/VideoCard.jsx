import React, { useState, useRef } from 'react';
import { Play, Cloud, HardDrive, Download, Trash2, Clock, CheckCircle2, Film, Loader2 } from 'lucide-react';

export default function VideoCard({ video, onPlay, onDelete, onDownload }) {
  const [isHovered, setIsHovered] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const videoRef = useRef(null);

  const isLocal = video.status === 'LOCAL_READY';
  const isCloud = video.status === 'REMOTE_ONLY';
  const isDownloading = video.status === 'DOWNLOADING';
  const isProcessing = video.status === 'PROCESSING';

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
        <div className="absolute top-2 left-2 z-10">
          {isLocal && (
            <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-[#238636]/30 text-[#3fb950] border border-[#238636]/50 backdrop-blur-md shadow-sm">
              <CheckCircle2 className="w-3 h-3" />
              <span>Saved on Server</span>
            </span>
          )}
          {isCloud && (
            <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-amber-500/20 text-amber-300 border border-amber-500/30 backdrop-blur-md shadow-sm">
              <Cloud className="w-3 h-3" />
              <span>Cloud Remote</span>
            </span>
          )}
          {isDownloading && (
            <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-sky-500/20 text-sky-300 border border-sky-500/30 backdrop-blur-md shadow-sm animate-pulse">
              <Download className="w-3 h-3 animate-bounce" />
              <span>Downloading...</span>
            </span>
          )}
          {isProcessing && (
            <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-purple-500/20 text-purple-300 border border-purple-500/30 backdrop-blur-md shadow-sm animate-pulse">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Generating Sprites</span>
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
          </div>
        </div>

        {/* Action Toolbar */}
        <div className="flex items-center justify-between pt-2 border-t border-[#30363d]/60 text-xs">
          <div>
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
