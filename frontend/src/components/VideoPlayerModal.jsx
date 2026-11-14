import React, { useEffect, useRef, useState, useCallback } from 'react';
import Plyr from 'plyr';
import {
  X, DownloadCloud, Activity, CheckCircle, Film, Volume2,
  Maximize2, Minimize2, Tv, Sparkles, Sliders, Play, Pause,
  RotateCcw, RotateCw, Subtitles, Layers, Clock
} from 'lucide-react';

export default function VideoPlayerModal({
  video,
  token,
  activeTransfer,
  processingJob,
  onClose,
  onTriggerDownload,
  onTranscode,
  onTranscribe
}) {
  const playerContainerRef = useRef(null);
  const plyrInstanceRef = useRef(null);
  const audioContextRef = useRef(null);
  const gainNodeRef = useRef(null);
  const currentVideoIdRef = useRef(null);

  const [downloadStarted, setDownloadStarted] = useState(false);
  const [audioGain, setAudioGain] = useState(100); // 100% to 200%
  const [isTheater, setIsTheater] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [selectedQuality, setSelectedQuality] = useState('original');
  const [resumeNotice, setResumeNotice] = useState(null);
  const [isTranscodingModalOpen, setIsTranscodingModalOpen] = useState(false);
  const [replaceOriginal, setReplaceOriginal] = useState(false);

  const isLocal = video.status === 'LOCAL_READY';
  const isDownloading = video.status === 'DOWNLOADING' || (activeTransfer && activeTransfer.status === 'DOWNLOADING');
  const activeProc = processingJob || video.processing_info;
  const isProcessing = video.status === 'PROCESSING' || Boolean(activeProc);

  // Format seconds to mm:ss
  const formatTime = (secs) => {
    if (!secs || isNaN(secs)) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  // 1. Keyboard Shortcuts (J, K, L, F, Space, Escape)
  useEffect(() => {
    const handleKeyDown = (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      const isInput = activeTag === 'INPUT' || activeTag === 'TEXTAREA' || document.activeElement?.isContentEditable;
      if (isInput) return;

      if (e.key === 'Escape') {
        onClose();
        return;
      }

      const plyr = plyrInstanceRef.current;
      if (!plyr) return;

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          plyr.togglePlay();
          break;
        case 'j':
          e.preventDefault();
          plyr.rewind(10);
          break;
        case 'l':
          e.preventDefault();
          plyr.forward(10);
          break;
        case 'f':
          e.preventDefault();
          plyr.fullscreen.toggle();
          break;
        case 'm':
          e.preventDefault();
          plyr.muted = !plyr.muted;
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // 2. Auto-trigger on-demand download if clicked while remote
  useEffect(() => {
    if (video.status === 'REMOTE_ONLY' && !downloadStarted) {
      setDownloadStarted(true);
      if (onTriggerDownload) {
        onTriggerDownload(video.video_id);
      }
    }
  }, [video, downloadStarted, onTriggerDownload]);

  // 3. Audio Booster Web Audio API GainNode Configuration
  const initAudioBooster = useCallback((mediaEl) => {
    if (!mediaEl) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      if (!audioContextRef.current) {
        const ctx = new AudioCtx();
        const source = ctx.createMediaElementSource(mediaEl);
        const gainNode = ctx.createGain();
        gainNode.gain.value = audioGain / 100;

        source.connect(gainNode);
        gainNode.connect(ctx.destination);

        audioContextRef.current = ctx;
        gainNodeRef.current = gainNode;
      }
    } catch (e) {
      // Element might already be hooked
    }
  }, [audioGain]);

  const handleGainChange = (newGain) => {
    setAudioGain(newGain);
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = newGain / 100;
    }
    if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume().catch(() => {});
    }
  };

  // 4. Stable Plyr lifecycle initialization
  useEffect(() => {
    if (isLocal && playerContainerRef.current) {
      const videoEl = playerContainerRef.current;
      const streamBase = `/api/stream/${video.video_id}`;
      const params = new URLSearchParams();
      if (token) params.set('token', token);
      if (selectedQuality && selectedQuality !== 'original') {
        params.set('quality', selectedQuality);
      }
      const qs = params.toString();
      const streamUrl = qs ? `${streamBase}?${qs}` : streamBase;

      const vttUrl = video.vtt_url || `/metadata/${video.video_id}/thumbnails.vtt`;

      // Save position across quality transitions
      let initialTime = 0;
      if (plyrInstanceRef.current) {
        try {
          initialTime = plyrInstanceRef.current.currentTime || 0;
        } catch {}
        plyrInstanceRef.current.destroy();
        plyrInstanceRef.current = null;
      } else {
        // Watch Position Memory from localStorage
        const savedPos = parseFloat(localStorage.getItem(`dc_playback_pos_${video.video_id}`) || '0');
        if (savedPos > 5) {
          initialTime = savedPos;
          setResumeNotice(`Resumed at ${formatTime(savedPos)}`);
          setTimeout(() => setResumeNotice(null), 4000);
        }
      }

      const options = {
        autoplay: true,
        controls: [
          'play-large', 'play', 'progress', 'current-time', 'duration',
          'mute', 'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen'
        ],
        speed: {
          selected: playbackSpeed,
          options: [0.5, 0.75, 1, 1.25, 1.5, 2]
        },
        previewThumbnails: {
          enabled: Boolean(video.vtt_url),
          src: vttUrl
        },
        keyboard: { focused: false, global: false }, // Handled custom keyboard listeners
        tooltips: { controls: true, seek: true }
      };

      const tracks = [];
      if (video.subtitles_url) {
        tracks.push({
          kind: 'captions',
          label: 'English AI',
          srclang: 'en',
          src: video.subtitles_url,
          default: true
        });
      }

      const plyr = new Plyr(videoEl, options);
      plyr.source = {
        type: 'video',
        title: video.title,
        sources: [
          {
            src: streamUrl,
            type: 'video/mp4'
          }
        ],
        tracks
      };

      plyr.on('ready', () => {
        if (initialTime > 0) {
          plyr.currentTime = initialTime;
        }
        plyr.speed = playbackSpeed;
        initAudioBooster(videoEl);
      });

      plyr.on('play', () => {
        if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
          audioContextRef.current.resume().catch(() => {});
        }
      });

      // Watch Position Memory Throttled Save
      let lastSave = 0;
      plyr.on('timeupdate', () => {
        const now = Date.now();
        if (now - lastSave > 2000) {
          lastSave = now;
          const curr = plyr.currentTime;
          const dur = plyr.duration;
          if (curr > 5 && dur && curr < dur - 10) {
            localStorage.setItem(`dc_playback_pos_${video.video_id}`, curr.toString());
          } else if (dur && curr >= dur - 10) {
            localStorage.removeItem(`dc_playback_pos_${video.video_id}`);
          }
        }
      });

      plyrInstanceRef.current = plyr;
      currentVideoIdRef.current = video.video_id;
    }

    return () => {
      if (plyrInstanceRef.current) {
        plyrInstanceRef.current.destroy();
        plyrInstanceRef.current = null;
      }
    };
  }, [isLocal, video.video_id, selectedQuality, video.vtt_url, video.subtitles_url, token, initAudioBooster]);

  // Handle Quality Change
  const handleQualitySelect = (q) => {
    setSelectedQuality(q);
  };

  // Handle Playback Speed
  const handleSpeedSelect = (s) => {
    setPlaybackSpeed(s);
    if (plyrInstanceRef.current) {
      plyrInstanceRef.current.speed = s;
    }
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/90 backdrop-blur-md animate-fade-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`relative w-full bg-[#0d1117] border border-[#30363d] rounded-2xl shadow-2xl overflow-hidden flex flex-col transition-all duration-300 ${
          isTheater
            ? 'w-[98vw] max-w-[98vw] h-[96vh] max-h-[96vh]'
            : 'max-w-5xl max-h-[92vh]'
        }`}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-3.5 bg-[#161b22] border-b border-[#30363d]">
          <div className="flex items-center space-x-3 truncate mr-4">
            <div className="p-1.5 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20">
              <Film className="w-4 h-4" />
            </div>
            <div className="truncate">
              <h3 className="text-sm font-semibold text-white truncate" title={video.title}>
                {video.title}
              </h3>
              {resumeNotice && (
                <span className="text-[10px] text-emerald-400 font-mono animate-fade-in">
                  ✓ {resumeNotice}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {/* Theater Mode Toggle */}
            <button
              onClick={() => setIsTheater(!isTheater)}
              title={isTheater ? "Exit Theater Mode" : "Theater Mode"}
              className={`p-2 rounded-lg transition ${
                isTheater
                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                  : 'text-slate-400 hover:text-white hover:bg-[#21262d]'
              }`}
            >
              <Tv className="w-4 h-4" />
            </button>

            {/* Close Button */}
            <button
              onClick={onClose}
              title="Close Player (Esc)"
              className="text-slate-400 hover:text-white p-2 rounded-lg hover:bg-[#21262d] transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Live Processing Telemetry Strip (Stage, %, ETA countdown) */}
        {isProcessing && activeProc && (
          <div className="bg-purple-950/40 border-b border-purple-500/30 px-5 py-2.5 flex items-center justify-between text-xs font-mono">
            <div className="flex items-center space-x-2 text-purple-300">
              <Activity className="w-4 h-4 text-purple-400 animate-spin" />
              <span className="font-semibold">{activeProc.stage_name || 'Processing'}:</span>
              <span>{activeProc.details || `${activeProc.percent}%`}</span>
            </div>
            <div className="flex items-center space-x-4">
              <div className="w-32 bg-[#21262d] h-2 rounded-full overflow-hidden">
                <div
                  className="bg-purple-500 h-full transition-all duration-300 rounded-full"
                  style={{ width: `${activeProc.percent || 0}%` }}
                />
              </div>
              <span className="text-purple-300 font-bold">{activeProc.percent}%</span>
              {activeProc.eta_seconds > 0 && (
                <span className="text-slate-400 text-[11px] flex items-center space-x-1">
                  <Clock className="w-3 h-3 text-slate-500" />
                  <span>{activeProc.eta_seconds}s left</span>
                </span>
              )}
            </div>
          </div>
        )}

        {/* Player Viewport */}
        <div className="relative flex-1 min-h-[300px] bg-black flex items-center justify-center overflow-hidden">
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
                  Streaming directly to 1TB NVMe Block Storage. Player will auto-start immediately.
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

        {/* Supercharged Controls & Features Toolbar */}
        {isLocal && (
          <div className="px-5 py-3 bg-[#161b22] border-t border-[#30363d] flex flex-wrap items-center justify-between gap-3 text-xs">
            {/* Left Controls: Audio Booster & Speeds */}
            <div className="flex items-center space-x-3 flex-wrap gap-y-2">
              {/* Web Audio Booster (Up to 200%) */}
              <div className="flex items-center space-x-2 bg-[#0d1117] px-3 py-1.5 rounded-lg border border-[#30363d]">
                <Volume2 className="w-4 h-4 text-sky-400" />
                <span className="text-[11px] font-mono text-slate-400">Audio Boost:</span>
                <div className="flex items-center space-x-1">
                  {[100, 125, 150, 175, 200].map((g) => (
                    <button
                      key={g}
                      onClick={() => handleGainChange(g)}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-medium transition ${
                        audioGain === g
                          ? 'bg-sky-500 text-white font-bold'
                          : 'text-slate-400 hover:text-white hover:bg-[#21262d]'
                      }`}
                    >
                      {g}%
                    </button>
                  ))}
                </div>
              </div>

              {/* Speed Buttons */}
              <div className="flex items-center space-x-1 bg-[#0d1117] px-2.5 py-1.5 rounded-lg border border-[#30363d]">
                <span className="text-[11px] font-mono text-slate-400 mr-1">Speed:</span>
                {[0.75, 1.0, 1.25, 1.5, 2.0].map((s) => (
                  <button
                    key={s}
                    onClick={() => handleSpeedSelect(s)}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition ${
                      playbackSpeed === s
                        ? 'bg-indigo-500 text-white font-bold'
                        : 'text-slate-400 hover:text-white hover:bg-[#21262d]'
                    }`}
                  >
                    {s}x
                  </button>
                ))}
              </div>
            </div>

            {/* Right Controls: Multi-Resolution & AI Subtitles */}
            <div className="flex items-center space-x-3 flex-wrap gap-y-2">
              {/* Multi-Resolution Selector */}
              <div className="flex items-center space-x-1.5 bg-[#0d1117] px-3 py-1.5 rounded-lg border border-[#30363d]">
                <Layers className="w-4 h-4 text-emerald-400" />
                <span className="text-[11px] font-mono text-slate-400">Quality:</span>
                <select
                  value={selectedQuality}
                  onChange={(e) => handleQualitySelect(e.target.value)}
                  className="bg-transparent text-white font-mono text-xs focus:outline-none cursor-pointer"
                >
                  <option value="original" className="bg-[#161b22] text-white">Original / Source</option>
                  <option value="720p" className="bg-[#161b22] text-white">
                    720p HD {video.renditions?.['720p'] ? '✓' : ''}
                  </option>
                  <option value="480p" className="bg-[#161b22] text-white">
                    480p SD {video.renditions?.['480p'] ? '✓' : ''}
                  </option>
                  <option value="360p" className="bg-[#161b22] text-white">
                    360p Low {video.renditions?.['360p'] ? '✓' : ''}
                  </option>
                </select>
                <button
                  type="button"
                  onClick={() => setIsTranscodingModalOpen(true)}
                  title="Transcode / Downgrade Video"
                  className="p-1 rounded bg-[#21262d] hover:bg-[#30363d] text-slate-300 hover:text-white transition"
                >
                  <Sliders className="w-3 h-3" />
                </button>
              </div>

              {/* AI Subtitles Button */}
              {video.subtitles_url ? (
                <div className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-mono">
                  <CheckCircle className="w-3.5 h-3.5" />
                  <span>AI Subtitles Active</span>
                </div>
              ) : (
                <button
                  onClick={() => onTranscribe && onTranscribe(video.video_id)}
                  title="Generate Local AI Subtitles via Whisper"
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-600/20 to-indigo-600/20 hover:from-purple-600/30 hover:to-indigo-600/30 text-purple-300 hover:text-white border border-purple-500/30 font-mono text-xs transition"
                >
                  <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                  <span>Generate AI Subtitles</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Modal Footer Info */}
        <div className="px-5 py-2.5 bg-[#0d1117] flex items-center justify-between text-[11px] text-slate-400 border-t border-[#30363d]/80 font-mono">
          <div className="flex items-center space-x-4">
            <span>Storage: <strong className="text-slate-300">/mnt/storage/videos/{video.video_id}.mp4</strong></span>
            {video.vtt_url && (
              <span className="flex items-center space-x-1 text-emerald-400">
                <CheckCircle className="w-3 h-3" />
                <span>Hover Scrub Previews Active</span>
              </span>
            )}
          </div>
          <div className="flex items-center space-x-3 text-slate-500">
            <span>Shortcuts: Space/K Play • J/L ±10s • F Fullscreen • Esc Close</span>
          </div>
        </div>

        {/* Transcoding Sub-Modal */}
        {isTranscodingModalOpen && (
          <div
            onClick={() => setIsTranscodingModalOpen(false)}
            className="absolute inset-0 z-20 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="bg-[#161b22] border border-[#30363d] rounded-xl p-5 max-w-sm w-full space-y-4 shadow-2xl"
            >
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-white flex items-center space-x-2">
                  <Sliders className="w-4 h-4 text-emerald-400" />
                  <span>Transcode & Downscale</span>
                </h4>
                <button
                  onClick={() => setIsTranscodingModalOpen(false)}
                  className="text-slate-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <p className="text-xs text-slate-400">
                Generate downscaled versions or replace original to drastically reduce NVMe disk usage.
              </p>

              <div className="space-y-2">
                {['720p', '480p', '360p'].map((q) => (
                  <button
                    key={q}
                    onClick={() => {
                      if (onTranscode) onTranscode(video.video_id, q, replaceOriginal);
                      setIsTranscodingModalOpen(false);
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[#0d1117] hover:bg-[#21262d] border border-[#30363d] text-xs text-white font-mono transition"
                  >
                    <span>Transcode to {q}</span>
                    <span className="text-[10px] text-slate-500">
                      {q === '720p' ? '~60% size' : q === '480p' ? '~35% size' : '~20% size'}
                    </span>
                  </button>
                ))}
              </div>

              <div className="pt-2 border-t border-[#30363d] flex items-center justify-between text-xs">
                <label className="flex items-center space-x-2 text-slate-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={replaceOriginal}
                    onChange={(e) => setReplaceOriginal(e.target.checked)}
                    className="rounded bg-[#0d1117] border-[#30363d] text-sky-500 focus:ring-0"
                  />
                  <span>Replace original to save disk</span>
                </label>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
