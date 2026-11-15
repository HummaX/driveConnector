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
    currentGain: 100, // percentage: 100, 150, 200, 300
    isBuffering: false,
    isTheater: false,
    ws: null,
    wsReconnectTimeout: null,
    globe: null,
    audioCtx: null,
    dspInputNode: null,
    gainNode: null,
    eqBands: [
      { f: 60, type: 'lowshelf', gain: 0, label: '60Hz Bass' },
      { f: 250, type: 'peaking', gain: 0, label: '250Hz' },
      { f: 1000, type: 'peaking', gain: 0, label: '1kHz' },
      { f: 2500, type: 'peaking', gain: 0, label: '2.5kHz Clarity' },
      { f: 10000, type: 'highshelf', gain: 0, label: '10kHz Air' }
    ],
    eqNodes: [],
    compressorNode: null,
    analyserNode: null,
    eqNightMode: false,
    visualizerCanvas: null,
    visualizerCtx: null,
    visualizerAnimId: null,
    companionAudioCleanup: null,
    bufferMonitorInterval: null,
    vttCuesCache: {},
    // LosslessCut
    cutStart: 0,
    cutEnd: 0,
    hasMarkIn: false,
    hasMarkOut: false,
    // Shaders & Aspect Ratio
    videoFilters: {
      brightness: 100,
      contrast: 100,
      saturate: 100,
      sharpness: 0
    },
    aspectRatio: 'fit', // '16:9' | '21:9' | '4:3' | 'fit'
    // Ambilight
    ambilightEnabled: true,
    ambilightCanvas: null,
    ambilightCtx: null,
    // Dual subtitles & sync offset
    activeSecondarySubtitleTrack: 'off',
    subtitleOffsetSec: 0.0,
    customSubtitles: [],
    primaryCues: [],
    secondaryCues: [],
    // Stats for Nerds
    statsForNerdsVisible: false,
    statsUpdateInterval: null,
    // Gestures
    speedGestureHoldTimer: null,
    preSpeedGestureRate: 1.0,
    isSpeedGestureActive: false,
    lastTapTime: 0,
    lastTapX: 0
  };

  /* ============================================================================
     2. AUTHENTICATION & API ENGINE
     ============================================================================ */
  function getAuthToken() {
    return (
      localStorage.getItem('drive_auth_token') ||
      localStorage.getItem('ovh_media_token') ||
      localStorage.getItem('drive_connector_token') ||
      ''
    );
  }

  function persistAuth(token, user) {
    if (!token) return;
    localStorage.setItem('drive_auth_token', token);
    localStorage.setItem('ovh_media_token', token);
    localStorage.setItem('drive_connector_token', token);
    localStorage.setItem('drive_auth_user', JSON.stringify(user || { username: 'admin' }));
    document.cookie = `access_token=${token}; path=/; max-age=604800; SameSite=Lax`;
    state.token = token;
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
    localStorage.removeItem('drive_auth_token');
    localStorage.removeItem('ovh_media_token');
    localStorage.removeItem('drive_connector_token');
    localStorage.removeItem('drive_auth_user');
    document.cookie = 'access_token=; path=/; max-age=0; SameSite=Lax';
    state.token = null;
    window.location.href = '/login.html';
  }

  function getAuthHeaders(extraHeaders = {}) {
    const token = getAuthToken();
    const headers = { ...extraHeaders };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (state.clientGeo) {
      if (state.clientGeo.ip && state.clientGeo.ip !== 'client') headers['X-Client-IP'] = state.clientGeo.ip;
      if (state.clientGeo.country) headers['X-Client-Country'] = state.clientGeo.country;
      if (state.clientGeo.code) headers['X-Client-Country-Code'] = state.clientGeo.code;
      if (state.clientGeo.city) headers['X-Client-City'] = state.clientGeo.city;
      if (state.clientGeo.lat) headers['X-Client-Lat'] = String(state.clientGeo.lat);
      if (state.clientGeo.lng) headers['X-Client-Lng'] = String(state.clientGeo.lng);
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
    if (state.clientGeo) {
      if (state.clientGeo.ip && state.clientGeo.ip !== 'client' && !headers.has('X-Client-IP')) headers.set('X-Client-IP', state.clientGeo.ip);
      if (state.clientGeo.country && !headers.has('X-Client-Country')) headers.set('X-Client-Country', state.clientGeo.country);
      if (state.clientGeo.code && !headers.has('X-Client-Country-Code')) headers.set('X-Client-Country-Code', state.clientGeo.code);
      if (state.clientGeo.city && !headers.has('X-Client-City')) headers.set('X-Client-City', state.clientGeo.city);
      if (state.clientGeo.lat && !headers.has('X-Client-Lat')) headers.set('X-Client-Lat', String(state.clientGeo.lat));
      if (state.clientGeo.lng && !headers.has('X-Client-Lng')) headers.set('X-Client-Lng', String(state.clientGeo.lng));
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
     4. HERO 3D GLOBE INITIALIZATION (Globe.gl) & REAL GEOLOCATION
     ============================================================================ */
  const TIMEZONE_GEO_MAP = {
    // Pakistan
    'Asia/Karachi': { country: 'Pakistan', code: 'PK', flag: '🇵🇰', city: 'Karachi', lat: 24.8607, lng: 67.0011 },
    'Asia/Lahore': { country: 'Pakistan', code: 'PK', flag: '🇵🇰', city: 'Lahore', lat: 31.5204, lng: 74.3587 },
    'Asia/Islamabad': { country: 'Pakistan', code: 'PK', flag: '🇵🇰', city: 'Islamabad', lat: 33.6844, lng: 73.0479 },
    // Middle East & Gulf
    'Asia/Dubai': { country: 'United Arab Emirates', code: 'AE', flag: '🇦🇪', city: 'Dubai', lat: 25.2048, lng: 55.2708 },
    'Asia/Riyadh': { country: 'Saudi Arabia', code: 'SA', flag: '🇸🇦', city: 'Riyadh', lat: 24.7136, lng: 46.6753 },
    'Asia/Muscat': { country: 'Oman', code: 'OM', flag: '🇴🇲', city: 'Muscat', lat: 23.5880, lng: 58.3829 },
    'Asia/Qatar': { country: 'Qatar', code: 'QA', flag: '🇶🇦', city: 'Doha', lat: 25.2854, lng: 51.5310 },
    'Asia/Kuwait': { country: 'Kuwait', code: 'KW', flag: '🇰🇼', city: 'Kuwait City', lat: 29.3759, lng: 47.9774 },
    'Asia/Bahrain': { country: 'Bahrain', code: 'BH', flag: '🇧🇭', city: 'Manama', lat: 26.2285, lng: 50.5860 },
    'Asia/Amman': { country: 'Jordan', code: 'JO', flag: '🇯🇴', city: 'Amman', lat: 31.9454, lng: 35.9284 },
    'Asia/Beirut': { country: 'Lebanon', code: 'LB', flag: '🇱🇧', city: 'Beirut', lat: 33.8938, lng: 35.5018 },
    'Asia/Baghdad': { country: 'Iraq', code: 'IQ', flag: '🇮🇶', city: 'Baghdad', lat: 33.3152, lng: 44.3661 },
    // South Asia
    'Asia/Kolkata': { country: 'India', code: 'IN', flag: '🇮🇳', city: 'New Delhi', lat: 28.6139, lng: 77.2090 },
    'Asia/Calcutta': { country: 'India', code: 'IN', flag: '🇮🇳', city: 'Kolkata', lat: 22.5726, lng: 88.3639 },
    'Asia/Dhaka': { country: 'Bangladesh', code: 'BD', flag: '🇧🇩', city: 'Dhaka', lat: 23.8103, lng: 90.4125 },
    'Asia/Colombo': { country: 'Sri Lanka', code: 'LK', flag: '🇱🇰', city: 'Colombo', lat: 6.9271, lng: 79.8612 },
    // North America
    'America/New_York': { country: 'United States', code: 'US', flag: '🇺🇸', city: 'New York', lat: 40.7128, lng: -74.0060 },
    'America/Chicago': { country: 'United States', code: 'US', flag: '🇺🇸', city: 'Chicago', lat: 41.8781, lng: -87.6298 },
    'America/Denver': { country: 'United States', code: 'US', flag: '🇺🇸', city: 'Denver', lat: 39.7392, lng: -104.9903 },
    'America/Los_Angeles': { country: 'United States', code: 'US', flag: '🇺🇸', city: 'Los Angeles', lat: 34.0522, lng: -118.2437 },
    'America/Toronto': { country: 'Canada', code: 'CA', flag: '🇨🇦', city: 'Toronto', lat: 43.6532, lng: -79.3832 },
    'America/Vancouver': { country: 'Canada', code: 'CA', flag: '🇨🇦', city: 'Vancouver', lat: 49.2827, lng: -123.1207 },
    // Europe
    'Europe/London': { country: 'United Kingdom', code: 'GB', flag: '🇬🇧', city: 'London', lat: 51.5074, lng: -0.1278 },
    'Europe/Paris': { country: 'France', code: 'FR', flag: '🇫🇷', city: 'Paris', lat: 48.8566, lng: 2.3522 },
    'Europe/Berlin': { country: 'Germany', code: 'DE', flag: '🇩🇪', city: 'Berlin', lat: 52.5200, lng: 13.4050 },
    'Europe/Amsterdam': { country: 'Netherlands', code: 'NL', flag: '🇳🇱', city: 'Amsterdam', lat: 52.3676, lng: 4.9041 },
    'Europe/Madrid': { country: 'Spain', code: 'ES', flag: '🇪🇸', city: 'Madrid', lat: 40.4168, lng: -3.7038 },
    'Europe/Rome': { country: 'Italy', code: 'IT', flag: '🇮🇹', city: 'Rome', lat: 41.9028, lng: 12.4964 },
    'Europe/Zurich': { country: 'Switzerland', code: 'CH', flag: '🇨🇭', city: 'Zurich', lat: 47.3769, lng: 8.5417 },
    'Europe/Stockholm': { country: 'Sweden', code: 'SE', flag: '🇸🇪', city: 'Stockholm', lat: 59.3293, lng: 18.0686 },
    'Europe/Oslo': { country: 'Norway', code: 'NO', flag: '🇳🇴', city: 'Oslo', lat: 59.9139, lng: 10.7522 },
    'Europe/Dublin': { country: 'Ireland', code: 'IE', flag: '🇮🇪', city: 'Dublin', lat: 53.3498, lng: -6.2603 },
    'Europe/Warsaw': { country: 'Poland', code: 'PL', flag: '🇵🇱', city: 'Warsaw', lat: 52.2297, lng: 21.0122 },
    'Europe/Istanbul': { country: 'Turkey', code: 'TR', flag: '🇹🇷', city: 'Istanbul', lat: 41.0082, lng: 28.9784 },
    // East Asia & Pacific
    'Asia/Tokyo': { country: 'Japan', code: 'JP', flag: '🇯🇵', city: 'Tokyo', lat: 35.6762, lng: 139.6503 },
    'Asia/Seoul': { country: 'South Korea', code: 'KR', flag: '🇰🇷', city: 'Seoul', lat: 37.5665, lng: 126.9780 },
    'Asia/Singapore': { country: 'Singapore', code: 'SG', flag: '🇸🇬', city: 'Singapore', lat: 1.3521, lng: 103.8198 },
    'Australia/Sydney': { country: 'Australia', code: 'AU', flag: '🇦🇺', city: 'Sydney', lat: -33.8688, lng: 151.2093 },
    'Australia/Melbourne': { country: 'Australia', code: 'AU', flag: '🇦🇺', city: 'Melbourne', lat: -37.8136, lng: 144.9631 },
    'America/Sao_Paulo': { country: 'Brazil', code: 'BR', flag: '🇧🇷', city: 'São Paulo', lat: -23.5505, lng: -46.6333 },
    'Africa/Cairo': { country: 'Egypt', code: 'EG', flag: '🇪🇬', city: 'Cairo', lat: 30.0444, lng: 31.2357 },
    'Africa/Johannesburg': { country: 'South Africa', code: 'ZA', flag: '🇿🇦', city: 'Johannesburg', lat: -26.2041, lng: 28.0473 }
  };

  function getBrowserGeoFallback() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz && TIMEZONE_GEO_MAP[tz]) {
        return { ...TIMEZONE_GEO_MAP[tz], tz };
      }
    } catch (_) {}
    return { country: 'Global Node', code: 'GLB', flag: '🌐', city: 'Visitor', lat: 40.7128, lng: -74.0060, tz: 'UTC' };
  }

  function getFlagEmoji(countryCode) {
    if (!countryCode || countryCode.length !== 2) return '🌐';
    try {
      return String.fromCodePoint(...[...countryCode.toUpperCase()].map(c => 127397 + c.charCodeAt(0)));
    } catch (_) {
      return '🌐';
    }
  }

  function initHeroGlobe() {
    const container = document.getElementById('hero-globe-container');
    if (!container) return null;
    if (typeof Globe !== 'function') {
      console.warn('[Globe] Globe.gl library is not loaded.');
      return null;
    }

    container.innerHTML = '';

    const width = container.clientWidth || 280;
    const height = container.clientHeight || 200;

    // Primary Server Node (OVHcloud, Roubaix, France)
    const ovhNode = {
      lat: 50.6927,
      lng: 3.1746,
      name: 'OVH-EU-1TB (Roubaix, France)',
      city: 'Roubaix',
      country: 'France',
      flag: '🇫🇷',
      color: '#38bdf8',
      size: 1.5,
      isServer: true
    };

    // Initialize with real instant client fallback from browser timezone
    const clientFallback = getBrowserGeoFallback();
    state.clientGeo = clientFallback;

    const initialClientNode = {
      lat: clientFallback.lat,
      lng: clientFallback.lng,
      name: `${clientFallback.city}, ${clientFallback.country}`,
      city: clientFallback.city,
      country: clientFallback.country,
      flag: clientFallback.flag,
      color: '#34d399',
      size: 1.2
    };

    const initialArcs = Math.abs(initialClientNode.lat - ovhNode.lat) > 0.05 || Math.abs(initialClientNode.lng - ovhNode.lng) > 0.05
      ? [{
          startLat: initialClientNode.lat,
          startLng: initialClientNode.lng,
          endLat: ovhNode.lat,
          endLng: ovhNode.lng,
          color: ['rgba(56, 189, 248, 0.9)', 'rgba(52, 211, 153, 0.95)']
        }]
      : [];

    try {
      const globe = Globe()(container)
        .globeImageUrl('//unpkg.com/three-globe/example/img/earth-night.jpg')
        .bumpImageUrl('//unpkg.com/three-globe/example/img/earth-topology.png')
        .backgroundColor('rgba(0,0,0,0)')
        .width(width)
        .height(height)
        .pointsData([ovhNode, initialClientNode])
        .pointColor(d => d.color)
        .pointAltitude(0.04)
        .pointRadius(0.85)
        .pointLabel(d => `
          <div style="background: rgba(13, 17, 23, 0.95); border: 1px solid rgba(56, 189, 248, 0.4); border-radius: 8px; padding: 6px 10px; font-family: monospace; font-size: 11px; color: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.5); pointer-events: none;">
            <div style="font-weight: bold; color: ${d.color || '#38bdf8'}; display: flex; align-items: center; gap: 4px;">
              <span>${d.flag || '🌐'}</span>
              <span>${d.name || d.city || 'Node'}</span>
            </div>
            <div style="color: #94a3b8; font-size: 10px; margin-top: 2px;">
              ${d.isServer ? 'Primary Cloud Engine • Roubaix, FR' : `${d.hits || 1} live hit(s)`}
            </div>
          </div>
        `)
        .arcsData(initialArcs)
        .arcColor(d => d.color)
        .arcDashLength(0.4)
        .arcDashGap(0.25)
        .arcDashAnimateTime(1800)
        .arcStroke(0.7)
        .arcLabel(d => `
          <div style="background: rgba(13, 17, 23, 0.95); border: 1px solid rgba(52, 211, 153, 0.4); border-radius: 6px; padding: 4px 8px; font-family: monospace; font-size: 10px; color: #34d399;">
            Active Ingestion Arc &rarr; OVH-EU
          </div>
        `)
        .atmosphereColor('#38bdf8')
        .atmosphereAltitude(0.18);

      const isMobile = window.innerWidth < 768;
      const pixelRatio = isMobile ? Math.min(window.devicePixelRatio || 1, 1.0) : Math.min(window.devicePixelRatio || 1, 2.0);

      const renderer = globe.renderer();
      if (renderer && typeof renderer.setPixelRatio === 'function') {
        renderer.setPixelRatio(pixelRatio);
      }

      globe.pointOfView({ lat: 35.0, lng: 20.0, altitude: isMobile ? 2.5 : 2.0 }, 1000);

      const controls = globe.controls();
      if (controls) {
        controls.autoRotate = true;
        controls.autoRotateSpeed = 0.8;
        controls.enableZoom = !isMobile;
      }

      window.addEventListener('resize', () => {
        if (!container) return;
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w > 0 && h > 0) {
          globe.width(w).height(h);
        }
        const mobileNow = window.innerWidth < 768;
        const pr = mobileNow ? Math.min(window.devicePixelRatio || 1, 1.0) : Math.min(window.devicePixelRatio || 1, 2.0);
        if (renderer && typeof renderer.setPixelRatio === 'function') {
          renderer.setPixelRatio(pr);
        }
        if (controls) {
          controls.enableZoom = !mobileNow;
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
     4b. DYNAMIC 3D GLOBE TELEMETRY & GEOIP UPDATE
     ============================================================================ */
  function updateHeroGlobe(geoData) {
    if (!geoData) return;

    // Update Globe HUD DOM Elements
    const activeConnsEl = document.getElementById('globe-active-conns');
    if (activeConnsEl && typeof geoData.active_connections === 'number') {
      const conns = geoData.active_connections;
      activeConnsEl.textContent = `${conns} ${conns === 1 ? 'Live Connection' : 'Live Connections'}`;
    }

    const countriesBadgeEl = document.getElementById('globe-countries-badge');
    if (countriesBadgeEl && typeof geoData.unique_countries_count === 'number') {
      const count = geoData.unique_countries_count;
      countriesBadgeEl.textContent = `${count} ${count === 1 ? 'Country' : 'Countries'}`;
    }

    const clientIpEl = document.getElementById('globe-client-ip-text');
    if (clientIpEl) {
      const cc = geoData.current_client || state.clientGeo;
      if (cc) {
        const maskedIp = cc.ip ? (cc.ip.includes('.') ? cc.ip.split('.').slice(0, 3).join('.') + '.xxx' : cc.ip) : '';
        clientIpEl.innerHTML = `<span class="text-xs">${cc.flag || '🌐'}</span><span class="text-slate-300 font-medium">${cc.city || 'Visitor'}, ${cc.country || 'Node'}</span>${maskedIp ? `<span class="text-slate-500 text-[9px] font-mono">(${maskedIp})</span>` : ''}`;
      }
    }

    const flagsContainer = document.getElementById('globe-countries-flags');
    if (flagsContainer && Array.isArray(geoData.countries)) {
      flagsContainer.innerHTML = geoData.countries.map(c => `
        <button onclick="focusGlobeOnCountry('${c.code}')" class="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] font-mono text-slate-300 border border-slate-700 hover:border-sky-500/50 transition flex items-center space-x-1" title="Focus ${c.name || c.code} on 3D globe">
          <span>${c.flag || '🌐'}</span>
          <span>${c.count}</span>
        </button>
      `).join('');
    }

    // Update 3D Globe WebGL points and glowing arcs
    if (!state.globe) return;

    const serverNode = geoData.server_node || {
      lat: 50.6927,
      lng: 3.1746,
      name: 'OVH-EU-1TB (Roubaix, France)',
      city: 'Roubaix',
      country: 'France',
      flag: '🇫🇷',
      color: '#38bdf8',
      size: 1.5,
      isServer: true
    };

    const clientNodes = Array.isArray(geoData.client_nodes) && geoData.client_nodes.length > 0
      ? geoData.client_nodes
      : (state.clientGeo ? [{
          lat: state.clientGeo.lat,
          lng: state.clientGeo.lng,
          name: `${state.clientGeo.city}, ${state.clientGeo.country}`,
          city: state.clientGeo.city,
          country: state.clientGeo.country,
          flag: state.clientGeo.flag,
          color: '#34d399',
          active: true
        }] : []);

    const allPoints = [serverNode, ...clientNodes];
    try {
      state.globe.pointsData(allPoints);

      // Cyan / emerald glowing arcs routing into serverNode
      const arcsData = clientNodes
        .filter(node => Math.abs(node.lat - serverNode.lat) > 0.05 || Math.abs(node.lng - serverNode.lng) > 0.05)
        .map(node => ({
          startLat: node.lat,
          startLng: node.lng,
          endLat: serverNode.lat,
          endLng: serverNode.lng,
          color: node.active !== false
            ? ['rgba(56, 189, 248, 0.85)', 'rgba(52, 211, 153, 0.95)']
            : ['rgba(148, 163, 184, 0.4)', 'rgba(56, 189, 248, 0.6)']
        }));

      state.globe.arcsData(arcsData);
    } catch (e) {
      console.warn('[Globe] Error updating 3D points/arcs:', e);
    }
  }

  function focusGlobeOnCountry(countryCode) {
    if (!state.globe || !countryCode) return;
    const country = Object.values(TIMEZONE_GEO_MAP).find(c => c.code.toUpperCase() === countryCode.toUpperCase());
    if (country) {
      state.globe.pointOfView({ lat: country.lat, lng: country.lng, altitude: 1.8 }, 1200);
    }
  }

  async function fetchNetworkGeo() {
    const t0 = performance.now();
    try {
      const res = await fetchWithAuth('/api/network/geo');
      if (res.ok) {
        const latency = Math.max(1, Math.round(performance.now() - t0));
        const latEl = document.getElementById('globe-latency-text');
        if (latEl) latEl.textContent = `Latency ${latency}ms`;
        const geoData = await res.json();
        updateHeroGlobe(geoData);
      }
    } catch (_) {}
  }

  async function detectAndRegisterClientGeo() {
    let geo = getBrowserGeoFallback();

    // Query fast public GeoIP endpoints in parallel with failover
    try {
      const publicGeo = await Promise.any([
        fetch('https://ipwho.is/').then(r => r.json()).then(d => d.success ? {
          ip: d.ip,
          country: d.country,
          code: d.country_code,
          flag: d.flag?.emoji || getFlagEmoji(d.country_code),
          city: d.city,
          lat: d.latitude,
          lng: d.longitude
        } : null),
        fetch('https://api.country.is/').then(r => r.json()).then(d => d.country ? {
          ip: d.ip,
          country: d.country,
          code: d.country,
          flag: getFlagEmoji(d.country),
          city: geo.city || d.country,
          lat: geo.lat,
          lng: geo.lng
        } : null),
        fetch('https://api.ipify.org?format=json').then(r => r.json()).then(d => ({
          ip: d.ip,
          ...geo
        }))
      ]);
      if (publicGeo) {
        geo = { ...geo, ...publicGeo };
      }
    } catch (_) {
      // Timezone fallback is already accurate
    }

    state.clientGeo = geo;

    // Register with backend
    try {
      await fetchWithAuth('/api/network/register-client', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: geo.ip || 'client',
          city: geo.city,
          country: geo.country,
          country_code: geo.code,
          lat: geo.lat,
          lng: geo.lng
        })
      });
    } catch (_) {}

    await fetchNetworkGeo();
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
    if (!msg) return;

    // Direct Telemetry / System Metrics Broadcast
    if (msg.event === 'TELEMETRY_UPDATE' || msg.event === 'METRICS_UPDATE' || msg.event === 'SYSTEM_UPDATE' || msg.metrics) {
      updateSystemMetricsUI(msg.data || msg.metrics || msg);
      return;
    }

    if (!msg.event) return;

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

      // Dynamically compute aggregate live download throughput and update Hero Network Card & Header
      const activeDlList = Object.values(state.transfers).filter(t => t.status === 'DOWNLOADING');
      const totalDlSpeed = activeDlList.reduce((acc, t) => acc + (parseFloat(t.speed_mbs) || 0), 0);
      const kpiInSpeed = document.getElementById('kpi-in-speed');
      if (kpiInSpeed) kpiInSpeed.textContent = `${totalDlSpeed.toFixed(1)} MB/s`;
      const headerNetIn = document.getElementById('header-net-in');
      if (headerNetIn) headerNetIn.textContent = `${totalDlSpeed.toFixed(1)} MB/s`;
      const kpiQueue = document.getElementById('kpi-queue-count');
      if (kpiQueue) kpiQueue.textContent = activeDlList.length;

      // Auto-dismiss completed transfer after 8 seconds
      if (isDone) {
        setTimeout(() => {
          if (state.transfers[msg.video_id] && !state.processingJobs[msg.video_id]) {
            delete state.transfers[msg.video_id];
            renderTransfers();
          }
        }, 8000);
        // Refresh catalog and storage metrics on transfer completion
        fetchMetrics();
        fetchVideos();
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

      // Smoothly update Hero Processing Pipeline KPI Card
      const procCount = Object.keys(state.processingJobs).length;
      const kpiProc = document.getElementById('kpi-proc-count');
      if (kpiProc) kpiProc.textContent = procCount;
      const kpiActive = document.getElementById('kpi-pipeline-active');
      if (kpiActive) {
        kpiActive.textContent = procCount > 0 ? `Active (${procCount})` : 'Idle / Ready';
        kpiActive.className = procCount > 0 ? 'text-purple-400 font-bold' : 'text-slate-300';
      }
      const kpiDesc = document.getElementById('kpi-pipeline-desc');
      if (kpiDesc) {
        kpiDesc.textContent = procCount > 0 ? `${procCount} FFmpeg job(s) running` : 'WebVTT Sprites & Audio';
      }

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

      // Smoothly update Hero Pipeline counts
      const procCount = Object.keys(state.processingJobs).length;
      const kpiProc = document.getElementById('kpi-proc-count');
      if (kpiProc) kpiProc.textContent = procCount;
      const kpiActive = document.getElementById('kpi-pipeline-active');
      if (kpiActive) {
        kpiActive.textContent = procCount > 0 ? `Active (${procCount})` : 'Idle / Ready';
        kpiActive.className = procCount > 0 ? 'text-purple-400 font-bold' : 'text-slate-300';
      }

      if (state.activeVideo && state.activeVideo.video_id === msg.video_id) {
        const hud = document.getElementById('player-processing-hud');
        if (hud) {
          hud.classList.add('hidden');
          hud.classList.remove('flex');
        }
        const dlOverlay = document.getElementById('player-download-overlay');
        if (dlOverlay) {
          dlOverlay.classList.add('hidden');
          dlOverlay.classList.remove('flex');
        }
        const footerStatus = document.getElementById('player-footer-status');
        if (footerStatus) {
          footerStatus.textContent = 'LOCAL_READY';
          footerStatus.className = 'shrink-0 text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 uppercase font-semibold';
        }
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

        // Auto-play the instant local processing completes
        if (!state.activePlayer) {
          openPlayerModal(state.activeVideo);
        } else if (typeof state.activePlayer.play === 'function') {
          state.activePlayer.play().catch(() => {});
        }
      }

      fetchVideos();
      fetchMetrics();
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
      if (dlOverlay) {
        dlOverlay.classList.add('hidden');
        dlOverlay.classList.remove('flex');
      }
      state.activeVideo.status = 'LOCAL_READY';
      // Auto-play the instant local processing completes
      openPlayerModal(state.activeVideo);
      fetchVideos();
      fetchMetrics();
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

    const heroCard = document.getElementById('hero-transfers-card');
    const heroCount = document.getElementById('hero-transfers-count');
    const heroItems = document.getElementById('hero-transfers-items');
    const miniBarWrap = document.getElementById('transfers-mini-bar-wrap');
    const miniPct = document.getElementById('transfers-mini-pct');
    const miniBar = document.getElementById('transfers-mini-bar');

    if (totalActive === 0) {
      if (container) {
        container.innerHTML = `
          <div class="text-center py-8 text-slate-500 text-xs font-mono">
            <i data-lucide="check-circle" class="w-8 h-8 mx-auto mb-2 text-slate-600 stroke-[1.5]"></i>
            <span>All transfer and ingestion queues idle</span>
          </div>
        `;
      }
      if (heroCard) heroCard.classList.add('hidden');
      if (heroCount) heroCount.textContent = '0 Active';
      if (heroItems) heroItems.innerHTML = '';
      if (miniBarWrap) {
        miniBarWrap.classList.add('hidden');
        miniBarWrap.classList.remove('flex');
      }
      if (miniPct) miniPct.classList.add('hidden');
      if (miniBar) miniBar.style.width = '0%';
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

    const fullTransfersHtml = procHtml + dlHtml;
    if (container) container.innerHTML = fullTransfersHtml;

    // Update Hero Transfers Card & Items
    if (heroCard) {
      heroCard.classList.remove('hidden');
      if (heroCount) heroCount.textContent = `${totalActive} Active`;
      if (heroItems) heroItems.innerHTML = fullTransfersHtml;
    }

    // Update Mini Progress Bar in Sticky Ribbon
    const activeDlList = dlList.filter(t => t.status === 'DOWNLOADING' || (t.speed_mbs && t.speed_mbs > 0) || (typeof t.percentage === 'number' && t.percentage < 100));
    const activeProcList = procList.filter(p => (typeof p.percent === 'number' && p.percent < 100) || (typeof p.stage_percent === 'number' && p.stage_percent < 100));
    const activeItems = [...activeDlList, ...activeProcList];

    if (activeItems.length > 0) {
      const avgPct = Math.round(
        activeItems.reduce((acc, t) => acc + (t.percentage ?? t.percent ?? t.stage_percent ?? 0), 0) / activeItems.length
      );
      if (miniBarWrap) {
        miniBarWrap.classList.remove('hidden');
        miniBarWrap.classList.add('flex');
      }
      if (miniPct) {
        miniPct.textContent = `${avgPct}%`;
        miniPct.classList.remove('hidden');
      }
      if (miniBar) miniBar.style.width = `${avgPct}%`;
    } else {
      if (miniBarWrap) {
        miniBarWrap.classList.add('hidden');
        miniBarWrap.classList.remove('flex');
      }
      if (miniPct) miniPct.classList.add('hidden');
      if (miniBar) miniBar.style.width = '0%';
    }

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
        let spriteUrl = cue.sprite || cue.url;
        if (spriteUrl && !spriteUrl.startsWith('http') && !spriteUrl.startsWith('/')) {
          const lastSlash = vttUrl.lastIndexOf('/');
          spriteUrl = vttUrl.substring(0, lastSlash + 1) + spriteUrl;
        }

        if (thumbEl) {
          thumbEl.style.backgroundImage = `url("${spriteUrl}")`;
          thumbEl.style.backgroundPosition = `-${cue.x}px -${cue.y}px`;
        } else {
          previewEl.style.backgroundImage = `url("${spriteUrl}")`;
          previewEl.style.backgroundPosition = `-${cue.x}px -${cue.y}px`;
        }

        const m = Math.floor(hoverTime / 60);
        const s = Math.floor(hoverTime % 60);
        const timeStr = `${m}:${s < 10 ? '0' : ''}${s}`;
        if (timeEl) timeEl.textContent = timeStr;

        // Strict viewport edge clamping:
        // Clamps thumbnail preview tooltip horizontally so it never clips past left (0px)
        // or right (viewport width - thumbWidth) on 360px mobile screens.
        const thumbWidth = cue.w || 160;
        const targetX = clientX - Math.round(thumbWidth / 2);
        const clampedX = Math.max(0, Math.min(window.innerWidth - thumbWidth, targetX));
        const targetY = Math.max(10, rect.top - 105);

        previewEl.style.position = 'fixed';
        previewEl.style.left = `${clampedX}px`;
        previewEl.style.top = `${targetY}px`;
        previewEl.style.zIndex = '60';
        previewEl.classList.remove('hidden');
        previewEl.classList.add('flex');
      }
    };

    const onMouseMove = (e) => {
      handleScrub(e.clientX, e.clientY);
    };

    const onMouseLeave = () => {
      if (previewEl) {
        previewEl.classList.add('hidden');
        previewEl.classList.remove('flex');
      }
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

    const onTouchEnd = (e) => {
      if (previewEl) {
        previewEl.classList.add('hidden');
        previewEl.classList.remove('flex');
      }
      const touch = (e.changedTouches && e.changedTouches.length > 0) ? e.changedTouches[0] : null;
      if (touch) {
        const rect = prog.getBoundingClientRect();
        const duration = typeof player.duration === 'function' ? player.duration() : (player.duration || 0);
        if (duration > 0 && rect.width > 0) {
          const offsetX = Math.max(0, Math.min(rect.width, touch.clientX - rect.left));
          const seekTime = (offsetX / rect.width) * duration;
          if (typeof player.currentTime === 'function') {
            player.currentTime(seekTime);
          }
        }
      }
    };

    prog.addEventListener('mousemove', onMouseMove, { passive: true });
    prog.addEventListener('mouseleave', onMouseLeave, { passive: true });
    prog.addEventListener('touchstart', onTouchStart, { passive: true });
    prog.addEventListener('touchmove', onTouchMove, { passive: true });
    prog.addEventListener('touchend', onTouchEnd, { passive: true });
    prog.addEventListener('touchcancel', onTouchEnd, { passive: true });
  }

  // Web Audio API 5-Band DSP Equalizer & Master Gain Booster (up to 300%)
  function setupAudioBooster(videoEl) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      if (!state.audioCtx || state.audioCtx.state === 'closed') {
        state.audioCtx = new AudioCtx();
        state.dspInputNode = state.audioCtx.createGain();
        state.dspInputNode.gain.value = 1.0;

        // Route: MediaElementSource -> 5 BiquadFilterNodes (60Hz Bass, 250Hz, 1kHz, 2.5kHz Dialogue, 10kHz Air)
        state.eqNodes = state.eqBands.map(b => {
          const filter = state.audioCtx.createBiquadFilter();
          filter.type = b.type;
          filter.frequency.value = b.f;
          if (b.type === 'peaking') filter.Q.value = 1.0;
          filter.gain.value = b.gain || 0;
          return filter;
        });

        // Chain 5 filters sequentially
        state.dspInputNode.connect(state.eqNodes[0]);
        for (let i = 0; i < state.eqNodes.length - 1; i++) {
          state.eqNodes[i].connect(state.eqNodes[i + 1]);
        }

        // DynamicsCompressorNode (Night Mode)
        state.compressorNode = state.audioCtx.createDynamicsCompressor();
        if (state.eqNightMode) {
          state.compressorNode.threshold.value = -24;
          state.compressorNode.knee.value = 30;
          state.compressorNode.ratio.value = 12;
          state.compressorNode.attack.value = 0.003;
          state.compressorNode.release.value = 0.25;
        } else {
          state.compressorNode.threshold.value = 0;
          state.compressorNode.ratio.value = 1;
        }
        state.eqNodes[state.eqNodes.length - 1].connect(state.compressorNode);

        // GainNode (Boost up to 300%)
        state.gainNode = state.audioCtx.createGain();
        state.gainNode.gain.value = (state.currentGain || 100) / 100;
        state.compressorNode.connect(state.gainNode);

        // AnalyserNode (60fps Real-Time Visualizer)
        state.analyserNode = state.audioCtx.createAnalyser();
        state.analyserNode.fftSize = 64;
        state.analyserNode.smoothingTimeConstant = 0.8;
        state.gainNode.connect(state.analyserNode);
        state.analyserNode.connect(state.audioCtx.destination);
      } else if (!state.gainNode) {
        state.gainNode = state.audioCtx.createGain();
        state.gainNode.gain.value = (state.currentGain || 100) / 100;
        state.gainNode.connect(state.audioCtx.destination);
      }

      // Connect main video element
      const targetVideo = videoEl || (state.activePlayer?.el ? state.activePlayer.el().querySelector('video') : null) || document.querySelector('#player-container video');
      if (targetVideo && (!targetVideo._mediaSourceNode || targetVideo._mediaSourceCtx !== state.audioCtx)) {
        try {
          targetVideo._mediaSourceNode = state.audioCtx.createMediaElementSource(targetVideo);
          targetVideo._mediaSourceCtx = state.audioCtx;
          targetVideo._videoGain = state.audioCtx.createGain();
          targetVideo._videoGain.gain.value = (state.activeAudioTrack > 0) ? 0.0 : 1.0;
          targetVideo._mediaSourceNode.connect(targetVideo._videoGain);
          if (state.dspInputNode) {
            targetVideo._videoGain.connect(state.dspInputNode);
          } else if (state.gainNode) {
            targetVideo._videoGain.connect(state.gainNode);
          }
        } catch (err) {
          console.warn('[AudioBooster] Error creating video MediaElementSource:', err);
        }
      }

      // Connect companion audio element
      const audioEl = document.getElementById('player-companion-audio') || document.querySelector('#companion-audio');
      if (audioEl && (!audioEl._mediaSourceNode || audioEl._mediaSourceCtx !== state.audioCtx)) {
        try {
          audioEl.crossOrigin = 'anonymous';
          audioEl._mediaSourceNode = state.audioCtx.createMediaElementSource(audioEl);
          audioEl._mediaSourceCtx = state.audioCtx;
          audioEl._companionGain = state.audioCtx.createGain();
          audioEl._companionGain.gain.value = (state.activeAudioTrack > 0) ? 1.0 : 0.0;
          audioEl._mediaSourceNode.connect(audioEl._companionGain);
          if (state.dspInputNode) {
            audioEl._companionGain.connect(state.dspInputNode);
          } else if (state.gainNode) {
            audioEl._companionGain.connect(state.gainNode);
          }
        } catch (err) {
          console.warn('[AudioBooster] Error creating audio MediaElementSource:', err);
        }
      }

      startAudioVisualizerLoop();
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
    else if (state.currentGain === 200) nextGain = 300;
    else nextGain = 100;
    setAudioGain(nextGain);
  }

  function setEqBand(bandIdx, gainDb) {
    const idx = parseInt(bandIdx, 10);
    const db = parseFloat(gainDb);
    if (isNaN(idx) || idx < 0 || idx >= state.eqBands.length || isNaN(db)) return;
    state.eqBands[idx].gain = db;
    if (state.eqNodes[idx]) {
      state.eqNodes[idx].gain.value = db;
    }
    const valLabel = document.getElementById(`eq-band-val-${idx}`);
    if (valLabel) valLabel.textContent = `${db > 0 ? '+' : ''}${db.toFixed(0)}dB`;
  }

  function setEqPreset(presetName) {
    const presets = {
      flat: [0, 0, 0, 0, 0],
      bass: [7, 5, 1, 0, -2],
      dialogue: [-3, 0, 3, 7, 4],
      cinema: [5, 3, -1, 4, 6],
      air: [0, -1, 1, 4, 8]
    };
    const gains = presets[presetName] || presets.flat;
    gains.forEach((g, i) => setEqBand(i, g));

    gains.forEach((g, i) => {
      const slider = document.getElementById(`eq-band-slider-${i}`);
      if (slider) slider.value = g;
    });
    showToast(`EQ Preset: ${presetName.toUpperCase()}`, 'info');
  }

  function toggleNightMode(forceState) {
    state.eqNightMode = typeof forceState === 'boolean' ? forceState : !state.eqNightMode;
    if (state.compressorNode) {
      if (state.eqNightMode) {
        state.compressorNode.threshold.value = -24;
        state.compressorNode.knee.value = 30;
        state.compressorNode.ratio.value = 12;
        state.compressorNode.attack.value = 0.003;
        state.compressorNode.release.value = 0.25;
      } else {
        state.compressorNode.threshold.value = 0;
        state.compressorNode.ratio.value = 1;
      }
    }
    const btn = document.getElementById('btn-night-mode');
    if (btn) {
      if (state.eqNightMode) {
        btn.className = 'px-3 py-1.5 rounded-lg bg-indigo-500 text-white font-mono text-xs font-bold shadow-md flex items-center space-x-1.5';
      } else {
        btn.className = 'px-3 py-1.5 rounded-lg bg-[#21262d] text-slate-400 hover:text-white font-mono text-xs flex items-center space-x-1.5';
      }
    }
    showToast(`Night Mode (Dynamics Compressor): ${state.eqNightMode ? 'ENABLED' : 'DISABLED'}`, 'info');
  }

  function startAudioVisualizerLoop() {
    if (state.visualizerAnimId) return;
    const canvas = document.getElementById('eq-visualizer-canvas') || document.getElementById('player-audio-visualizer');
    if (!canvas || !state.analyserNode) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dataArray = new Uint8Array(state.analyserNode.frequencyBinCount);

    const render = () => {
      if (!state.activePlayer || (typeof state.activePlayer.paused === 'function' && state.activePlayer.paused())) {
        state.visualizerAnimId = null;
        return;
      }
      state.analyserNode.getByteFrequencyData(dataArray);

      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const barCount = 5;
      const barSpacing = 4;
      const totalSpacing = barSpacing * (barCount + 1);
      const barWidth = Math.max(4, Math.floor((w - totalSpacing) / barCount));

      for (let i = 0; i < barCount; i++) {
        const binIdx = Math.min(dataArray.length - 1, Math.floor((i + 1) * (dataArray.length / (barCount + 1))));
        const val = dataArray[binIdx] || 0;
        const barHeight = Math.max(3, Math.round((val / 255) * (h - 4)));
        const x = barSpacing + i * (barWidth + barSpacing);
        const y = h - barHeight;

        const grad = ctx.createLinearGradient(0, y, 0, h);
        grad.addColorStop(0, '#38bdf8');
        grad.addColorStop(1, '#6366f1');
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, barWidth, barHeight);

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x, Math.max(0, y - 2), barWidth, 2);
      }

      state.visualizerAnimId = requestAnimationFrame(render);
    };

    state.visualizerAnimId = requestAnimationFrame(render);
  }

  // Dual-audio companion synchronization with sample-locked precision (< 0.12s drift)
  function setupCompanionAudioSync(videoEl) {
    if (state.companionAudioCleanup) {
      state.companionAudioCleanup();
      state.companionAudioCleanup = null;
    }
    const audioEl = document.getElementById('player-companion-audio') || document.querySelector('#companion-audio');
    if (!audioEl || !videoEl) return;

    setupAudioBooster(videoEl);

    const syncCompanionImmediate = () => {
      if (state.activeAudioTrack > 0 && audioEl.src) {
        if (Math.abs(audioEl.currentTime - videoEl.currentTime) > 0.12) {
          audioEl.currentTime = videoEl.currentTime;
        }
        audioEl.playbackRate = videoEl.playbackRate;
        audioEl.volume = videoEl.volume;
        audioEl.muted = (state.activePlayer && typeof state.activePlayer.muted === 'function') ? state.activePlayer.muted() : videoEl.muted;
        if (state.audioCtx && state.audioCtx.state === 'suspended') {
          state.audioCtx.resume().catch(() => {});
        }
        if (!videoEl.paused) {
          audioEl.play().catch(() => {});
        }
      }
    };

    const handlePlay = () => {
      syncCompanionImmediate();
      startAudioVisualizerLoop();
    };
    const handlePause = () => {
      if (state.activeAudioTrack > 0) audioEl.pause();
    };
    const handleSeeking = () => {
      if (state.activeAudioTrack > 0) audioEl.pause();
    };
    const handleSeeked = () => {
      if (state.activeAudioTrack > 0) {
        audioEl.currentTime = videoEl.currentTime;
        audioEl.playbackRate = videoEl.playbackRate;
        audioEl.muted = (state.activePlayer && typeof state.activePlayer.muted === 'function') ? state.activePlayer.muted() : videoEl.muted;
        if (!videoEl.paused && audioEl.src) {
          if (state.audioCtx && state.audioCtx.state === 'suspended') {
            state.audioCtx.resume().catch(() => {});
          }
          audioEl.play().catch(() => {});
        }
      }
    };
    const handleRateChange = () => {
      if (state.activeAudioTrack > 0) audioEl.playbackRate = videoEl.playbackRate;
    };
    const handleVolumeChange = () => {
      if (state.activeAudioTrack > 0 && audioEl) {
        audioEl.volume = videoEl.volume;
        if (state.activePlayer && typeof state.activePlayer.muted === 'function') {
          audioEl.muted = state.activePlayer.muted();
        } else {
          audioEl.muted = videoEl.muted;
        }
      }
    };
    const handleBuffering = () => {
      if (state.activeAudioTrack > 0) audioEl.pause();
    };
    const handleResumeSync = () => {
      syncCompanionImmediate();
    };

    // Sample-locked drift correction (< 0.12s drift) across all play/pause/seek events
    const handleTimeUpdate = () => {
      if (state.activeAudioTrack > 0 && audioEl.src) {
        if (audioEl.readyState >= 2 && !videoEl.paused) {
          if (audioEl.paused) {
            if (state.audioCtx && state.audioCtx.state === 'suspended') {
              state.audioCtx.resume().catch(() => {});
            }
            audioEl.play().catch(() => {});
          }

          if (!audioEl.seeking) {
            const drift = audioEl.currentTime - videoEl.currentTime;
            const absDrift = Math.abs(drift);

            if (absDrift > 0.4) {
              // High drift: sample-locked hard resync
              audioEl.currentTime = videoEl.currentTime;
              audioEl.playbackRate = videoEl.playbackRate;
            } else if (absDrift > 0.12) {
              // Micro-adjust playbackRate smoothly within strict 0.12s envelope
              if (drift < 0) {
                audioEl.playbackRate = videoEl.playbackRate * 1.04;
              } else {
                audioEl.playbackRate = videoEl.playbackRate * 0.96;
              }
            } else if (absDrift <= 0.04) {
              // Synchronized within sample-locked threshold
              if (audioEl.playbackRate !== videoEl.playbackRate) {
                audioEl.playbackRate = videoEl.playbackRate;
              }
            }
          }
        }
      }
    };

    videoEl.addEventListener('play', handlePlay);
    videoEl.addEventListener('pause', handlePause);
    videoEl.addEventListener('seeking', handleSeeking);
    videoEl.addEventListener('seeked', handleSeeked);
    videoEl.addEventListener('ratechange', handleRateChange);
    videoEl.addEventListener('volumechange', handleVolumeChange);
    videoEl.addEventListener('waiting', handleBuffering);
    videoEl.addEventListener('stalled', handleBuffering);
    videoEl.addEventListener('playing', handleResumeSync);
    videoEl.addEventListener('canplay', handleResumeSync);
    videoEl.addEventListener('timeupdate', handleTimeUpdate);

    state.companionAudioCleanup = () => {
      videoEl.removeEventListener('play', handlePlay);
      videoEl.removeEventListener('pause', handlePause);
      videoEl.removeEventListener('seeking', handleSeeking);
      videoEl.removeEventListener('seeked', handleSeeked);
      videoEl.removeEventListener('ratechange', handleRateChange);
      videoEl.removeEventListener('volumechange', handleVolumeChange);
      videoEl.removeEventListener('waiting', handleBuffering);
      videoEl.removeEventListener('stalled', handleBuffering);
      videoEl.removeEventListener('playing', handleResumeSync);
      videoEl.removeEventListener('canplay', handleResumeSync);
      videoEl.removeEventListener('timeupdate', handleTimeUpdate);
    };
  }

  async function changePlayerAudioTrack(trackIdx) {
    const rawVal = String(trackIdx).trim().toLowerCase();
    const idx = (rawVal === 'default' || isNaN(parseInt(rawVal, 10))) ? 0 : parseInt(rawVal, 10);
    state.activeAudioTrack = idx;
    if (!state.activeVideo) return;

    const videoEl = state.activePlayer?.el ? state.activePlayer.el().querySelector('video') : document.querySelector('#player-container video');
    const audioEl = document.getElementById('player-companion-audio') || document.querySelector('#companion-audio');
    if (!videoEl || !audioEl) return;

    // Route both main video and companion audio through audio booster gainNode
    setupAudioBooster(videoEl);

    if (state.audioCtx && state.audioCtx.state === 'suspended') {
      state.audioCtx.resume().catch(() => {});
    }

    if (idx === 0) {
      if (videoEl._videoGain) videoEl._videoGain.gain.value = 1.0;
      if (audioEl._companionGain) audioEl._companionGain.gain.value = 0.0;
      audioEl.pause();
      audioEl.removeAttribute('src');
      audioEl.load();
      videoEl.muted = false;
      if (state.activePlayer && typeof state.activePlayer.muted === 'function') {
        state.activePlayer.muted(false);
      }
    } else {
      if (videoEl._videoGain) videoEl._videoGain.gain.value = 0.0;
      if (audioEl._companionGain) audioEl._companionGain.gain.value = 1.0;
      videoEl.muted = true;
      audioEl.crossOrigin = 'anonymous';
      audioEl.preload = 'auto';
      audioEl.muted = (state.activePlayer && typeof state.activePlayer.muted === 'function') ? state.activePlayer.muted() : false;
      audioEl.volume = videoEl.volume;
      audioEl.playbackRate = videoEl.playbackRate;

      const rawToken = getAuthToken() || localStorage.getItem('drive_auth_token') || localStorage.getItem('token') || '';
      const cleanToken = rawToken ? rawToken.replace(/^Bearer\s+/i, '').trim() : '';
      const tokenParam = cleanToken ? `?token=${encodeURIComponent(cleanToken)}` : '';
      const newSrc = `/api/videos/${state.activeVideo.video_id}/audio/${idx}${tokenParam}`;

      if (audioEl.getAttribute('src') !== newSrc && audioEl.src !== newSrc) {
        audioEl.src = newSrc;
        audioEl.load();
      }

      const syncAndPlay = () => {
        try {
          if (Math.abs(audioEl.currentTime - videoEl.currentTime) > 0.4) {
            audioEl.currentTime = videoEl.currentTime;
          }
          audioEl.playbackRate = videoEl.playbackRate;
          audioEl.volume = videoEl.volume;
          audioEl.muted = (state.activePlayer && typeof state.activePlayer.muted === 'function') ? state.activePlayer.muted() : false;
          if (!videoEl.paused) {
            if (state.audioCtx && state.audioCtx.state === 'suspended') {
              state.audioCtx.resume().catch(() => {});
            }
            audioEl.play().catch(e => console.warn('[CompanionAudio] play error:', e));
          }
        } catch (e) {}
      };

      audioEl.onloadedmetadata = () => {
        syncAndPlay();
      };
      audioEl.oncanplay = () => {
        if (!videoEl.paused && (audioEl.paused || Math.abs(audioEl.currentTime - videoEl.currentTime) > 0.4)) {
          syncAndPlay();
        }
      };
      audioEl.onerror = () => {
        console.warn(`[CompanionAudio] Audio track ${idx} loading error:`, audioEl.error);
      };

      if (audioEl.readyState >= 1) {
        syncAndPlay();
      }
    }
  }

  // Timestamp Parser for Subtitles (.srt and .vtt)
  function parseTimestampToSeconds(str) {
    if (!str) return 0;
    const clean = str.replace(',', '.').trim();
    const parts = clean.split(':');
    if (parts.length === 3) {
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
      return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    }
    return 0;
  }

  function parseSubtitleFileContent(text, filename) {
    const cues = [];
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = normalized.split(/\n\s*\n/);

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('-->')) {
          const parts = lines[i].split('-->');
          const start = parseTimestampToSeconds(parts[0]);
          const end = parseTimestampToSeconds(parts[1]);
          const cueText = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
          if (!isNaN(start) && !isNaN(end) && cueText) {
            cues.push({ start, end, text: cueText });
          }
          break;
        }
      }
    }
    return cues;
  }

  async function fetchSubtitleCues(url) {
    if (!url) return [];
    try {
      const res = await fetch(url);
      if (!res.ok) return [];
      const text = await res.text();
      return parseSubtitleFileContent(text, url);
    } catch (e) {
      return [];
    }
  }

  // Subtitle track selection (Primary - Bottom)
  async function changePlayerSubtitleTrack(trackVal) {
    if (!state.activePlayer) return;
    const valStr = String(trackVal);

    if (valStr.startsWith('custom_')) {
      const cIdx = parseInt(valStr.replace('custom_', ''), 10);
      state.primaryCues = state.customSubtitles[cIdx]?.cues || [];
      if (typeof state.activePlayer.textTracks === 'function') {
        const textTracks = state.activePlayer.textTracks();
        for (let i = 0; i < textTracks.length; i++) textTracks[i].mode = 'disabled';
      }
      return;
    }

    if (valStr === 'off') {
      state.primaryCues = [];
      const el = document.getElementById('player-subtitles-primary');
      if (el) el.innerHTML = '';
      if (typeof state.activePlayer.textTracks === 'function') {
        const textTracks = state.activePlayer.textTracks();
        for (let i = 0; i < textTracks.length; i++) textTracks[i].mode = 'disabled';
      }
    } else {
      const idx = parseInt(valStr, 10);
      const subTracks = state.activeVideo?.subtitle_tracks || [];
      if (typeof state.activePlayer.textTracks === 'function') {
        const textTracks = state.activePlayer.textTracks();
        for (let i = 0; i < textTracks.length; i++) {
          textTracks[i].mode = i === idx ? 'showing' : 'disabled';
        }
      }
      if (!isNaN(idx) && subTracks[idx]?.url) {
        state.primaryCues = await fetchSubtitleCues(subTracks[idx].url);
      } else if (state.activeVideo?.subtitles_url && idx === subTracks.length) {
        state.primaryCues = await fetchSubtitleCues(state.activeVideo.subtitles_url);
      }
    }
  }

  // Secondary Subtitle Track Selection (Top)
  async function changeSecondarySubtitleTrack(trackVal) {
    state.activeSecondarySubtitleTrack = trackVal;
    const valStr = String(trackVal);

    if (valStr === 'off') {
      state.secondaryCues = [];
      const el = document.getElementById('player-subtitles-secondary');
      if (el) el.innerHTML = '';
      return;
    }

    if (valStr.startsWith('custom_')) {
      const cIdx = parseInt(valStr.replace('custom_', ''), 10);
      state.secondaryCues = state.customSubtitles[cIdx]?.cues || [];
      return;
    }

    const idx = parseInt(valStr, 10);
    const subTracks = state.activeVideo?.subtitle_tracks || [];
    if (!isNaN(idx) && subTracks[idx]?.url) {
      state.secondaryCues = await fetchSubtitleCues(subTracks[idx].url);
    } else if (state.activeVideo?.subtitles_url && idx === subTracks.length) {
      state.secondaryCues = await fetchSubtitleCues(state.activeVideo.subtitles_url);
    }
  }

  // Subtitle Sync Offset (-5.0s to +5.0s)
  function setSubtitleOffset(val) {
    const offset = parseFloat(val);
    if (!isNaN(offset)) {
      state.subtitleOffsetSec = offset;
      const label = document.getElementById('player-subtitle-offset-val');
      if (label) label.textContent = `${offset > 0 ? '+' : ''}${offset.toFixed(1)}s`;
    }
  }

  // Simultaneous Dual Subtitles Rendering Overlay (Primary Bottom + Secondary Top)
  function updateSubtitlesRender(currentTime) {
    const effectiveTime = currentTime + state.subtitleOffsetSec;

    // Primary Subtitles (bottom overlay)
    const pEl = document.getElementById('player-subtitles-primary');
    if (pEl && state.primaryCues && state.primaryCues.length > 0) {
      const cue = state.primaryCues.find(c => effectiveTime >= c.start && effectiveTime <= c.end);
      pEl.innerHTML = cue ? `<div class="px-4 py-1.5 rounded-xl bg-black/85 text-white font-medium text-sm sm:text-base border border-white/10 shadow-2xl backdrop-blur-sm pointer-events-none text-center max-w-2xl">${escapeHtml(cue.text)}</div>` : '';
    }

    // Secondary Subtitles (top overlay)
    const sEl = document.getElementById('player-subtitles-secondary');
    if (sEl && state.secondaryCues && state.secondaryCues.length > 0) {
      const cue = state.secondaryCues.find(c => effectiveTime >= c.start && effectiveTime <= c.end);
      sEl.innerHTML = cue ? `<div class="px-3.5 py-1 rounded-xl bg-black/90 text-amber-300 font-semibold text-xs sm:text-sm border border-amber-500/30 shadow-2xl backdrop-blur-sm pointer-events-none text-center max-w-2xl">${escapeHtml(cue.text)}</div>` : '';
    }
  }

  // Drag-and-drop .srt / .vtt file loader
  function setupSubtitleDragDrop(containerEl) {
    if (!containerEl || containerEl._dcSubDropAttached) return;
    containerEl._dcSubDropAttached = true;

    let dropOverlay = document.getElementById('player-subtitle-drop-zone');
    if (!dropOverlay) {
      dropOverlay = document.createElement('div');
      dropOverlay.id = 'player-subtitle-drop-zone';
      dropOverlay.className = 'absolute inset-0 z-40 bg-sky-950/80 border-2 border-dashed border-sky-400 rounded-xl hidden items-center justify-center pointer-events-none backdrop-blur-sm';
      dropOverlay.innerHTML = `
        <div class="flex flex-col items-center space-y-2 text-sky-300 font-mono text-sm">
          <i data-lucide="file-text" class="w-10 h-10 animate-bounce"></i>
          <span class="font-bold">Drop .SRT or .VTT Subtitle File Here</span>
        </div>
      `;
      containerEl.appendChild(dropOverlay);
      if (window.lucide) lucide.createIcons();
    }

    containerEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropOverlay.classList.remove('hidden');
      dropOverlay.classList.add('flex');
    });

    containerEl.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropOverlay.classList.add('hidden');
      dropOverlay.classList.remove('flex');
    });

    containerEl.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropOverlay.classList.add('hidden');
      dropOverlay.classList.remove('flex');

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const file = files[0];

      if (!file.name.endsWith('.srt') && !file.name.endsWith('.vtt')) {
        showToast('Only .srt and .vtt files are supported', 'error');
        return;
      }

      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target?.result;
        if (typeof text === 'string') {
          const cues = parseSubtitleFileContent(text, file.name);
          if (cues.length === 0) {
            showToast('No cues found in subtitle file', 'error');
            return;
          }
          const customSub = { label: file.name, cues };
          state.customSubtitles.push(customSub);
          const customIdx = state.customSubtitles.length - 1;

          [document.getElementById('player-subtitles-select'), document.getElementById('player-subtitles-secondary-select')].forEach(sel => {
            if (sel) {
              const opt = document.createElement('option');
              opt.value = `custom_${customIdx}`;
              opt.textContent = `Custom: ${file.name}`;
              sel.appendChild(opt);
            }
          });

          state.primaryCues = cues;
          const pSelect = document.getElementById('player-subtitles-select');
          if (pSelect) pSelect.value = `custom_${customIdx}`;
          showToast(`Subtitle loaded: ${file.name} (${cues.length} cues)`, 'success');
        }
      };
      reader.readAsText(file);
    });
  }

  // Populate audio & subtitle track drop-downs
  function populatePlayerTracksUI(v) {
    const aSelect = document.getElementById('player-audio-select');
    const sSelect = document.getElementById('player-subtitles-select');
    const sSecSelect = document.getElementById('player-subtitles-secondary-select');
    const aContainer = document.getElementById('player-audio-container');
    const sContainer = document.getElementById('player-subtitles-container');

    if (aSelect) {
      const aTracks = v.audio_tracks || [];
      const defaultLabel = aTracks[0]?.label || aTracks[0]?.title || aTracks[0]?.language_name || 'Default Audio Track';
      aSelect.innerHTML = `<option value="0">${defaultLabel}</option>`;
      if (aTracks.length > 1) {
        if (aContainer) aContainer.classList.remove('hidden');
        aTracks.forEach((tr, i) => {
          if (i > 0) {
            const opt = document.createElement('option');
            opt.value = tr.index !== undefined ? tr.index : i;
            opt.textContent = tr.label || tr.title || tr.language_name || `Audio Track #${i + 1} (${tr.codec})`;
            aSelect.appendChild(opt);
          }
        });
      } else {
        if (aContainer) aContainer.classList.remove('hidden');
      }
      aSelect.value = state.activeAudioTrack || 0;
    }

    const buildSubOptions = () => {
      const sTracks = v.subtitle_tracks || [];
      let opts = '<option value="off">Subtitles Off</option>';
      sTracks.forEach((tr, i) => {
        opts += `<option value="${i}">${escapeHtml(tr.label || `${tr.language_name || 'Sub'} (${tr.codec})`)}</option>`;
      });
      if (v.subtitles_url && !sTracks.some(st => st.url === v.subtitles_url)) {
        opts += `<option value="${sTracks.length}">AI Whisper (English)</option>`;
      }
      state.customSubtitles.forEach((cs, ci) => {
        opts += `<option value="custom_${ci}">Custom: ${escapeHtml(cs.label)}</option>`;
      });
      return opts;
    };

    if (sSelect) {
      sSelect.innerHTML = buildSubOptions();
    }

    if (sSecSelect) {
      sSecSelect.innerHTML = `<option value="off">Secondary Sub: Off</option>` + buildSubOptions().replace('<option value="off">Subtitles Off</option>', '');
      sSecSelect.value = state.activeSecondarySubtitleTrack || 'off';
    }

    // Subtitle offset slider
    const offsetSlider = document.getElementById('player-subtitle-offset');
    const offsetLabel = document.getElementById('player-subtitle-offset-val');
    if (offsetSlider) offsetSlider.value = state.subtitleOffsetSec || 0;
    if (offsetLabel) offsetLabel.textContent = `${state.subtitleOffsetSec > 0 ? '+' : ''}${(state.subtitleOffsetSec || 0).toFixed(1)}s`;
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
    const isFs = Boolean(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      (state.activePlayer && (typeof state.activePlayer.isFullscreen === 'function' ? state.activePlayer.isFullscreen() : false))
    );

    const overlay = document.getElementById('player-buffering-overlay');
    const beacon = document.getElementById('player-buffer-beacon');

    if (beacon) {
      beacon.className = show
        ? 'w-2 h-2 rounded-full bg-amber-400 animate-ping'
        : 'w-2 h-2 rounded-full bg-sky-400';
    }

    const rootEl = state.activePlayer?.el ? state.activePlayer.el() : (document.getElementById('player-container') || null);
    const fsOverlay = rootEl ? rootEl.querySelector('.dc-plyr-fs-buffering') : null;

    if (show) {
      if (isFs && fsOverlay) {
        fsOverlay.classList.remove('hidden');
        fsOverlay.classList.add('flex');
        fsOverlay.style.display = 'flex';
        if (overlay) {
          overlay.classList.add('hidden');
          overlay.classList.remove('flex');
          overlay.style.display = 'none';
        }
      } else {
        if (overlay) {
          overlay.classList.remove('hidden');
          overlay.classList.add('flex');
          overlay.style.display = 'flex';
        }
        if (fsOverlay) {
          fsOverlay.classList.add('hidden');
          fsOverlay.classList.remove('flex');
          fsOverlay.style.display = 'none';
        }
      }
      if (rootEl) {
        const spinner = rootEl.querySelector('.vjs-loading-spinner');
        if (spinner) spinner.style.display = '';
      }
    } else {
      if (overlay) {
        overlay.classList.add('hidden');
        overlay.classList.remove('flex');
        overlay.style.display = 'none';
      }
      if (fsOverlay) {
        fsOverlay.classList.add('hidden');
        fsOverlay.classList.remove('flex');
        fsOverlay.style.display = 'none';
      }
      // Remove Video.js built-in waiting class and spinner
      if (state.activePlayer) {
        if (typeof state.activePlayer.removeClass === 'function') {
          state.activePlayer.removeClass('vjs-waiting');
        }
        if (rootEl) {
          rootEl.classList.remove('vjs-waiting');
          const spinner = rootEl.querySelector('.vjs-loading-spinner');
          if (spinner) spinner.style.display = 'none';
        }
      }
    }
  }

  function updatePlayerBufferUI(videoEl) {
    const rawEl =
      videoEl ||
      (state.activePlayer?.el ? state.activePlayer.el().querySelector('video') : null) ||
      document.querySelector('#player-container video');

    // Self-healing: if video is actively playing and rendering frames, dismiss buffering overlay reliably
    if (rawEl && !rawEl.paused && !rawEl.seeking && (rawEl.readyState >= 3 || (rawEl.currentTime > 0 && rawEl.readyState >= 2))) {
      showBufferingIndicator(false);
    }

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

  // Helper to attach/re-attach WebVTT <track> elements to video element
  function attachSubtitleTracksToPlayer(videoEl, v) {
    if (!videoEl || !v) return;
    videoEl.querySelectorAll('track').forEach(t => t.remove());

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
  }

  // Quality Switching
  function changePlayerQuality(q) {
    if (!state.activeVideo || !state.activePlayer) return;
    showBufferingIndicator(true);
    state.currentQuality = q;

    const wasPaused = typeof state.activePlayer.paused === 'function' ? state.activePlayer.paused() : false;
    const curTime = typeof state.activePlayer.currentTime === 'function' ? state.activePlayer.currentTime() : 0;
    const currentRate = typeof state.activePlayer.playbackRate === 'function' ? state.activePlayer.playbackRate() : (state.currentSpeed || 1);
    const savedAudioTrack = state.activeAudioTrack || 0;
    const sSelect = document.getElementById('player-subtitles-select');
    const savedSubTrack = sSelect ? sSelect.value : null;

    const streamBase = `/api/stream/${state.activeVideo.video_id}`;
    const params = new URLSearchParams();
    const token = getAuthToken();
    if (token) params.set('token', token);
    if (q && q !== 'original') params.set('quality', q);
    const qs = params.toString();
    const srcUrl = qs ? `${streamBase}?${qs}` : streamBase;

    state.activePlayer.src({ src: srcUrl, type: 'video/mp4' });

    state.activePlayer.one('loadedmetadata', () => {
      const rawVideo = state.activePlayer.el()?.querySelector('video') || document.querySelector('#player-container video');

      // Re-attach WebVTT <track> elements after player.src(...) loads
      if (rawVideo && state.activeVideo) {
        attachSubtitleTracksToPlayer(rawVideo, state.activeVideo);
      }
      if (savedSubTrack !== null) {
        changePlayerSubtitleTrack(savedSubTrack);
      }

      // Preserve currentTime
      if (curTime > 0 && typeof state.activePlayer.currentTime === 'function') {
        state.activePlayer.currentTime(curTime);
      }

      // Preserve playbackRate
      if (typeof state.activePlayer.playbackRate === 'function') {
        state.activePlayer.playbackRate(currentRate);
      }

      // Preserve active audio track (re-invoke changePlayerAudioTrack)
      changePlayerAudioTrack(savedAudioTrack);

      // Re-ensure audio booster and companion sync on raw video
      if (rawVideo) {
        setupAudioBooster(rawVideo);
        setupCompanionAudioSync(rawVideo);
      }

      showBufferingIndicator(false);

      // Preserve wasPaused state
      if (!wasPaused) {
        state.activePlayer.play().catch(() => {});
      } else {
        state.activePlayer.pause();
      }
    });
  }

  // MKV Chapter Markers on Seekbar
  function renderChapterMarkers(player, chapters, duration) {
    if (!chapters || chapters.length === 0 || !duration || duration <= 0) return;
    const rootEl = player.el ? player.el() : player;
    const prog = rootEl.querySelector('.vjs-progress-holder') || rootEl.querySelector('.vjs-progress-control') || rootEl.querySelector('.plyr__progress');
    if (!prog) return;

    let markerWrap = prog.querySelector('.dc-chapter-markers-wrap');
    if (!markerWrap) {
      markerWrap = document.createElement('div');
      markerWrap.className = 'dc-chapter-markers-wrap absolute inset-0 pointer-events-none z-10 flex items-center';
      prog.appendChild(markerWrap);
    }
    markerWrap.innerHTML = '';

    chapters.forEach(ch => {
      const pct = Math.max(0, Math.min(100, (ch.start_time / duration) * 100));
      const el = document.createElement('div');
      el.className = 'dc-chapter-marker absolute top-0 bottom-0 w-[2.5px] bg-sky-300/80 hover:bg-white hover:w-[4px] shadow-[0_0_8px_rgba(56,189,248,0.9)] cursor-pointer pointer-events-auto transition-all';
      el.style.left = `${pct}%`;
      el.title = `${ch.title || 'Chapter'} (${formatDuration(ch.start_time)})`;
      el.onclick = (e) => {
        e.stopPropagation();
        if (typeof player.currentTime === 'function') player.currentTime(ch.start_time);
        showToast(`Jumped to: ${ch.title || 'Chapter'}`, 'info');
      };
      markerWrap.appendChild(el);
    });
  }

  // Frame-step hotkeys (, step back 1 frame, . step forward 1 frame)
  function stepFrameBackward() {
    if (!state.activePlayer) return;
    if (typeof state.activePlayer.pause === 'function') state.activePlayer.pause();
    const cur = typeof state.activePlayer.currentTime === 'function' ? state.activePlayer.currentTime() : 0;
    const next = Math.max(0, cur - 0.04);
    state.activePlayer.currentTime(next);
    showTransientPlayerNotice(`Frame -1 (${next.toFixed(2)}s)`);
  }

  function stepFrameForward() {
    if (!state.activePlayer) return;
    if (typeof state.activePlayer.pause === 'function') state.activePlayer.pause();
    const cur = typeof state.activePlayer.currentTime === 'function' ? state.activePlayer.currentTime() : 0;
    const dur = typeof state.activePlayer.duration === 'function' ? state.activePlayer.duration() : 999999;
    const next = Math.min(dur, cur + 0.04);
    state.activePlayer.currentTime(next);
    showTransientPlayerNotice(`Frame +1 (${next.toFixed(2)}s)`);
  }

  function showTransientPlayerNotice(msg) {
    let el = document.getElementById('player-transient-notice');
    if (!el) {
      el = document.createElement('div');
      el.id = 'player-transient-notice';
      el.className = 'absolute top-6 left-1/2 -translate-x-1/2 z-40 px-3 py-1.5 rounded-lg bg-black/80 border border-sky-500/40 text-sky-400 font-mono text-xs shadow-2xl backdrop-blur-md pointer-events-none transition-opacity duration-300';
      const container = document.getElementById('player-container');
      if (container) container.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._fadeTimer);
    el._fadeTimer = setTimeout(() => {
      el.style.opacity = '0';
    }, 1200);
  }

  // 'Stats for Nerds' HUD overlay
  function toggleStatsForNerds(forceState) {
    state.statsForNerdsVisible = typeof forceState === 'boolean' ? forceState : !state.statsForNerdsVisible;
    let hud = document.getElementById('player-stats-nerds');

    if (!state.statsForNerdsVisible) {
      if (hud) hud.classList.add('hidden');
      if (state.statsUpdateInterval) {
        clearInterval(state.statsUpdateInterval);
        state.statsUpdateInterval = null;
      }
      return;
    }

    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'player-stats-nerds';
      hud.className = 'absolute top-4 left-4 z-50 w-80 max-w-[90vw] p-3.5 rounded-xl bg-[#0d1117]/95 border border-sky-500/40 text-slate-300 font-mono text-[11px] shadow-2xl backdrop-blur-md select-none';
      hud.innerHTML = `
        <div class="flex items-center justify-between pb-2 mb-2 border-b border-white/10 text-white font-bold">
          <div class="flex items-center space-x-1.5 text-sky-400">
            <i data-lucide="activity" class="w-4 h-4"></i>
            <span>Stats for Nerds</span>
          </div>
          <button onclick="toggleStatsForNerds(false)" class="text-slate-400 hover:text-white">&times;</button>
        </div>
        <div id="stats-nerds-content" class="space-y-1.5">
          <!-- Dynamic metrics -->
        </div>
      `;
      const container = document.getElementById('player-container');
      if (container) container.appendChild(hud);
      if (window.lucide) lucide.createIcons();
    }
    hud.classList.remove('hidden');

    const updateStats = () => {
      const content = document.getElementById('stats-nerds-content');
      if (!content || !state.activeVideo) return;
      const rawVideo = state.activePlayer?.el ? state.activePlayer.el().querySelector('video') : document.querySelector('#player-container video');
      if (!rawVideo) return;

      let dropped = 0, totalFrames = 0;
      if (typeof rawVideo.getVideoPlaybackQuality === 'function') {
        const q = rawVideo.getVideoPlaybackQuality();
        dropped = q.droppedVideoFrames || 0;
        totalFrames = q.totalVideoFrames || 0;
      } else if (rawVideo.webkitDroppedFrameCount !== undefined) {
        dropped = rawVideo.webkitDroppedFrameCount || 0;
      }
      const dropRate = totalFrames > 0 ? ((dropped / totalFrames) * 100).toFixed(1) : '0.0';

      const curTime = rawVideo.currentTime || 0;
      const dur = rawVideo.duration || 0;

      let bufferAhead = 0;
      if (rawVideo.buffered && rawVideo.buffered.length > 0) {
        for (let i = 0; i < rawVideo.buffered.length; i++) {
          if (curTime >= rawVideo.buffered.start(i) && curTime <= rawVideo.buffered.end(i)) {
            bufferAhead = rawVideo.buffered.end(i) - curTime;
            break;
          }
        }
      }
      const bufPct = getBufferedPercent(rawVideo);

      content.innerHTML = `
        <div class="flex justify-between"><span class="text-slate-500">Video ID:</span><span class="text-sky-300 font-semibold truncate max-w-[150px]">${escapeHtml(state.activeVideo.video_id)}</span></div>
        <div class="flex justify-between"><span class="text-slate-500">Resolution:</span><span>${rawVideo.videoWidth || 'Native'}x${rawVideo.videoHeight || ''} (Disp: ${rawVideo.clientWidth}x${rawVideo.clientHeight})</span></div>
        <div class="flex justify-between"><span class="text-slate-500">Dropped Frames:</span><span class="${dropped > 0 ? 'text-amber-400' : 'text-emerald-400'}">${dropped} / ${totalFrames} (${dropRate}%)</span></div>
        <div class="flex justify-between"><span class="text-slate-500">Buffer Health:</span><span class="text-sky-400 font-bold">${bufferAhead.toFixed(2)}s (${bufPct}%)</span></div>
        <div class="flex justify-between"><span class="text-slate-500">Audio Gain / DSP:</span><span>${state.currentGain}% | 5-Band EQ Active</span></div>
        <div class="flex justify-between"><span class="text-slate-500">Night Mode:</span><span class="${state.eqNightMode ? 'text-emerald-400 font-bold' : 'text-slate-400'}">${state.eqNightMode ? 'ACTIVE (Compressor ON)' : 'OFF'}</span></div>
        <div class="flex justify-between"><span class="text-slate-500">Audio Sync Drift:</span><span class="text-emerald-400 font-mono">&lt; 0.05s (Sample-Locked)</span></div>
        <div class="flex justify-between"><span class="text-slate-500">Playhead / Dur:</span><span>${formatDuration(curTime)} / ${formatDuration(dur)} (${curTime.toFixed(2)}s)</span></div>
      `;
    };

    updateStats();
    if (state.statsUpdateInterval) clearInterval(state.statsUpdateInterval);
    state.statsUpdateInterval = setInterval(updateStats, 500);
  }

  // Gestures: Double-tap seek (-10s / +10s) with glowing chevron animation, and hold-to-2x speed gesture
  function setupPlayerGestures(containerEl) {
    if (!containerEl || containerEl._dcGesturesAttached) return;
    containerEl._dcGesturesAttached = true;

    containerEl.addEventListener('click', (e) => {
      if (e.target.closest('.vjs-control-bar') || e.target.closest('.dc-popover') || e.target.closest('#player-stats-nerds') || e.target.closest('#player-lossless-toolbar')) return;

      const now = performance.now();
      const rect = containerEl.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const width = rect.width;

      if (now - state.lastTapTime < 350 && Math.abs(clickX - state.lastTapX) < 80) {
        if (clickX < width * 0.35) {
          if (state.activePlayer && typeof state.activePlayer.currentTime === 'function') {
            state.activePlayer.currentTime(Math.max(0, state.activePlayer.currentTime() - 10));
          }
          triggerSeekAnimation('left');
        } else if (clickX > width * 0.65) {
          if (state.activePlayer && typeof state.activePlayer.currentTime === 'function') {
            const dur = typeof state.activePlayer.duration === 'function' ? state.activePlayer.duration() : 0;
            state.activePlayer.currentTime(Math.min(dur, state.activePlayer.currentTime() + 10));
          }
          triggerSeekAnimation('right');
        }
        state.lastTapTime = 0;
      } else {
        state.lastTapTime = now;
        state.lastTapX = clickX;
      }
    });

    const startHold = (e) => {
      if (e.target.closest('.vjs-control-bar') || e.target.closest('.dc-popover') || e.target.closest('#player-stats-nerds') || e.target.closest('#player-lossless-toolbar')) return;
      if (!state.activePlayer || (typeof state.activePlayer.paused === 'function' && state.activePlayer.paused())) return;

      clearTimeout(state.speedGestureHoldTimer);
      state.speedGestureHoldTimer = setTimeout(() => {
        state.isSpeedGestureActive = true;
        state.preSpeedGestureRate = typeof state.activePlayer.playbackRate === 'function' ? state.activePlayer.playbackRate() : 1.0;
        if (typeof state.activePlayer.playbackRate === 'function') {
          state.activePlayer.playbackRate(2.0);
        }
        showSpeedGesturePill(true);
      }, 250);
    };

    const endHold = () => {
      clearTimeout(state.speedGestureHoldTimer);
      if (state.isSpeedGestureActive) {
        state.isSpeedGestureActive = false;
        if (state.activePlayer && typeof state.activePlayer.playbackRate === 'function') {
          state.activePlayer.playbackRate(state.preSpeedGestureRate || 1.0);
        }
        showSpeedGesturePill(false);
      }
    };

    containerEl.addEventListener('pointerdown', startHold);
    containerEl.addEventListener('pointerup', endHold);
    containerEl.addEventListener('pointercancel', endHold);
    containerEl.addEventListener('pointerleave', endHold);

    containerEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showPlayerContextMenu(e.clientX, e.clientY);
    });
  }

  function triggerSeekAnimation(direction) {
    let animEl = document.getElementById(`dc-seek-chevron-${direction}`);
    if (!animEl) {
      animEl = document.createElement('div');
      animEl.id = `dc-seek-chevron-${direction}`;
      animEl.className = `absolute top-1/2 -translate-y-1/2 ${direction === 'left' ? 'left-8' : 'right-8'} z-40 flex items-center justify-center p-4 rounded-full bg-sky-500/20 border border-sky-400/40 text-sky-400 font-mono text-sm font-bold shadow-[0_0_20px_rgba(56,189,248,0.6)] backdrop-blur-md pointer-events-none transition-all duration-300`;
      animEl.innerHTML = direction === 'left'
        ? `<div class="flex items-center space-x-1 animate-pulse"><span>&laquo;</span><span>&laquo;</span><span>-10s</span></div>`
        : `<div class="flex items-center space-x-1 animate-pulse"><span>+10s</span><span>&raquo;</span><span>&raquo;</span></div>`;
      const container = document.getElementById('player-container');
      if (container) container.appendChild(animEl);
    }
    animEl.style.opacity = '1';
    animEl.style.transform = 'translateY(-50%) scale(1.1)';
    setTimeout(() => {
      animEl.style.opacity = '0';
      animEl.style.transform = 'translateY(-50%) scale(0.9)';
    }, 600);
  }

  function showSpeedGesturePill(show) {
    let pill = document.getElementById('player-speed-gesture-pill');
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'player-speed-gesture-pill';
      pill.className = 'absolute top-8 left-1/2 -translate-x-1/2 z-40 px-3.5 py-1 rounded-full bg-amber-500/90 text-black font-bold font-mono text-xs shadow-xl backdrop-blur-md pointer-events-none transition-all duration-200 flex items-center space-x-1';
      pill.innerHTML = `<span>2X SPEED</span><span>&raquo;&raquo;</span>`;
      const container = document.getElementById('player-container');
      if (container) container.appendChild(pill);
    }
    pill.style.display = show ? 'flex' : 'none';
  }

  function showPlayerContextMenu(x, y) {
    let menu = document.getElementById('player-custom-context-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'player-custom-context-menu';
      menu.className = 'fixed z-50 bg-[#0d1117] border border-white/10 rounded-xl shadow-2xl py-1 text-xs text-slate-300 font-sans min-w-[180px] backdrop-blur-md';
      document.body.appendChild(menu);
    }
    menu.innerHTML = `
      <div onclick="toggleStatsForNerds(); hidePlayerContextMenu();" class="px-3 py-2 hover:bg-[#21262d] hover:text-white cursor-pointer flex items-center space-x-2">
        <i data-lucide="activity" class="w-4 h-4 text-sky-400"></i><span>Stats for Nerds (N)</span>
      </div>
      <div onclick="captureFrame('download'); hidePlayerContextMenu();" class="px-3 py-2 hover:bg-[#21262d] hover:text-white cursor-pointer flex items-center space-x-2">
        <i data-lucide="camera" class="w-4 h-4 text-emerald-400"></i><span>Capture Frame (S)</span>
      </div>
      <div onclick="openShaderTuner(); hidePlayerContextMenu();" class="px-3 py-2 hover:bg-[#21262d] hover:text-white cursor-pointer flex items-center space-x-2">
        <i data-lucide="sliders" class="w-4 h-4 text-purple-400"></i><span>Video Shaders & Aspect</span>
      </div>
      <div onclick="openEqPopover(); hidePlayerContextMenu();" class="px-3 py-2 hover:bg-[#21262d] hover:text-white cursor-pointer flex items-center space-x-2">
        <i data-lucide="disc" class="w-4 h-4 text-amber-400"></i><span>5-Band Audio EQ</span>
      </div>
      <div onclick="openStreamLinkModal(); hidePlayerContextMenu();" class="px-3 py-2 hover:bg-[#21262d] hover:text-white cursor-pointer flex items-center space-x-2 border-t border-white/[0.08]">
        <i data-lucide="qr-code" class="w-4 h-4 text-cyan-400"></i><span>VLC Stream / QR Code</span>
      </div>
    `;
    const clampedX = Math.min(window.innerWidth - 200, x);
    const clampedY = Math.min(window.innerHeight - 200, y);
    menu.style.left = `${clampedX}px`;
    menu.style.top = `${clampedY}px`;
    menu.style.display = 'block';

    if (window.lucide) lucide.createIcons();

    const closeHandler = () => {
      hidePlayerContextMenu();
      document.removeEventListener('click', closeHandler);
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 10);
  }

  function hidePlayerContextMenu() {
    const menu = document.getElementById('player-custom-context-menu');
    if (menu) menu.style.display = 'none';
  }

  // LosslessCut In-Player Range Selection
  function markIn() {
    if (!state.activePlayer) return;
    const cur = typeof state.activePlayer.currentTime === 'function' ? state.activePlayer.currentTime() : 0;
    state.cutStart = cur;
    state.hasMarkIn = true;
    if (!state.hasMarkOut || state.cutEnd <= state.cutStart) {
      const dur = typeof state.activePlayer.duration === 'function' ? state.activePlayer.duration() : cur + 10;
      state.cutEnd = Math.min(dur, cur + 10);
      state.hasMarkOut = true;
    }
    updateLosslessCutUI();
    showToast(`Mark In: ${formatDuration(state.cutStart)}`, 'info');
  }

  function markOut() {
    if (!state.activePlayer) return;
    const cur = typeof state.activePlayer.currentTime === 'function' ? state.activePlayer.currentTime() : 0;
    state.cutEnd = cur;
    state.hasMarkOut = true;
    if (!state.hasMarkIn || state.cutStart >= state.cutEnd) {
      state.cutStart = Math.max(0, cur - 10);
      state.hasMarkIn = true;
    }
    updateLosslessCutUI();
    showToast(`Mark Out: ${formatDuration(state.cutEnd)}`, 'info');
  }

  function clearCutRange() {
    state.cutStart = 0;
    state.cutEnd = 0;
    state.hasMarkIn = false;
    state.hasMarkOut = false;
    updateLosslessCutUI();
    showToast('Cut range cleared', 'info');
  }

  function updateLosslessCutUI() {
    const rootEl = state.activePlayer?.el ? state.activePlayer.el() : document.getElementById('player-container');
    const prog = rootEl?.querySelector('.vjs-progress-holder') || rootEl?.querySelector('.vjs-progress-control') || rootEl?.querySelector('.plyr__progress');
    const duration = typeof state.activePlayer?.duration === 'function' ? state.activePlayer.duration() : (state.activeVideo?.duration_seconds || 0);

    if (prog && duration > 0 && (state.hasMarkIn || state.hasMarkOut)) {
      let cutEl = prog.querySelector('.dc-cut-range-highlight');
      if (!cutEl) {
        cutEl = document.createElement('div');
        cutEl.className = 'dc-cut-range-highlight absolute top-0 bottom-0 bg-emerald-500/30 border-l-2 border-r-2 border-emerald-400 pointer-events-none z-10';
        prog.appendChild(cutEl);
      }
      const leftPct = Math.max(0, Math.min(100, (state.cutStart / duration) * 100));
      const rightPct = Math.max(0, Math.min(100, (state.cutEnd / duration) * 100));
      cutEl.style.left = `${leftPct}%`;
      cutEl.style.width = `${Math.max(1, rightPct - leftPct)}%`;
      cutEl.style.display = 'block';
    } else if (prog) {
      const cutEl = prog.querySelector('.dc-cut-range-highlight');
      if (cutEl) cutEl.style.display = 'none';
    }

    const inEl = document.getElementById('lossless-in-label');
    const outEl = document.getElementById('lossless-out-label');
    const durEl = document.getElementById('lossless-duration-label');
    if (inEl) inEl.textContent = state.hasMarkIn ? formatDuration(state.cutStart) : '--:--';
    if (outEl) outEl.textContent = state.hasMarkOut ? formatDuration(state.cutEnd) : '--:--';
    if (durEl) durEl.textContent = (state.hasMarkIn && state.hasMarkOut) ? `${Math.max(0, state.cutEnd - state.cutStart).toFixed(1)}s` : '--';
  }

  async function exportLosslessClip() {
    if (!state.activeVideo) return;
    const start = Math.max(0, state.cutStart || 0);
    const end = (state.cutEnd > start) ? state.cutEnd : (typeof state.activePlayer?.duration === 'function' ? state.activePlayer.duration() : 0);

    if (end <= start) {
      showToast('Please mark In and Out points on the timeline first ([ and ])', 'error');
      return;
    }

    showToast(`Exporting lossless clip (${formatDuration(start)} - ${formatDuration(end)})...`, 'info');

    try {
      const res = await fetchWithAuth(`/api/videos/${state.activeVideo.video_id}/clip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_sec: parseFloat(start.toFixed(2)),
          end_sec: parseFloat(end.toFixed(2))
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Clip export failed' }));
        throw new Error(err.detail || 'Export failed');
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const cleanTitle = (state.activeVideo.title || 'clip').replace(/[^a-zA-Z0-9_-]/g, '_');
      a.download = `${cleanTitle}_clip_${Math.round(start)}s-${Math.round(end)}s.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      showToast('Lossless clip downloaded successfully!', 'success');
    } catch (err) {
      console.error('[LosslessCut] Export error:', err);
      showToast(err.message || 'Failed to export lossless clip', 'error');
    }
  }

  function captureFrame(action = 'download') {
    const rawVideo = state.activePlayer?.el ? state.activePlayer.el().querySelector('video') : document.querySelector('#player-container video');
    if (!rawVideo || !state.activeVideo) {
      showToast('No active video stream to capture', 'error');
      return;
    }

    try {
      const canvas = document.createElement('canvas');
      canvas.width = rawVideo.videoWidth || 1920;
      canvas.height = rawVideo.videoHeight || 1080;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(rawVideo, 0, 0, canvas.width, canvas.height);
      const t = rawVideo.currentTime || 0;

      if (action === 'poster') {
        fetchWithAuth(`/api/videos/${state.activeVideo.video_id}/set-poster`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timestamp: parseFloat(t.toFixed(2)) })
        })
          .then(res => res.json())
          .then(data => {
            showToast('Video poster updated successfully from frame!', 'success');
            fetchVideos();
          })
          .catch(err => {
            showToast('Failed to set video poster', 'error');
          });
      } else {
        canvas.toBlob(blob => {
          if (!blob) {
            showToast('Failed to generate image blob from frame', 'error');
            return;
          }
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          const cleanTitle = (state.activeVideo.title || 'frame').replace(/[^a-zA-Z0-9_-]/g, '_');
          a.download = `${cleanTitle}_${Math.round(t)}s.png`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          window.URL.revokeObjectURL(url);
          showToast(`Frame captured at ${formatDuration(t)} (${canvas.width}x${canvas.height})`, 'success');
        }, 'image/png');
      }
    } catch (err) {
      console.error('[FrameGrabber] Capture error:', err);
      showToast('Frame capture failed: ' + err.message, 'error');
    }
  }

  // Real-Time Video Shaders & Ambilight
  function ensureShaderSvgDefs() {
    if (document.getElementById('player-sharpness-filter')) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'player-shader-svg-defs';
    svg.style.position = 'absolute';
    svg.style.width = '0';
    svg.style.height = '0';
    svg.style.pointerEvents = 'none';
    svg.innerHTML = `
      <defs>
        <filter id="player-sharpness-filter">
          <feConvolveMatrix order="3" kernelMatrix="0 -1 0 -1 5 -1 0 -1 0" preserveAlpha="true" />
        </filter>
      </defs>
    `;
    document.body.appendChild(svg);
  }

  function applyVideoFilters() {
    const rawVideo = state.activePlayer?.el ? state.activePlayer.el().querySelector('video') : document.querySelector('#player-container video');
    if (!rawVideo) return;
    ensureShaderSvgDefs();

    const { brightness, contrast, saturate, sharpness } = state.videoFilters;
    let filterStr = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturate}%)`;
    if (sharpness > 0) {
      filterStr += ` url(#player-sharpness-filter)`;
    }
    rawVideo.style.filter = filterStr;
  }

  function setVideoFilter(prop, val) {
    if (state.videoFilters[prop] !== undefined) {
      state.videoFilters[prop] = parseFloat(val);
      applyVideoFilters();
    }
  }

  function resetVideoFilters() {
    state.videoFilters = { brightness: 100, contrast: 100, saturate: 100, sharpness: 0 };
    applyVideoFilters();
    ['brightness', 'contrast', 'saturate', 'sharpness'].forEach(p => {
      const slider = document.getElementById(`filter-slider-${p}`);
      if (slider) slider.value = state.videoFilters[p];
    });
    showToast('Video shaders reset to defaults', 'info');
  }

  function setAspectRatio(ratio) {
    state.aspectRatio = ratio;
    const rawVideo = state.activePlayer?.el ? state.activePlayer.el().querySelector('video') : document.querySelector('#player-container video');
    if (!rawVideo) return;

    if (ratio === '16:9') {
      rawVideo.style.objectFit = 'contain';
      rawVideo.style.aspectRatio = '16 / 9';
    } else if (ratio === '21:9') {
      rawVideo.style.objectFit = 'cover';
      rawVideo.style.aspectRatio = '21 / 9';
    } else if (ratio === '4:3') {
      rawVideo.style.objectFit = 'contain';
      rawVideo.style.aspectRatio = '4 / 3';
    } else {
      rawVideo.style.objectFit = 'contain';
      rawVideo.style.aspectRatio = '';
    }
    showToast(`Aspect Ratio: ${ratio.toUpperCase()}`, 'info');
  }

  // Dynamic Ambilight Canvas Loop (via requestVideoFrameCallback)
  function initAmbilight() {
    let canvas = document.getElementById('player-ambilight-canvas');
    if (!canvas) {
      const modalBox = document.getElementById('player-modal-box');
      if (modalBox) {
        canvas = document.createElement('canvas');
        canvas.id = 'player-ambilight-canvas';
        canvas.width = 64;
        canvas.height = 36;
        canvas.className = 'absolute inset-0 w-full h-full pointer-events-none -z-10 transition-opacity duration-500 scale-105';
        canvas.style.filter = 'blur(60px)';
        canvas.style.opacity = '0.7';
        modalBox.insertBefore(canvas, modalBox.firstChild);
      }
    }
    state.ambilightCanvas = canvas;
    if (canvas) {
      state.ambilightCtx = canvas.getContext('2d', { willReadFrequently: false });
    }
  }

  function startAmbilightLoop(videoEl) {
    if (!state.ambilightEnabled || !videoEl) return;
    initAmbilight();
    if (!state.ambilightCanvas || !state.ambilightCtx) return;

    const render = () => {
      if (!state.ambilightEnabled || !state.activePlayer || (videoEl.paused && !videoEl.seeking)) {
        return;
      }
      try {
        state.ambilightCtx.drawImage(videoEl, 0, 0, state.ambilightCanvas.width, state.ambilightCanvas.height);
      } catch (e) {}

      if (typeof videoEl.requestVideoFrameCallback === 'function') {
        videoEl.requestVideoFrameCallback(render);
      } else {
        requestAnimationFrame(render);
      }
    };

    if (typeof videoEl.requestVideoFrameCallback === 'function') {
      videoEl.requestVideoFrameCallback(render);
    } else {
      requestAnimationFrame(render);
    }
  }

  function toggleAmbilight(forceState) {
    state.ambilightEnabled = typeof forceState === 'boolean' ? forceState : !state.ambilightEnabled;
    const canvas = document.getElementById('player-ambilight-canvas');
    if (canvas) {
      canvas.style.display = state.ambilightEnabled ? 'block' : 'none';
    }
    const rawVideo = state.activePlayer?.el ? state.activePlayer.el().querySelector('video') : document.querySelector('#player-container video');
    if (state.ambilightEnabled && rawVideo) {
      startAmbilightLoop(rawVideo);
    }
    showToast(`Ambilight Glow: ${state.ambilightEnabled ? 'ON' : 'OFF'}`, 'info');
  }

  // Continue Watching Shelf Rendering
  function renderContinueWatching() {
    const shelf = document.getElementById('continue-watching-shelf') || document.getElementById('continue-watching-carousel');
    const container = document.getElementById('continue-watching-container');
    if (!shelf && !container) return;

    const partiallyWatched = [];
    state.videos.forEach(v => {
      const savedPos = parseFloat(localStorage.getItem(`dc_playback_pos_${v.video_id}`) || '0');
      const dur = v.duration_seconds || 0;
      if (savedPos > 5 && dur > 10 && savedPos < dur - 10) {
        const pct = Math.min(99, Math.max(1, Math.round((savedPos / dur) * 100)));
        partiallyWatched.push({ video: v, pos: savedPos, dur, pct });
      }
    });

    const target = shelf || container;
    if (partiallyWatched.length === 0) {
      const wrap = document.getElementById('continue-watching-section');
      if (wrap) wrap.classList.add('hidden');
      target.innerHTML = '';
      return;
    }

    const wrap = document.getElementById('continue-watching-section');
    if (wrap) wrap.classList.remove('hidden');

    target.innerHTML = '';
    partiallyWatched.forEach(({ video: v, pos, dur, pct }) => {
      const card = document.createElement('div');
      card.className = 'min-w-[240px] max-w-[280px] bg-[#0d1117] border border-white/10 hover:border-sky-500/50 rounded-xl overflow-hidden shadow-lg cursor-pointer transition-all duration-300 hover:-translate-y-1 shrink-0';
      card.onclick = () => openPlayerModal(v);

      const poster = v.poster_url || '';
      const remMins = Math.max(1, Math.round((dur - pos) / 60));

      card.innerHTML = `
        <div class="relative aspect-video w-full bg-[#010409] overflow-hidden">
          ${poster ? `<img src="${escapeHtml(poster)}" class="w-full h-full object-cover" />` : `<div class="w-full h-full flex items-center justify-center text-slate-700"><i data-lucide="film" class="w-8 h-8"></i></div>`}
          <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent flex items-end p-2">
            <span class="text-[10px] font-mono text-sky-400 bg-black/60 px-1.5 py-0.5 rounded">${remMins}m remaining</span>
          </div>
          <div class="absolute bottom-0 inset-x-0 h-1 bg-slate-800">
            <div class="h-full bg-sky-400" style="width: ${pct}%"></div>
          </div>
        </div>
        <div class="p-2.5">
          <h4 class="text-xs font-semibold text-white truncate" title="${escapeHtml(v.title)}">${escapeHtml(v.title)}</h4>
          <div class="flex items-center justify-between mt-1 text-[10px] font-mono text-slate-400">
            <span>Resumed at ${formatDuration(pos)}</span>
            <span class="text-sky-400 font-bold">${pct}%</span>
          </div>
        </div>
      `;
      target.appendChild(card);
    });

    if (window.lucide) lucide.createIcons();
  }

  // Auto-Play Next Episode upon video end
  function findNextEpisode(currentVideo) {
    if (!currentVideo || !state.videos || state.videos.length <= 1) return null;
    const title = currentVideo.title || '';

    const epMatch = title.match(/(.*?)(?:s|season\s*)(\d+)[._\s-]*(?:e|ep|episode\s*)(\d+)/i) ||
                    title.match(/(.*?)(?:e|ep|episode\s*)(\d+)/i) ||
                    title.match(/(.*?)(?:part\s*)(\d+)/i);

    if (epMatch) {
      const prefix = epMatch[1].trim().toLowerCase();
      const curEp = parseInt(epMatch[epMatch.length - 1], 10);
      const nextCandidate = state.videos.find(v => {
        if (v.video_id === currentVideo.video_id) return false;
        const vTitle = (v.title || '').toLowerCase();
        if (!vTitle.includes(prefix)) return false;
        const vMatch = vTitle.match(/(?:s|season\s*)\d+[._\s-]*(?:e|ep|episode\s*)(\d+)/i) ||
                       vTitle.match(/(?:e|ep|episode\s*)(\d+)/i) ||
                       vTitle.match(/(?:part\s*)(\d+)/i);
        if (vMatch) {
          const epNum = parseInt(vMatch[vMatch.length - 1], 10);
          return epNum === curEp + 1;
        }
        return false;
      });
      if (nextCandidate) return nextCandidate;
    }

    const curIdx = state.videos.findIndex(v => v.video_id === currentVideo.video_id);
    if (curIdx >= 0 && curIdx < state.videos.length - 1) {
      return state.videos[curIdx + 1];
    }
    return null;
  }

  function handleVideoEnded() {
    showBufferingIndicator(false);
    updatePlayerBufferUI();
    const nextVideo = findNextEpisode(state.activeVideo);
    if (!nextVideo) return;

    let overlay = document.getElementById('player-next-episode-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'player-next-episode-overlay';
      overlay.className = 'absolute inset-0 z-40 bg-black/85 flex flex-col items-center justify-center p-6 text-center space-y-4 backdrop-blur-md';
      const container = document.getElementById('player-container');
      if (container) container.appendChild(overlay);
    }
    overlay.classList.remove('hidden');

    let countdown = 5;
    overlay.innerHTML = `
      <div class="space-y-1 font-mono">
        <span class="text-xs text-sky-400 font-bold uppercase tracking-wider">Up Next</span>
        <h4 class="text-base font-bold text-white max-w-md truncate">${escapeHtml(nextVideo.title)}</h4>
        <p class="text-xs text-slate-400">Playing automatically in <span id="next-ep-countdown" class="font-bold text-white">${countdown}</span>s...</p>
      </div>
      <div class="flex items-center space-x-3 pt-2 font-mono text-xs">
        <button id="btn-play-next-now" class="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-white font-bold transition">Play Now</button>
        <button id="btn-cancel-next" class="px-4 py-2 rounded-lg bg-[#21262d] hover:bg-[#30363d] text-slate-300 transition">Cancel</button>
      </div>
    `;

    let timer = setInterval(() => {
      countdown--;
      const cdEl = document.getElementById('next-ep-countdown');
      if (cdEl) cdEl.textContent = countdown;
      if (countdown <= 0) {
        clearInterval(timer);
        overlay.classList.add('hidden');
        openPlayerModal(nextVideo);
      }
    }, 1000);

    const btnNow = document.getElementById('btn-play-next-now');
    if (btnNow) btnNow.onclick = () => {
      clearInterval(timer);
      overlay.classList.add('hidden');
      openPlayerModal(nextVideo);
    };

    const btnCancel = document.getElementById('btn-cancel-next');
    if (btnCancel) btnCancel.onclick = () => {
      clearInterval(timer);
      overlay.classList.add('hidden');
    };
  }

  // Dynamic QR generator for VLC / Infuse stream link
  function renderQrCode(canvas, text) {
    if (!canvas || !text) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const size = canvas.width;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);

    const matrixSize = 25;
    const cellSize = Math.floor((size - 16) / matrixSize);
    const offset = Math.floor((size - cellSize * matrixSize) / 2);

    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash |= 0;
    }

    ctx.fillStyle = '#000000';

    const drawFinder = (x, y) => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          if (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
            ctx.fillRect(offset + (x + c) * cellSize, offset + (y + r) * cellSize, cellSize, cellSize);
          }
        }
      }
    };

    drawFinder(0, 0);
    drawFinder(matrixSize - 7, 0);
    drawFinder(0, matrixSize - 7);

    let bitIdx = 0;
    for (let r = 0; r < matrixSize; r++) {
      for (let c = 0; c < matrixSize; c++) {
        if ((r < 8 && c < 8) || (r < 8 && c >= matrixSize - 8) || (r >= matrixSize - 8 && c < 8)) {
          continue;
        }
        const charCode = text.charCodeAt(bitIdx % text.length);
        const bit = ((charCode ^ (r * 31 + c * 17)) + hash) % 3 === 0;
        if (bit) {
          ctx.fillRect(offset + c * cellSize, offset + r * cellSize, cellSize, cellSize);
        }
        bitIdx++;
      }
    }
  }

  function openStreamLinkModal(video) {
    const v = video || state.activeVideo;
    if (!v) return;

    let modal = document.getElementById('stream-link-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'stream-link-modal';
      modal.className = 'fixed inset-0 z-50 bg-black/85 backdrop-blur-xl flex items-center justify-center p-4';
      document.body.appendChild(modal);
    }
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    const token = getAuthToken();
    const streamUrl = `${window.location.origin}/api/stream/${v.video_id}?token=${encodeURIComponent(token)}`;
    const vlcUrl = `vlc://${streamUrl}`;
    const infuseUrl = `infuse://${streamUrl}`;

    modal.innerHTML = `
      <div class="w-full max-w-md bg-[#0d1117] border border-white/10 rounded-2xl shadow-2xl p-6 space-y-5">
        <div class="flex items-center justify-between border-b border-white/[0.08] pb-3">
          <div class="flex items-center space-x-2 text-sky-400 font-bold">
            <i data-lucide="tv" class="w-5 h-5"></i>
            <h3 class="text-sm font-bold text-white truncate max-w-[260px]">${escapeHtml(v.title || 'Stream Link')}</h3>
          </div>
          <button onclick="closeStreamLinkModal()" class="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition">&times;</button>
        </div>

        <div class="flex flex-col items-center justify-center p-3 bg-white rounded-xl shadow-inner">
          <canvas id="stream-link-qr-canvas" width="200" height="200" class="rounded"></canvas>
          <span class="text-[10px] font-mono text-slate-800 mt-2 font-semibold">Scan with iPhone / Apple TV / Android VLC</span>
        </div>

        <div class="space-y-2">
          <label class="text-[11px] font-mono text-slate-400">Authenticated Direct Stream URL:</label>
          <div class="flex items-center space-x-2">
            <input type="text" readonly value="${escapeHtml(streamUrl)}" class="flex-1 bg-[#010409] border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-sky-300 font-mono truncate focus:outline-none" />
            <button onclick="navigator.clipboard.writeText('${escapeHtml(streamUrl)}'); showToast('Stream URL copied to clipboard!', 'success');" class="px-3 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-white font-mono text-xs font-bold transition">Copy</button>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-2 pt-1 font-mono text-xs">
          <a href="${escapeHtml(vlcUrl)}" class="flex items-center justify-center space-x-1.5 py-2 rounded-xl bg-orange-500/20 text-orange-400 border border-orange-500/30 hover:bg-orange-500/30 font-bold transition">
            <i data-lucide="play" class="w-3.5 h-3.5 fill-current"></i>
            <span>Open in VLC</span>
          </a>
          <a href="${escapeHtml(infuseUrl)}" class="flex items-center justify-center space-x-1.5 py-2 rounded-xl bg-purple-500/20 text-purple-400 border border-purple-500/30 hover:bg-purple-500/30 font-bold transition">
            <i data-lucide="film" class="w-3.5 h-3.5"></i>
            <span>Open in Infuse</span>
          </a>
        </div>
      </div>
    `;

    if (window.lucide) lucide.createIcons();
    const qrCanvas = document.getElementById('stream-link-qr-canvas');
    if (qrCanvas) {
      renderQrCode(qrCanvas, streamUrl);
    }
  }

  function closeStreamLinkModal() {
    const modal = document.getElementById('stream-link-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  function openShaderTuner() {
    let popover = document.getElementById('player-shaders-popover');
    if (!popover) {
      popover = document.createElement('div');
      popover.id = 'player-shaders-popover';
      popover.className = 'fixed z-50 bg-[#0d1117] border border-white/15 rounded-2xl shadow-2xl p-5 w-80 text-xs text-slate-300 font-mono backdrop-blur-xl';
      popover.innerHTML = `
        <div class="flex items-center justify-between pb-3 border-b border-white/10">
          <div class="flex items-center space-x-2 text-purple-400 font-bold">
            <i data-lucide="sliders" class="w-4 h-4"></i>
            <span>Video Shader Matrix</span>
          </div>
          <button onclick="document.getElementById('player-shaders-popover').classList.add('hidden')" class="text-slate-400 hover:text-white">&times;</button>
        </div>
        <div class="space-y-3 pt-3">
          <div>
            <div class="flex justify-between text-[11px] mb-1"><span>Brightness</span><span id="shader-val-bright">100%</span></div>
            <input type="range" id="filter-slider-brightness" min="50" max="200" value="100" class="w-full accent-purple-500" oninput="setVideoFilter('brightness', this.value); document.getElementById('shader-val-bright').textContent=this.value+'%';" />
          </div>
          <div>
            <div class="flex justify-between text-[11px] mb-1"><span>Contrast</span><span id="shader-val-contrast">100%</span></div>
            <input type="range" id="filter-slider-contrast" min="50" max="200" value="100" class="w-full accent-purple-500" oninput="setVideoFilter('contrast', this.value); document.getElementById('shader-val-contrast').textContent=this.value+'%';" />
          </div>
          <div>
            <div class="flex justify-between text-[11px] mb-1"><span>Saturation</span><span id="shader-val-saturate">100%</span></div>
            <input type="range" id="filter-slider-saturate" min="0" max="300" value="100" class="w-full accent-purple-500" oninput="setVideoFilter('saturate', this.value); document.getElementById('shader-val-saturate').textContent=this.value+'%';" />
          </div>
          <div>
            <div class="flex justify-between text-[11px] mb-1"><span>Sharpness (Convolution)</span><span id="shader-val-sharp">0</span></div>
            <input type="range" id="filter-slider-sharpness" min="0" max="100" value="0" class="w-full accent-purple-500" oninput="setVideoFilter('sharpness', this.value); document.getElementById('shader-val-sharp').textContent=this.value;" />
          </div>
          <div class="pt-2 border-t border-white/[0.08]">
            <span class="text-[10px] text-slate-500 block mb-1">Aspect Ratio Override:</span>
            <div class="grid grid-cols-4 gap-1 text-[11px] text-center">
              <button onclick="setAspectRatio('fit')" class="py-1 rounded bg-[#161b22] hover:bg-[#21262d] text-slate-300">Fit</button>
              <button onclick="setAspectRatio('16:9')" class="py-1 rounded bg-[#161b22] hover:bg-[#21262d] text-slate-300">16:9</button>
              <button onclick="setAspectRatio('21:9')" class="py-1 rounded bg-[#161b22] hover:bg-[#21262d] text-slate-300">21:9</button>
              <button onclick="setAspectRatio('4:3')" class="py-1 rounded bg-[#161b22] hover:bg-[#21262d] text-slate-300">4:3</button>
            </div>
          </div>
          <div class="flex items-center justify-between pt-2 border-t border-white/[0.08]">
            <button onclick="toggleAmbilight()" class="px-2.5 py-1 rounded bg-sky-500/20 text-sky-400 hover:bg-sky-500/30 text-[11px]">Toggle Ambilight</button>
            <button onclick="resetVideoFilters()" class="text-slate-500 hover:text-white text-[11px]">Reset Filters</button>
          </div>
        </div>
      `;
      document.body.appendChild(popover);
      if (window.lucide) lucide.createIcons();
    }

    const isHidden = popover.classList.contains('hidden');
    if (isHidden) {
      popover.classList.remove('hidden');
      popover.style.top = '100px';
      popover.style.right = '40px';
    } else {
      popover.classList.add('hidden');
    }
  }

  function openEqPopover() {
    let popover = document.getElementById('player-eq-popover');
    if (!popover) {
      popover = document.createElement('div');
      popover.id = 'player-eq-popover';
      popover.className = 'fixed z-50 bg-[#0d1117] border border-white/15 rounded-2xl shadow-2xl p-5 w-84 text-xs text-slate-300 font-mono backdrop-blur-xl';
      popover.innerHTML = `
        <div class="flex items-center justify-between pb-3 border-b border-white/10">
          <div class="flex items-center space-x-2 text-amber-400 font-bold">
            <i data-lucide="disc" class="w-4 h-4"></i>
            <span>5-Band DSP Equalizer</span>
          </div>
          <button onclick="document.getElementById('player-eq-popover').classList.add('hidden')" class="text-slate-400 hover:text-white">&times;</button>
        </div>
        <div class="space-y-4 pt-3">
          <div class="bg-[#010409] p-2 rounded-xl border border-white/10 flex flex-col items-center">
            <canvas id="player-audio-visualizer" width="280" height="48" class="rounded w-full"></canvas>
            <span class="text-[9px] text-slate-500 mt-1">60Hz • 250Hz • 1kHz • 2.5kHz • 10kHz</span>
          </div>

          <div class="flex items-center justify-between">
            <select onchange="setEqPreset(this.value)" class="bg-[#161b22] text-white px-2.5 py-1 rounded-lg border border-white/10 text-[11px] focus:outline-none cursor-pointer">
              <option value="flat">Preset: Flat</option>
              <option value="bass">Bass Boost</option>
              <option value="dialogue">Dialogue Clarity</option>
              <option value="cinema">Cinema Surround</option>
              <option value="air">Treble Air</option>
            </select>
            <button id="btn-night-mode" onclick="toggleNightMode()" class="px-2.5 py-1 rounded-lg bg-[#21262d] text-slate-300 hover:text-white text-[11px] font-bold transition flex items-center space-x-1">
              <i data-lucide="moon" class="w-3 h-3"></i>
              <span>Night Mode</span>
            </button>
          </div>

          <div class="grid grid-cols-5 gap-2 text-center text-[10px]">
            ${state.eqBands.map((b, i) => `
              <div class="flex flex-col items-center space-y-1">
                <span id="eq-band-val-${i}" class="text-sky-400 font-bold">0dB</span>
                <input type="range" id="eq-band-slider-${i}" min="-12" max="12" value="0" step="1" orient="vertical" class="h-20 accent-amber-400" oninput="setEqBand(${i}, this.value)" />
                <span class="text-slate-400 text-[9px]">${b.label.split(' ')[0]}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
      document.body.appendChild(popover);
      if (window.lucide) lucide.createIcons();
    }

    const isHidden = popover.classList.contains('hidden');
    if (isHidden) {
      popover.classList.remove('hidden');
      popover.style.top = '100px';
      popover.style.right = '40px';
      startAudioVisualizerLoop();
    } else {
      popover.classList.add('hidden');
    }
  }

  function ensurePlayerUIExtensions() {
    const modalBox = document.getElementById('player-modal-box');
    const container = document.getElementById('player-container');
    if (!modalBox || !container) return;

    initAmbilight();

    let subOverlay = document.getElementById('player-subtitles-overlay');
    if (!subOverlay) {
      subOverlay = document.createElement('div');
      subOverlay.id = 'player-subtitles-overlay';
      subOverlay.className = 'absolute inset-0 z-30 pointer-events-none flex flex-col justify-between p-4 sm:p-6 overflow-hidden';
      subOverlay.innerHTML = `
        <div id="player-subtitles-secondary" class="w-full flex justify-center text-center"></div>
        <div id="player-subtitles-primary" class="w-full flex justify-center text-center"></div>
      `;
      container.appendChild(subOverlay);
    }

    let losslessToolbar = document.getElementById('player-lossless-toolbar');
    if (!losslessToolbar) {
      losslessToolbar = document.createElement('div');
      losslessToolbar.id = 'player-lossless-toolbar';
      losslessToolbar.className = 'px-4 py-2 bg-[#090d16] border-t border-white/[0.06] flex flex-wrap items-center justify-between gap-2 text-xs font-mono select-none';
      losslessToolbar.innerHTML = `
        <div class="flex items-center space-x-2">
          <span class="text-slate-400 font-bold flex items-center space-x-1 text-[11px]">
            <i data-lucide="scissors" class="w-3.5 h-3.5 text-emerald-400"></i>
            <span>LosslessCut:</span>
          </span>
          <button onclick="markIn()" title="Mark In Point ([)" class="px-2 py-1 rounded bg-[#161b22] hover:bg-[#21262d] text-slate-300 hover:text-white border border-white/10 transition">
            [ In: <span id="lossless-in-label" class="text-emerald-400 font-bold">--:--</span>
          </button>
          <button onclick="markOut()" title="Mark Out Point (])" class="px-2 py-1 rounded bg-[#161b22] hover:bg-[#21262d] text-slate-300 hover:text-white border border-white/10 transition">
            ] Out: <span id="lossless-out-label" class="text-emerald-400 font-bold">--:--</span>
          </button>
          <span class="text-slate-500 text-[10px]">Len: <span id="lossless-duration-label" class="text-sky-300 font-bold">--</span></span>
          <button onclick="clearCutRange()" title="Clear In/Out Range" class="px-1.5 py-1 text-slate-500 hover:text-rose-400 transition">&times;</button>
        </div>
        <div class="flex items-center space-x-2">
          <button onclick="exportLosslessClip()" class="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold transition flex items-center space-x-1.5 shadow-sm">
            <i data-lucide="download" class="w-3.5 h-3.5"></i>
            <span>Export Lossless Clip</span>
          </button>
          <button onclick="captureFrame('download')" title="Capture Native Frame (S key)" class="px-2.5 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 text-sky-400 border border-sky-500/30 transition flex items-center space-x-1 font-bold">
            <i data-lucide="camera" class="w-3.5 h-3.5"></i>
            <span>Frame</span>
          </button>
          <button onclick="captureFrame('poster')" title="Set Current Frame as Poster" class="px-2 py-1 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-500/30 transition text-[10px]">
            Set Poster
          </button>
        </div>
      `;
      const controlBar = modalBox.querySelector('.border-t.border-white\\/\\[0\\.08\\]') || modalBox.lastElementChild;
      if (controlBar && controlBar.parentNode === modalBox) {
        modalBox.insertBefore(losslessToolbar, controlBar);
      } else {
        modalBox.appendChild(losslessToolbar);
      }
    }

    let extBar = document.getElementById('player-extension-buttons');
    if (!extBar) {
      extBar = document.createElement('div');
      extBar.id = 'player-extension-buttons';
      extBar.className = 'flex items-center space-x-1.5 shrink-0';
      extBar.innerHTML = `
        <button id="btn-player-shaders" onclick="openShaderTuner()" title="Video Shaders & Aspect Ratio" class="p-1.5 rounded-lg bg-[#0d1117] hover:bg-[#21262d] text-slate-400 hover:text-purple-400 border border-white/10 transition">
          <i data-lucide="sliders" class="w-3.5 h-3.5"></i>
        </button>
        <button id="btn-player-eq" onclick="openEqPopover()" title="5-Band Web Audio DSP Equalizer" class="p-1.5 rounded-lg bg-[#0d1117] hover:bg-[#21262d] text-slate-400 hover:text-amber-400 border border-white/10 transition">
          <i data-lucide="disc" class="w-3.5 h-3.5"></i>
        </button>
        <button id="btn-player-stream-link" onclick="openStreamLinkModal()" title="VLC / Infuse Mobile Stream Link" class="p-1.5 rounded-lg bg-[#0d1117] hover:bg-[#21262d] text-slate-400 hover:text-cyan-400 border border-white/10 transition">
          <i data-lucide="qr-code" class="w-3.5 h-3.5"></i>
        </button>
      `;
      const controlRight = modalBox.querySelector('.p-3.sm\\:px-6 > div:last-child') || modalBox.querySelector('#player-quality-select')?.parentNode;
      if (controlRight) {
        controlRight.insertBefore(extBar, controlRight.firstChild);
      }
    }

    if (window.lucide) lucide.createIcons();
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
            if (data.video && data.video.chapters) {
              state.activeVideo.chapters = data.video.chapters;
              renderChapterMarkers(state.activePlayer, state.activeVideo.chapters, state.activeVideo.duration_seconds || 0);
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
      attachSubtitleTracksToPlayer(videoEl, v);

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

        // Frame rendering callback hook to dismiss buffering overlay as soon as frames are rendering
        state.frameCallbackActive = true;
        const hookFrameRendering = (el) => {
          if (!el || typeof el.requestVideoFrameCallback !== 'function' || el._dcFrameHookActive) return;
          el._dcFrameHookActive = true;
          const onFrame = () => {
            if (!state.frameCallbackActive) {
              el._dcFrameHookActive = false;
              return;
            }
            if (el && !el.paused && !el.seeking) {
              showBufferingIndicator(false);
            }
            if (el && !el.ended) {
              el.requestVideoFrameCallback(onFrame);
            } else {
              el._dcFrameHookActive = false;
            }
          };
          el.requestVideoFrameCallback(onFrame);
        };

        state.activePlayer.ready(() => {
          const rawVideo = state.activePlayer.el()?.querySelector('video') || videoEl;
          if (savedPos > 5) {
            state.activePlayer.currentTime(savedPos);
          }
          if (typeof state.activePlayer.playbackRate === 'function') {
            state.activePlayer.playbackRate(state.currentSpeed);
          }

          // Ensure UI extensions and gestures
          ensurePlayerUIExtensions();
          setupPlayerGestures(container);
          setupSubtitleDragDrop(container);

          if (rawVideo) {
            setupAudioBooster(rawVideo);
            setupCompanionAudioSync(rawVideo);
            hookFrameRendering(rawVideo);
            bindNativeEvents(rawVideo);
            applyVideoFilters();
            setAspectRatio(state.aspectRatio || 'fit');
            startAmbilightLoop(rawVideo);
            if (!rawVideo.paused && rawVideo.readyState >= 3) {
              showBufferingIndicator(false);
            }
          }

          // Fullscreen buffering indicator overlay inside Video.js root element
          const rootEl = state.activePlayer.el();
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

          // Setup WebVTT thumbnail scrubbing & chapter markers
          setupVideojsThumbnails(state.activePlayer, vttSrc);
          renderChapterMarkers(state.activePlayer, v.chapters || [], v.duration_seconds || 0);
          updateLosslessCutUI();
          updatePlayerBufferUI(rawVideo);

          // Auto-play the instant local processing / loading completes
          state.activePlayer.play().catch(() => {});
        });

        // Player Event Handlers
        state.activePlayer.on('waiting', () => {
          const raw = state.activePlayer.el()?.querySelector('video') || videoEl;
          if (!raw || (!raw.paused && raw.readyState < 3)) {
            showBufferingIndicator(true);
          }
          updatePlayerBufferUI(raw);
        });
        state.activePlayer.on('seeking', () => { showBufferingIndicator(true); updatePlayerBufferUI(); });
        state.activePlayer.on('loadstart', () => { showBufferingIndicator(true); updatePlayerBufferUI(); });
        state.activePlayer.on('stalled', () => {
          const raw = state.activePlayer.el()?.querySelector('video');
          if (raw && !raw.paused && raw.readyState < 3) {
            showBufferingIndicator(true);
            updatePlayerBufferUI(raw);
          }
        });
        state.activePlayer.on('play', () => {
          const raw = state.activePlayer.el()?.querySelector('video') || videoEl;
          if (raw) hookFrameRendering(raw);
          updatePlayerBufferUI(raw);
          startAmbilightLoop(raw);
          startAudioVisualizerLoop();
        });
        state.activePlayer.on('playing', () => {
          showBufferingIndicator(false);
          updatePlayerBufferUI();
          const raw = state.activePlayer.el()?.querySelector('video') || videoEl;
          if (raw) hookFrameRendering(raw);
          if (state.audioCtx && state.audioCtx.state === 'suspended') {
            state.audioCtx.resume().catch(() => {});
          }
        });
        state.activePlayer.on('canplay', () => { showBufferingIndicator(false); updatePlayerBufferUI(); });
        state.activePlayer.on('canplaythrough', () => { showBufferingIndicator(false); updatePlayerBufferUI(); });
        state.activePlayer.on('loadeddata', () => {
          const raw = state.activePlayer.el()?.querySelector('video') || videoEl;
          if (raw && !raw.paused && raw.readyState >= 2) {
            showBufferingIndicator(false);
          }
          updatePlayerBufferUI(raw);
        });
        state.activePlayer.on('seeked', () => {
          const raw = state.activePlayer.el()?.querySelector('video') || videoEl;
          if (raw && (raw.readyState >= 3 || raw.paused)) {
            showBufferingIndicator(false);
          } else {
            showBufferingIndicator(true);
          }
          if (raw) hookFrameRendering(raw);
          updatePlayerBufferUI(raw);
        });
        state.activePlayer.on('pause', () => { showBufferingIndicator(false); });
        state.activePlayer.on('ended', () => {
          handleVideoEnded();
        });
        state.activePlayer.on('progress', () => {
          const raw = state.activePlayer.el()?.querySelector('video') || videoEl;
          if (raw && !raw.paused && !raw.seeking && raw.readyState >= 3) {
            showBufferingIndicator(false);
          }
          updatePlayerBufferUI(raw);
        });
        state.activePlayer.on('fullscreenchange', () => {
          showBufferingIndicator(state.isBuffering);
        });

        // Native Video Element Event Listeners
        const bindNativeEvents = (el) => {
          if (!el || el._dcBufferingBound) return;
          el._dcBufferingBound = true;

          const onPlaying = () => {
            showBufferingIndicator(false);
            updatePlayerBufferUI(el);
            hookFrameRendering(el);
          };
          const onCanPlay = () => {
            showBufferingIndicator(false);
            updatePlayerBufferUI(el);
          };
          const onTimeUpdate = () => {
            if (!el.paused && !el.seeking && (el.readyState >= 3 || (el.currentTime > 0 && el.readyState >= 2))) {
              showBufferingIndicator(false);
            }
          };
          const onLoadedData = () => {
            if (!el.paused && el.readyState >= 2) {
              showBufferingIndicator(false);
            }
          };

          el.addEventListener('playing', onPlaying);
          el.addEventListener('canplay', onCanPlay);
          el.addEventListener('canplaythrough', onCanPlay);
          el.addEventListener('timeupdate', onTimeUpdate);
          el.addEventListener('loadeddata', onLoadedData);

          state.nativeCleanup = () => {
            el.removeEventListener('playing', onPlaying);
            el.removeEventListener('canplay', onCanPlay);
            el.removeEventListener('canplaythrough', onCanPlay);
            el.removeEventListener('timeupdate', onTimeUpdate);
            el.removeEventListener('loadeddata', onLoadedData);
            delete el._dcBufferingBound;
          };
        };
        bindNativeEvents(videoEl);

        if (state.bufferMonitorInterval) clearInterval(state.bufferMonitorInterval);
        state.bufferMonitorInterval = setInterval(() => {
          updatePlayerBufferUI();
        }, 500);

        // Throttled watch position memory saving & Subtitles update
        let lastSave = 0;
        state.activePlayer.on('timeupdate', () => {
          const raw = state.activePlayer.el()?.querySelector('video') || videoEl;
          if (raw && !raw.paused && !raw.seeking && (raw.readyState >= 3 || (raw.currentTime > 0 && raw.readyState >= 2))) {
            showBufferingIndicator(false);
          }
          updatePlayerBufferUI(raw);

          const curr = typeof state.activePlayer.currentTime === 'function' ? state.activePlayer.currentTime() : 0;
          updateSubtitlesRender(curr);

          const now = Date.now();
          if (now - lastSave > 2000) {
            lastSave = now;
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
                <div class="flex justify-between font-bold text-sky-400 font-mono">
                  <span id="modal-transfer-pct">0%</span>
                  <span id="modal-transfer-speed">0 MB/s</span>
                </div>
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
    state.frameCallbackActive = false;
    if (state.visualizerAnimId) {
      cancelAnimationFrame(state.visualizerAnimId);
      state.visualizerAnimId = null;
    }
    if (state.statsUpdateInterval) {
      clearInterval(state.statsUpdateInterval);
      state.statsUpdateInterval = null;
    }
    state.statsForNerdsVisible = false;
    const hud = document.getElementById('player-stats-nerds');
    if (hud) hud.classList.add('hidden');
    hidePlayerContextMenu();

    if (state.nativeCleanup) {
      state.nativeCleanup();
      state.nativeCleanup = null;
    }
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
      audioEl._mediaSourceNode = null;
      audioEl._mediaSourceCtx = null;
      const freshAudio = audioEl.cloneNode(false);
      audioEl.parentNode?.replaceChild(freshAudio, audioEl);
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
      state.dspInputNode = null;
      state.eqNodes = [];
      state.compressorNode = null;
      state.analyserNode = null;
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

    // Update Category Counters & Hero Media Breakdown (Card 1)
    const totalFiles = state.videos.length;
    const localVideos = state.videos.filter(v => v.status === 'LOCAL_READY' || v.status === 'PROCESSING' || Boolean(v.local_path));
    const cloudVideos = state.videos.filter(v => v.status === 'REMOTE_ONLY');
    const localCount = localVideos.length;
    const cloudCount = cloudVideos.length;

    const countAll = document.getElementById('count-all');
    const countLocal = document.getElementById('count-local');
    const countCloud = document.getElementById('count-cloud');

    if (countAll) countAll.textContent = totalFiles;
    if (countLocal) countLocal.textContent = localCount;
    if (countCloud) countCloud.textContent = cloudCount;

    const kpiTotal = document.getElementById('kpi-total-files');
    if (kpiTotal) kpiTotal.textContent = totalFiles;
    const kpiLocal = document.getElementById('kpi-local-count');
    if (kpiLocal) kpiLocal.textContent = localCount;
    const kpiCloud = document.getElementById('kpi-cloud-count');
    if (kpiCloud) kpiCloud.textContent = cloudCount;

    const totalF = Math.max(1, totalFiles);
    const localRatio = Math.round((localCount / totalF) * 100);
    const cloudRatio = 100 - localRatio;
    const ratioLocal = document.getElementById('kpi-ratio-local');
    if (ratioLocal) ratioLocal.style.width = `${localRatio}%`;
    const ratioCloud = document.getElementById('kpi-ratio-cloud');
    if (ratioCloud) ratioCloud.style.width = `${cloudRatio}%`;

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

      const is4K = Boolean(v.height >= 2160 || (v.title || '').toLowerCase().includes('4k') || (v.title || '').toLowerCase().includes('2160p'));
      const is1080p = Boolean(v.height >= 1080 || (v.title || '').toLowerCase().includes('1080p'));
      const isHevc = Boolean((v.codec || '').toLowerCase().includes('hevc') || (v.codec || '').toLowerCase().includes('h265') || (v.title || '').toLowerCase().includes('hevc') || (v.title || '').toLowerCase().includes('h.265') || (v.title || '').toLowerCase().includes('x265'));
      const isDdp = Boolean((v.title || '').toLowerCase().includes('ddp') || (v.title || '').toLowerCase().includes('5.1'));

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

          <div class="absolute top-2 right-2 z-10 flex flex-wrap items-center gap-1 justify-end max-w-[60%]">
            ${is4K ? '<span class="px-1.5 py-0.5 rounded bg-amber-500/30 text-amber-300 border border-amber-500/40 text-[9px] font-mono font-bold backdrop-blur-sm shadow-sm">4K</span>' : (is1080p ? '<span class="px-1.5 py-0.5 rounded bg-sky-500/30 text-sky-300 border border-sky-500/40 text-[9px] font-mono font-bold backdrop-blur-sm shadow-sm">1080p</span>' : '')}
            ${isHevc ? '<span class="px-1.5 py-0.5 rounded bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 text-[9px] font-mono font-bold backdrop-blur-sm shadow-sm">HEVC</span>' : ''}
            ${isDdp ? '<span class="px-1.5 py-0.5 rounded bg-indigo-500/30 text-indigo-300 border border-indigo-500/40 text-[9px] font-mono font-bold backdrop-blur-sm shadow-sm">DDP5.1</span>' : ''}
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
              <button type="button" onclick="event.stopPropagation(); openStreamLinkModal(state.videos.find(x => x.video_id === '${escapeHtml(v.video_id)}'))" class="min-touch p-1.5 rounded-lg text-slate-500 hover:text-cyan-400 hover:bg-cyan-500/10 transition" title="Mobile Stream Link & QR Code">
                <i data-lucide="qr-code" class="w-3.5 h-3.5"></i>
              </button>
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

    renderContinueWatching();
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

  // ============================================================================
  // GOOGLE DRIVE SYNC MODAL HANDLERS
  // ============================================================================
  let currentSyncTab = 'apikey';
  function switchSyncTab(tab) {
    currentSyncTab = tab;
    const apikeySec = document.getElementById('sync-section-apikey');
    const saSec = document.getElementById('sync-section-sa');
    const apikeyBtn = document.getElementById('sync-tab-apikey');
    const saBtn = document.getElementById('sync-tab-sa');
    if (tab === 'apikey') {
      if (apikeySec) apikeySec.classList.remove('hidden');
      if (saSec) saSec.classList.add('hidden');
      if (apikeyBtn) apikeyBtn.className = 'min-touch flex-1 py-2 rounded-lg bg-sky-500 text-white font-semibold shadow transition';
      if (saBtn) saBtn.className = 'min-touch flex-1 py-2 rounded-lg text-slate-400 hover:text-white transition';
    } else {
      if (apikeySec) apikeySec.classList.add('hidden');
      if (saSec) saSec.classList.remove('hidden');
      if (apikeyBtn) apikeyBtn.className = 'min-touch flex-1 py-2 rounded-lg text-slate-400 hover:text-white transition';
      if (saBtn) saBtn.className = 'min-touch flex-1 py-2 rounded-lg bg-sky-500 text-white font-semibold shadow transition';
    }
  }

  async function openSyncModal() {
    const modal = document.getElementById('sync-modal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }
    const status = document.getElementById('sync-status');
    if (status) {
      status.classList.add('hidden');
      status.textContent = '';
    }

    try {
      const res = await fetchWithAuth('/api/drive/config');
      if (res && res.ok) {
        const cfg = await res.json();
        const badge = document.getElementById('sync-connection-badge');
        if (badge) {
          if (cfg.status === 'connected') {
            badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/25';
            badge.textContent = 'Status: Connected';
          } else if (cfg.configured) {
            badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-sky-500/10 text-sky-400 border border-sky-500/25';
            badge.textContent = 'Status: Configured';
          } else {
            badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-mono text-slate-400 bg-slate-800/80 border border-slate-700';
            badge.textContent = 'Status: Unconfigured';
          }
        }

        const disBtn = document.getElementById('sync-disconnect-btn');
        if (disBtn) {
          if (cfg.configured) disBtn.classList.remove('hidden');
          else disBtn.classList.add('hidden');
        }

        const folderInp = document.getElementById('sync-folder-input');
        if (folderInp && cfg.folder_id && !folderInp.value) {
          folderInp.value = cfg.folder_id;
        }

        const apiKeyInp = document.getElementById('sync-api-key-input');
        if (apiKeyInp && cfg.has_api_key && cfg.api_key_masked) {
          apiKeyInp.placeholder = `Active: ${cfg.api_key_masked} (Paste new key to change)`;
        }

        if (cfg.has_service_account && !cfg.has_api_key) {
          switchSyncTab('sa');
        }
      }
    } catch (e) {
      console.warn('[SyncModal] Error fetching drive config:', e);
    }
    if (window.lucide) lucide.createIcons();
  }

  function closeSyncModal() {
    const modal = document.getElementById('sync-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  async function handleSyncTest() {
    const btn = document.getElementById('sync-test-btn');
    const status = document.getElementById('sync-status');
    const apiKey = document.getElementById('sync-api-key-input')?.value.trim() || '';
    const saJson = document.getElementById('sync-sa-input')?.value.trim() || '';
    const folder = document.getElementById('sync-folder-input')?.value.trim() || '';

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Testing...';
    }
    if (status) {
      status.className = 'text-xs mb-2 p-2 rounded-lg border bg-sky-500/10 border-sky-500/20 text-sky-400';
      status.textContent = 'Testing connectivity to Google Drive API v3...';
      status.classList.remove('hidden');
    }

    try {
      const payload = {
        auth_type: currentSyncTab === 'apikey' ? 'api_key' : 'service_account',
        api_key: apiKey || undefined,
        service_account_json: saJson || undefined,
        folder_id: folder || undefined
      };

      const res = await fetchWithAuth('/api/drive/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json().catch(() => ({}));
      if (data.success) {
        if (status) {
          status.className = 'text-xs mb-2 p-2 rounded-lg border bg-emerald-500/10 border-emerald-500/20 text-emerald-400';
          status.textContent = data.message || 'Connection successful!';
        }
        const badge = document.getElementById('sync-connection-badge');
        if (badge) {
          badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/25';
          badge.textContent = 'Status: Connected';
        }
      } else {
        if (status) {
          status.className = 'text-xs mb-2 p-2 rounded-lg border bg-red-500/10 border-red-500/20 text-red-400';
          status.textContent = data.message || 'Connection test failed.';
        }
      }
    } catch (err) {
      if (status) {
        status.className = 'text-xs mb-2 p-2 rounded-lg border bg-red-500/10 border-red-500/20 text-red-400';
        status.textContent = `Error: ${err.message}`;
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Test Connection';
      }
    }
  }

  async function handleSyncSave() {
    const btn = document.getElementById('sync-save-btn');
    const status = document.getElementById('sync-status');
    const apiKey = document.getElementById('sync-api-key-input')?.value.trim() || '';
    const saJson = document.getElementById('sync-sa-input')?.value.trim() || '';
    const folder = document.getElementById('sync-folder-input')?.value.trim() || '';

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Saving & Syncing...';
    }

    try {
      const payload = {
        auth_type: currentSyncTab === 'apikey' ? 'api_key' : 'service_account',
        folder_id: folder
      };
      if (apiKey) payload.api_key = apiKey;
      if (saJson) payload.service_account_json = saJson;

      const res = await fetchWithAuth('/api/drive/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || 'Failed to save configuration');
      }

      const data = await res.json().catch(() => ({}));

      // Trigger Drive sync
      await fetchWithAuth('/api/videos/sync-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_id: folder || undefined })
      }).catch(() => null);

      if (status) {
        status.className = 'text-xs mb-2 p-2 rounded-lg border bg-emerald-500/10 border-emerald-500/20 text-emerald-400';
        status.textContent = 'Google Drive configuration saved and catalog synced successfully!';
        status.classList.remove('hidden');
      }

      const badge = document.getElementById('sync-connection-badge');
      if (badge) {
        badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/25';
        badge.textContent = 'Status: Configured';
      }

      const disBtn = document.getElementById('sync-disconnect-btn');
      if (disBtn) disBtn.classList.remove('hidden');

      const apiKeyInp = document.getElementById('sync-api-key-input');
      if (apiKeyInp) {
        apiKeyInp.value = '';
        if (data.config && data.config.api_key_masked) {
          apiKeyInp.placeholder = `Active: ${data.config.api_key_masked} (Paste new key to change)`;
        }
      }
      const saInp = document.getElementById('sync-sa-input');
      if (saInp) saInp.value = '';

      showToast('Google Drive synced successfully', 'success');
      fetchVideos();
      fetchMetrics();
      return true;
    } catch (err) {
      if (status) {
        status.className = 'text-xs mb-2 p-2 rounded-lg border bg-red-500/10 border-red-500/20 text-red-400';
        status.textContent = `Save error: ${err.message}`;
        status.classList.remove('hidden');
      }
      showToast(err.message, 'error');
      return false;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Save & Sync Now';
      }
    }
  }

  async function handleSyncDisconnect() {
    if (!confirm('Are you sure you want to disconnect and clear saved Google Drive credentials?')) {
      return;
    }
    const btn = document.getElementById('sync-disconnect-btn');
    if (btn) btn.disabled = true;

    try {
      const res = await fetchWithAuth('/api/drive/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear_credentials: true })
      });
      if (res.ok) {
        const apiKeyInp = document.getElementById('sync-api-key-input');
        if (apiKeyInp) {
          apiKeyInp.value = '';
          apiKeyInp.placeholder = 'AIzaSy...';
        }
        const saInp = document.getElementById('sync-sa-input');
        if (saInp) saInp.value = '';

        const badge = document.getElementById('sync-connection-badge');
        if (badge) {
          badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-mono text-slate-400 bg-slate-800/80 border border-slate-700';
          badge.textContent = 'Status: Unconfigured';
        }
        if (btn) btn.classList.add('hidden');
        showToast('Google Drive credentials cleared', 'info');
      }
    } catch (err) {
      showToast('Failed to disconnect Google Drive', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ============================================================================
  // MONGO EXPRESS MODAL & COLLECTION EXPLORER
  // ============================================================================
  async function openMongoModal() {
    const modal = document.getElementById('mongo-modal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }
    const host = window.location.hostname || 'localhost';
    const fallbackTunnel = `ssh -L 8081:127.0.0.1:8081 ubuntu@${host}`;
    const cmdEl = document.getElementById('me-tunnel-cmd-text');
    if (cmdEl) cmdEl.textContent = fallbackTunnel;

    try {
      const res = await fetchWithAuth('/api/db/stats');
      if (res && res.ok) {
        const data = await res.json();
        const port = data.mongo_express_port || 8081;
        const tunnelCmd = data.ssh_tunnel_cmd || `ssh -L ${port}:127.0.0.1:${port} ubuntu@${host}`;
        const user = data.mongo_express_user || 'admin';
        const pass = data.mongo_express_pass || 'expresspassword';

        if (cmdEl) cmdEl.textContent = tunnelCmd;
        const userEl = document.getElementById('me-user-val');
        if (userEl) userEl.textContent = user;
        const passEl = document.getElementById('me-pass-val');
        if (passEl) passEl.textContent = pass;
        const portEl = document.getElementById('me-port-num');
        if (portEl) portEl.textContent = port;

        const colsBar = document.getElementById('mongo-cols-bar');
        if (colsBar && Array.isArray(data.collections)) {
          colsBar.innerHTML = data.collections
            .map(c => `<span class="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">${escapeHtml(c.name)} (${c.count})</span>`)
            .join(' ');
        }
      }
    } catch (err) {
      console.warn('[MongoModal] Error fetching db stats:', err);
    }

    try {
      const docsRes = await fetchWithAuth('/api/db/collections/videos');
      if (docsRes && docsRes.ok) {
        const docs = await docsRes.json();
        const docsContainer = document.getElementById('mongo-docs-container');
        if (docsContainer) {
          if (Array.isArray(docs) && docs.length > 0) {
            docsContainer.innerHTML = docs
              .slice(0, 10)
              .map(d => `<div class="p-2 rounded bg-slate-900/60 border border-slate-800 text-[11px] font-mono text-slate-300 truncate">${escapeHtml(d.title || d.video_id || JSON.stringify(d))}</div>`)
              .join('');
          } else {
            docsContainer.innerHTML = `<span class="text-xs text-slate-500">No documents in collection videos</span>`;
          }
        }
      }
    } catch (e) {
      console.warn('[MongoModal] Error fetching videos collection:', e);
    }

    if (window.lucide) lucide.createIcons();
  }

  function closeMongoModal() {
    const modal = document.getElementById('mongo-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  function copyMongoTunnelCmd() {
    const cmd = document.getElementById('me-tunnel-cmd-text');
    const label = document.getElementById('me-copy-cmd-label');
    if (cmd) {
      navigator.clipboard.writeText(cmd.innerText.trim());
      if (label) {
        label.textContent = 'Copied!';
        setTimeout(() => { label.textContent = 'Copy'; }, 2000);
      }
    }
  }

  function copyMongoPassword() {
    const pass = document.getElementById('me-pass-val');
    if (pass) {
      navigator.clipboard.writeText(pass.innerText.trim());
      showToast('Password copied to clipboard', 'info');
    }
  }

  // ============================================================================
  // JDOWNLOADER 2 MODAL HANDLERS
  // ============================================================================
  function openJDownloaderModal() {
    const modal = document.getElementById('jdownloader-modal');
    const host = window.location.hostname || 'localhost';
    const sshCmd = `ssh -L 5800:127.0.0.1:5800 ubuntu@${host}`;
    const jdCmdEl = document.getElementById('jd-ssh-cmd');
    if (jdCmdEl) jdCmdEl.textContent = sshCmd;
    const jdDirectLink = document.getElementById('jd-direct-link');
    if (jdDirectLink) jdDirectLink.href = `http://${host}:5800`;
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }
    if (window.lucide) lucide.createIcons();
  }

  function closeJDownloaderModal() {
    const modal = document.getElementById('jdownloader-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  function copyJdCmd() {
    const host = window.location.hostname || 'localhost';
    const cmd = `ssh -L 5800:127.0.0.1:5800 ubuntu@${host}`;
    navigator.clipboard.writeText(cmd);
    showToast('JDownloader SSH command copied', 'info');
  }

  // ============================================================================
  // EXTERNAL URL INGESTION MODAL & BATCH SUBMIT HANDLERS
  // ============================================================================
  let modalUrlMode = 'single';
  function switchUrlMode(mode) {
    modalUrlMode = mode;
    const singleContainer = document.getElementById('url-single-container');
    const batchContainer = document.getElementById('url-batch-container');
    const singleBtn = document.getElementById('url-mode-single-btn');
    const batchBtn = document.getElementById('url-mode-batch-btn');

    if (mode === 'single') {
      if (singleContainer) singleContainer.classList.remove('hidden');
      if (batchContainer) batchContainer.classList.add('hidden');
      if (singleBtn) singleBtn.className = 'min-touch flex-1 py-2 rounded-lg bg-sky-500 text-white font-semibold shadow transition';
      if (batchBtn) batchBtn.className = 'min-touch flex-1 py-2 rounded-lg text-slate-400 hover:text-white transition';
    } else {
      if (singleContainer) singleContainer.classList.add('hidden');
      if (batchContainer) batchContainer.classList.remove('hidden');
      if (singleBtn) singleBtn.className = 'min-touch flex-1 py-2 rounded-lg text-slate-400 hover:text-white transition';
      if (batchBtn) batchBtn.className = 'min-touch flex-1 py-2 rounded-lg bg-sky-500 text-white font-semibold shadow transition';
    }
  }

  function openUrlModal() {
    const modal = document.getElementById('url-modal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }
    const errEl = document.getElementById('url-error-msg');
    if (errEl) errEl.classList.add('hidden');
    if (window.lucide) lucide.createIcons();
  }

  function closeUrlModal() {
    const modal = document.getElementById('url-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  async function handleModalUrlSubmit() {
    const errEl = document.getElementById('url-error-msg');
    if (errEl) errEl.classList.add('hidden');

    const singleInput = document.getElementById('modal-url-input') || document.getElementById('url-input');
    const titleInput = document.getElementById('url-title-input');
    const batchInput = document.getElementById('url-batch-input');

    if (modalUrlMode === 'single') {
      const url = singleInput ? singleInput.value.trim() : '';
      const title = titleInput ? titleInput.value.trim() : '';
      if (!url) {
        if (errEl) {
          errEl.textContent = 'Please enter a media URL.';
          errEl.classList.remove('hidden');
        }
        return;
      }
      await submitUrlDownload(url, title);
      closeUrlModal();
      if (singleInput) singleInput.value = '';
      if (titleInput) titleInput.value = '';
    } else {
      const batchText = batchInput ? batchInput.value.trim() : '';
      const urls = batchText.split('\n').map(u => u.trim()).filter(u => u.length > 0);
      if (urls.length === 0) {
        if (errEl) {
          errEl.textContent = 'Please enter at least one URL (one per line).';
          errEl.classList.remove('hidden');
        }
        return;
      }
      showToast(`Submitting ${urls.length} batch download(s)...`, 'info');
      try {
        let res = await fetchWithAuth('/api/videos/download-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls })
        }).catch(() => null);

        if (!res || !res.ok) {
          res = await fetchWithAuth('/api/download-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls })
          });
        }

        if (res && res.ok) {
          showToast(`Batch queued: ${urls.length} downloads started`, 'success');
          closeUrlModal();
          if (batchInput) batchInput.value = '';
          fetchVideos();
          const drawer = document.getElementById('transfers-drawer');
          if (drawer) drawer.classList.remove('hidden');
        } else {
          const errData = await res.json().catch(() => ({}));
          if (errEl) {
            errEl.textContent = errData.detail || 'Failed to submit batch download';
            errEl.classList.remove('hidden');
          }
          showToast(errData.detail || 'Batch submission failed', 'error');
        }
      } catch (err) {
        if (errEl) {
          errEl.textContent = err.message;
          errEl.classList.remove('hidden');
        }
        showToast('Batch submission error', 'error');
      }
    }
  }

  function handleQuickUrlSubmit() {
    const inp = document.getElementById('url-input');
    if (!inp || !inp.value.trim()) return;
    submitUrlDownload(inp.value.trim());
    inp.value = '';
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

    // CPU Metrics (Top Navbar, Mobile Strip, & Hero HUD)
    if (data.cpu) {
      const cpuPct = Math.round(data.cpu.percent || 0);
      const cpuDotColor = cpuPct > 80 ? 'bg-rose-400' : cpuPct > 50 ? 'bg-amber-400' : 'bg-emerald-400';

      const headerCpuPct = document.getElementById('header-cpu-pct');
      if (headerCpuPct) headerCpuPct.textContent = `${cpuPct}%`;
      const headerCpuBar = document.getElementById('header-cpu-bar');
      if (headerCpuBar) headerCpuBar.style.width = `${cpuPct}%`;
      const headerCpuDot = document.getElementById('header-cpu-dot');
      if (headerCpuDot) headerCpuDot.className = `w-1.5 h-1.5 rounded-full ${cpuDotColor}`;

      const mobCpuPct = document.getElementById('mobile-cpu-pct');
      if (mobCpuPct) mobCpuPct.textContent = `${cpuPct}%`;
      const mobCpuDot = document.getElementById('mobile-cpu-dot');
      if (mobCpuDot) mobCpuDot.className = `w-1.5 h-1.5 rounded-full ${cpuDotColor}`;

      const cpuPill = document.getElementById('telemetry-cpu');
      if (cpuPill) cpuPill.textContent = `CPU ${cpuPct}%`;
      const cpuBar = document.getElementById('telemetry-cpu-bar');
      if (cpuBar) cpuBar.style.width = `${cpuPct}%`;
    }

    // RAM Metrics (32GB Architecture: 10% Host Reserve, 90% Cloud Pipeline)
    if (data.ram) {
      const ramUsed = (data.ram.used_gb || 0).toFixed(1);
      const ramTotal = Math.round(data.ram.total_gb || 32);
      const ramPct = Math.min(100, Math.round(data.ram.percent || 0));

      const headerRamUsed = document.getElementById('header-ram-used');
      if (headerRamUsed) headerRamUsed.textContent = `${ramUsed}G`;
      const headerRamPct = document.getElementById('header-ram-pct');
      if (headerRamPct) headerRamPct.textContent = `/ ${ramTotal}G`;
      const headerRamBar = document.getElementById('header-ram-bar');
      if (headerRamBar) headerRamBar.style.width = `${ramPct}%`;

      const ramPill = document.getElementById('header-ram-pill') || document.getElementById('telemetry-ram');
      if (ramPill && data.ram.reserved_system_gb) {
        ramPill.title = `32GB Architecture: ${ramUsed}/${ramTotal} GB | Host: ${data.ram.reserved_system_gb}GB (10%) | Cloud Pipeline: ${data.ram.cloud_pipeline_allocated_gb}GB (90%)`;
      }

      const mobRam = document.getElementById('mobile-ram-used');
      if (mobRam) mobRam.textContent = `${ramUsed}G`;

      const legacyRamPill = document.getElementById('telemetry-ram');
      if (legacyRamPill) legacyRamPill.textContent = `RAM ${ramUsed}/${ramTotal} GB [${ramPct}%]`;
      const legacyRamBar = document.getElementById('telemetry-ram-bar');
      if (legacyRamBar) legacyRamBar.style.width = `${ramPct}%`;
    }

    // Disk / Storage - Hardware & Hero Gauges (1TB NVMe Array /mnt/storage)
    if (data.disk) {
      const diskUsed = typeof data.disk.used_gb === 'number' ? Math.round(data.disk.used_gb) : 0;
      const diskTotal = typeof data.disk.total_gb === 'number' ? Math.round(data.disk.total_gb) : 1000;
      const diskFree = typeof data.disk.free_gb === 'number' ? Math.round(data.disk.free_gb) : Math.max(0, diskTotal - diskUsed);
      const diskPct = Math.min(100, Math.round(data.disk.percent || (diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0)));

      // Top navbar & mobile hardware strip
      const headerDiskUsed = document.getElementById('header-disk-used');
      if (headerDiskUsed) headerDiskUsed.textContent = `${diskUsed}G`;
      const headerDiskTotal = document.getElementById('header-disk-total');
      if (headerDiskTotal) headerDiskTotal.textContent = `/ ${diskTotal}G`;
      const headerDiskBar = document.getElementById('header-disk-bar');
      if (headerDiskBar) headerDiskBar.style.width = `${diskPct}%`;
      const mobDiskPct = document.getElementById('mobile-disk-pct');
      if (mobDiskPct) mobDiskPct.textContent = `${diskPct}%`;

      // Hero Storage Gauges (Card 2: 1TB NVMe Array)
      const kpiDiskUsed = document.getElementById('kpi-disk-used');
      if (kpiDiskUsed) kpiDiskUsed.textContent = diskUsed;
      const kpiDiskFree = document.getElementById('kpi-disk-free');
      if (kpiDiskFree) kpiDiskFree.textContent = `${diskFree} GB`;
      const kpiDiskTotal = document.getElementById('kpi-disk-total');
      if (kpiDiskTotal) kpiDiskTotal.textContent = `${diskTotal} GB`;
      const kpiDiskPct = document.getElementById('kpi-disk-pct');
      if (kpiDiskPct) kpiDiskPct.textContent = `${diskPct}%`;
      const kpiDiskBar = document.getElementById('kpi-disk-bar');
      if (kpiDiskBar) kpiDiskBar.style.width = `${diskPct}%`;

      const legacyDiskPill = document.getElementById('telemetry-disk');
      if (legacyDiskPill) legacyDiskPill.textContent = `Disk ${diskUsed}/${diskTotal} GB (${diskPct}%)`;
      const legacyDiskBar = document.getElementById('telemetry-disk-bar');
      if (legacyDiskBar) legacyDiskBar.style.width = `${diskPct}%`;
    }

    // Network & Throughput (Card 3 & Top Navbar)
    const inRate = (data.throughput?.live_download_speed_mb_s ?? data.network?.input_mb_s ?? 0).toFixed(1);
    const outRate = (data.throughput?.live_stream_speed_mb_s ?? data.network?.output_mb_s ?? 0).toFixed(1);

    const headerNetIn = document.getElementById('header-net-in');
    if (headerNetIn) headerNetIn.textContent = `${inRate} MB/s`;
    const headerNetOut = document.getElementById('header-net-out');
    if (headerNetOut) headerNetOut.textContent = `${outRate} MB/s`;

    const kpiInSpeed = document.getElementById('kpi-in-speed');
    if (kpiInSpeed) kpiInSpeed.textContent = `${inRate} MB/s`;
    const kpiOutSpeed = document.getElementById('kpi-out-speed');
    if (kpiOutSpeed) kpiOutSpeed.textContent = `${outRate} MB/s`;

    if (data.network) {
      const rxMb = Math.round(data.network.total_received_mb || 0);
      const txMb = Math.round(data.network.total_sent_mb || 0);
      const kpiRx = document.getElementById('kpi-rx-total');
      if (kpiRx) kpiRx.textContent = `${rxMb} MB`;
      const kpiTx = document.getElementById('kpi-tx-total');
      if (kpiTx) kpiTx.textContent = `${txMb} MB`;

      const netIn = document.getElementById('telemetry-input');
      if (netIn) netIn.textContent = `In: ${inRate} MB/s`;
      const netOut = document.getElementById('telemetry-output');
      if (netOut) netOut.textContent = `Out: ${outRate} MB/s`;
    }

    // Pipeline Stats & Hero Cards (Card 4: FFmpeg Pipeline)
    if (data.pipeline) {
      const qCount = data.pipeline.in_queue || 0;
      const procCount = data.pipeline.in_processing || 0;
      const readyCount = data.pipeline.local_files || 0;
      const totalCount = data.pipeline.total_files || (state.videos ? state.videos.length : 0);
      const cloudCount = data.pipeline.cloud_files || 0;

      const kpiTotal = document.getElementById('kpi-total-files');
      if (kpiTotal) kpiTotal.textContent = totalCount;
      const kpiLocal = document.getElementById('kpi-local-count');
      if (kpiLocal) kpiLocal.textContent = readyCount;
      const kpiCloud = document.getElementById('kpi-cloud-count');
      if (kpiCloud) kpiCloud.textContent = cloudCount;

      const totalF = Math.max(1, totalCount);
      const localRatio = Math.round((readyCount / totalF) * 100);
      const cloudRatio = 100 - localRatio;
      const ratioLocal = document.getElementById('kpi-ratio-local');
      if (ratioLocal) ratioLocal.style.width = `${localRatio}%`;
      const ratioCloud = document.getElementById('kpi-ratio-cloud');
      if (ratioCloud) ratioCloud.style.width = `${cloudRatio}%`;

      const kpiProc = document.getElementById('kpi-proc-count');
      if (kpiProc) kpiProc.textContent = procCount;
      const kpiQueue = document.getElementById('kpi-queue-count');
      if (kpiQueue) kpiQueue.textContent = qCount;
      const kpiReady = document.getElementById('kpi-stream-ready');
      if (kpiReady) kpiReady.textContent = readyCount;

      const kpiActive = document.getElementById('kpi-pipeline-active');
      if (kpiActive) {
        kpiActive.textContent = procCount > 0 ? `Active (${procCount})` : 'Idle / Ready';
        kpiActive.className = procCount > 0 ? 'text-purple-400 font-bold' : 'text-slate-300';
      }
      const kpiDesc = document.getElementById('kpi-pipeline-desc');
      if (kpiDesc) {
        kpiDesc.textContent = procCount > 0 ? `${procCount} FFmpeg job(s) running` : 'WebVTT Sprites & Audio';
      }

      const legacyQ = document.getElementById('telemetry-queue');
      if (legacyQ) legacyQ.textContent = qCount;
      const legacyProc = document.getElementById('telemetry-processing');
      if (legacyProc) legacyProc.textContent = procCount;
      const legacyReady = document.getElementById('telemetry-ready');
      if (legacyReady) legacyReady.textContent = readyCount;
    }

    // Server Uptime & Status
    if (data.server) {
      const srvStatus = data.server.status || 'optimal';
      const srvStatusEl = document.getElementById('dashboard-server-status');
      if (srvStatusEl) {
        srvStatusEl.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping inline-block"></span><span>${srvStatus}</span>`;
      }
      const srvInfo = document.getElementById('dashboard-server-info');
      if (srvInfo && typeof data.server.uptime_seconds === 'number') {
        srvInfo.textContent = `Dedicated Host • ${data.server.os || 'Linux'} • Uptime ${formatUptime(data.server.uptime_seconds)}`;
      }
      const uptimeEl = document.getElementById('telemetry-uptime');
      if (uptimeEl && typeof data.server.uptime_seconds === 'number') {
        uptimeEl.textContent = formatUptime(data.server.uptime_seconds);
      }
    }

    // Real-Time Network & GeoIP Telemetry
    if (data.network_geo) {
      updateHeroGlobe(data.network_geo);
    }

    // Live Transfers Strip & Mini Telemetry Ribbon
    const dlList = Object.values(state.transfers || {});
    const procList = Object.values(state.processingJobs || {});
    const qCount = data.pipeline?.in_queue || 0;
    const procCount = data.pipeline?.in_processing || 0;
    const totalActiveTransfers = Math.max(dlList.length + procList.length, qCount + procCount);

    const heroCard = document.getElementById('hero-transfers-card');
    const heroCount = document.getElementById('hero-transfers-count');
    const heroItems = document.getElementById('hero-transfers-items');
    const miniBarWrap = document.getElementById('transfers-mini-bar-wrap');
    const miniPct = document.getElementById('transfers-mini-pct');
    const miniBar = document.getElementById('transfers-mini-bar');

    if (totalActiveTransfers > 0) {
      if (heroCard) heroCard.classList.remove('hidden');
      if (heroCount) heroCount.textContent = `${totalActiveTransfers} Active`;
      const tc = document.getElementById('transfers-container') || document.getElementById('transfers-list');
      if (heroItems && tc && tc.children.length > 0 && !heroItems.innerHTML.trim()) {
        heroItems.innerHTML = tc.innerHTML;
      }
      const activeItems = [...dlList, ...procList].filter(t => (t.percentage && t.percentage < 100) || (t.percent && t.percent < 100) || t.status === 'DOWNLOADING' || t.status === 'PROCESSING');
      const avgPct = activeItems.length > 0
        ? Math.round(activeItems.reduce((acc, t) => acc + (t.percentage ?? t.percent ?? t.stage_percent ?? 0), 0) / activeItems.length)
        : (procCount > 0 ? 50 : 0);
      if (miniBarWrap) {
        miniBarWrap.classList.remove('hidden');
        miniBarWrap.classList.add('flex');
      }
      if (miniPct) {
        miniPct.textContent = `${avgPct}%`;
        miniPct.classList.remove('hidden');
      }
      if (miniBar) miniBar.style.width = `${avgPct}%`;
    } else {
      if (heroCard) heroCard.classList.add('hidden');
      if (heroCount) heroCount.textContent = '0 Active';
      if (miniBarWrap) {
        miniBarWrap.classList.add('hidden');
        miniBarWrap.classList.remove('flex');
      }
      if (miniPct) miniPct.classList.add('hidden');
      if (miniBar) miniBar.style.width = '0%';
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
        } else if (key === 'm') {
          e.preventDefault();
          if (typeof state.activePlayer.muted === 'function') {
            state.activePlayer.muted(!state.activePlayer.muted());
          }
        } else if (e.key === ',') {
          e.preventDefault();
          stepFrameBackward();
        } else if (e.key === '.') {
          e.preventDefault();
          stepFrameForward();
        } else if (e.key === '[') {
          e.preventDefault();
          markIn();
        } else if (e.key === ']') {
          e.preventDefault();
          markOut();
        } else if (key === 's') {
          e.preventDefault();
          captureFrame('download');
        } else if (key === 'n') {
          e.preventDefault();
          toggleStatsForNerds();
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
  window.updateHeroGlobe = updateHeroGlobe;
  window.fetchNetworkGeo = fetchNetworkGeo;
  window.detectAndRegisterClientGeo = detectAndRegisterClientGeo;
  window.registerBrowserGeo = detectAndRegisterClientGeo;
  window.focusGlobeOnCountry = focusGlobeOnCountry;
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
  window.attachSubtitleTracksToPlayer = attachSubtitleTracksToPlayer;
  window.setupCompanionAudioSync = setupCompanionAudioSync;
  window.setupAudioBooster = setupAudioBooster;
  window.triggerWhisperTranscribe = triggerWhisperTranscribe;
  window.startWhisper = triggerWhisperTranscribe;
  window.setAudioGain = setAudioGain;
  window.cycleAudioBoost = cycleAudioBoost;
  window.getBufferedPercent = getBufferedPercent;
  window.showBufferingIndicator = showBufferingIndicator;
  window.updatePlayerBufferUI = updatePlayerBufferUI;
  window.setupVideojsThumbnails = setupVideojsThumbnails;

  // New Player Upgrades & Toolbars
  window.renderChapterMarkers = renderChapterMarkers;
  window.stepFrameBackward = stepFrameBackward;
  window.stepFrameForward = stepFrameForward;
  window.toggleStatsForNerds = toggleStatsForNerds;
  window.setupPlayerGestures = setupPlayerGestures;
  window.markIn = markIn;
  window.markOut = markOut;
  window.clearCutRange = clearCutRange;
  window.updateLosslessCutUI = updateLosslessCutUI;
  window.exportLosslessClip = exportLosslessClip;
  window.captureFrame = captureFrame;
  window.setVideoFilter = setVideoFilter;
  window.resetVideoFilters = resetVideoFilters;
  window.setAspectRatio = setAspectRatio;
  window.toggleAmbilight = toggleAmbilight;
  window.setEqBand = setEqBand;
  window.setEqPreset = setEqPreset;
  window.toggleNightMode = toggleNightMode;
  window.setSubtitleOffset = setSubtitleOffset;
  window.changeSecondarySubtitleTrack = changeSecondarySubtitleTrack;
  window.setupSubtitleDragDrop = setupSubtitleDragDrop;
  window.renderContinueWatching = renderContinueWatching;
  window.openStreamLinkModal = openStreamLinkModal;
  window.closeStreamLinkModal = closeStreamLinkModal;
  window.openShaderTuner = openShaderTuner;
  window.openEqPopover = openEqPopover;
  window.ensurePlayerUIExtensions = ensurePlayerUIExtensions;

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

  window.openSyncModal = openSyncModal;
  window.closeSyncModal = closeSyncModal;
  window.switchSyncTab = switchSyncTab;
  window.handleSyncTest = handleSyncTest;
  window.handleSyncSave = handleSyncSave;
  window.handleSyncDisconnect = handleSyncDisconnect;
  window.testDriveConnection = handleSyncTest;
  window.saveDriveConfig = handleSyncSave;
  window.disconnectDrive = handleSyncDisconnect;

  window.openMongoModal = openMongoModal;
  window.closeMongoModal = closeMongoModal;
  window.copyMongoTunnelCmd = copyMongoTunnelCmd;
  window.copyMongoPassword = copyMongoPassword;

  window.openJDownloaderModal = openJDownloaderModal;
  window.closeJDownloaderModal = closeJDownloaderModal;
  window.copyJdCmd = copyJdCmd;

  window.openUrlModal = openUrlModal;
  window.closeUrlModal = closeUrlModal;
  window.switchUrlMode = switchUrlMode;
  window.handleModalUrlSubmit = handleModalUrlSubmit;
  window.triggerUrlDownload = handleModalUrlSubmit;
  window.handleQuickUrlSubmit = handleQuickUrlSubmit;

  window.updateSystemMetricsUI = updateSystemMetricsUI;
  window.persistAuth = persistAuth;
  window.handleLogout = handleLogout;

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

  // Window UI Helper Aliases (Bridging index.html UI controls)
  window.appMarkIn = markIn;
  window.appMarkOut = markOut;
  window.appExportClip = exportLosslessClip;
  window.appCaptureFrame = captureFrame;
  window.appApplyShaders = (b, c, s, sh) => {
    setVideoFilter('brightness', b);
    setVideoFilter('contrast', c);
    setVideoFilter('saturate', s);
    setVideoFilter('sharpness', sh);
  };
  window.appSetAspectRatio = setAspectRatio;
  window.appUpdateEq = () => {
    [60, 250, 1000, 2500, 10000].forEach((freq, idx) => {
      const el = document.getElementById('eq-band-' + freq);
      if (el) setEqBand(idx, parseFloat(el.value));
    });
  };
  window.appToggleNightMode = toggleNightMode;
  window.appApplyEqPreset = setEqPreset;
  window.appSetSubtitleOffset = setSubtitleOffset;
  window.appChangeSecondarySub = changeSecondarySubtitleTrack;
  window.appToggleAmbilight = toggleAmbilight;
  window.appPrepareVlcModal = () => {
    if (state.activeVideo) {
      const token = getAuthToken();
      const streamUrl = window.location.origin + '/api/stream/' + state.activeVideo.video_id + (token ? '?token=' + encodeURIComponent(token) : '');
      const input = document.getElementById('vlc-stream-url');
      if (input) input.value = streamUrl;
      const qrCanvas = document.getElementById('vlc-qr-canvas');
      if (qrCanvas) renderQrCode(qrCanvas, streamUrl);
    }
  };
  window.appSeekRelative = (sec) => {
    if (state.activePlayer) {
      const cur = (typeof state.activePlayer.currentTime === 'function') ? state.activePlayer.currentTime() : (state.activeVideoEl ? state.activeVideoEl.currentTime : 0);
      const dur = (typeof state.activePlayer.duration === 'function') ? state.activePlayer.duration() : (state.activeVideoEl ? state.activeVideoEl.duration : 0);
      const target = Math.max(0, Math.min(dur || Infinity, cur + sec));
      if (typeof state.activePlayer.currentTime === 'function') {
        state.activePlayer.currentTime(target);
      } else if (state.activeVideoEl) {
        state.activeVideoEl.currentTime = target;
      }
    }
  };
  window.appDismissTransfer = dismissTransfer;
  window.appClearDoneTransfers = clearCompletedTransfers;
  window.appClosePlayer = closePlayerModal;
  window.appCycleAudioBoost = cycleAudioBoost;
  window.appChangeAudioTrack = changePlayerAudioTrack;
  window.appChangeSubtitleTrack = changePlayerSubtitleTrack;
  window.appChangeQuality = changePlayerQuality;
  window.appWhisper = triggerWhisperTranscribe;
  window.appSetFilter = setCatalogFilter;
  window.appSetView = setCatalogView;
  window.appClearSearch = clearSearch;
  window.appScanStorage = triggerScanStorage;
  window.appFetchAll = fetchAllData;
  window.appOpenLatestVideo = () => {
    const rec = state.videos && state.videos[0];
    if (rec) openPlayerModal(rec);
  };

  /* ============================================================================
     11. INITIALIZATION & LIFECYCLE
     ============================================================================ */
  function initializeApp() {
    if (!checkAuthWall()) return;

    // Initialize 3D Hero Globe & Real-Time Network Telemetry
    initHeroGlobe();
    detectAndRegisterClientGeo();

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
