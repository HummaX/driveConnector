import React, { useState, useRef } from 'react';
import { Play, Cloud, HardDrive, Download, Trash2, Clock, CheckCircle2, Film } from 'lucide-react';

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
    if (!bytes || bytes <= 0) return '';
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
    if (confirm(`Are you sure you want to delete "${video.title}"?`)) {
      setIsDeleting(true);
      await onDelete(video.video_id);
      setIsDeleting(false);
    }
  };

  return (
    <div
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={() => onPlay(video)}
      className="group relative flex flex-col bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden shadow-lg hover:shadow-2xl hover:border-slate-700 transition-all duration-300 cursor-pointer"
    >
      {/* Media / Thumbnail / Preview Container */}
      <div className="relative aspect-video w-full bg-slate-950 overflow-hidden">
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
          <div className="w-full h-full flex flex-col items-center justify-center bg-slate-950 text-slate-700">
            <Film className="w-12 h-12 stroke-[1.2]" />
            <span className="text-[11px] mt-1 text-slate-600">No Preview</span>
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
        <div className="absolute top-2.5 left-2.5 z-10">
          {isLocal && (
            <span className="flex items-center space-x-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-emerald-500/90 text-white backdrop-blur-md shadow-md">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Saved on Server</span>
            </span>
          )}
          {isCloud && (
            <span className="flex items-center space-x-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-amber-500/90 text-white backdrop-blur-md shadow-md">
              <Cloud className="w-3.5 h-3.5" />
              <span>On Cloud (Click to Fetch)</span>
            </span>
          )}
          {isDownloading && (
            <span className="flex items-center space-x-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-sky-500/90 text-white backdrop-blur-md shadow-md animate-pulse">
              <Download className="w-3.5 h-3.5 animate-bounce" />
              <span>Downloading...</span>
            </span>
          )}
          {isProcessing && (
            <span className="flex items-center space-x-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-purple-500/90 text-white backdrop-blur-md shadow-md animate-pulse">
              <span>Generating Sprites...</span>
            </span>
          )}
        </div>

        {/* Duration Pill */}
        {video.duration_seconds > 0 && (
          <div className="absolute bottom-2.5 right-2.5 z-10 px-2 py-0.5 rounded bg-black/80 backdrop-blur-sm text-[11px] font-mono text-white flex items-center space-x-1">
            <Clock className="w-3 h-3 text-slate-400" />
            <span>{formatDuration(video.duration_seconds)}</span>
          </div>
        )}

        {/* Hover Play Button Overlay */}
        <div className={`absolute inset-0 flex items-center justify-center bg-black/30 backdrop-blur-[1px] transition-opacity duration-300 ${
          isHovered ? 'opacity-100' : 'opacity-0'
        }`}>
          <div className="p-3.5 rounded-full bg-sky-500/90 text-white shadow-xl shadow-sky-500/30 transform transition-transform group-hover:scale-110">
            <Play className="w-6 h-6 fill-white translate-x-0.5" />
          </div>
        </div>
      </div>

      {/* Card Info */}
      <div className="p-3.5 flex flex-col flex-1 justify-between">
        <div>
          <h4 className="text-sm font-semibold text-white line-clamp-2 leading-snug mb-1" title={video.title}>
            {video.title}
          </h4>
          <div className="flex items-center space-x-2 text-[11px] text-slate-400">
            <span className="capitalize">{video.source === 'GDRIVE' ? 'Google Drive' : 'Direct Link'}</span>
            <span>•</span>
            <span>{formatBytes(video.file_size_bytes)}</span>
          </div>
        </div>

        {/* Action Toolbar */}
        <div className="flex items-center justify-between pt-3 mt-2 border-t border-slate-800/80 text-xs">
          <div className="flex items-center space-x-2">
            {isCloud ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDownload(video.video_id);
                }}
                className="flex items-center space-x-1 text-sky-400 hover:text-sky-300 font-medium py-1 px-2 rounded hover:bg-sky-500/10 transition"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Fetch Local</span>
              </button>
            ) : (
              <span className="text-[11px] text-slate-500">Stored at /mnt/storage</span>
            )}
          </div>

          <button
            onClick={handleDelete}
            disabled={isDeleting}
            title="Delete Video"
            className="text-slate-500 hover:text-red-400 p-1.5 rounded-lg hover:bg-red-500/10 transition"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
