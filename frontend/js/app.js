(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { videos: [], filter: 'all', active: null, pending: null, transfers: new Map(), socket: null,
    socketTimer: null, pingTimer: null, metricsTimer: null, audioContext: null, gain: null,
    mediaSource: null, alternateSource: null, cues: [] };
  const player = $('player');
  const alternateAudio = $('player-alternate-audio');
  let lastPositionSave = 0;
  let syncingAlternate = false;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`); svg.setAttribute('aria-hidden', 'true'); svg.append(use); return svg;
  }
  function toast(message, isError = false) {
    const item = el('div', `toast${isError ? ' error' : ''}`, message);
    $('toast-region').append(item); setTimeout(() => item.remove(), 4500);
  }
  async function api(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
    if (response.status === 401) { location.replace('/login'); throw new Error('Session expired.'); }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const detail = data.detail;
      throw new Error(typeof detail === 'string' ? detail : detail?.message || data.message || `Request failed (${response.status}).`);
    }
    return response;
  }
  function bytes(n) {
    n = Number(n); if (!Number.isFinite(n) || n <= 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
  }
  function duration(n) {
    n = Math.max(0, Math.floor(Number(n) || 0)); const h = Math.floor(n / 3600), m = Math.floor(n % 3600 / 60), s = n % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  function isLocal(v) { return v.status === 'LOCAL_READY' || (v.status === 'PROCESSING' && Boolean(v.local_path)); }
  function showDialog(id) { const d = $(id); if (d && !d.open) d.showModal(); }
  function closeDialog(id) { const d = $(id); if (d?.open) d.close(); }
  function errorMessage(id, message) { const node = $(id); node.textContent = message || ''; node.classList.toggle('hidden', !message); }

  function setFilter(filter) {
    state.filter = filter;
    document.querySelectorAll('[data-filter]').forEach(button => button.classList.toggle('active', button.dataset.filter === filter));
    document.querySelectorAll('[data-nav]').forEach(button => button.classList.toggle('active', button.dataset.nav === (filter === 'all' ? 'library' : filter)));
    $('library-title').firstChild.nodeValue = filter === 'local' ? 'On this server ' : filter === 'cloud' ? 'Google Drive ' : 'All videos ';
    renderVideos();
  }
  function card(v) {
    const wrapper = el('article', 'video-card');
    const open = el('button', 'poster'); open.type = 'button'; open.setAttribute('aria-label', `Open ${v.title || 'video'}`);
    const placeholder = el('span', 'poster-fallback'); placeholder.append(icon('film')); open.append(placeholder);
    if (v.poster_url && v.poster_url.startsWith('/metadata/')) {
      const image = el('img', 'poster-art'); image.alt = ''; image.loading = 'lazy'; image.src = v.poster_url;
      image.addEventListener('error', () => image.remove()); open.append(image);
    }
    if (isLocal(v) && typeof v.preview_url === 'string' && v.preview_url.startsWith('/metadata/')) {
      const preview = el('video', 'card-preview'); preview.src = v.preview_url; preview.muted = true; preview.loop = true; preview.playsInline = true; preview.preload = 'none'; open.append(preview);
      open.addEventListener('mouseenter', () => { if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) preview.play().catch(() => {}); });
      open.addEventListener('mouseleave', () => { preview.pause(); preview.currentTime = 0; });
    }
    const play = el('span', 'play-circle'); play.append(icon('play')); open.append(play);
    if (v.duration_seconds > 0) open.append(el('span', 'poster-duration', duration(v.duration_seconds)));
    open.addEventListener('click', () => openVideo(v)); wrapper.append(open);
    const copy = el('div', 'card-copy'), details = el('div');
    const title = el('button', 'card-title', v.title || 'Untitled video'); title.type = 'button'; title.title = v.title || 'Untitled video';
    title.addEventListener('click', () => openVideo(v)); details.append(title);
    const meta = el('div', 'card-meta'); const status = isLocal(v) ? 'On server' : v.status === 'REMOTE_ONLY' ? 'In Drive' : (v.status || 'Processing').replaceAll('_', ' ').toLowerCase();
    meta.append(el('span', `card-state${isLocal(v) ? '' : ' cloud'}`, status));
    if (v.file_size_bytes) { meta.append(el('span', 'meta-dot', '·')); meta.append(el('span', '', bytes(v.file_size_bytes))); }
    details.append(meta); copy.append(details);
    const more = el('button', 'icon-button card-menu'); more.type = 'button'; more.title = 'Video details'; more.setAttribute('aria-label', `Video details for ${v.title || 'video'}`); more.append(icon('more')); more.addEventListener('click', () => openVideo(v)); copy.append(more); wrapper.append(copy);
    return wrapper;
  }
  function renderVideos() {
    const q = $('search').value.trim().toLocaleLowerCase();
    const list = state.videos.filter(v => (!q || String(v.title || '').toLocaleLowerCase().includes(q)) &&
      (state.filter === 'all' || (state.filter === 'local' && isLocal(v)) || (state.filter === 'cloud' && v.status === 'REMOTE_ONLY')));
    const sort = $('sort').value;
    list.sort((a,b) => sort === 'title' ? String(a.title || '').localeCompare(String(b.title || '')) : sort === 'size' ? (b.file_size_bytes || 0) - (a.file_size_bytes || 0) : sort === 'duration' ? (b.duration_seconds || 0) - (a.duration_seconds || 0) : String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const grid = $('library-grid'); grid.replaceChildren(...list.map(card));
    $('empty').classList.toggle('hidden', list.length !== 0);
    const filtered = Boolean(q || state.filter !== 'all');
    $('empty-title').textContent = filtered ? 'No videos found' : 'Your library is waiting';
    $('empty-message').textContent = filtered ? 'Try a different search or choose another filter.' : 'Connect Google Drive, add a link, or scan the videos already on your server.';
    $('library-count').textContent = list.length; $('result-description').textContent = `${list.length} ${list.length === 1 ? 'video' : 'videos'}`;
    $('stat-total').textContent = state.videos.length; $('nav-count').textContent = state.videos.length;
    $('stat-local').textContent = state.videos.filter(isLocal).length;
    $('stat-cloud').textContent = state.videos.filter(v => v.status === 'REMOTE_ONLY').length;
  }
  async function loadVideos() {
    try {
      const response = await api('/api/videos'); const data = await response.json();
      state.videos = Array.isArray(data) ? data : (data.items || []); $('loading').classList.add('hidden'); renderVideos();
    } catch (problem) { $('loading').textContent = 'Could not load the library. Check that the server and database are running.'; toast(problem.message, true); }
  }
  async function loadMetrics() {
    try {
      const m = await (await api('/api/system/metrics')).json();
      const disk = m.disk || {}, cpu = m.cpu || {}, ram = m.ram || {};
      const pct = Math.max(0, Math.min(100, Number(disk.percent) || 0));
      $('storage-summary').textContent = `${Number(disk.used_gb || 0).toFixed(1)} of ${Number(disk.total_gb || 0).toFixed(1)} GB used`;
      $('storage-free').textContent = `${Number(disk.free_gb || 0).toFixed(1)} GB free`; $('storage-meter').style.width = `${pct}%`;
      $('detail-disk').textContent = `${Number(disk.used_gb || 0).toFixed(1)} / ${Number(disk.total_gb || 0).toFixed(1)} GB`;
      $('detail-cpu').textContent = `${Number(cpu.percent || 0).toFixed(1)}%`;
      $('detail-memory').textContent = `${Number(ram.used_gb || 0).toFixed(1)} / ${Number(ram.total_gb || 0).toFixed(1)} GB`;
      $('detail-threads').textContent = String(cpu.worker_threads || '—'); $('server-status').textContent = 'Server connected'; $('server-dot').classList.remove('offline');
    } catch (_) { $('server-status').textContent = 'Server unavailable'; $('server-dot').classList.add('offline'); }
  }
  function renderTransfers() {
    const items = [...state.transfers.values()]; const active = items.filter(x => !['LOCAL_READY','DOWNLOAD_COMPLETE','DONE','FAILED','PROCESSING_COMPLETE'].includes(x.status));
    $('nav-transfer-count').textContent = String(active.length); $('nav-transfer-count').classList.toggle('hidden', !active.length); $('transfer-dot').classList.toggle('hidden', !active.length);
    const box = $('transfers-list'); box.replaceChildren();
    if (!items.length) { box.append(el('p', 'quiet', 'No active transfers.')); return; }
    items.forEach(item => {
      const row = el('div', 'transfer-item'), head = el('div', 'transfer-title');
      const video = state.videos.find(v => v.video_id === item.video_id);
      head.append(el('span', '', item.title || video?.title || item.stage_name || 'Video'));
      const value = Number.isFinite(Number(item.percentage ?? item.percent)) ? `${Math.round(Number(item.percentage ?? item.percent))}%` : '';
      head.append(el('span', '', value)); row.append(head);
      row.append(el('div', 'transfer-meta', item.error || item.details || String(item.status || item.stage_name || 'Preparing').replaceAll('_',' ')));
      const meter = el('div', 'meter'), fill = el('span'); fill.style.width = `${Math.max(0, Math.min(100, Number(item.percentage ?? item.percent) || 0))}%`; meter.append(fill); row.append(meter); box.append(row);
    });
  }
  function connectSocket() {
    clearTimeout(state.socketTimer); const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/transfers`;
    const socket = new WebSocket(url); state.socket = socket;
    socket.addEventListener('open', () => { clearInterval(state.pingTimer); state.pingTimer = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send('ping'); }, 25000); });
    socket.addEventListener('message', event => {
      let msg; try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (!msg.video_id) return;
      if (msg.event === 'TRANSFER_UPDATE') {
        state.transfers.set(msg.video_id, msg); renderTransfers();
        if (state.pending === msg.video_id) {
          $('player-overlay-detail').textContent = msg.error || (msg.total_bytes ? `${Math.round(msg.percentage || 0)}% downloaded` : 'Downloading to your server…');
          if (msg.status === 'FAILED') { state.pending = null; $('player-overlay-title').textContent = 'Download failed'; }
          if (['DOWNLOAD_COMPLETE','LOCAL_READY','DONE'].includes(msg.status)) beginPendingPlayback(msg.video_id);
        }
        if (['DOWNLOAD_COMPLETE','FAILED'].includes(msg.status)) { loadVideos(); loadMetrics(); }
      } else if (msg.event === 'PROCESSING_FAILED') { state.transfers.set(msg.video_id, { ...msg, status: 'FAILED' }); renderTransfers(); loadVideos();
      } else if (msg.event === 'PROCESSING_UPDATE') { state.transfers.set(msg.video_id, msg); renderTransfers();
      } else if (msg.event === 'PROCESSING_COMPLETE') {
        state.transfers.set(msg.video_id, { ...msg, status: msg.action?.endsWith('_FAILED') ? 'FAILED' : 'PROCESSING_COMPLETE', title: state.videos.find(v => v.video_id === msg.video_id)?.title || 'Video' }); renderTransfers();
        // Never recreate or auto-resume an already active player on background completion.
        if (state.pending === msg.video_id) beginPendingPlayback(msg.video_id);
        if (state.active?.video_id === msg.video_id && !state.pending) { if (msg.metadata?.subtitles_url) addSubtitle(msg.metadata.subtitles_url, 'Generated subtitles', 'en'); refreshPlayerMetadata(msg.video_id); loadCues(msg.video_id); }
        loadVideos(); loadMetrics();
      }
    });
    socket.addEventListener('close', () => { clearInterval(state.pingTimer); state.socketTimer = setTimeout(connectSocket, 3500); });
  }
  async function beginPendingPlayback(id) {
    if (state.pending !== id) return;
    // Clear before awaiting, so adjacent transfer and processing events cannot recreate playback twice.
    state.pending = null;
    try {
      const fresh = await (await api(`/api/videos/${encodeURIComponent(id)}`)).json();
      if (state.active?.video_id === id && $('player-dialog').open) startPlayback(fresh);
    } catch (problem) { $('player-overlay-title').textContent = 'Could not start playback'; $('player-overlay-detail').textContent = problem.message; }
  }
  async function refreshPlayerMetadata(id) {
    try { const v = await (await api(`/api/videos/${encodeURIComponent(id)}`)).json(); if (state.active?.video_id === id) { state.active = v; populatePlayerOptions(v); } } catch (_) {}
  }
  function addSubtitle(url, label = 'Subtitles', language = 'en') {
    if (!url || !url.startsWith('/metadata/') || [...player.querySelectorAll('track')].some(t => t.src.endsWith(url))) return;
    const track = document.createElement('track'); track.kind = 'subtitles'; track.label = label; track.srclang = /^[a-z]{2,3}$/i.test(language) ? language : 'und'; track.src = url; player.append(track);
  }
  function populatePlayerOptions(v) {
    const quality = $('player-quality'), currentQuality = quality.value; quality.replaceChildren(new Option('Original', 'original'));
    Object.keys(v.renditions || {}).filter(q => ['720p','480p','360p'].includes(q)).forEach(q => quality.add(new Option(q, q)));
    if ([...quality.options].some(o => o.value === currentQuality)) quality.value = currentQuality;
    const audio = $('player-audio'), currentAudio = audio.value; audio.replaceChildren(new Option('Original audio', 'default'));
    (v.audio_tracks || []).forEach((track, index) => { if (index > 0) audio.add(new Option(track.label || `Audio ${index + 1}`, String(track.index ?? index))); });
    if ([...audio.options].some(o => o.value === currentAudio)) audio.value = currentAudio;
    (v.subtitle_tracks || []).forEach(track => { if (track.url) addSubtitle(track.url, track.label || 'Subtitles', track.language || 'und'); });
    if (v.subtitles_url) addSubtitle(v.subtitles_url, 'Generated subtitles', 'en');
  }
  function startPlayback(v) {
    state.active = v; state.pending = null; $('player-overlay').classList.add('hidden'); $('player-note').textContent = '';
    player.querySelectorAll('track').forEach(t => t.remove()); populatePlayerOptions(v); $('player-quality').value = 'original';
    player.src = `/api/stream/${encodeURIComponent(v.video_id)}`; player.load();
    const saved = Number(localStorage.getItem(`dc_position_${v.video_id}`) || 0);
    player.addEventListener('loadedmetadata', () => { if (saved > 5 && saved < player.duration - 5) player.currentTime = saved; }, { once: true });
    player.play().catch(() => { $('player-note').textContent = 'Press play to start watching.'; }); loadCues(v.video_id);
    if (!v.audio_tracks?.length) api(`/api/videos/${encodeURIComponent(v.video_id)}/probe-tracks`, { method: 'POST' }).then(() => refreshPlayerMetadata(v.video_id)).catch(() => {});
  }
  function openVideo(v) {
    state.active = v; state.pending = null; $('player-title').textContent = v.title || 'Untitled video';
    $('player-source').textContent = isLocal(v) ? 'On your server' : v.status === 'REMOTE_ONLY' ? 'Google Drive' : 'Your library';
    $('player-quality').replaceChildren(new Option('Original', 'original')); $('player-audio').replaceChildren(new Option('Original audio', 'default'));
    $('player-note').textContent = ''; $('player-overlay').classList.add('hidden'); showDialog('player-dialog');
    if (isLocal(v)) startPlayback(v);
    else if (v.status === 'REMOTE_ONLY') {
      state.pending = v.video_id; $('player-overlay').classList.remove('hidden'); $('player-overlay-title').textContent = 'Fetching from Google Drive'; $('player-overlay-detail').textContent = 'Downloading to your server…';
      api(`/api/videos/${encodeURIComponent(v.video_id)}/download`, { method: 'POST' }).catch(problem => { state.pending = null; $('player-overlay-title').textContent = 'Download failed'; $('player-overlay-detail').textContent = problem.message; });
    } else { $('player-overlay').classList.remove('hidden'); $('player-overlay-title').textContent = 'Video not available yet'; $('player-overlay-detail').textContent = v.error || 'Check Transfers for the current status.'; }
  }
  function cleanupPlayer() {
    state.pending = null; state.active = null; state.cues = []; alternateAudio.pause(); alternateAudio.removeAttribute('src'); alternateAudio.load();
    player.pause(); player.removeAttribute('src'); player.querySelectorAll('track').forEach(t => t.remove()); player.load(); player.muted = false; $('player-overlay').classList.add('hidden'); $('scrub-preview').classList.add('hidden');
  }
  $('player-dialog').addEventListener('close', cleanupPlayer);
  $('player-quality').addEventListener('change', () => {
    if (!state.active || !player.src) return;
    const wasPaused = player.paused, time = player.currentTime, rate = player.playbackRate;
    const url = new URL(`/api/stream/${encodeURIComponent(state.active.video_id)}`, location.origin);
    if ($('player-quality').value !== 'original') url.searchParams.set('quality', $('player-quality').value);
    player.src = url.pathname + url.search; player.addEventListener('loadedmetadata', () => { player.currentTime = Math.min(time, player.duration || time); player.playbackRate = rate; if (!wasPaused) player.play().catch(() => {}); }, { once: true }); player.load();
  });
  $('player-audio').addEventListener('change', () => {
    if (!state.active) return; const idx = $('player-audio').value;
    if (idx === 'default') { alternateAudio.pause(); alternateAudio.removeAttribute('src'); player.muted = false; return; }
    alternateAudio.src = `/api/videos/${encodeURIComponent(state.active.video_id)}/audio/${encodeURIComponent(idx)}`;
    alternateAudio.currentTime = player.currentTime; alternateAudio.playbackRate = player.playbackRate; player.muted = true;
    if (!player.paused) alternateAudio.play().catch(() => { $('player-note').textContent = 'Alternate audio is preparing. Try again shortly.'; });
  });
  player.addEventListener('play', () => { if (alternateAudio.src && $('player-audio').value !== 'default') { alternateAudio.currentTime = player.currentTime; alternateAudio.play().catch(() => {}); } });
  player.addEventListener('pause', () => alternateAudio.pause());
  player.addEventListener('seeking', () => { if (alternateAudio.src) alternateAudio.currentTime = player.currentTime; });
  player.addEventListener('ratechange', () => { alternateAudio.playbackRate = player.playbackRate; });
  player.addEventListener('timeupdate', () => {
    if (alternateAudio.src && !syncingAlternate && Math.abs(alternateAudio.currentTime - player.currentTime) > 0.4) { syncingAlternate = true; try { alternateAudio.currentTime = player.currentTime; } finally { syncingAlternate = false; } }
    if (Number.isFinite(player.duration) && player.duration > 0) $('scrub').value = String(player.currentTime / player.duration * 100);
    $('player-time').textContent = duration(player.currentTime);
    if (state.active && Date.now() - lastPositionSave > 5000) { lastPositionSave = Date.now(); if (player.currentTime > 5) localStorage.setItem(`dc_position_${state.active.video_id}`, String(player.currentTime)); }
  });
  player.addEventListener('error', () => { if (state.active && player.getAttribute('src')) $('player-note').textContent = 'The video could not be played. Its codec may not be supported by your browser.'; });
  player.addEventListener('ended', () => { if (state.active) localStorage.removeItem(`dc_position_${state.active.video_id}`); });
  $('player-gain').addEventListener('change', async () => {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('Audio boost is not available in this browser.');
      if (!state.audioContext) { state.audioContext = new AudioContextClass(); state.gain = state.audioContext.createGain(); state.gain.connect(state.audioContext.destination); state.mediaSource = state.audioContext.createMediaElementSource(player); state.mediaSource.connect(state.gain); state.alternateSource = state.audioContext.createMediaElementSource(alternateAudio); state.alternateSource.connect(state.gain); }
      state.gain.gain.value = Number($('player-gain').value) / 100; if (state.audioContext.state === 'suspended') await state.audioContext.resume();
    } catch (problem) { $('player-note').textContent = problem.message; }
  });
  function parseTime(text) { const parts = text.trim().split(':').map(Number); return parts.reduce((a,b) => a * 60 + b, 0); }
  async function loadCues(id) {
    state.cues = [];
    try {
      const data = await (await api(`/metadata/${encodeURIComponent(id)}/thumbnails.vtt`)).text();
      const lines = data.split(/\r?\n/);
      for (let i = 0; i < lines.length - 1; i++) {
        const match = lines[i].match(/^\s*(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/);
        const sprite = lines[i + 1]?.match(/^(\/metadata\/[A-Za-z0-9_-]+\/sprites\.jpg)#xywh=(\d+),(\d+),(\d+),(\d+)$/);
        if (match && sprite) state.cues.push({ start: parseTime(match[1]), end: parseTime(match[2]), url: sprite[1], x: +sprite[2], y: +sprite[3] });
      }
    } catch (_) {}
  }
  $('scrub').addEventListener('input', () => { if (Number.isFinite(player.duration)) player.currentTime = Number($('scrub').value) / 100 * player.duration; });
  $('scrub').addEventListener('pointermove', event => {
    if (!Number.isFinite(player.duration) || !state.cues.length) return;
    const bounds = $('scrub').getBoundingClientRect(), ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)), t = ratio * player.duration;
    const cue = state.cues.find(c => t >= c.start && t < c.end); if (!cue) return;
    const preview = $('scrub-preview'); preview.style.left = `${Math.max(0, Math.min(bounds.width - 160, ratio * bounds.width - 80))}px`;
    $('scrub-image').style.backgroundImage = `url("${cue.url}")`; $('scrub-image').style.backgroundPosition = `-${cue.x}px -${cue.y}px`; $('scrub-time').textContent = duration(t); preview.classList.remove('hidden');
  });
  $('scrub').addEventListener('pointerleave', () => $('scrub-preview').classList.add('hidden'));
  $('player-theater').addEventListener('click', event => { const theater = $('player-dialog').classList.toggle('theater'); event.currentTarget.setAttribute('aria-pressed', String(theater)); });
  $('player-transcribe').addEventListener('click', async () => { if (!state.active) return; try { await api(`/api/videos/${encodeURIComponent(state.active.video_id)}/transcribe`, {method:'POST'}); toast('Subtitle generation started.'); } catch (p) { toast(p.message, true); } });
  $('player-transcode').addEventListener('click', async () => { if (!state.active) return; try { await api(`/api/videos/${encodeURIComponent(state.active.video_id)}/transcode`, {method:'POST', body:JSON.stringify({quality:'720p', replace_original:false})}); toast('720p conversion started; the original will be kept.'); } catch (p) { toast(p.message, true); } });
  $('player-delete').addEventListener('click', async () => { if (!state.active || !confirm(`Delete “${state.active.title || 'this video'}” and its local files? This cannot be undone.`)) return; try { await api(`/api/videos/${encodeURIComponent(state.active.video_id)}`, { method:'DELETE' }); closeDialog('player-dialog'); await loadVideos(); await loadMetrics(); toast('Video removed.'); } catch (p) { toast(p.message, true); } });

  function drivePayload() {
    const payload = { auth_type: $('drive-auth').value, folder_id: $('drive-folder').value.trim() };
    const key = $('drive-key').value.trim(), service = $('drive-service').value.trim();
    if (payload.auth_type === 'api_key' && key) payload.api_key = key;
    if (payload.auth_type === 'service_account' && service) payload.service_account_json = service;
    return payload;
  }
  async function loadDrive() {
    errorMessage('drive-error', '');
    try { const cfg = await (await api('/api/drive/config')).json(); $('drive-auth').value = cfg.auth_type === 'service_account' ? 'service_account' : 'api_key'; $('drive-folder').value = cfg.folder_id || ''; $('drive-status').textContent = cfg.configured ? `Saved connection: ${cfg.auth_type.replaceAll('_',' ')}${cfg.api_key_masked ? ` (${cfg.api_key_masked})` : ''}.` : 'No saved connection yet.'; updateDriveFields(); } catch (p) { errorMessage('drive-error', p.message); }
  }
  function updateDriveFields() { const isKey = $('drive-auth').value === 'api_key'; $('drive-key-group').classList.toggle('hidden', !isKey); $('drive-service-group').classList.toggle('hidden', isKey); }
  $('drive-auth').addEventListener('change', updateDriveFields);
  $('drive-test').addEventListener('click', async event => { const button = event.currentTarget; button.disabled = true; errorMessage('drive-error',''); try { const result = await (await api('/api/drive/test', {method:'POST', body:JSON.stringify(drivePayload())})).json(); if (!result.success) throw new Error(result.message || 'Connection failed.'); $('drive-status').textContent = result.message; } catch (p) { errorMessage('drive-error',p.message); } finally { button.disabled = false; } });
  $('drive-form').addEventListener('submit', async event => { event.preventDefault(); const button = $('drive-save'); button.disabled = true; errorMessage('drive-error',''); try { const payload = drivePayload(); await api('/api/drive/config', {method:'POST',body:JSON.stringify(payload)}); $('drive-key').value = ''; $('drive-service').value = ''; toast('Connection saved. Syncing your library…'); await api('/api/videos/sync-drive', {method:'POST',body:JSON.stringify({folder_id:payload.folder_id || null})}); closeDialog('drive-dialog'); await loadVideos(); await loadMetrics(); toast('Google Drive sync finished.'); } catch(p) { errorMessage('drive-error',p.message); } finally { button.disabled = false; } });
  $('add-form').addEventListener('submit', async event => { event.preventDefault(); const button = $('add-submit'); button.disabled = true; errorMessage('add-error',''); try { const urls = $('video-urls').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean); const payload = {urls, title: urls.length === 1 ? $('video-title').value.trim() || null : null, engine: $('download-engine').value}; const result = await (await api('/api/videos/download-url', {method:'POST',body:JSON.stringify(payload)})).json(); if (result.errors?.length) toast(`${result.count} queued; ${result.errors.length} could not be queued.`, true); else toast(`${result.count || urls.length} video${(result.count || urls.length) === 1 ? '' : 's'} added to the queue.`); event.target.reset(); closeDialog('add-dialog'); await loadVideos(); } catch(p) { errorMessage('add-error',p.message); } finally { button.disabled = false; } });
  $('clear-transfers').addEventListener('click', () => { for (const [id, item] of state.transfers) if (['LOCAL_READY','DOWNLOAD_COMPLETE','DONE','FAILED','PROCESSING_COMPLETE'].includes(item.status)) state.transfers.delete(id); renderTransfers(); });
  $('search').addEventListener('input', renderVideos); $('sort').addEventListener('change', renderVideos);
  document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => setFilter(button.dataset.filter)));
  document.querySelectorAll('[data-nav]').forEach(button => button.addEventListener('click', () => setFilter(button.dataset.nav === 'library' ? 'all' : button.dataset.nav)));
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => closeDialog(button.dataset.close)));
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', async () => {
    const action = button.dataset.action;
    if (action === 'add') showDialog('add-dialog');
    if (action === 'sync') { showDialog('drive-dialog'); await loadDrive(); }
    if (action === 'transfers') showDialog('transfers-dialog');
    if (action === 'system') { showDialog('system-dialog'); loadMetrics(); }
    if (action === 'scan') { button.disabled = true; try { const result = await (await api('/api/videos/scan-local',{method:'POST'})).json(); toast(result.message || 'Storage scan finished.'); await loadVideos(); } catch (p) { toast(p.message, true); } finally { button.disabled = false; } }
    if (action === 'logout') { try { await api('/api/auth/logout',{method:'POST'}); } catch (_) {} location.replace('/login'); }
  }));
  document.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || ['INPUT','TEXTAREA','SELECT','BUTTON'].includes(document.activeElement?.tagName)) return;
    if (event.key === '/' && !document.querySelector('dialog[open]')) { event.preventDefault(); $('search').focus(); return; }
    if (!$('player-dialog').open || !state.active || state.pending) return;
    if (event.key === ' ' || event.key.toLowerCase() === 'k') { event.preventDefault(); if (player.paused) player.play().catch(() => {}); else player.pause(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); player.currentTime = Math.max(0, player.currentTime - 10); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); if (Number.isFinite(player.duration)) player.currentTime = Math.min(player.duration, player.currentTime + 10); }
    else if (event.key.toLowerCase() === 'f' && player.requestFullscreen) { event.preventDefault(); player.requestFullscreen().catch(() => {}); }
  });
  async function start() {
    try { const user = await (await api('/api/auth/me')).json(); $('account-name').textContent = user.username || 'Admin'; document.querySelector('.avatar').textContent = (user.username || 'A').charAt(0).toUpperCase(); await Promise.all([loadVideos(), loadMetrics()]); connectSocket(); state.metricsTimer = setInterval(loadMetrics, 10000); } catch (_) {}
  }
  start();
})();
