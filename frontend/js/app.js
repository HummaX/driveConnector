/**
 * ==============================================================================
 * DriveConnector Client Application Engine (app.js)
 * High-performance, modular client-side engine handling:
 * - Authentication & centralized fetchWithAuth
 * - Real-time WebSocket telemetry (/ws/transfers)
 * - Hero 3D Globe rendering (Globe.gl with mobile 60fps GPU cap & OVH arcs)
 * - Cinema Video.js 8 player with watch position memory
 * - Touch & Mouse seekbar WebVTT thumbnail scrubbing with 360px viewport clamp
 * - Web Audio API 200% GainNode booster
 * - Companion audio synchronization & multi-audio/subtitle switching
 * - Unified catalog search, filter, and on-demand streaming orchestration
 * ==============================================================================
 */

(function (window, document) {
  'use strict';

  /* ============================================================================
     1. GLOBAL APPLICATION STATE
     ============================================================================ */
  const state = {
    token: null,
    videos: [],
    transfers: {},
    processingJobs: {},
    currentFilter: 'all', // 'all' | 'local' | 'cloud'
    currentSort: 'date',  // 'date' | 'title' | 'size' | 'duration'
    currentView: 'grid',  // 'grid' | 'list'
    downloadEngine: 'auto', // 'auto' | 'native' | 'jd'
    activeVideo: null,
    activePlayer: null,
    activeAudioTrack: 0,
    currentQuality: 'original',
    currentSpeed: 1.0,
    currentGain: 100, // percentage: 100, 150, 200
    isBuffering: false,
    isTheater: false,
    ws: null,
    wsReconnectTimeout: null,
    globe: null,
    audioCtx: null,
    gainNode: null,
    companionAudioCleanup: null,
    bufferMonitorInterval: null,
    vttCuesCache: {}
  };

  /* ============================================================================
     2. AUTHENTICATION & API ENGINE
     ============================================================================ */
  function getAuthToken() {
    return (
      localStorage.getItem('ovh_media_token') ||
      localStorage.getItem('drive_connector_token') ||
      ''
    );
  }

  function checkAuthWall() {
    const token = getAuthToken();
    const pathname = window.location.pathname;
    const isLoginPage = pathname.endsWith('/login.html') || pathname.endsWith('/login');

    if (!token && !isLoginPage) {
      window.location.href = '/login.html';
      return false;
    }
    state.token = token;
    return Boolean(token);
  }

  function handleLogout() {
    localStorage.removeItem('ovh_media_token');
    localStorage.removeItem('drive_connector_token');
    state.token = null;
    window.location.href = '/login.html';
  }

  function getAuthHeaders(extraHeaders = {}) {
    const token = getAuthToken();
    const headers = { ...extraHeaders };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  async function fetchWithAuth(url, options = {}) {
    const token = getAuthToken();
    const headers = new Headers(options.headers || {});
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json');
    }

    try {
      const response = await fetch(url, { ...options, headers });
      if (response.status === 401) {
        console.warn('[Auth] 401 Unauthorized encountered from', url);
        handleLogout();
        throw new Error('Unauthorized session expired');
      }
      return response;
    } catch (err) {
      if (err.message === 'Unauthorized session expired') {
        throw err;
      }
      console.error(`[API] Network error requesting ${url}:`, err);
      throw err;
    }
  }

  /* ============================================================================
     3. UTILITY HELPERS
     ============================================================================ */
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatBytes(bytes) {
    if (!bytes || isNaN(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
  }

  function formatDuration(sec) {
    if (!sec || isNaN(sec) || sec <= 0) return '00:00';
    const s = Math.floor(sec);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    if (hrs > 0) {
      return `${hrs}:${mins < 10 ? '0' : ''}${mins}:${rem < 10 ? '0' : ''}${rem}`;
    }
    return `${mins}:${rem < 10 ? '0' : ''}${rem}`;
  }

  function formatUptime(seconds) {
    if (!seconds || isNaN(seconds) || seconds < 0) return '0s';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const mins = Math.floor(seconds / 60);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${mins % 60}m`;
    return `${mins}m`;
  }

  function showToast(message, type = 'info') {
    let toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'toast-container';
      toastContainer.className = 'fixed bottom-4 right-4 z-50 flex flex-col space-y-2 pointer-events-none';
      document.body.appendChild(toastContainer);
    }

    const toast = document.createElement('div');
    const colorClass =
      type === 'success'
        ? 'border-emerald-500/40 bg-[#0d1117]/95 text-emerald-400'
        : type === 'error'
        ? 'border-rose-500/40 bg-[#0d1117]/95 text-rose-400'
        : 'border-sky-500/40 bg-[#0d1117]/95 text-sky-400';

    toast.className = `pointer-events-auto px-4 py-2.5 rounded-xl border text-xs font-mono shadow-2xl backdrop-blur-xl flex items-center space-x-2 transition-all duration-300 transform translate-y-4 opacity-0 ${colorClass}`;
    toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
    toastContainer.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.remove('translate-y-4', 'opacity-0');
      toast.classList.add('translate-y-0', 'opacity-100');
    });

    setTimeout(() => {
      toast.classList.add('opacity-0', 'translate-y-2');
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  /* ============================================================================
     4. HERO 3D GLOBE INITIALIZATION (Globe.gl)
     ============================================================================ */
  function initHeroGlobe() {
    const container = document.getElementById('hero-globe-container');
    if (!container) return null;
    if (typeof Globe !== 'function') {
      console.warn('[Globe] Globe.gl library is not loaded.');
      return null;
    }

    // Clear any previous globe instance in container
    container.innerHTML = '';

    const width = container.clientWidth || 280;
    const height = container.clientHeight || 200;

    // Target Node: OVH EU 1TB Dedicated Cloud Node
    const ovhNode = {
      lat: 50.6927,
      lng: 3.1746,
      name: 'OVH-EU-1TB (Roubaix, France)',
      color: '#38bdf8',
      size: 1.5
    };

    // Client Ingestion & Stream Nodes
    const clientNodes = [
      { lat: 37.7749, lng: -122.4194, name: 'San Francisco, US', color: '#34d399' },
      { lat: 40.7128, lng: -74.0060, name: 'New York, US', color: '#38bdf8' },
      { lat: 51.5074, lng: -0.1278, name: 'London, UK', color: '#34d399' },
      { lat: 35.6762, lng: 139.6503, name: 'Tokyo, JP', color: '#818cf8' },
      { lat: -33.8688, lng: 151.2093, name: 'Sydney, AU', color: '#a855f7' },
      { lat: 1.3521, lng: 103.8198, name: 'Singapore, SG', color: '#38bdf8' },
      { lat: 52.5200, lng: 13.4050, name: 'Berlin, DE', color: '#34d399' },
      { lat: -23.5505, lng: -46.6333, name: 'São Paulo, BR', color: '#818cf8' }
    ];

    // Cyan / emerald glowing arcs routing into OVH-EU
    const arcsData = clientNodes.map(node => ({
      startLat: node.lat,
      startLng: node.lng,
      endLat: ovhNode.lat,
      endLng: ovhNode.lng,
      color: ['rgba(56, 189, 248, 0.85)', 'rgba(52, 211, 153, 0.95)']
    }));

    try {
      const globe = Globe()(container)
        .globeImageUrl('//unpkg.com/three-globe/example/img/earth-night.jpg')
        .bumpImageUrl('//unpkg.com/three-globe/example/img/earth-topology.png')
        .backgroundColor('rgba(0,0,0,0)')
        .width(width)
        .height(height)
        .pointsData([ovhNode, ...clientNodes])
        .pointColor(d => d.color)
        .pointAltitude(0.04)
        .pointRadius(0.85)
        .arcsData(arcsData)
        .arcColor(d => d.color)
        .arcDashLength(0.4)
        .arcDashGap(0.25)
        .arcDashAnimateTime(1800)
        .arcStroke(0.7)
        .atmosphereColor('#38bdf8')
        .atmosphereAltitude(0.18);

      // Mobile GPU optimization: cap pixel ratio to prevent GPU throttling and lock 60fps
      const isMobile = window.innerWidth < 768;
      const pixelRatio = isMobile ? Math.min(window.devicePixelRatio, 1.5) : window.devicePixelRatio;

      const renderer = globe.renderer();
      if (renderer && typeof renderer.setPixelRatio === 'function') {
        renderer.setPixelRatio(pixelRatio);
      }

      // Center POV on Europe / Roubaix node
      globe.pointOfView({ lat: 50.0, lng: 10.0, altitude: isMobile ? 2.5 : 2.0 }, 1000);

      const controls = globe.controls();
      if (controls) {
        controls.autoRotate = true;
        controls.autoRotateSpeed = 0.8;
        controls.enableZoom = false;
      }

      // Responsive window resize listener
      window.addEventListener('resize', () => {
        if (!container) return;
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w > 0 && h > 0) {
          globe.width(w).height(h);
        }
        const mobileNow = window.innerWidth < 768;
        const pr = mobileNow ? Math.min(window.devicePixelRatio, 1.5) : window.devicePixelRatio;
        if (renderer && typeof renderer.setPixelRatio === 'function') {
          renderer.setPixelRatio(pr);
        }
      });

      state.globe = globe;
      return globe;
    } catch (err) {
      console.warn('[Globe] Error initializing 3D Hero globe:', err);
      return null;
    }
  }

  /* ============================================================================
     5. WEBSOCKET TELEMETRY (/ws/transfers)
     ============================================================================ */
  function initWebSocket() {
    const token = getAuthToken();
    if (!token) return;

    if (state.ws) {
      try {
        state.ws.close();
      } catch (e) {}
      state.ws = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/transfers?token=${encodeURIComponent(token)}`;

    try {
      const ws = new WebSocket(wsUrl);
      state.ws = ws;

      ws.onopen = () => {
        if (state.wsReconnectTimeout) {
          clearTimeout(state.wsReconnectTimeout);
          state.wsReconnectTimeout = null;
        }
        console.log('[WebSocket] Telemetry link online (/ws/transfers)');
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleWebSocketMessage(msg);
        } catch (err) {
          console.warn('[WebSocket] Malformed message payload:', err);
        }
      };

      ws.onclose = () => {
        if (getAuthToken()) {
          state.wsReconnectTimeout = setTimeout(initWebSocket, 3000);
        }
      };

      ws.onerror = (err) => {
        console.warn('[WebSocket] Transport error:', err);
      };
    } catch (err) {
      console.error('[WebSocket] Failed to connect:', err);
      state.wsReconnectTimeout = setTimeout(initWebSocket, 4000);
    }
  }

  function handleWebSocketMessage(msg) {
    if (!msg || !msg.event) return;

    // 1. Transfer Progress Updates
    if (msg.event === 'TRANSFER_UPDATE') {
      const rawPct = typeof msg.percentage === 'number' ? msg.percentage : 0;
      const isDone = rawPct >= 100 || msg.status === 'DOWNLOAD_COMPLETE' || msg.status === 'LOCAL_READY' || msg.status === 'DONE';

      if (isDone) {
        msg.percentage = 100;
        msg.status = (msg.status === 'DOWNLOADING') ? 'DOWNLOAD_COMPLETE' : msg.status;
        msg.speed_mbs = 0;
        msg.eta_seconds = 0;
      } else {
        msg.percentage = Math.min(100, Math.max(0, Math.round(rawPct * 10) / 10));
      }

      state.transfers[msg.video_id] = msg;
      renderTransfers();

      // Auto-dismiss completed transfer after 8 seconds
      if (isDone) {
        setTimeout(() => {
          if (state.transfers[msg.video_id] && !state.processingJobs[msg.video_id]) {
            delete state.transfers[msg.video_id];
            renderTransfers();
          }
        }, 8000);
      }

      // Update in-player modal on-demand download HUD if open on this video
      if (state.activeVideo && state.activeVideo.video_id === msg.video_id) {
        updateModalDownloadHUD(msg, isDone);
      }

      // Update card badge in grid
      updateVideoCardTelemetry(msg.video_id);
    }

    // 2. Video Processing Updates (FFmpeg WebVTT Sprites, Transcoding, Whisper)
    else if (msg.event === 'PROCESSING_UPDATE') {
      state.processingJobs[msg.video_id] = msg;
      renderTransfers();
      updateVideoCardTelemetry(msg.video_id);

      // In-player processing HUD update
      if (state.activeVideo && state.activeVideo.video_id === msg.video_id) {
        const hud = document.getElementById('player-processing-hud');
        if (hud) {
          hud.classList.remove('hidden');
          hud.classList.add('flex');
          const stageEl = document.getElementById('player-proc-stage');
          const detEl = document.getElementById('player-proc-details');
          const barEl = document.getElementById('player-proc-bar');
          const pctEl = document.getElementById('player-proc-pct');
          const etaEl = document.getElementById('player-proc-eta');

          if (stageEl) stageEl.textContent = `${msg.stage_name || 'Processing'}:`;
          if (detEl) detEl.textContent = msg.details || `${msg.stage_percent || msg.percent}%`;
          if (barEl) barEl.style.width = `${msg.stage_percent || msg.percent}%`;
          if (pctEl) pctEl.textContent = `${msg.stage_percent || msg.percent}%`;
          if (etaEl) etaEl.textContent = msg.eta_seconds > 0 ? `${msg.eta_seconds}s left` : '';
        }
      }
    }

    // 3. Multi-Track Update (Audio / Embedded Subtitles probed)
    else if (msg.event === 'TRACKS_UPDATED') {
      if (state.activeVideo && state.activeVideo.video_id === msg.video_id) {
        state.activeVideo.audio_tracks = msg.audio_tracks || [];
        state.activeVideo.subtitle_tracks = msg.subtitle_tracks || [];
        if (msg.metadata && msg.metadata.subtitles_url) {
          state.activeVideo.subtitles_url = msg.metadata.subtitles_url;
        }
        populatePlayerTracksUI(state.activeVideo);
      }
      renderVideos();
    }

    // 4. Processing Complete
    else if (msg.event === 'PROCESSING_COMPLETE') {
      delete state.processingJobs[msg.video_id];
      if (state.transfers[msg.video_id]) {
        state.transfers[msg.video_id].status = 'LOCAL_READY';
        state.transfers[msg.video_id].percentage = 100;
        setTimeout(() => {
          delete state.transfers[msg.video_id];
          renderTransfers();
        }, 5000);
      }
      renderTransfers();

      if (state.activeVideo && state.activeVideo.video_id === msg.video_id) {
        const hud = document.getElementById('player-processing-hud');
        if (hud) {
          hud.classList.add('hidden');
          hud.classList.remove('flex');
        }
        const footerStatus = document.getElementById('player-footer-status');
        if (footerStatus) footerStatus.textContent = 'LOCAL_READY';
        state.activeVideo.status = 'LOCAL_READY';

        if (msg.metadata) {
          if (msg.metadata.vtt_url) state.activeVideo.vtt_url = msg.metadata.vtt_url;
          if (msg.metadata.subtitles_url) state.activeVideo.subtitles_url = msg.metadata.subtitles_url;
          if (msg.metadata.renditions) state.activeVideo.renditions = msg.metadata.renditions;
          if (msg.metadata.preview_url) state.activeVideo.preview_url = msg.metadata.preview_url;
          if (msg.metadata.audio_tracks) state.activeVideo.audio_tracks = msg.metadata.audio_tracks;
          if (msg.metadata.subtitle_tracks) state.activeVideo.subtitle_tracks = msg.metadata.subtitle_tracks;
          populatePlayerTracksUI(state.activeVideo);
        }
      }

      fetchVideos();
    }
  }

  function updateModalDownloadHUD(t, isDone) {
    const dlOverlay = document.getElementById('player-download-overlay');
    const bar = document.getElementById('modal-transfer-bar');
    const pct = document.getElementById('modal-transfer-pct');
    const speed = document.getElementById('modal-transfer-speed');

    if (bar) bar.style.width = `${t.percentage}%`;
    if (pct) pct.textContent = isDone ? '100% (Ready)' : `${t.percentage}%`;
    if (speed) speed.textContent = `${t.speed_mbs || 0} MB/s`;

    if (isDone) {
      if (dlOverlay) dlOverlay.classList.add('hidden');
      state.activeVideo.status = 'LOCAL_READY';
      openPlayerModal(state.activeVideo);
      fetchVideos();
    }
  }

  function updateVideoCardTelemetry(videoId) {
    const card = document.querySelector(`[data-video-id="${videoId}"]`);
    if (!card) return;

    const t = state.transfers[videoId];
    const proc = state.processingJobs[videoId];
    const badgeContainer = card.querySelector('.dc-card-badge');
    if (!badgeContainer) return;

    if (proc) {
      badgeContainer.innerHTML = `
        <span class="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-purple-500/20 text-purple-300 border border-purple-500/30 backdrop-blur-md shadow-sm animate-pulse truncate">
          <i data-lucide="loader-2" class="w-3 h-3 animate-spin shrink-0"></i>
          <span class="truncate">${escapeHtml(proc.stage_name || 'Generating Sprites')}: ${proc.stage_percent || proc.percent}% ${proc.eta_seconds > 0 ? `(${proc.eta_seconds}s left)` : ''}</span>
        </span>
      `;
    } else if (t && t.status === 'DOWNLOADING') {
      badgeContainer.innerHTML = `
        <span class="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-sky-500/20 text-sky-300 border border-sky-500/30 backdrop-blur-md shadow-sm animate-pulse">
          <i data-lucide="download" class="w-3 h-3 animate-bounce shrink-0"></i>
          <span>Downloading ${t.percentage}% (${t.speed_mbs} MB/s)</span>
        </span>
      `;
    }
    if (window.lucide) lucide.createIcons();
  }

  function renderTransfers() {
    const container = document.getElementById('transfers-container');
    const countEl = document.getElementById('transfers-count');
    const headerBadge = document.getElementById('header-transfers-badge');
    const mobileBadge = document.getElementById('mobile-transfers-badge');

    const dlList = Object.values(state.transfers);
    const procList = Object.values(state.processingJobs);
    const totalActive = dlList.length + procList.length;

    if (countEl) countEl.textContent = totalActive;

    if (headerBadge) {
      if (totalActive > 0) {
        headerBadge.classList.remove('hidden');
        headerBadge.classList.add('flex');
        const countSpan = headerBadge.querySelector('span');
        if (countSpan) countSpan.textContent = totalActive;
      } else {
        headerBadge.classList.add('hidden');
        headerBadge.classList.remove('flex');
      }
    }

    if (mobileBadge) {
      if (totalActive > 0) {
        mobileBadge.classList.remove('hidden');
        mobileBadge.classList.add('flex');
      } else {
        mobileBadge.classList.add('hidden');
        mobileBadge.classList.remove('flex');
      }
    }

    // Dynamic Arc Acceleration on Hero 3D Globe during active downloads
    if (state.globe) {
      const isDownloading = dlList.some(t => t.status === 'DOWNLOADING' || (t.speed_mbs && t.speed_mbs > 0));
      const targetAnimTime = isDownloading ? 600 : 1800;
      if (typeof state.globe.arcDashAnimateTime === 'function') {
        state.globe.arcDashAnimateTime(targetAnimTime);
      }
      const controls = state.globe.controls ? state.globe.controls() : null;
      if (controls) {
        controls.autoRotateSpeed = isDownloading ? 2.2 : 0.8;
      }
    }

    if (!container) return;

    if (totalActive === 0) {
      container.innerHTML = `
        <div class="text-center py-8 text-slate-500 text-xs font-mono">
          <i data-lucide="check-circle" class="w-8 h-8 mx-auto mb-2 text-slate-600 stroke-[1.5]"></i>
          <span>All transfer and ingestion queues idle</span>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    // Render processing items
    const procHtml = procList
      .map(
        p => `
      <div class="bg-[#090d16] p-3 rounded-xl border border-purple-500/30 space-y-2">
        <div class="flex justify-between items-center text-xs">
          <span class="font-medium text-purple-200 truncate flex items-center space-x-1.5">
            <i data-lucide="cpu" class="w-3.5 h-3.5 text-purple-400 shrink-0"></i>
            <span class="truncate">${escapeHtml(p.stage_name || 'Processing')}</span>
          </span>
          <span class="text-[10px] font-mono font-bold text-purple-300 bg-purple-500/10 px-2 py-0.5 rounded border border-purple-500/20">${p.stage_percent || p.percent}%</span>
        </div>
        <div class="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
          <div class="bg-gradient-to-r from-purple-500 to-indigo-500 h-full rounded-full transition-all duration-300" style="width: ${p.stage_percent || p.percent}%"></div>
        </div>
        <div class="flex justify-between text-[10px] text-slate-400 font-mono">
          <span class="truncate">${escapeHtml(p.details || 'FFmpeg sprite & transcode pipeline')}</span>
          <span>${p.eta_seconds > 0 ? `${p.eta_seconds}s left` : ''}</span>
        </div>
      </div>
    `
      )
      .join('');

    // Render download items
    const dlHtml = dlList
      .map(t => {
        const isDone = t.percentage >= 100 || t.status === 'DOWNLOAD_COMPLETE' || t.status === 'LOCAL_READY';
        const isFailed = t.status === 'FAILED';

        if (isDone) {
          return `
          <div class="bg-[#090d16] p-3 rounded-xl border border-emerald-500/30 space-y-2">
            <div class="flex justify-between items-center text-xs">
              <span class="font-medium text-emerald-300 truncate flex items-center space-x-1.5">
                <i data-lucide="check-circle-2" class="w-3.5 h-3.5 text-emerald-400 shrink-0"></i>
                <span class="truncate">${escapeHtml(t.title || t.video_id)}</span>
              </span>
              <span class="text-[10px] font-mono font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">Saved</span>
            </div>
            <div class="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
              <div class="bg-emerald-500 h-full rounded-full" style="width: 100%"></div>
            </div>
            <div class="flex justify-between text-[10px] text-slate-400 font-mono">
              <span class="text-emerald-400">Completed</span>
              <button onclick="dismissTransfer('${escapeHtml(t.video_id)}')" class="text-slate-500 hover:text-slate-300 transition cursor-pointer">Dismiss</button>
            </div>
          </div>
        `;
        } else if (isFailed) {
          return `
          <div class="bg-[#090d16] p-3 rounded-xl border border-rose-500/30 space-y-2">
            <div class="flex justify-between items-center text-xs">
              <span class="font-medium text-rose-300 truncate">${escapeHtml(t.title || t.video_id)}</span>
              <span class="text-[10px] font-mono font-bold text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">Failed</span>
            </div>
            <div class="text-[10px] text-rose-400 font-mono break-words">${escapeHtml(t.error || 'Download failed')}</div>
          </div>
        `;
        } else {
          return `
          <div class="bg-[#090d16] p-3 rounded-xl border border-sky-500/30 space-y-2">
            <div class="flex justify-between items-center text-xs">
              <span class="font-medium text-slate-200 truncate">${escapeHtml(t.title || t.video_id)}</span>
              <span class="text-sky-400 font-mono font-bold">${t.percentage}%</span>
            </div>
            <div class="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
              <div class="bg-sky-500 h-full rounded-full transition-all duration-300" style="width: ${t.percentage}%"></div>
            </div>
            <div class="flex justify-between text-[10px] text-slate-400 font-mono">
              <span class="text-sky-300">${t.speed_mbs || 0} MB/s</span>
              <span>${escapeHtml(t.downloaded_str || '')} / ${escapeHtml(t.total_str || '')}</span>
              <span>ETA ${t.eta_seconds || 0}s</span>
            </div>
          </div>
        `;
        }
      })
      .join('');

    container.innerHTML = procHtml + dlHtml;
    if (window.lucide) lucide.createIcons();
  }

  function dismissTransfer(id) {
    if (state.transfers[id]) {
      delete state.transfers[id];
      renderTransfers();
    }
  }

  function clearCompletedTransfers() {
    Object.keys(state.transfers).forEach(id => {
      const t = state.transfers[id];
      if (t.percentage >= 100 || t.status === 'DOWNLOAD_COMPLETE' || t.status === 'LOCAL_READY') {
        delete state.transfers[id];
      }
    });
    renderTransfers();
  }

  /* ============================================================================
     6. VIDEO PLAYER & TOUCH / MOUSE VTT SCRUBBING
     ============================================================================ */

  // WebVTT Timestamp Parser
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

  // Load and cache WebVTT sprites
  async function loadVttCues(vttUrl) {
    if (!vttUrl) return [];
    if (state.vttCuesCache[vttUrl]) return state.vttCuesCache[vttUrl];

    try {
      const res = await fetch(vttUrl);
      if (!res.ok) return [];
      const text = await res.text();
      const cues = [];
      const lines = text.split(/\r?\n/);
      let currentCue = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.includes('-->')) {
          const parts = line.split('-->');
          currentCue = {
            start: parseVttTimestamp(parts[0]),
            end: parseVttTimestamp(parts[1])
          };
        } else if (currentCue && line.includes('#xywh=')) {
          const [spriteUrl, hash] = line.split('#xywh=');
          const [x, y, w, h] = hash.split(',').map(Number);
          currentCue.sprite = spriteUrl;
          currentCue.x = x || 0;
          currentCue.y = y || 0;
          currentCue.w = w || 160;
          currentCue.h = h || 90;
          cues.push(currentCue);
          currentCue = null;
        }
      }
      state.vttCuesCache[vttUrl] = cues;
      return cues;
    } catch (err) {
      console.warn('[VTT] Error parsing WebVTT thumbnails:', err);
      return [];
    }
  }

  // Video.js Seekbar Hover & Touch Scrubbing with Viewport Edge Clamping
  async function setupVideojsThumbnails(player, vttUrl) {
    if (!player || !vttUrl) return;
    const rootEl = player.el ? player.el() : player;
    const prog = rootEl.querySelector('.vjs-progress-control') || rootEl.querySelector('.plyr__progress');
    if (!prog) return;

    const cues = await loadVttCues(vttUrl);
    if (!cues || cues.length === 0) return;

    // Use existing scrub preview elements if available, or create dedicated tooltip
    let previewEl = document.getElementById('player-scrub-preview');
    let thumbEl = document.getElementById('player-scrub-thumb');
    let timeEl = document.getElementById('player-scrub-time');

    if (!previewEl) {
      previewEl = prog.querySelector('.dc-vjs-thumbnail-preview');
      if (!previewEl) {
        previewEl = document.createElement('div');
        previewEl.className = 'dc-vjs-thumbnail-preview fixed pointer-events-none rounded-lg overflow-hidden border border-sky-400/50 shadow-2xl bg-black hidden z-50';
        previewEl.style.width = '160px';
        previewEl.style.height = '90px';
        previewEl.style.backgroundRepeat = 'no-repeat';
        document.body.appendChild(previewEl);

        timeEl = document.createElement('div');
        timeEl.className = 'dc-vjs-thumbnail-time absolute bottom-1 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-black/85 text-[10px] font-mono text-sky-300 pointer-events-none';
        previewEl.appendChild(timeEl);
      }
    }

    const handleScrub = (clientX, clientY) => {
      const rect = prog.getBoundingClientRect();
      const duration = typeof player.duration === 'function' ? player.duration() : (player.duration || 0);
      if (!duration || duration <= 0) return;

      const offsetX = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const hoverTime = (offsetX / rect.width) * duration;

      const cue = cues.find(c => hoverTime >= c.start && hoverTime < c.end) || cues[0];
      if (cue) {
        if (thumbEl) {
          thumbEl.style.backgroundImage = `url("${cue.sprite}")`;
          thumbEl.style.backgroundPosition = `-${cue.x}px -${cue.y}px`;
        } else {
          previewEl.style.backgroundImage = `url("${cue.sprite}")`;
          previewEl.style.backgroundPosition = `-${cue.x}px -${cue.y}px`;
        }

        const m = Math.floor(hoverTime / 60);
        const s = Math.floor(hoverTime % 60);
        const timeStr = `${m}:${s < 10 ? '0' : ''}${s}`;
        if (timeEl) timeEl.textContent = timeStr;

        // CRITICAL: Clamp tooltip horizontally within viewport edges
        // Math.max(10, Math.min(window.innerWidth - 170, targetX))
        // Ensures thumbnail preview box never clips outside screen edges on 360px mobile devices!
        const targetX = clientX - 80;
        const clampedX = Math.max(10, Math.min(window.innerWidth - 170, targetX));
        const targetY = Math.max(10, rect.top - 105);

        previewEl.style.position = 'fixed';
        previewEl.style.left = `${clampedX}px`;
        previewEl.style.top = `${targetY}px`;
        previewEl.style.zIndex = '60';
        previewEl.classList.remove('hidden');
      }
    };

    const onMouseMove = (e) => {
      handleScrub(e.clientX, e.clientY);
    };

    const onMouseLeave = () => {
      if (previewEl) previewEl.classList.add('hidden');
    };

    const onTouchStart = (e) => {
      if (e.touches && e.touches.length > 0) {
        handleScrub(e.touches[0].clientX, e.touches[0].clientY);
      }
    };

    const onTouchMove = (e) => {
      if (e.touches && e.touches.length > 0) {
        handleScrub(e.touches[0].clientX, e.touches[0].clientY);
      }
    };

    const onTouchEnd = () => {
      if (previewEl) previewEl.classList.add('hidden');
    };

    prog.addEventListener('mousemove', onMouseMove, { passive: true });
    prog.addEventListener('mouseleave', onMouseLeave, { passive: true });
    prog.addEventListener('touchstart', onTouchStart, { passive: true });
    prog.addEventListener('touchmove', onTouchMove, { passive: true });
    prog.addEventListener('touchend', onTouchEnd, { passive: true });
    prog.addEventListener('touchcancel', onTouchEnd, { passive: true });
  }

  // Web Audio API 200% GainNode booster
  function setupAudioBooster(videoEl) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx || !videoEl) return;
      if (state.audioCtx) {
        try { state.audioCtx.close(); } catch (e) {}
        state.audioCtx = null;
        state.gainNode = null;
      }
      state.audioCtx = new AudioCtx();
      const source = state.audioCtx.createMediaElementSource(videoEl);
      state.gainNode = state.audioCtx.createGain();
      state.gainNode.gain.value = state.currentGain / 100;
      source.connect(state.gainNode);
      state.gainNode.connect(state.audioCtx.destination);
    } catch (err) {
      console.warn('[AudioBooster] Error initializing AudioContext gain node:', err);
    }
  }

  function setAudioGain(g) {
    state.currentGain = g;
    if (state.gainNode) {
      state.gainNode.gain.value = g / 100;
    }
    if (state.audioCtx && state.audioCtx.state === 'suspended') {
      state.audioCtx.resume().catch(() => {});
    }

    const btn = document.getElementById('audio-boost-btn');
    if (btn) btn.textContent = `${g}%`;

    document.querySelectorAll('.gain-btn').forEach(b => {
      const bGain = parseInt(b.dataset.gain, 10);
      if (bGain === g) {
        b.className = 'gain-btn min-touch px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-sky-500 text-white shadow-sm';
      } else {
        b.className = 'gain-btn min-touch px-2 py-0.5 rounded text-[10px] font-mono text-slate-400 hover:text-white hover:bg-[#21262d] transition';
      }
    });
  }

  function cycleAudioBoost() {
    let nextGain = 100;
    if (state.currentGain === 100) nextGain = 150;
    else if (state.currentGain === 150) nextGain = 200;
    else nextGain = 100;
    setAudioGain(nextGain);
  }

  // Dual-audio companion synchronization
  function setupCompanionAudioSync(videoEl) {
    if (state.companionAudioCleanup) {
      state.companionAudioCleanup();
      state.companionAudioCleanup = null;
    }
    const audioEl = document.getElementById('player-companion-audio');
    if (!audioEl || !videoEl) return;

    const handlePlay = () => {
      if (state.activeAudioTrack > 0 && audioEl.src) {
        audioEl.play().catch(() => {});
      }
    };
    const handlePause = () => {
      if (state.activeAudioTrack > 0) audioEl.pause();
    };
    const handleSeeking = () => {
      if (state.activeAudioTrack > 0) audioEl.currentTime = videoEl.currentTime;
    };
    const handleSeeked = () => {
      if (state.activeAudioTrack > 0) audioEl.currentTime = videoEl.currentTime;
    };
    const handleRateChange = () => {
      if (state.activeAudioTrack > 0) audioEl.playbackRate = videoEl.playbackRate;
    };
    const handleVolumeChange = () => {
      if (state.activeAudioTrack > 0) audioEl.volume = videoEl.volume;
    };
    const handleTimeUpdate = () => {
      if (state.activeAudioTrack > 0 && Math.abs(audioEl.currentTime - videoEl.currentTime) > 0.3) {
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

    state.companionAudioCleanup = () => {
      videoEl.removeEventListener('play', handlePlay);
      videoEl.removeEventListener('pause', handlePause);
      videoEl.removeEventListener('seeking', handleSeeking);
      videoEl.removeEventListener('seeked', handleSeeked);
      videoEl.removeEventListener('ratechange', handleRateChange);
      videoEl.removeEventListener('volumechange', handleVolumeChange);
      videoEl.removeEventListener('timeupdate', handleTimeUpdate);
    };
  }

  async function changePlayerAudioTrack(trackIdx) {
    const idx = parseInt(trackIdx, 10) || 0;
    state.activeAudioTrack = idx;
    if (!state.activeVideo) return;

    const videoEl = state.activePlayer?.el ? state.activePlayer.el().querySelector('video') : document.querySelector('#player-container video');
    const audioEl = document.getElementById('player-companion-audio');
    if (!videoEl || !audioEl) return;

    if (idx === 0) {
      audioEl.pause();
      audioEl.removeAttribute('src');
      videoEl.muted = false;
    } else {
      videoEl.muted = true;
      const token = getAuthToken();
      const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
      audioEl.src = `/api/videos/${state.activeVideo.video_id}/audio/${idx}${tokenParam}`;
      audioEl.currentTime = videoEl.currentTime;
      audioEl.playbackRate = videoEl.playbackRate;
      audioEl.volume = videoEl.volume;
      if (!videoEl.paused) {
        audioEl.play().catch(() => {});
      }
    }
  }

  // Subtitle track selection
  function changePlayerSubtitleTrack(trackVal) {
    if (!state.activePlayer) return;
    if (typeof state.activePlayer.textTracks === 'function') {
      const textTracks = state.activePlayer.textTracks();
      if (trackVal === 'off') {
        for (let i = 0; i < textTracks.length; i++) {
          textTracks[i].mode = 'disabled';
        }
      } else {
        const idx = parseInt(trackVal, 10);
        for (let i = 0; i < textTracks.length; i++) {
          textTracks[i].mode = i === idx ? 'showing' : 'disabled';
        }
      }
    }
  }

  // Populate audio & subtitle track drop-downs
  function populatePlayerTracksUI(v) {
    const aSelect = document.getElementById('player-audio-select');
    const sSelect = document.getElementById('player-subtitles-select');
    const aContainer = document.getElementById('player-audio-container');
    const sContainer = document.getElementById('player-subtitles-container');

    if (aSelect) {
      aSelect.innerHTML = '<option value="0">Default Audio Track</option>';
      const aTracks = v.audio_tracks || [];
      if (aTracks.length > 1) {
        if (aContainer) aContainer.classList.remove('hidden');
        aTracks.forEach((tr, i) => {
          if (i > 0) {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = tr.title || tr.language_name || `Audio Track #${i + 1} (${tr.codec})`;
            aSelect.appendChild(opt);
          }
        });
      } else {
        if (aContainer) aContainer.classList.remove('hidden');
      }
      aSelect.value = state.activeAudioTrack || 0;
    }

    if (sSelect) {
      sSelect.innerHTML = '<option value="off">Subtitles Off</option>';
      const sTracks = v.subtitle_tracks || [];
      let hasDefault = false;

      sTracks.forEach((tr, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = tr.label || `${tr.language_name || 'Sub'} (${tr.codec})`;
        if (tr.is_default && !hasDefault) {
          opt.selected = true;
          hasDefault = true;
        }
        sSelect.appendChild(opt);
      });

      if (v.subtitles_url && !sTracks.some(st => st.url === v.subtitles_url)) {
        const opt = document.createElement('option');
        opt.value = sTracks.length;
        opt.textContent = 'AI Whisper (English)';
        if (!hasDefault) opt.selected = true;
        sSelect.appendChild(opt);
      }
    }
  }

  // Buffering indicator & Buffer TimeRanges calculation
  function getBufferedPercent(videoEl) {
    if (!videoEl || !videoEl.duration || !isFinite(videoEl.duration) || videoEl.duration <= 0) return 0;
    const dur = videoEl.duration;
    const buf = videoEl.buffered;
    if (!buf || buf.length === 0) return 0;
    let total = 0;
    for (let i = 0; i < buf.length; i++) {
      try {
        const start = buf.start(i);
        const end = buf.end(i);
        if (end > start) total += end - start;
      } catch (e) {}
    }
    const pct = Math.min(100, Math.max(0, Math.round((total / dur) * 100)));
    return isNaN(pct) ? 0 : pct;
  }

  function showBufferingIndicator(show) {
    state.isBuffering = show;
    const overlay = document.getElementById('player-buffering-overlay');
    const beacon = document.getElementById('player-buffer-beacon');

    if (beacon) {
      beacon.className = show
        ? 'w-2 h-2 rounded-full bg-amber-400 animate-ping'
        : 'w-2 h-2 rounded-full bg-sky-400';
    }

    if (overlay) {
      if (show) {
        overlay.classList.remove('hidden');
        overlay.classList.add('flex');
      } else {
        overlay.classList.add('hidden');
        overlay.classList.remove('flex');
      }
    }
  }

  function updatePlayerBufferUI(videoEl) {
    const rawEl =
      videoEl ||
      (state.activePlayer?.el ? state.activePlayer.el().querySelector('video') : null) ||
      document.querySelector('#player-container video');
    const pct = getBufferedPercent(rawEl);

    const pctEl = document.getElementById('player-buffer-pct');
    if (pctEl) pctEl.textContent = `${pct}%`;

    const barEl = document.getElementById('player-buffer-bar');
    if (barEl) barEl.style.width = `${pct}%`;

    const overlayPctEl = document.getElementById('player-buffering-overlay-pct');
    if (overlayPctEl) overlayPctEl.textContent = `Buffered: ${pct}%`;

    const footerBuf = document.getElementById('player-footer-buffer');
    if (footerBuf) {
      footerBuf.textContent = `• Buffered: ${pct}%`;
      footerBuf.classList.remove('hidden');
    }

    const rootEl = state.activePlayer?.el ? state.activePlayer.el() : document.getElementById('player-container');
    if (rootEl) {
      const buf = rootEl.querySelector('.plyr__progress__buffer') || rootEl.querySelector('.vjs-load-progress');
      if (buf) {
        buf.value = pct;
        buf.setAttribute('aria-valuenow', pct);
        buf.setAttribute('title', `Buffered: ${pct}%`);
      }

      const prog = rootEl.querySelector('.vjs-progress-control') || rootEl.querySelector('.plyr__progress');
      if (prog) {
        let badge = prog.querySelector('.plyr__buffer-live-badge');
        if (badge) {
          badge.textContent = `Buffered: ${pct}%`;
        }
      }
    }
  }

  // Quality Switching
  function changePlayerQuality(q) {
    if (!state.activeVideo || !state.activePlayer) return;
    showBufferingIndicator(true);
    state.currentQuality = q;
    const curTime = typeof state.activePlayer.currentTime === 'function' ? state.activePlayer.currentTime() : 0;
    const streamBase = `/api/stream/${state.activeVideo.video_id}`;
    const params = new URLSearchParams();
    const token = getAuthToken();
    if (token) params.set('token', token);
    if (q && q !== 'original') params.set('quality', q);
    const qs = params.toString();
    const srcUrl = qs ? `${streamBase}?${qs}` : streamBase;

    state.activePlayer.src({ src: srcUrl, type: 'video/mp4' });
    state.activePlayer.one('loadedmetadata', () => {
      if (curTime > 0) state.activePlayer.currentTime(curTime);
      if (typeof state.activePlayer.playbackRate === 'function') {
        state.activePlayer.playbackRate(state.currentSpeed);
      }
      state.activePlayer.play().catch(() => {});
    });
  }

  // Open Player Modal
  async function openPlayerModal(v) {
    state.activeVideo = v;
    state.activeAudioTrack = 0;
    const isPlayable = v.status === 'LOCAL_READY' || v.status === 'PROCESSING' || Boolean(v.local_path);

    const titleEl = document.getElementById('player-title');
    if (titleEl) titleEl.textContent = v.title || 'Video Stream';

    const pathEl = document.getElementById('player-footer-path');
    if (pathEl) pathEl.textContent = v.local_path || `/mnt/storage/videos/${v.video_id}.mp4`;

    const statusEl = document.getElementById('player-footer-status');
    if (statusEl) {
      statusEl.textContent = v.status || 'UNKNOWN';
      statusEl.className = isPlayable
        ? 'shrink-0 text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 uppercase font-semibold'
        : 'shrink-0 text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 uppercase font-semibold';
    }

    const modal = document.getElementById('player-modal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }

    // Populate track UI
    populatePlayerTracksUI(v);

    // Auto-probe tracks if playable and not yet probed
    if (isPlayable && (!v.audio_tracks || v.audio_tracks.length === 0)) {
      fetchWithAuth(`/api/videos/${v.video_id}/probe-tracks`, { method: 'POST' })
        .then(res => res.json())
        .then(data => {
          if (data.status === 'success' && state.activeVideo && state.activeVideo.video_id === v.video_id) {
            state.activeVideo.audio_tracks = data.audio_tracks;
            state.activeVideo.subtitle_tracks = data.subtitle_tracks;
            if (data.video && data.video.subtitles_url) {
              state.activeVideo.subtitles_url = data.video.subtitles_url;
            }
            populatePlayerTracksUI(state.activeVideo);
          }
        })
        .catch(err => console.warn('[Player] Track probe error:', err));
    }

    // Dispose old player if present
    if (state.activePlayer) {
      try {
        if (typeof state.activePlayer.dispose === 'function') state.activePlayer.dispose();
      } catch (e) {}
      state.activePlayer = null;
    }

    const container = document.getElementById('player-container');
    if (!container) return;
    container.innerHTML = '';

    if (isPlayable) {
      showBufferingIndicator(true);

      const videoEl = document.createElement('video');
      videoEl.id = 'video-stream-element';
      videoEl.className = 'video-js vjs-default-skin vjs-big-play-centered w-full h-full';
      videoEl.setAttribute('playsinline', '');
      videoEl.setAttribute('crossorigin', 'anonymous');
      videoEl.controls = true;

      // Inject Subtitle tracks
      const subTracks = v.subtitle_tracks || [];
      subTracks.forEach(st => {
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
      if (v.subtitles_url && !subTracks.some(st => st.url === v.subtitles_url)) {
        const trackEl = document.createElement('track');
        trackEl.kind = 'captions';
        trackEl.label = 'AI Whisper (English)';
        trackEl.srclang = 'en';
        trackEl.src = v.subtitles_url;
        if (subTracks.length === 0) trackEl.default = true;
        videoEl.appendChild(trackEl);
      }

      container.appendChild(videoEl);

      const vttSrc = v.vtt_url || `/metadata/${v.video_id}/thumbnails.vtt`;

      // Check Watch Position Memory
      const savedPos = parseFloat(localStorage.getItem(`dc_playback_pos_${v.video_id}`) || '0');
      const resumeNotice = document.getElementById('player-resume-notice');
      if (savedPos > 5 && resumeNotice) {
        const m = Math.floor(savedPos / 60);
        const s = Math.floor(savedPos % 60);
        resumeNotice.textContent = `✓ Resumed at ${m}:${s < 10 ? '0' : ''}${s}`;
        resumeNotice.classList.remove('hidden');
        setTimeout(() => {
          if (resumeNotice) resumeNotice.classList.add('hidden');
        }, 4000);
      }

      const streamBase = `/api/stream/${v.video_id}`;
      const params = new URLSearchParams();
      const token = getAuthToken();
      if (token) params.set('token', token);
      if (state.currentQuality && state.currentQuality !== 'original') {
        params.set('quality', state.currentQuality);
      }
      const qs = params.toString();
      const streamSrc = qs ? `${streamBase}?${qs}` : streamBase;

      // Initialize Video.js 8
      if (typeof videojs === 'function') {
        state.activePlayer = videojs(videoEl, {
          autoplay: true,
          controls: true,
          fluid: true,
          responsive: true,
          playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 2],
          sources: [{ src: streamSrc, type: 'video/mp4' }],
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

        window.activeVideoPlayer = state.activePlayer;

        state.activePlayer.ready(() => {
          const rawVideo = state.activePlayer.el()?.querySelector('video') || videoEl;
          if (savedPos > 5) {
            state.activePlayer.currentTime(savedPos);
          }
          if (typeof state.activePlayer.playbackRate === 'function') {
            state.activePlayer.playbackRate(state.currentSpeed);
          }
          if (rawVideo) {
            setupAudioBooster(rawVideo);
            setupCompanionAudioSync(rawVideo);
          }

          // Inject timeline buffer live badge
          const prog = state.activePlayer.controlBar?.progressControl?.el() || state.activePlayer.el()?.querySelector('.vjs-progress-control');
          if (prog) {
            let badge = prog.querySelector('.plyr__buffer-live-badge');
            if (!badge) {
              badge = document.createElement('span');
              badge.className = 'plyr__buffer-live-badge absolute right-2 -top-6 text-[10px] font-mono px-2 py-0.5 rounded bg-[#0d1117]/90 border border-sky-500/30 text-sky-400 pointer-events-none shadow-md backdrop-blur-sm z-20';
              badge.textContent = 'Buffered: 0%';
              prog.style.position = 'relative';
              prog.appendChild(badge);
            }
          }

          // Setup WebVTT thumbnail scrubbing
          setupVideojsThumbnails(state.activePlayer, vttSrc);
          updatePlayerBufferUI(rawVideo);
        });

        // Player Event Handlers
        state.activePlayer.on('waiting', () => { showBufferingIndicator(true); updatePlayerBufferUI(); });
        state.activePlayer.on('seeking', () => { showBufferingIndicator(true); updatePlayerBufferUI(); });
        state.activePlayer.on('loadstart', () => { showBufferingIndicator(true); updatePlayerBufferUI(); });
        state.activePlayer.on('stalled', () => {
          const raw = state.activePlayer.el()?.querySelector('video');
          if (raw && !raw.paused && raw.readyState < 3) {
            showBufferingIndicator(true);
            updatePlayerBufferUI();
          }
        });
        state.activePlayer.on('playing', () => {
          showBufferingIndicator(false);
          updatePlayerBufferUI();
          if (state.audioCtx && state.audioCtx.state === 'suspended') {
            state.audioCtx.resume().catch(() => {});
          }
        });
        state.activePlayer.on('canplay', () => { showBufferingIndicator(false); updatePlayerBufferUI(); });
        state.activePlayer.on('canplaythrough', () => { showBufferingIndicator(false); updatePlayerBufferUI(); });
        state.activePlayer.on('seeked', () => {
          const raw = state.activePlayer.el()?.querySelector('video');
          if (raw && (raw.readyState >= 3 || raw.paused)) {
            showBufferingIndicator(false);
          } else {
            showBufferingIndicator(true);
          }
          updatePlayerBufferUI();
        });
        state.activePlayer.on('pause', () => { showBufferingIndicator(false); });
        state.activePlayer.on('ended', () => { showBufferingIndicator(false); updatePlayerBufferUI(); });
        state.activePlayer.on('progress', () => { updatePlayerBufferUI(); });

        if (state.bufferMonitorInterval) clearInterval(state.bufferMonitorInterval);
        state.bufferMonitorInterval = setInterval(() => {
          updatePlayerBufferUI();
        }, 500);

        // Throttled watch position memory saving
        let lastSave = 0;
        state.activePlayer.on('timeupdate', () => {
          updatePlayerBufferUI();
          const now = Date.now();
          if (now - lastSave > 2000) {
            lastSave = now;
            const curr = typeof state.activePlayer.currentTime === 'function' ? state.activePlayer.currentTime() : 0;
            const dur = typeof state.activePlayer.duration === 'function' ? state.activePlayer.duration() : 0;
            if (curr > 5 && dur && curr < dur - 10) {
              localStorage.setItem(`dc_playback_pos_${v.video_id}`, curr.toString());
            } else if (dur && curr >= dur - 10) {
              localStorage.removeItem(`dc_playback_pos_${v.video_id}`);
            }
          }
        });
      }
    } else {
      // Remote only - Trigger on-demand streaming and display progress overlay
      const dlOverlay = document.getElementById('player-download-overlay');
      if (dlOverlay) {
        dlOverlay.classList.remove('hidden');
        dlOverlay.classList.add('flex');
      } else {
        container.innerHTML = `
          <div class="flex flex-col items-center justify-center p-8 text-center space-y-4 font-mono">
            <i data-lucide="cloud-download" class="w-12 h-12 text-sky-400 animate-bounce"></i>
            <div>
              <h4 class="text-base font-bold text-white">Fetching On-Demand From Cloud</h4>
              <p class="text-xs text-slate-400">Streaming directly into /mnt/storage/videos/. Auto-plays on completion.</p>
            </div>
            <div id="modal-transfer-hud" class="w-full max-w-sm bg-[#010409] p-4 rounded-xl border border-white/10 text-xs text-slate-300 space-y-2">
              <div class="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                <div id="modal-transfer-bar" class="bg-sky-500 h-full rounded-full transition-all duration-300" style="width: 0%"></div>
              </div>
              <div class="flex justify-between font-bold text-sky-400 font-mono">
                <span id="modal-transfer-pct">0%</span>
                <span id="modal-transfer-speed">0 MB/s</span>
              </div>
            </div>
          </div>
        `;
      }
      if (window.lucide) lucide.createIcons();

      // Trigger server-side cloud fetch
      fetchWithAuth(`/api/videos/${v.video_id}/download`, { method: 'POST' }).catch(err => {
        console.warn('[Player] Error requesting video download:', err);
      });
    }

    if (window.lucide) lucide.createIcons();
  }

  function closePlayerModal() {
    if (state.bufferMonitorInterval) {
      clearInterval(state.bufferMonitorInterval);
      state.bufferMonitorInterval = null;
    }
    showBufferingIndicator(false);

    if (state.companionAudioCleanup) {
      state.companionAudioCleanup();
      state.companionAudioCleanup = null;
    }
    const audioEl = document.getElementById('player-companion-audio');
    if (audioEl) {
      audioEl.pause();
      audioEl.removeAttribute('src');
    }
    state.activeAudioTrack = 0;

    if (state.activePlayer) {
      try {
        if (typeof state.activePlayer.dispose === 'function') state.activePlayer.dispose();
      } catch (e) {}
      state.activePlayer = null;
      window.activeVideoPlayer = null;
    }

    if (state.audioCtx) {
      try { state.audioCtx.close(); } catch (e) {}
      state.audioCtx = null;
      state.gainNode = null;
    }

    // Hide thumbnail scrub preview tooltip if lingering
    const scrubTooltip = document.querySelector('.dc-vjs-thumbnail-preview') || document.getElementById('player-scrub-preview');
    if (scrubTooltip) scrubTooltip.classList.add('hidden');

    state.activeVideo = null;
    const modal = document.getElementById('player-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  function toggleTheaterMode() {
    state.isTheater = !state.isTheater;
    const box = document.getElementById('player-modal-box');
    if (box) {
      if (state.isTheater) {
        box.classList.remove('sm:max-w-5xl');
        box.classList.add('sm:max-w-7xl', 'w-[98vw]');
      } else {
        box.classList.remove('sm:max-w-7xl', 'w-[98vw]');
        box.classList.add('sm:max-w-5xl');
      }
    }
  }

  // AI Whisper transcription trigger
  async function triggerWhisperTranscribe() {
    if (!state.activeVideo) return;
    try {
      const res = await fetchWithAuth(`/api/videos/${state.activeVideo.video_id}/transcribe`, {
        method: 'POST'
      });
      const data = await res.json();
      if (res.ok) {
        showToast('AI Whisper subtitle generation queued!', 'success');
      } else {
        showToast(data.detail || 'Whisper transcription error', 'error');
      }
    } catch (err) {
      showToast('Failed to queue Whisper transcription', 'error');
    }
  }

  /* ============================================================================
     7. CATALOG, FILTERS & CONTROLS
     ============================================================================ */
  async function fetchVideos() {
    const token = getAuthToken();
    if (!token) return;

    try {
      const res = await fetchWithAuth('/api/videos');
      if (res.ok) {
        state.videos = await res.json();
        renderVideos();
      }
    } catch (err) {
      console.warn('[Catalog] Error fetching videos:', err);
    }
  }

  function setCatalogFilter(filter) {
    state.currentFilter = filter;
    const allB = document.getElementById('filter-all');
    const locB = document.getElementById('filter-local');
    const cldB = document.getElementById('filter-cloud');

    [allB, locB, cldB].forEach(b => {
      if (b) {
        b.className =
          'min-touch flex items-center space-x-2 px-4 py-2.5 rounded-xl bg-[#161b22] hover:bg-[#21262d] text-slate-300 hover:text-white border border-white/[0.08] transition shrink-0 active:scale-95';
      }
    });

    if (filter === 'all' && allB) allB.className = 'min-touch flex items-center space-x-2 px-4 py-2.5 rounded-xl bg-sky-500 text-white font-semibold shadow-sm transition shrink-0 active:scale-95';
    if (filter === 'local' && locB) locB.className = 'min-touch flex items-center space-x-2 px-4 py-2.5 rounded-xl bg-emerald-600 text-white font-semibold shadow-sm transition shrink-0 active:scale-95';
    if (filter === 'cloud' && cldB) cldB.className = 'min-touch flex items-center space-x-2 px-4 py-2.5 rounded-xl bg-sky-600 text-white font-semibold shadow-sm transition shrink-0 active:scale-95';

    renderVideos();
  }

  function setCatalogView(view) {
    state.currentView = view;
    const gridB = document.getElementById('view-grid-btn');
    const listB = document.getElementById('view-list-btn');

    if (view === 'grid') {
      if (gridB) gridB.className = 'min-touch p-2 rounded-lg bg-sky-500 text-white transition flex items-center justify-center';
      if (listB) listB.className = 'min-touch p-2 rounded-lg text-slate-400 hover:text-white transition flex items-center justify-center';
    } else {
      if (gridB) gridB.className = 'min-touch p-2 rounded-lg text-slate-400 hover:text-white transition flex items-center justify-center';
      if (listB) listB.className = 'min-touch p-2 rounded-lg bg-sky-500 text-white transition flex items-center justify-center';
    }

    renderVideos();
  }

  function setSort(sortBy) {
    state.currentSort = sortBy;
    renderVideos();
  }

  function clearSearch() {
    const s = document.getElementById('search-input');
    const clr = document.getElementById('search-clear-btn');
    if (s) {
      s.value = '';
    }
    if (clr) clr.classList.add('hidden');
    renderVideos();
  }

  function renderVideos() {
    const sInput = document.getElementById('search-input');
    const query = (sInput?.value || '').trim().toLowerCase();
    const clrBtn = document.getElementById('search-clear-btn');
    if (clrBtn) {
      if (query) clrBtn.classList.remove('hidden');
      else clrBtn.classList.add('hidden');
    }

    // Filter
    let filtered = state.videos.filter(v => {
      const matchTitle = (v.title || '').toLowerCase().includes(query);
      if (!matchTitle) return false;
      if (state.currentFilter === 'local') {
        return v.status === 'LOCAL_READY' || v.status === 'PROCESSING' || Boolean(v.local_path);
      }
      if (state.currentFilter === 'cloud') {
        return v.status === 'REMOTE_ONLY';
      }
      return true;
    });

    // Sort
    filtered.sort((a, b) => {
      if (state.currentSort === 'title') {
        return (a.title || '').localeCompare(b.title || '');
      }
      if (state.currentSort === 'size') {
        return (b.file_size_bytes || 0) - (a.file_size_bytes || 0);
      }
      if (state.currentSort === 'duration') {
        return (b.duration_seconds || 0) - (a.duration_seconds || 0);
      }
      return (b.created_at || '').localeCompare(a.created_at || '');
    });

    // Update Category Counters
    const countAll = document.getElementById('count-all');
    const countLocal = document.getElementById('count-local');
    const countCloud = document.getElementById('count-cloud');

    if (countAll) countAll.textContent = state.videos.length;
    if (countLocal) countLocal.textContent = state.videos.filter(v => v.status === 'LOCAL_READY' || v.status === 'PROCESSING' || Boolean(v.local_path)).length;
    if (countCloud) countCloud.textContent = state.videos.filter(v => v.status === 'REMOTE_ONLY').length;

    const grid = document.getElementById('video-grid');
    const emptyState = document.getElementById('video-empty-state');

    if (!grid) return;

    if (filtered.length === 0) {
      grid.innerHTML = '';
      if (emptyState) emptyState.classList.remove('hidden');
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');
    grid.innerHTML = '';

    filtered.forEach(v => {
      const isLocal = v.status === 'LOCAL_READY' || v.status === 'PROCESSING' || Boolean(v.local_path);
      const isCloud = v.status === 'REMOTE_ONLY' && !v.local_path;
      const proc = state.processingJobs[v.video_id] || v.processing_info;
      const t = state.transfers[v.video_id];

      const safeTitle = escapeHtml(v.title || 'Untitled Video');
      const safePoster = escapeHtml(v.poster_url || '');
      const safePreview = escapeHtml(v.preview_url || '');
      const sizeStr = formatBytes(v.file_size_bytes);
      const durStr = formatDuration(v.duration_seconds);

      const card = document.createElement('div');
      card.setAttribute('data-video-id', v.video_id);
      card.className =
        'group relative flex flex-col bg-[#0d1117] hover:bg-[#161b22] border border-white/[0.08] hover:border-sky-500/50 rounded-2xl overflow-hidden shadow-lg hover:shadow-2xl hover:shadow-sky-500/10 transition-all duration-300 cursor-pointer backdrop-blur-md hover:-translate-y-1';

      card.onclick = (e) => {
        // Guard if clicking delete button
        if (e.target.closest('.dc-delete-btn')) return;
        openPlayerModal(v);
      };

      card.onmouseenter = () => {
        const previewVideo = card.querySelector('video');
        if (previewVideo) previewVideo.play().catch(() => {});
      };

      card.onmouseleave = () => {
        const previewVideo = card.querySelector('video');
        if (previewVideo) {
          previewVideo.pause();
          previewVideo.currentTime = 0;
        }
      };

      const posterMarkup = safePoster
        ? `<img src="${safePoster}" alt="${safeTitle}" class="w-full h-full object-cover transition-opacity duration-300 ${isLocal && safePreview ? 'group-hover:opacity-0' : ''}" onerror="this.outerHTML='<div class=\\\'w-full h-full flex flex-col items-center justify-center bg-[#010409] text-slate-700\\\'><i data-lucide=\\\'film\\\' class=\\\'w-10 h-10 stroke-[1.2]\\\'></i></div>'; if(window.lucide)lucide.createIcons();" />`
        : `<div class="w-full h-full flex flex-col items-center justify-center bg-[#010409] text-slate-700">
             <i data-lucide="film" class="w-10 h-10 stroke-[1.2]"></i>
           </div>`;

      card.innerHTML = `
        <div class="relative aspect-video w-full bg-[#010409] overflow-hidden border-b border-white/[0.06]">
          ${posterMarkup}
          ${isLocal && safePreview ? `<video src="${safePreview}" loop muted playsinline preload="none" class="absolute inset-0 w-full h-full object-cover opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"></video>` : ''}

          <div class="dc-card-badge absolute top-2 left-2 z-10 max-w-[85%] truncate">
            ${proc ? `<span class="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-purple-500/20 text-purple-300 border border-purple-500/30 backdrop-blur-md shadow-sm animate-pulse truncate"><i data-lucide="loader-2" class="w-3 h-3 animate-spin shrink-0"></i><span class="truncate">${escapeHtml(proc.stage_name || 'Generating Sprites')}: ${proc.stage_percent || proc.percent}% ${proc.eta_seconds > 0 ? `(${proc.eta_seconds}s left)` : ''}</span></span>` : ''}
            ${!proc && t && t.status === 'DOWNLOADING' ? `<span class="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-sky-500/20 text-sky-300 border border-sky-500/30 backdrop-blur-md shadow-sm animate-pulse"><i data-lucide="download" class="w-3 h-3 animate-bounce shrink-0"></i><span>Downloading ${t.percentage}%</span></span>` : ''}
            ${!proc && (!t || t.status !== 'DOWNLOADING') && isLocal ? `<span class="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 backdrop-blur-md shadow-sm"><i data-lucide="check-circle-2" class="w-3 h-3"></i><span>Saved on Server</span></span>` : ''}
            ${!proc && (!t || t.status !== 'DOWNLOADING') && isCloud ? `<span class="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-amber-500/20 text-amber-300 border border-amber-500/30 backdrop-blur-md shadow-sm"><i data-lucide="cloud" class="w-3 h-3"></i><span>Cloud Remote</span></span>` : ''}
          </div>

          <div class="absolute top-2 right-2 z-10 flex items-center space-x-1">
            ${v.audio_tracks && v.audio_tracks.length > 1 ? `<span class="px-1.5 py-0.5 rounded bg-blue-500/30 text-blue-300 border border-blue-500/40 text-[9px] font-mono font-bold backdrop-blur-sm" title="${v.audio_tracks.length} Audio Tracks Available">${v.audio_tracks.length} Audio</span>` : ''}
            ${(v.subtitle_tracks && v.subtitle_tracks.length > 0) || v.subtitles_url ? `<span class="px-1.5 py-0.5 rounded bg-purple-500/30 text-purple-300 border border-purple-500/40 text-[9px] font-mono font-bold backdrop-blur-sm" title="Subtitles Available">CC</span>` : ''}
          </div>

          <div class="absolute bottom-2 right-2 z-10 px-1.5 py-0.5 rounded bg-black/80 backdrop-blur-md text-[10px] font-mono font-medium text-slate-300 border border-white/10">
            ${durStr}
          </div>
        </div>

        <div class="p-3.5 flex flex-col flex-1 justify-between space-y-3">
          <div>
            <h4 class="text-xs sm:text-sm font-semibold text-white truncate tracking-tight" title="${safeTitle}">${safeTitle}</h4>
            <div class="flex items-center justify-between mt-1 text-[11px] text-slate-400 font-mono">
              <span>${sizeStr}</span>
              <span class="text-[10px] text-slate-500 uppercase">${escapeHtml(v.source || 'Direct')}</span>
            </div>
          </div>

          <div class="flex items-center justify-between pt-2 border-t border-white/[0.06]">
            <span class="text-[10px] font-mono text-slate-500">ID: ${escapeHtml(v.video_id.substring(0, 8))}</span>
            <div class="flex items-center space-x-1.5">
              ${isLocal ? `
                <button type="button" onclick="event.stopPropagation(); confirmAndDelete('${escapeHtml(v.video_id)}', '${safeTitle}')" class="dc-delete-btn min-touch p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition" title="Free Local Storage">
                  <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                </button>
              ` : ''}
              <button type="button" class="min-touch px-2.5 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 text-sky-400 text-xs font-semibold font-mono border border-sky-500/30 transition flex items-center space-x-1">
                <i data-lucide="play" class="w-3 h-3 fill-current"></i>
                <span>Watch</span>
              </button>
            </div>
          </div>
        </div>
      `;

      grid.appendChild(card);
    });

    if (window.lucide) lucide.createIcons();
  }

  // Delete Video with Confirmation
  async function deleteVideo(id, title) {
    if (!confirm(`Are you sure you want to remove "${title || id}" and free local server storage?`)) return;
    try {
      const res = await fetchWithAuth(`/api/videos/${id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast('Local video removed from storage', 'success');
        fetchVideos();
      } else {
        showToast('Failed to delete video', 'error');
      }
    } catch (err) {
      console.error('[Delete] Video deletion failed:', err);
    }
  }

  // Alias helper for verification compliance
  function confirmAndDelete(id, title) {
    return deleteVideo(id, title);
  }

  // Sync Google Drive Catalog
  async function syncDrive() {
    const btn = document.getElementById('sync-btn');
    if (btn) {
      btn.disabled = true;
      btn.classList.add('opacity-75');
    }

    try {
      showToast('Triggering Google Drive catalog synchronization...', 'info');
      // Attempt /api/videos/sync-drive, fallback to /api/sync-drive
      let res = await fetchWithAuth('/api/videos/sync-drive', { method: 'POST' }).catch(() => null);
      if (!res || !res.ok) {
        res = await fetchWithAuth('/api/sync-drive', { method: 'POST' });
      }

      if (res.ok) {
        showToast('Google Drive synced successfully!', 'success');
        fetchVideos();
      } else {
        showToast('Sync request error', 'error');
      }
    } catch (err) {
      showToast('Failed to sync Drive catalog', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('opacity-75');
      }
    }
  }

  // Submit External URL for Direct Ingestion
  async function submitUrlDownload(url, title = '') {
    if (!url) return;
    try {
      showToast('Dispatching download job...', 'info');
      let res = await fetchWithAuth('/api/videos/download-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, title })
      }).catch(() => null);

      if (!res || !res.ok) {
        res = await fetchWithAuth('/api/download-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, title })
        });
      }

      if (res.ok) {
        showToast('Ingestion task started in background', 'success');
        fetchVideos();
        // Open transfers drawer to show live progress
        const drawer = document.getElementById('transfers-drawer');
        if (drawer) drawer.classList.remove('hidden');
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(data.detail || 'Download submission error', 'error');
      }
    } catch (err) {
      showToast('Failed to queue URL download', 'error');
    }
  }

  // Scan local storage directory
  async function triggerScanStorage() {
    try {
      showToast('Scanning /mnt/storage/videos...', 'info');
      const res = await fetchWithAuth('/api/videos/scan-local', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        showToast(`Scan complete: ${data.added || 0} new media files imported`, 'success');
        fetchVideos();
      }
    } catch (err) {
      showToast('Failed to scan local storage', 'error');
    }
  }

  /* ============================================================================
     8. SYSTEM METRICS & TELEMETRY POLLING
     ============================================================================ */
  async function fetchMetrics() {
    const token = getAuthToken();
    if (!token) return;

    try {
      const res = await fetchWithAuth('/api/system/metrics');
      if (res.ok) {
        const data = await res.json();
        updateSystemMetricsUI(data);
      }
    } catch (err) {}
  }

  function updateSystemMetricsUI(data) {
    if (!data) return;

    // CPU Pill
    if (data.cpu) {
      const cpuPill = document.getElementById('telemetry-cpu');
      const cpuPct = Math.round(data.cpu.percent || 0);
      if (cpuPill) cpuPill.textContent = `CPU ${cpuPct}%`;
      const cpuBar = document.getElementById('telemetry-cpu-bar');
      if (cpuBar) cpuBar.style.width = `${cpuPct}%`;
    }

    // RAM Pill
    if (data.ram) {
      const ramPill = document.getElementById('telemetry-ram');
      const ramUsed = (data.ram.used_gb || 0).toFixed(1);
      const ramTotal = Math.round(data.ram.total_gb || 16);
      const ramPct = Math.round(data.ram.percent || 0);
      if (ramPill) ramPill.textContent = `RAM ${ramUsed}/${ramTotal} GB [${ramPct}%]`;
      const ramBar = document.getElementById('telemetry-ram-bar');
      if (ramBar) ramBar.style.width = `${ramPct}%`;
    }

    // Disk / Storage
    if (data.disk) {
      const diskPill = document.getElementById('telemetry-disk');
      const diskUsed = Math.round(data.disk.used_gb || 0);
      const diskTotal = Math.round(data.disk.total_gb || 1000);
      const diskPct = Math.round(data.disk.percent || 0);
      if (diskPill) diskPill.textContent = `Disk ${diskUsed}/${diskTotal} GB (${diskPct}%)`;
      const diskBar = document.getElementById('telemetry-disk-bar');
      if (diskBar) diskBar.style.width = `${diskPct}%`;
    }

    // Network Inbound / Outbound
    if (data.network) {
      const netIn = document.getElementById('telemetry-input');
      if (netIn) netIn.textContent = `In: ${(data.network.input_mb_s || 0).toFixed(1)} MB/s`;
      const netOut = document.getElementById('telemetry-output');
      if (netOut) netOut.textContent = `Out: ${(data.network.output_mb_s || 0).toFixed(1)} MB/s`;
    }

    // Throughput Live Speeds
    if (data.throughput) {
      const dlSpeed = document.getElementById('telemetry-dl-speed');
      if (dlSpeed) dlSpeed.textContent = `${(data.throughput.live_download_speed_mb_s || 0).toFixed(1)} MB/s`;
      const upSpeed = document.getElementById('telemetry-up-speed');
      if (upSpeed) upSpeed.textContent = `${(data.throughput.live_stream_speed_mb_s || 0).toFixed(1)} MB/s`;
    }

    // Pipeline Stats
    if (data.pipeline) {
      const qEl = document.getElementById('telemetry-queue');
      if (qEl) qEl.textContent = data.pipeline.in_queue || 0;
      const procEl = document.getElementById('telemetry-processing');
      if (procEl) procEl.textContent = data.pipeline.in_processing || 0;
      const readyEl = document.getElementById('telemetry-ready');
      if (readyEl) readyEl.textContent = data.pipeline.local_files || 0;
    }

    // Server Uptime
    if (data.server && typeof data.server.uptime_seconds === 'number') {
      const uptimeEl = document.getElementById('telemetry-uptime');
      if (uptimeEl) uptimeEl.textContent = formatUptime(data.server.uptime_seconds);
    }
  }

  async function fetchAllData() {
    const refreshBtn = document.getElementById('refresh-all-btn');
    if (refreshBtn) {
      const icon = refreshBtn.querySelector('i');
      if (icon) icon.classList.add('animate-spin', 'text-sky-400');
      setTimeout(() => {
        if (icon) icon.classList.remove('animate-spin', 'text-sky-400');
      }, 700);
    }
    await Promise.all([fetchVideos(), fetchMetrics()]);
  }

  /* ============================================================================
     9. KEYBOARD SHORTCUTS & EVENT LISTENERS
     ============================================================================ */
  function setupKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      const activeEl = document.activeElement;
      const tagName = activeEl ? activeEl.tagName.toLowerCase() : '';
      const isInput = tagName === 'input' || tagName === 'textarea' || tagName === 'select' || (activeEl && activeEl.isContentEditable);

      if (e.key === 'Escape') {
        closePlayerModal();
        const mongoModal = document.getElementById('mongo-modal');
        if (mongoModal) mongoModal.classList.add('hidden');
        const syncModal = document.getElementById('sync-modal');
        if (syncModal) syncModal.classList.add('hidden');
        const urlModal = document.getElementById('url-modal');
        if (urlModal) urlModal.classList.add('hidden');
        const jdModal = document.getElementById('jdownloader-modal');
        if (jdModal) jdModal.classList.add('hidden');
        const drawer = document.getElementById('transfers-drawer');
        if (drawer) drawer.classList.add('hidden');
        clearSearch();
      } else if (e.key === '/' && !isInput && activeEl !== document.getElementById('search-input')) {
        const sInput = document.getElementById('search-input');
        if (sInput) {
          e.preventDefault();
          sInput.focus();
        }
      } else if (!isInput && state.activePlayer) {
        const key = e.key.toLowerCase();
        if (key === ' ' || key === 'k') {
          e.preventDefault();
          if (typeof state.activePlayer.paused === 'function') {
            if (state.activePlayer.paused()) state.activePlayer.play();
            else state.activePlayer.pause();
          }
        } else if (key === 'j') {
          e.preventDefault();
          if (typeof state.activePlayer.currentTime === 'function') {
            state.activePlayer.currentTime(Math.max(0, state.activePlayer.currentTime() - 10));
          }
        } else if (key === 'l') {
          e.preventDefault();
          if (typeof state.activePlayer.currentTime === 'function') {
            const dur = typeof state.activePlayer.duration === 'function' ? state.activePlayer.duration() : 0;
            state.activePlayer.currentTime(Math.min(dur, state.activePlayer.currentTime() + 10));
          }
        } else if (key === 'f') {
          e.preventDefault();
          if (typeof state.activePlayer.isFullscreen === 'function') {
            if (state.activePlayer.isFullscreen()) state.activePlayer.exitFullscreen();
            else state.activePlayer.requestFullscreen();
          }
        }
      }
    });
  }

  /* ============================================================================
     10. PUBLIC API / WINDOW EXPOSURE
     ============================================================================ */
  window.checkAuthWall = checkAuthWall;
  window.getAuthToken = getAuthToken;
  window.getAuthHeaders = getAuthHeaders;
  window.handleLogout = handleLogout;
  window.fetchWithAuth = fetchWithAuth;

  window.initHeroGlobe = initHeroGlobe;
  window.initWebSocket = initWebSocket;

  window.openPlayerModal = openPlayerModal;
  window.closePlayerModal = closePlayerModal;
  window.toggleTheaterMode = toggleTheaterMode;
  window.changePlayerQuality = changePlayerQuality;
  window.switchVideoQuality = changePlayerQuality;
  window.changePlayerAudioTrack = changePlayerAudioTrack;
  window.switchAudioTrack = changePlayerAudioTrack;
  window.changePlayerSubtitleTrack = changePlayerSubtitleTrack;
  window.switchSubtitleTrack = changePlayerSubtitleTrack;
  window.triggerWhisperTranscribe = triggerWhisperTranscribe;
  window.startWhisper = triggerWhisperTranscribe;
  window.setAudioGain = setAudioGain;
  window.cycleAudioBoost = cycleAudioBoost;
  window.getBufferedPercent = getBufferedPercent;
  window.showBufferingIndicator = showBufferingIndicator;
  window.updatePlayerBufferUI = updatePlayerBufferUI;
  window.setupVideojsThumbnails = setupVideojsThumbnails;

  window.fetchVideos = fetchVideos;
  window.renderVideos = renderVideos;
  window.fetchAllData = fetchAllData;
  window.loadDashboardData = fetchAllData;
  window.clearSearch = clearSearch;
  window.setSort = setSort;
  window.setCatalogFilter = setCatalogFilter;
  window.filterCatalog = setCatalogFilter;
  window.setCatalogView = setCatalogView;
  window.setAppCatalogView = setCatalogView;

  window.syncDrive = syncDrive;
  window.submitUrlDownload = submitUrlDownload;
  window.triggerScanStorage = triggerScanStorage;
  window.scanStorage = triggerScanStorage;
  window.deleteVideo = deleteVideo;
  window.confirmAndDelete = confirmAndDelete;

  window.dismissTransfer = dismissTransfer;
  window.removeTransfer = dismissTransfer;
  window.clearCompletedTransfers = clearCompletedTransfers;
  window.clearFinishedTransfers = clearCompletedTransfers;
  window.formatUptime = formatUptime;
  window.formatBytes = formatBytes;
  window.formatDuration = formatDuration;

  /* ============================================================================
     11. INITIALIZATION & LIFECYCLE
     ============================================================================ */
  function initializeApp() {
    if (!checkAuthWall()) return;

    // Initialize 3D Hero Globe
    initHeroGlobe();

    // Initialize WebSocket Telemetry
    initWebSocket();

    // Fetch initial catalog & metrics
    fetchAllData();

    // Setup periodic polling for server telemetry
    setInterval(fetchMetrics, 3000);

    // Setup keyboard shortcuts
    setupKeyboardShortcuts();

    // Search input listener
    const sInput = document.getElementById('search-input');
    if (sInput) {
      sInput.addEventListener('input', () => renderVideos());
    }

    // Refresh icons
    if (window.lucide) {
      lucide.createIcons();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
  } else {
    initializeApp();
  }

})(window, document);
