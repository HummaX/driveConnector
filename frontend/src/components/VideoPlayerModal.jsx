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
  const companionAudioRef = useRef(null);
  const plyrInstanceRef = useRef(null);
  const audioContextRef = useRef(null);
  const gainNodeRef = useRef(null);
  const currentVideoIdRef = useRef(null);

  const [downloadStarted, setDownloadStarted] = useState(false);
  const [audioGain, setAudioGain] = useState(100); // 100% to 200%
  const [isTheater, setIsTheater] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [selectedQuality, setSelectedQuality] = useState('original');
  const [audioTracks, setAudioTracks] = useState(video.audio_tracks || []);
  const [subtitleTracks, setSubtitleTracks] = useState(video.subtitle_tracks || []);
  const [selectedAudioTrack, setSelectedAudioTrack] = useState(0);
  const [selectedSubtitle, setSelectedSubtitle] = useState('off');
  const [resumeNotice, setResumeNotice] = useState(null);
  const [isTranscodingModalOpen, setIsTranscodingModalOpen] = useState(false);
  const [replaceOriginal, setReplaceOriginal] = useState(false);
  const [isBuffering, setIsBuffering] = useState(true);
  const [bufferedPercent, setBufferedPercent] = useState(0);
  const [isResetting, setIsResetting] = useState(false);

  const handleResetStatus = async () => {
    if (!video?.video_id || isResetting) return;
    setIsResetting(true);
    try {
      await fetch(`/api/videos/${video.video_id}/reset-status`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
    } catch (err) {
      console.error('Reset status error:', err);
    } finally {
      setIsResetting(false);
    }
  };

  const isLocal = video.status === 'LOCAL_READY' || video.status === 'PROCESSING' || Boolean(video.local_path);
  const isTransferDone = Boolean(activeTransfer && (
    (activeTransfer.percentage || 0) >= 100 ||
    activeTransfer.status === 'DOWNLOAD_COMPLETE' ||
    activeTransfer.status === 'LOCAL_READY' ||
    activeTransfer.status === 'DONE'
  ));
  const isReadyToPlay = isLocal || isTransferDone;
  const isDownloading = !isTransferDone && (video.status === 'DOWNLOADING' || (activeTransfer && activeTransfer.status === 'DOWNLOADING'));
  const activeProc = processingJob || video.processing_info;
  const isProcessing = video.status === 'PROCESSING' || Boolean(activeProc);

  // Format seconds to h:mm:ss or mm:ss
  const formatTime = (secs) => {
    if (!secs || isNaN(secs)) return '0:00';
    const totalSecs = Math.floor(secs);
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    if (h > 0) {
      return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    }
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

  // Sync state when video prop changes
  useEffect(() => {
    if (video.audio_tracks) setAudioTracks(video.audio_tracks);
    if (video.subtitle_tracks) setSubtitleTracks(video.subtitle_tracks);
  }, [video.audio_tracks, video.subtitle_tracks]);

  // Auto-probe tracks if video is ready/local and tracks haven't been probed yet
  useEffect(() => {
    if (!isReadyToPlay || (video.audio_tracks && video.audio_tracks.length > 0)) return;

    fetch(`/api/videos/${video.video_id}/probe-tracks`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.status === 'success') {
          if (data.audio_tracks) setAudioTracks(data.audio_tracks);
          if (data.subtitle_tracks) setSubtitleTracks(data.subtitle_tracks);
        }
      })
      .catch((err) => console.warn('[VideoPlayerModal] Auto-probe error:', err));
  }, [isReadyToPlay, video.video_id, video.audio_tracks, token]);

  // Companion audio synchronization
  useEffect(() => {
    const videoEl = playerContainerRef.current;
    const audioEl = companionAudioRef.current;
    if (!videoEl || !audioEl) return;

    if (selectedAudioTrack === 0) {
      audioEl.pause();
      audioEl.removeAttribute('src');
      videoEl.muted = false;
      return;
    }

    videoEl.muted = true;
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
    audioEl.src = `/api/videos/${video.video_id}/audio/${selectedAudioTrack}${tokenParam}`;
    audioEl.currentTime = videoEl.currentTime;
    audioEl.playbackRate = videoEl.playbackRate;
    audioEl.volume = videoEl.volume;
    if (!videoEl.paused) {
      audioEl.play().catch(() => {});
    }

    const handlePlay = () => { if (selectedAudioTrack > 0 && audioEl.src) audioEl.play().catch(() => {}); };
    const handlePause = () => { if (selectedAudioTrack > 0) audioEl.pause(); };
    const handleSeeking = () => { if (selectedAudioTrack > 0) audioEl.currentTime = videoEl.currentTime; };
    const handleSeeked = () => { if (selectedAudioTrack > 0) audioEl.currentTime = videoEl.currentTime; };
    const handleRateChange = () => { if (selectedAudioTrack > 0) audioEl.playbackRate = videoEl.playbackRate; };
    const handleVolumeChange = () => { if (selectedAudioTrack > 0) audioEl.volume = videoEl.volume; };
    const handleTimeUpdate = () => {
      if (selectedAudioTrack > 0 && Math.abs(audioEl.currentTime - videoEl.currentTime) > 0.3) {
        audioEl.currentTime = videoEl.currentTime;
      }
    };

    videoEl.addEventListener('play', handlePlay);
    videoEl.addEventListener('pause', handlePause);
    videoEl.addEventListener('seeking', handleSeeking);
    videoEl.addEventListener('seeked', handleSeeked);
    videoEl.addEventListener('ratechange', handleRateChange);
    videoEl.addEventListener('volumechange', handleVolumeChange);
    videoEl.addEventListener('timeupdate', handleTimeUpdate);

    return () => {
      videoEl.removeEventListener('play', handlePlay);
      videoEl.removeEventListener('pause', handlePause);
      videoEl.removeEventListener('seeking', handleSeeking);
      videoEl.removeEventListener('seeked', handleSeeked);
      videoEl.removeEventListener('ratechange', handleRateChange);
      videoEl.removeEventListener('volumechange', handleVolumeChange);
      videoEl.removeEventListener('timeupdate', handleTimeUpdate);
    };
  }, [selectedAudioTrack, video.video_id, token]);

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
    if (isReadyToPlay && playerContainerRef.current) {
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
      (subtitleTracks || []).forEach((st) => {
        if (st.url) {
          tracks.push({
            kind: 'captions',
            label: st.label || `${st.language_name || 'Sub'} (${st.codec})`,
            srclang: st.language || 'en',
            src: st.url,
            default: Boolean(st.is_default)
          });
        }
      });
      if (video.subtitles_url) {
        const alreadyIn = (subtitleTracks || []).some((st) => st.url === video.subtitles_url);
        if (!alreadyIn) {
          tracks.push({
            kind: 'captions',
            label: 'AI Whisper (English)',
            srclang: 'en',
            src: video.subtitles_url,
            default: tracks.length === 0
          });
        }
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

      const calculateBufferedPercent = () => {
        if (!videoEl || !videoEl.duration || !isFinite(videoEl.duration) || videoEl.duration <= 0) return 0;
        const dur = videoEl.duration;
        const buf = videoEl.buffered;
        if (!buf || buf.length === 0) return 0;
        let total = 0;
        for (let i = 0; i < buf.length; i++) {
          try {
            const start = buf.start(i);
            const end = buf.end(i);
            if (end > start) total += (end - start);
          } catch (e) {}
        }
        const pct = Math.min(100, Math.max(0, Math.round((total / dur) * 100)));
        return isNaN(pct) ? 0 : pct;
      };

      const updateBufferMetrics = () => {
        const pct = calculateBufferedPercent();
        setBufferedPercent(pct);

        // Update Plyr native progress buffer element, tooltip, and timeline badge
        const bufBar = (plyr.elements?.display && plyr.elements.display.buffer) ||
                       (plyr.elements?.progress && plyr.elements.progress.querySelector && plyr.elements.progress.querySelector('.plyr__progress__buffer')) ||
                       (plyr.elements?.container && plyr.elements.container.querySelector && plyr.elements.container.querySelector('.plyr__progress__buffer'));
        if (bufBar) {
          bufBar.value = pct;
          bufBar.setAttribute('aria-valuenow', pct);
          bufBar.setAttribute('title', `Buffered: ${pct}%`);
          const span = bufBar.querySelector('span');
          if (span) span.textContent = pct;
        }

        if (plyr.elements?.progress) {
          plyr.elements.progress.setAttribute('title', `Buffered: ${pct}%`);
          const badge = plyr.elements.progress.querySelector('.plyr__buffer-live-badge');
          if (badge) {
            badge.textContent = `Buffered: ${pct}%`;
          }
        }

        if (plyr.elements?.inputs?.seek) {
          plyr.elements.inputs.seek.setAttribute('title', `Buffered: ${pct}%`);
        }

        // Update full-screen overlay text if present
        if (plyr.elements?.container) {
          const fsTxt = plyr.elements.container.querySelector('.dc-fs-buffer-text');
          if (fsTxt) {
            fsTxt.textContent = `Buffered: ${pct}%`;
          }
        }
      };

      let isBufferingState = true;
      const setBufferingActive = (buffering) => {
        isBufferingState = buffering;
        setIsBuffering(buffering);

        const isFs = Boolean(
          document.fullscreenElement ||
          document.webkitFullscreenElement ||
          document.mozFullScreenElement ||
          (plyr?.fullscreen?.active)
        );

        if (plyr.elements?.container) {
          const fsOverlay = plyr.elements.container.querySelector('.dc-plyr-fs-buffering');
          if (fsOverlay) {
            if (buffering && isFs) {
              fsOverlay.classList.remove('hidden');
              fsOverlay.classList.add('flex');
            } else {
              fsOverlay.classList.add('hidden');
              fsOverlay.classList.remove('flex');
            }
          }
        }
      };

      plyr.on('ready', () => {
        if (initialTime > 0) {
          plyr.currentTime = initialTime;
        }
        plyr.speed = playbackSpeed;
        initAudioBooster(videoEl);

        // Inject timeline buffer badge into Plyr progress element
        if (plyr.elements?.progress) {
          let badge = plyr.elements.progress.querySelector('.plyr__buffer-live-badge');
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'plyr__buffer-live-badge absolute right-2 -top-6 text-[10px] font-mono px-2 py-0.5 rounded bg-[#0d1117]/90 border border-sky-500/30 text-sky-400 pointer-events-none shadow-md backdrop-blur-sm transition-opacity duration-200 z-10';
            badge.textContent = 'Buffered: 0%';
            plyr.elements.progress.style.position = 'relative';
            plyr.elements.progress.appendChild(badge);
          }
        }

        // Fullscreen buffering indicator overlay inside Plyr root container
        if (plyr.elements?.container) {
          let fsOverlay = plyr.elements.container.querySelector('.dc-plyr-fs-buffering');
          if (!fsOverlay) {
            fsOverlay = document.createElement('div');
            fsOverlay.className = 'dc-plyr-fs-buffering absolute inset-0 z-40 hidden items-center justify-center pointer-events-none bg-black/40 backdrop-blur-[2px] transition-all duration-200';
            fsOverlay.innerHTML = `
              <div class="flex flex-col items-center space-y-3 px-6 py-4 rounded-2xl bg-[#0d1117]/90 border border-sky-500/30 shadow-2xl backdrop-blur-md">
                <div class="relative flex items-center justify-center">
                  <div class="w-12 h-12 rounded-full border-2 border-sky-500/20 border-t-sky-400 animate-spin"></div>
                  <div class="absolute w-6 h-6 rounded-full bg-sky-500/20 animate-ping"></div>
                </div>
                <div class="flex flex-col items-center space-y-1 text-center font-mono">
                  <div class="flex items-center space-x-1.5 text-xs font-semibold text-white">
                    <span class="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse"></span>
                    <span>Buffering Stream...</span>
                  </div>
                  <span class="dc-fs-buffer-text text-[11px] text-sky-400 font-bold font-mono">Buffered: 0%</span>
                </div>
              </div>
            `;
            plyr.elements.container.appendChild(fsOverlay);
          }
        }

        updateBufferMetrics();
      });

      plyr.on('enterfullscreen', () => {
        setBufferingActive(isBufferingState);
      });

      plyr.on('exitfullscreen', () => {
        setBufferingActive(isBufferingState);
      });

      plyr.on('waiting', () => {
        setBufferingActive(true);
        updateBufferMetrics();
      });

      plyr.on('seeking', () => {
        setBufferingActive(true);
        updateBufferMetrics();
      });

      plyr.on('loadstart', () => {
        setBufferingActive(true);
        updateBufferMetrics();
      });

      videoEl.addEventListener('stalled', () => {
        if (!videoEl.paused && videoEl.readyState < 3) {
          setBufferingActive(true);
          updateBufferMetrics();
        }
      });

      plyr.on('playing', () => {
        setBufferingActive(false);
        updateBufferMetrics();
        if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
          audioContextRef.current.resume().catch(() => {});
        }
      });

      plyr.on('canplay', () => {
        setBufferingActive(false);
        updateBufferMetrics();
      });

      plyr.on('canplaythrough', () => {
        setBufferingActive(false);
        updateBufferMetrics();
      });

      plyr.on('seeked', () => {
        if (videoEl.readyState >= 3 || videoEl.paused) {
          setBufferingActive(false);
        } else {
          setBufferingActive(true);
        }
        updateBufferMetrics();
      });

      plyr.on('pause', () => {
        setBufferingActive(false);
      });

      plyr.on('ended', () => {
        setBufferingActive(false);
        updateBufferMetrics();
      });

      plyr.on('progress', () => {
        updateBufferMetrics();
      });

      // Watch Position Memory Throttled Save
      let lastSave = 0;
      plyr.on('timeupdate', () => {
        updateBufferMetrics();
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

      const bufferInterval = setInterval(updateBufferMetrics, 500);

      plyrInstanceRef.current = plyr;
      currentVideoIdRef.current = video.video_id;

      return () => {
        clearInterval(bufferInterval);
        if (plyrInstanceRef.current) {
          plyrInstanceRef.current.destroy();
          plyrInstanceRef.current = null;
        }
        if (audioContextRef.current) {
          try { audioContextRef.current.close(); } catch(e) {}
          audioContextRef.current = null;
          gainNodeRef.current = null;
        }
      };
    }

    return () => {
      if (plyrInstanceRef.current) {
        plyrInstanceRef.current.destroy();
        plyrInstanceRef.current = null;
      }
      if (audioContextRef.current) {
        try { audioContextRef.current.close(); } catch(e) {}
        audioContextRef.current = null;
        gainNodeRef.current = null;
      }
    };
  }, [isReadyToPlay, video.video_id, selectedQuality, video.subtitles_url, subtitleTracks, token, initAudioBooster]);

  // Handle Subtitle Track Change
  const handleSubtitleChange = (val) => {
    setSelectedSubtitle(val);
    const plyr = plyrInstanceRef.current;
    if (!plyr) return;
    if (val === 'off') {
      plyr.currentTrack = -1;
    } else {
      const idx = parseInt(val, 10);
      if (!isNaN(idx)) {
        plyr.currentTrack = idx;
      }
    }
  };

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
              <button
                type="button"
                onClick={handleResetStatus}
                disabled={isResetting}
                className="px-2 py-0.5 rounded bg-purple-500/20 hover:bg-purple-500/40 text-purple-200 border border-purple-500/40 text-[10px] transition font-sans cursor-pointer"
                title="Reset status to ready if stuck"
              >
                {isResetting ? 'Resetting...' : 'Dismiss / Ready'}
              </button>
            </div>
          </div>
        )}

        {/* Player Viewport */}
        <div className="relative flex-1 min-h-[300px] bg-black flex items-center justify-center overflow-hidden">
          {isReadyToPlay ? (
            <div className="relative w-full h-full flex items-center justify-center">
              <video
                ref={playerContainerRef}
                playsInline
                crossOrigin="anonymous"
                className="w-full h-full object-contain"
              />
              {/* Companion Audio Element for multi-track audio switching */}
              <audio ref={companionAudioRef} preload="none" className="hidden" />
              {/* Buffering Loading Indicator Overlay */}
              {isBuffering && (
                <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none bg-black/40 backdrop-blur-[2px] transition-all duration-200">
                  <div className="flex flex-col items-center space-y-3 px-6 py-4 rounded-2xl bg-[#0d1117]/90 border border-sky-500/30 shadow-2xl backdrop-blur-md">
                    <div className="relative flex items-center justify-center">
                      <div className="w-12 h-12 rounded-full border-2 border-sky-500/20 border-t-sky-400 animate-spin" />
                      <div className="absolute w-6 h-6 rounded-full bg-sky-500/20 animate-ping" />
                    </div>
                    <div className="flex flex-col items-center space-y-1 text-center font-mono">
                      <div className="flex items-center space-x-1.5 text-xs font-semibold text-white">
                        <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
                        <span>Buffering Stream...</span>
                      </div>
                      <span className="text-[11px] text-sky-400 font-bold">Buffered: {bufferedPercent}%</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : isTransferDone ? (
            <div className="flex flex-col items-center justify-center p-8 max-w-md w-full text-center space-y-6">
              <div className="relative">
                <div className="w-20 h-20 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                  <CheckCircle className="w-10 h-10" />
                </div>
              </div>

              <div className="space-y-1">
                <h4 className="text-lg font-bold text-white">Download Complete</h4>
                <p className="text-xs text-slate-400">
                  Stream stored on 1TB NVMe Block Storage. Preparing player...
                </p>
              </div>

              {activeTransfer && (
                <div className="w-full space-y-3 bg-[#010409] border border-emerald-500/30 p-4 rounded-xl font-mono text-xs">
                  <div className="w-full bg-[#21262d] h-2 rounded-full overflow-hidden">
                    <div
                      className="bg-emerald-500 h-full transition-all duration-300 rounded-full"
                      style={{ width: '100%' }}
                    />
                  </div>

                  <div className="flex justify-between items-center text-slate-300 text-xs">
                    <span className="flex items-center space-x-1 font-bold text-emerald-400 text-sm">
                      <CheckCircle className="w-4 h-4 text-emerald-400" />
                      <span>Done</span>
                    </span>
                    <span className="text-emerald-400 font-semibold">{activeTransfer.total_str || activeTransfer.downloaded_str || '100%'}</span>
                  </div>

                  <div className="flex justify-between items-center text-[11px] text-slate-500 pt-1 border-t border-[#30363d]/80">
                    <span>Source: {activeTransfer.source || 'Storage'}</span>
                    <span className="text-emerald-400 font-medium">Completed</span>
                  </div>
                </div>
              )}
            </div>
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

              {/* Pre-loaded Buffer Range & Indicator */}
              <div
                className="flex items-center space-x-2 bg-[#0d1117] px-3 py-1.5 rounded-lg border border-[#30363d]"
                title="Media pre-loaded into memory buffer"
              >
                <div className="relative flex items-center justify-center">
                  <div className={`w-2 h-2 rounded-full ${isBuffering ? 'bg-amber-400 animate-ping' : 'bg-sky-400'}`} />
                  <div className={`absolute w-2 h-2 rounded-full ${isBuffering ? 'bg-amber-400' : 'bg-sky-400'}`} />
                </div>
                <span className="text-[11px] font-mono text-slate-400">Buffered:</span>
                <span className="text-[11px] font-mono font-bold text-sky-400">{bufferedPercent}%</span>
                <div className="w-14 bg-[#21262d] h-1.5 rounded-full overflow-hidden ml-1 hidden sm:block">
                  <div
                    className="bg-gradient-to-r from-sky-500 to-cyan-400 h-full rounded-full transition-all duration-300"
                    style={{ width: `${bufferedPercent}%` }}
                  />
                </div>
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

              {/* Audio Track Selector */}
              {audioTracks && audioTracks.length > 0 && (
                <div
                  className="flex items-center space-x-1.5 bg-[#0d1117] px-2.5 py-1.5 rounded-lg border border-[#30363d]"
                  title="Select Audio Track / Language"
                >
                  <Volume2 className="w-3.5 h-3.5 text-sky-400" />
                  <span className="text-[11px] font-mono text-slate-400">Audio:</span>
                  <select
                    value={selectedAudioTrack}
                    onChange={(e) => setSelectedAudioTrack(Number(e.target.value))}
                    className="bg-transparent text-white font-mono text-xs focus:outline-none cursor-pointer max-w-[130px] truncate"
                  >
                    {audioTracks.map((t) => (
                      <option key={t.index} value={t.index} className="bg-[#161b22] text-white">
                        {t.label || `Track ${t.index + 1}`}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Subtitles Track Selector */}
              <div
                className="flex items-center space-x-1.5 bg-[#0d1117] px-2.5 py-1.5 rounded-lg border border-[#30363d]"
                title="Select Subtitle Track / Language"
              >
                <Subtitles className="w-3.5 h-3.5 text-purple-400" />
                <span className="text-[11px] font-mono text-slate-400">Subs:</span>
                <select
                  value={selectedSubtitle}
                  onChange={(e) => handleSubtitleChange(e.target.value)}
                  className="bg-transparent text-white font-mono text-xs focus:outline-none cursor-pointer max-w-[130px] truncate"
                >
                  <option value="off" className="bg-[#161b22] text-white">Off</option>
                  {(subtitleTracks || []).filter((s) => s.url).map((st, idx) => (
                    <option key={st.index} value={idx} className="bg-[#161b22] text-white">
                      {st.label || `${st.language_name || 'Sub'}`}
                    </option>
                  ))}
                  {video.subtitles_url && !(subtitleTracks || []).some((s) => s.url === video.subtitles_url) && (
                    <option value={(subtitleTracks || []).filter((s) => s.url).length} className="bg-[#161b22] text-white">
                      AI Whisper (English)
                    </option>
                  )}
                </select>
                <button
                  type="button"
                  onClick={() => onTranscribe && onTranscribe(video.video_id)}
                  title={video.subtitles_url ? "AI Subtitles Active" : "Generate Local AI Subtitles via Whisper"}
                  className={`p-1 rounded transition ${
                    video.subtitles_url
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'bg-purple-500/20 hover:bg-purple-500/40 text-purple-300'
                  }`}
                >
                  <Sparkles className="w-3 h-3" />
                </button>
              </div>
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
            <span className="flex items-center space-x-1 text-sky-400 font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
              <span>Buffered: {bufferedPercent}%</span>
            </span>
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
