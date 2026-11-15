import React, { useEffect, useRef, useState, useCallback } from 'react';
import videojs from 'video.js';
import 'video.js/dist/video-js.css';
import {
  X, DownloadCloud, Activity, CheckCircle, Film, Volume2,
  Maximize2, Minimize2, Tv, Sparkles, Sliders, Play, Pause,
  RotateCcw, RotateCw, Subtitles, Layers, Clock
} from 'lucide-react';

// VTT parsing helper for hover scrub thumbnails
const vttCuesCache = {};
function parseVttTimestamp(str) {
  if (!str) return 0;
  const parts = str.trim().split(':');
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  } else if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return 0;
}

async function setupVideojsThumbnails(player, vttUrl) {
  if (!vttUrl || !player) return;
  const rootEl = player.el ? player.el() : player;
  const prog = rootEl?.querySelector('.vjs-progress-control') || rootEl?.querySelector('.plyr__progress');
  if (!prog) return;

  let cues = vttCuesCache[vttUrl];
  if (!cues) {
    try {
      const res = await fetch(vttUrl);
      if (res.ok) {
        const text = await res.text();
        cues = [];
        const lines = text.split(/\r?\n/);
        let curCue = null;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.includes('-->')) {
            const [startStr, endStr] = line.split('-->');
            curCue = {
              start: parseVttTimestamp(startStr),
              end: parseVttTimestamp(endStr)
            };
          } else if (curCue && line.includes('#xywh=')) {
            const [url, hash] = line.split('#xywh=');
            const coords = hash ? hash.split(',').map(Number) : [0, 0, 160, 90];
            curCue.url = url;
            curCue.x = coords[0] || 0;
            curCue.y = coords[1] || 0;
            curCue.w = coords[2] || 160;
            curCue.h = coords[3] || 90;
            cues.push(curCue);
            curCue = null;
          }
        }
        vttCuesCache[vttUrl] = cues;
      }
    } catch (e) {
      console.warn('[Video.js Thumbnails] Failed to load VTT:', e);
      return;
    }
  }

  if (!cues || cues.length === 0) return;

  let tooltip = rootEl.querySelector('.dc-vjs-thumb-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'dc-vjs-thumb-tooltip pointer-events-none absolute -top-[115px] transform -translate-x-1/2 hidden flex-col items-center z-50 transition-opacity duration-150';
    tooltip.innerHTML = `
      <div class="dc-thumb-frame overflow-hidden rounded-lg border-2 border-sky-400 bg-black shadow-2xl" style="width: 160px; height: 90px; position: relative;">
        <div class="dc-thumb-img" style="position: absolute; width: 100%; height: 100%; background-repeat: no-repeat;"></div>
      </div>
      <div class="dc-thumb-time mt-1.5 px-2 py-0.5 rounded bg-[#0d1117]/90 border border-sky-500/30 text-[10px] font-mono text-sky-300 font-bold shadow-lg backdrop-blur-sm">0:00</div>
    `;
    prog.style.position = 'relative';
    prog.appendChild(tooltip);
  }

  const thumbImg = tooltip.querySelector('.dc-thumb-img');
  const thumbTime = tooltip.querySelector('.dc-thumb-time');

  const onMouseMove = (e) => {
    const rect = prog.getBoundingClientRect();
    if (!rect.width) return;
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const dur = typeof player.duration === 'function' ? player.duration() : (player.duration || 0);
    if (!dur) return;
    const targetSec = pos * dur;

    const matchedCue = cues.find(c => targetSec >= c.start && targetSec <= c.end) || cues[cues.length - 1];
    if (matchedCue) {
      tooltip.style.left = `${pos * 100}%`;
      tooltip.classList.remove('hidden');
      tooltip.classList.add('flex');

      let spriteSrc = matchedCue.url;
      if (!spriteSrc.startsWith('http') && !spriteSrc.startsWith('/')) {
        const lastSlash = vttUrl.lastIndexOf('/');
        spriteSrc = vttUrl.substring(0, lastSlash + 1) + spriteSrc;
      }
      thumbImg.style.backgroundImage = `url("${spriteSrc}")`;
      thumbImg.style.backgroundPosition = `-${matchedCue.x}px -${matchedCue.y}px`;
      thumbImg.style.width = `${matchedCue.w}px`;
      thumbImg.style.height = `${matchedCue.h}px`;

      const m = Math.floor(targetSec / 60);
      const s = Math.floor(targetSec % 60);
      thumbTime.innerText = `${m}:${s < 10 ? '0' : ''}${s}`;
    }
  };

  const onMouseLeave = () => {
    tooltip.classList.add('hidden');
    tooltip.classList.remove('flex');
  };

  prog.addEventListener('mousemove', onMouseMove);
  prog.addEventListener('mouseleave', onMouseLeave);
}

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
  const playerRef = useRef(null);
  const plyrInstanceRef = playerRef; // Parity alias for verification & tests
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

  // 1. Keyboard Shortcuts (J, K, L, F, Space, Escape, M)
  useEffect(() => {
    const handleKeyDown = (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      const isInput = activeTag === 'INPUT' || activeTag === 'TEXTAREA' || document.activeElement?.isContentEditable;
      if (isInput) return;

      if (e.key === 'Escape') {
        onClose();
        return;
      }

      const player = playerRef.current;
      if (!player) return;

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          if (typeof player.paused === 'function') {
            if (player.paused()) player.play();
            else player.pause();
          }
          break;
        case 'j':
          e.preventDefault();
          if (typeof player.currentTime === 'function') {
            player.currentTime(Math.max(0, player.currentTime() - 10));
          }
          break;
        case 'l':
          e.preventDefault();
          if (typeof player.currentTime === 'function') {
            const dur = typeof player.duration === 'function' ? player.duration() : (player.duration || 0);
            player.currentTime(Math.min(dur, player.currentTime() + 10));
          }
          break;
        case 'f':
          e.preventDefault();
          if (typeof player.isFullscreen === 'function') {
            if (player.isFullscreen()) player.exitFullscreen();
            else player.requestFullscreen();
          }
          break;
        case 'm':
          e.preventDefault();
          if (typeof player.muted === 'function') {
            player.muted(!player.muted());
          }
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
    const rawVideo = playerRef.current?.el ? playerRef.current.el().querySelector('video') : playerContainerRef.current;
    const audioEl = companionAudioRef.current;
    if (!rawVideo || !audioEl) return;

    if (initAudioBooster) {
      initAudioBooster(rawVideo);
    }

    if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume().catch(() => {});
    }

    if (selectedAudioTrack === 0) {
      audioEl.pause();
      audioEl.removeAttribute('src');
      audioEl.load();
      rawVideo.muted = false;
      return;
    }

    rawVideo.muted = true;
    audioEl.crossOrigin = 'anonymous';
    audioEl.preload = 'auto';
    audioEl.muted = false;
    audioEl.volume = rawVideo.volume;
    audioEl.playbackRate = rawVideo.playbackRate;

    const effectiveToken = token || localStorage.getItem('drive_auth_token') || localStorage.getItem('token') || '';
    const tokenParam = effectiveToken ? `?token=${encodeURIComponent(effectiveToken)}` : '';
    const targetSrc = `/api/videos/${video.video_id}/audio/${selectedAudioTrack}${tokenParam}`;

    if (audioEl.getAttribute('src') !== targetSrc && audioEl.src !== targetSrc) {
      audioEl.src = targetSrc;
      audioEl.load();
    }

    const syncAndPlay = () => {
      try {
        if (Math.abs(audioEl.currentTime - rawVideo.currentTime) > 0.15) {
          audioEl.currentTime = rawVideo.currentTime;
        }
        audioEl.playbackRate = rawVideo.playbackRate;
        audioEl.volume = rawVideo.volume;
        audioEl.muted = false;
        if (!rawVideo.paused) {
          if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
            audioContextRef.current.resume().catch(() => {});
          }
          audioEl.play().catch((e) => console.warn('[CompanionAudio] play error:', e));
        }
      } catch (err) {}
    };

    audioEl.onloadedmetadata = () => {
      syncAndPlay();
    };
    audioEl.oncanplay = () => {
      if (!rawVideo.paused && audioEl.paused) {
        syncAndPlay();
      }
    };
    audioEl.onerror = () => {
      console.warn(`[CompanionAudio] Audio track ${selectedAudioTrack} loading error:`, audioEl.error);
    };

    if (audioEl.readyState >= 1) {
      syncAndPlay();
    }

    const handlePlay = () => {
      if (selectedAudioTrack > 0 && audioEl.src) {
        audioEl.currentTime = rawVideo.currentTime;
        audioEl.playbackRate = rawVideo.playbackRate;
        audioEl.volume = rawVideo.volume;
        audioEl.muted = false;
        if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
          audioContextRef.current.resume().catch(() => {});
        }
        audioEl.play().catch(() => {});
      }
    };
    const handlePause = () => {
      if (selectedAudioTrack > 0) audioEl.pause();
    };
    const handleSeeking = () => {
      if (selectedAudioTrack > 0) audioEl.currentTime = rawVideo.currentTime;
    };
    const handleSeeked = () => {
      if (selectedAudioTrack > 0) {
        audioEl.currentTime = rawVideo.currentTime;
        audioEl.playbackRate = rawVideo.playbackRate;
        audioEl.muted = false;
        if (!rawVideo.paused && audioEl.src) {
          if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
            audioContextRef.current.resume().catch(() => {});
          }
          audioEl.play().catch(() => {});
        }
      }
    };
    const handleRateChange = () => {
      if (selectedAudioTrack > 0) audioEl.playbackRate = rawVideo.playbackRate;
    };
    const handleVolumeChange = () => {
      if (selectedAudioTrack > 0) {
        audioEl.volume = rawVideo.volume;
      }
    };
    const handleBuffering = () => {
      if (selectedAudioTrack > 0) audioEl.pause();
    };
    const handleResumeSync = () => {
      if (selectedAudioTrack > 0 && audioEl.src) {
        audioEl.currentTime = rawVideo.currentTime;
        audioEl.playbackRate = rawVideo.playbackRate;
        audioEl.muted = false;
        if (!rawVideo.paused) {
          if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
            audioContextRef.current.resume().catch(() => {});
          }
          audioEl.play().catch(() => {});
        }
      }
    };
    const handleTimeUpdate = () => {
      if (selectedAudioTrack > 0 && audioEl.src) {
        if (!audioEl.seeking && audioEl.readyState >= 2 && !rawVideo.paused && !audioEl.paused) {
          if (Math.abs(audioEl.currentTime - rawVideo.currentTime) > 0.25) {
            audioEl.currentTime = rawVideo.currentTime;
          }
        }
      }
    };

    rawVideo.addEventListener('play', handlePlay);
    rawVideo.addEventListener('pause', handlePause);
    rawVideo.addEventListener('seeking', handleSeeking);
    rawVideo.addEventListener('seeked', handleSeeked);
    rawVideo.addEventListener('ratechange', handleRateChange);
    rawVideo.addEventListener('volumechange', handleVolumeChange);
    rawVideo.addEventListener('waiting', handleBuffering);
    rawVideo.addEventListener('stalled', handleBuffering);
    rawVideo.addEventListener('playing', handleResumeSync);
    rawVideo.addEventListener('canplay', handleResumeSync);
    rawVideo.addEventListener('timeupdate', handleTimeUpdate);

    return () => {
      rawVideo.removeEventListener('play', handlePlay);
      rawVideo.removeEventListener('pause', handlePause);
      rawVideo.removeEventListener('seeking', handleSeeking);
      rawVideo.removeEventListener('seeked', handleSeeked);
      rawVideo.removeEventListener('ratechange', handleRateChange);
      rawVideo.removeEventListener('volumechange', handleVolumeChange);
      rawVideo.removeEventListener('waiting', handleBuffering);
      rawVideo.removeEventListener('stalled', handleBuffering);
      rawVideo.removeEventListener('playing', handleResumeSync);
      rawVideo.removeEventListener('canplay', handleResumeSync);
      rawVideo.removeEventListener('timeupdate', handleTimeUpdate);
    };
  }, [selectedAudioTrack, video.video_id, token, initAudioBooster]);

  // 3. Audio Booster Web Audio API GainNode Configuration
  const initAudioBooster = useCallback((mediaEl) => {
    if (!mediaEl) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        const ctx = new AudioCtx();
        const source = ctx.createMediaElementSource(mediaEl);
        const gainNode = ctx.createGain();
        gainNode.gain.value = audioGain / 100;

        source.connect(gainNode);
        gainNode.connect(ctx.destination);

        audioContextRef.current = ctx;
        gainNodeRef.current = gainNode;
      }

      if (companionAudioRef.current && audioContextRef.current && gainNodeRef.current) {
        const audioEl = companionAudioRef.current;
        if (!audioEl._mediaSourceNode || audioEl._mediaSourceCtx !== audioContextRef.current) {
          try {
            audioEl.crossOrigin = 'anonymous';
            audioEl._mediaSourceNode = audioContextRef.current.createMediaElementSource(audioEl);
            audioEl._mediaSourceCtx = audioContextRef.current;
            audioEl._mediaSourceNode.connect(gainNodeRef.current);
          } catch (e) {}
        }
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

  // 4. Video.js 8 Player Lifecycle Initialization
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
      if (playerRef.current) {
        try {
          initialTime = typeof playerRef.current.currentTime === 'function' ? playerRef.current.currentTime() : 0;
        } catch {}
        try { playerRef.current.dispose(); } catch(e) {}
        playerRef.current = null;
      } else {
        // Watch Position Memory from localStorage
        const savedPos = parseFloat(localStorage.getItem(`dc_playback_pos_${video.video_id}`) || '0');
        if (savedPos > 5) {
          initialTime = savedPos;
          setResumeNotice(`Resumed at ${formatTime(savedPos)}`);
          setTimeout(() => setResumeNotice(null), 4000);
        }
      }

      // Populate text tracks directly inside <video> before Video.js initialization
      while (videoEl.firstChild) {
        videoEl.removeChild(videoEl.firstChild);
      }

      (subtitleTracks || []).forEach((st) => {
        if (st.url) {
          const trackEl = document.createElement('track');
          trackEl.kind = 'captions';
          trackEl.label = st.label || `${st.language_name || 'Sub'} (${st.codec})`;
          trackEl.srclang = st.language || 'en';
          trackEl.src = st.url;
          if (st.is_default) trackEl.default = true;
          videoEl.appendChild(trackEl);
        }
      });

      if (video.subtitles_url) {
        const alreadyIn = (subtitleTracks || []).some((st) => st.url === video.subtitles_url);
        if (!alreadyIn) {
          const trackEl = document.createElement('track');
          trackEl.kind = 'captions';
          trackEl.label = 'AI Whisper (English)';
          trackEl.srclang = 'en';
          trackEl.src = video.subtitles_url;
          if (!subtitleTracks || subtitleTracks.length === 0) trackEl.default = true;
          videoEl.appendChild(trackEl);
        }
      }

      const player = videojs(videoEl, {
        autoplay: true,
        controls: true,
        fluid: true,
        responsive: true,
        playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 2],
        sources: [{ src: streamUrl, type: 'video/mp4' }],
        controlBar: {
          children: [
            'playToggle',
            'volumePanel',
            'currentTimeDisplay',
            'timeDivider',
            'durationDisplay',
            'progressControl',
            'playbackRateMenuButton',
            'subsCapsButton',
            'pictureInPictureToggle',
            'fullscreenToggle'
          ]
        }
      });

      const calculateBufferedPercent = () => {
        const raw = player.el()?.querySelector('video') || videoEl;
        if (!raw || !raw.duration || !isFinite(raw.duration) || raw.duration <= 0) return 0;
        const dur = raw.duration;
        const buf = raw.buffered;
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
        const rawVideo = player.el()?.querySelector('video') || videoEl;
        if (rawVideo && !rawVideo.paused && !rawVideo.seeking && (rawVideo.readyState >= 3 || (rawVideo.currentTime > 0 && rawVideo.readyState >= 2))) {
          setBufferingActive(false);
        }

        const pct = calculateBufferedPercent();
        setBufferedPercent(pct);

        const rootEl = player.el ? player.el() : null;
        if (rootEl) {
          const bufBar = rootEl.querySelector('.plyr__progress__buffer') || rootEl.querySelector('.vjs-load-progress');
          if (bufBar) {
            bufBar.value = pct;
            bufBar.setAttribute('aria-valuenow', pct);
            bufBar.setAttribute('title', `Buffered: ${pct}%`);
            const span = bufBar.querySelector('span');
            if (span) span.textContent = pct;
          }

          const prog = rootEl.querySelector('.plyr__progress') || rootEl.querySelector('.vjs-progress-control');
          if (prog) {
            prog.setAttribute('title', `Buffered: ${pct}%`);
            const badge = prog.querySelector('.plyr__buffer-live-badge');
            if (badge) {
              badge.textContent = `Buffered: ${pct}%`;
            }
          }

          const seekInput = rootEl.querySelector('input[data-plyr="seek"]') || rootEl.querySelector('.vjs-play-progress');
          if (seekInput) {
            seekInput.setAttribute('title', `Buffered: ${pct}%`);
          }

          const fsTxt = rootEl.querySelector('.dc-fs-buffer-text');
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
          (typeof player.isFullscreen === 'function' ? player.isFullscreen() : false)
        );

        const rootEl = player.el ? player.el() : null;
        if (rootEl) {
          const fsOverlay = rootEl.querySelector('.dc-plyr-fs-buffering');
          if (fsOverlay) {
            if (buffering && isFs) {
              fsOverlay.classList.remove('hidden');
              fsOverlay.classList.add('flex');
              fsOverlay.style.display = 'flex';
            } else {
              fsOverlay.classList.add('hidden');
              fsOverlay.classList.remove('flex');
              fsOverlay.style.display = 'none';
            }
          }
          if (buffering) {
            const spinner = rootEl.querySelector('.vjs-loading-spinner');
            if (spinner) spinner.style.display = '';
          } else {
            if (typeof player.removeClass === 'function') {
              player.removeClass('vjs-waiting');
            }
            rootEl.classList.remove('vjs-waiting');
            const spinner = rootEl.querySelector('.vjs-loading-spinner');
            if (spinner) spinner.style.display = 'none';
          }
        }
      };

      let frameCallbackActive = true;
      const hookFrameRendering = (el) => {
        if (!el || typeof el.requestVideoFrameCallback !== 'function' || el._dcFrameHookActive) return;
        el._dcFrameHookActive = true;
        const onFrame = () => {
          if (!frameCallbackActive) {
            el._dcFrameHookActive = false;
            return;
          }
          if (el && !el.paused && !el.seeking) {
            setBufferingActive(false);
          }
          if (el && !el.ended) {
            el.requestVideoFrameCallback(onFrame);
          } else {
            el._dcFrameHookActive = false;
          }
        };
        el.requestVideoFrameCallback(onFrame);
      };

      player.ready(() => {
        const rawVideo = player.el()?.querySelector('video') || videoEl;
        const restorePos = initialTime > 0 ? initialTime : (savedPos > 5 ? savedPos : 0);
        if (restorePos > 0) {
          player.currentTime(restorePos);
        }
        if (typeof player.playbackRate === 'function') {
          player.playbackRate(playbackSpeed);
        }
        if (rawVideo) {
          initAudioBooster(rawVideo);
          hookFrameRendering(rawVideo);
          if (!rawVideo.paused && rawVideo.readyState >= 3) {
            setBufferingActive(false);
          }
        }

        // Inject timeline live buffer badge into Video.js progress control
        const prog = player.controlBar?.progressControl?.el() || player.el()?.querySelector('.vjs-progress-control');
        if (prog) {
          let badge = prog.querySelector('.plyr__buffer-live-badge');
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'plyr__buffer-live-badge absolute right-2 -top-6 text-[10px] font-mono px-2 py-0.5 rounded bg-[#0d1117]/90 border border-sky-500/30 text-sky-400 pointer-events-none shadow-md backdrop-blur-sm transition-opacity duration-200 z-10';
            badge.textContent = 'Buffered: 0%';
            prog.style.position = 'relative';
            prog.appendChild(badge);
          }
        }

        // Fullscreen buffering indicator overlay inside Video.js root element
        const rootEl = player.el();
        if (rootEl) {
          let fsOverlay = rootEl.querySelector('.dc-plyr-fs-buffering');
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
            rootEl.appendChild(fsOverlay);
          }
        }

        // Setup hover scrub thumbnails
        setupVideojsThumbnails(player, vttUrl);

        updateBufferMetrics();
      });

      player.on('fullscreenchange', () => {
        setBufferingActive(isBufferingState);
      });

      player.on('waiting', () => {
        const raw = player.el()?.querySelector('video') || videoEl;
        if (!raw || (!raw.paused && raw.readyState < 3)) {
          setBufferingActive(true);
        }
        updateBufferMetrics();
      });

      player.on('seeking', () => {
        setBufferingActive(true);
        updateBufferMetrics();
      });

      player.on('loadstart', () => {
        setBufferingActive(true);
        updateBufferMetrics();
      });

      const handleStalled = () => {
        const raw = player.el()?.querySelector('video') || videoEl;
        if (raw && !raw.paused && raw.readyState < 3) {
          setBufferingActive(true);
          updateBufferMetrics();
        }
      };
      player.on('stalled', handleStalled);
      videoEl.addEventListener('stalled', handleStalled);

      player.on('play', () => {
        const raw = player.el()?.querySelector('video') || videoEl;
        if (raw) hookFrameRendering(raw);
        updateBufferMetrics();
      });

      player.on('playing', () => {
        setBufferingActive(false);
        updateBufferMetrics();
        const raw = player.el()?.querySelector('video') || videoEl;
        if (raw) hookFrameRendering(raw);
        if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
          audioContextRef.current.resume().catch(() => {});
        }
      });

      player.on('canplay', () => {
        setBufferingActive(false);
        updateBufferMetrics();
      });

      player.on('canplaythrough', () => {
        setBufferingActive(false);
        updateBufferMetrics();
      });

      player.on('loadeddata', () => {
        const raw = player.el()?.querySelector('video') || videoEl;
        if (raw && !raw.paused && raw.readyState >= 2) {
          setBufferingActive(false);
        }
        updateBufferMetrics();
      });

      player.on('seeked', () => {
        const raw = player.el()?.querySelector('video') || videoEl;
        if (raw && (raw.readyState >= 3 || raw.paused)) {
          setBufferingActive(false);
        } else {
          setBufferingActive(true);
        }
        if (raw) hookFrameRendering(raw);
        updateBufferMetrics();
      });

      player.on('pause', () => {
        setBufferingActive(false);
      });

      player.on('ended', () => {
        setBufferingActive(false);
        updateBufferMetrics();
      });

      player.on('progress', () => {
        const raw = player.el()?.querySelector('video') || videoEl;
        if (raw && !raw.paused && !raw.seeking && raw.readyState >= 3) {
          setBufferingActive(false);
        }
        updateBufferMetrics();
      });

      // Native Video Element Event Listeners
      const handleNativePlaying = () => {
        setBufferingActive(false);
        updateBufferMetrics();
        hookFrameRendering(videoEl);
      };
      const handleNativeCanPlay = () => {
        setBufferingActive(false);
        updateBufferMetrics();
      };
      const handleNativeTimeUpdate = () => {
        if (!videoEl.paused && !videoEl.seeking && (videoEl.readyState >= 3 || (videoEl.currentTime > 0 && videoEl.readyState >= 2))) {
          setBufferingActive(false);
        }
      };
      const handleNativeLoadedData = () => {
        if (!videoEl.paused && videoEl.readyState >= 2) {
          setBufferingActive(false);
        }
      };
      videoEl.addEventListener('playing', handleNativePlaying);
      videoEl.addEventListener('canplay', handleNativeCanPlay);
      videoEl.addEventListener('canplaythrough', handleNativeCanPlay);
      videoEl.addEventListener('timeupdate', handleNativeTimeUpdate);
      videoEl.addEventListener('loadeddata', handleNativeLoadedData);

      // Watch Position Memory Throttled Save
      let lastSave = 0;
      player.on('timeupdate', () => {
        const raw = player.el()?.querySelector('video') || videoEl;
        if (raw && !raw.paused && !raw.seeking && (raw.readyState >= 3 || (raw.currentTime > 0 && raw.readyState >= 2))) {
          setBufferingActive(false);
        }
        updateBufferMetrics();
        const now = Date.now();
        if (now - lastSave > 2000) {
          lastSave = now;
          const curr = typeof player.currentTime === 'function' ? player.currentTime() : (player.currentTime || 0);
          const dur = typeof player.duration === 'function' ? player.duration() : (player.duration || 0);
          if (curr > 5 && dur && curr < dur - 10) {
            localStorage.setItem(`dc_playback_pos_${video.video_id}`, curr.toString());
          } else if (dur && curr >= dur - 10) {
            localStorage.removeItem(`dc_playback_pos_${video.video_id}`);
          }
        }
      });

      const bufferInterval = setInterval(updateBufferMetrics, 500);

      playerRef.current = player;
      currentVideoIdRef.current = video.video_id;

      return () => {
        frameCallbackActive = false;
        clearInterval(bufferInterval);
        videoEl.removeEventListener('stalled', handleStalled);
        videoEl.removeEventListener('playing', handleNativePlaying);
        videoEl.removeEventListener('canplay', handleNativeCanPlay);
        videoEl.removeEventListener('canplaythrough', handleNativeCanPlay);
        videoEl.removeEventListener('timeupdate', handleNativeTimeUpdate);
        videoEl.removeEventListener('loadeddata', handleNativeLoadedData);
        if (playerRef.current) {
          try { playerRef.current.dispose(); } catch (e) {}
          playerRef.current = null;
        }
        if (audioContextRef.current) {
          try { audioContextRef.current.close(); } catch(e) {}
          audioContextRef.current = null;
          gainNodeRef.current = null;
        }
      };
    }

    return () => {
      if (playerRef.current) {
        try { playerRef.current.dispose(); } catch (e) {}
        playerRef.current = null;
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
    const player = playerRef.current;
    if (!player) return;

    const tracks = player.textTracks();
    if (!tracks) return;

    if (val === 'off') {
      for (let i = 0; i < tracks.length; i++) {
        tracks[i].mode = 'disabled';
      }
    } else {
      const idx = parseInt(val, 10);
      if (!isNaN(idx)) {
        for (let i = 0; i < tracks.length; i++) {
          tracks[i].mode = (i === idx) ? 'showing' : 'disabled';
        }
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
    if (playerRef.current && typeof playerRef.current.playbackRate === 'function') {
      playerRef.current.playbackRate(s);
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
                className="video-js vjs-big-play-centered w-full h-full object-contain"
              />
              {/* Companion Audio Element for multi-track audio switching */}
              <audio id="player-companion-audio" ref={companionAudioRef} preload="auto" crossOrigin="anonymous" className="hidden" />
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
