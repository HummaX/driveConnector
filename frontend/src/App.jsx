import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { 
  Search, Film, RefreshCw, LayoutGrid, List, 
  ArrowUpDown, X, Cloud, HardDrive, Plus, Sparkles, Database,
  SlidersHorizontal, CheckCircle2, AlertCircle, Loader2
} from 'lucide-react';
import Navbar from './components/Navbar';
import VideoCard from './components/VideoCard';
import VideoPlayerModal from './components/VideoPlayerModal';
import DriveSyncModal from './components/DriveSyncModal';
import UrlDownloadModal from './components/UrlDownloadModal';
import MongoDbModal from './components/MongoDbModal';
import TransfersDrawer from './components/TransfersDrawer';
import LoginPage from './components/LoginPage';
import StatsDashboard from './components/StatsDashboard';

export default function App() {
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('ALL');
  const [sortBy, setSortBy] = useState('newest');
  const [viewMode, setViewMode] = useState('grid');
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false);
  const [isMongoModalOpen, setIsMongoModalOpen] = useState(false);
  const [transfers, setTransfers] = useState({});
  const [processingJobs, setProcessingJobs] = useState({});
  const [metrics, setMetrics] = useState(null);

  const searchInputRef = useRef(null);

  // Authentication State
  const [token, setToken] = useState(() => localStorage.getItem('drive_auth_token'));
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('drive_auth_user'));
    } catch {
      return null;
    }
  });

  const selectedVideoRef = useRef(null);
  selectedVideoRef.current = selectedVideo;

  const handleLoginSuccess = (authData) => {
    setToken(authData.access_token);
    setUser({ username: authData.username, role: authData.role });
  };

  const handleLogout = () => {
    localStorage.removeItem('drive_auth_token');
    localStorage.removeItem('drive_auth_user');
    setToken(null);
    setUser(null);
    setVideos([]);
    setMetrics(null);
  };

  const getAuthHeaders = useCallback(() => {
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  }, [token]);

  // 1. Fetch System Hardware & Throughput Metrics
  const fetchMetrics = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/system/metrics', { headers: getAuthHeaders() });
      if (res.status === 401) {
        handleLogout();
        return;
      }
      if (res.ok) {
        const data = await res.json();
        setMetrics(data);
      }
    } catch (err) {
      console.error('Failed to load metrics:', err);
    }
  }, [token, getAuthHeaders]);

  // 2. Fetch Video Catalog
  const fetchVideos = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/videos', { headers: getAuthHeaders() });
      if (res.status === 401) {
        handleLogout();
        return;
      }
      if (res.ok) {
        const data = await res.json();
        setVideos(data);
      }
    } catch (err) {
      console.error('Failed to load videos:', err);
    } finally {
      setLoading(false);
    }
  }, [token, getAuthHeaders]);

  useEffect(() => {
    if (token) {
      fetchVideos();
      fetchMetrics();
      const interval = setInterval(fetchMetrics, 3000);
      return () => clearInterval(interval);
    }
  }, [token, fetchVideos, fetchMetrics]);

  // Keyboard shortcut listener ('/' to focus search safely without stealing from modals)
  useEffect(() => {
    const handleKeyDown = (e) => {
      const activeEl = document.activeElement;
      const tag = activeEl?.tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || activeEl?.isContentEditable;

      if (e.key === '/' && !isInput && activeEl !== searchInputRef.current) {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === 'Escape' && activeEl === searchInputRef.current) {
        setSearchQuery('');
        searchInputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 3. Stable Authenticated WebSocket Connection
  useEffect(() => {
    if (!token) return;

    let ws;
    let reconnectTimer;

    const connectWs = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws/transfers?token=${encodeURIComponent(token)}`;
      ws = new WebSocket(wsUrl);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.event === 'TRANSFER_UPDATE') {
            const isDone =
              msg.status === 'DOWNLOAD_COMPLETE' ||
              msg.status === 'LOCAL_READY' ||
              msg.status === 'DONE' ||
              (msg.percentage >= 100 && msg.status !== 'FAILED');
            const updatedMsg = isDone
              ? { ...msg, percentage: 100, speed_mbs: 0, eta_seconds: 0 }
              : msg;

            setTransfers((prev) => ({
              ...prev,
              [msg.video_id]: updatedMsg
            }));

            // Auto-dismiss completed transfer after a short period
            if (isDone) {
              setTimeout(() => {
                setTransfers((prev) => {
                  const curr = prev[msg.video_id];
                  if (
                    curr &&
                    (curr.status === 'DOWNLOAD_COMPLETE' ||
                      curr.status === 'LOCAL_READY' ||
                      curr.status === 'DONE' ||
                      curr.percentage >= 100)
                  ) {
                    const copy = { ...prev };
                    delete copy[msg.video_id];
                    return copy;
                  }
                  return prev;
                });
              }, 8000);
            }

            const activeModal = selectedVideoRef.current;
            if (activeModal && activeModal.video_id === msg.video_id && isDone) {
              setSelectedVideo((prev) => ({
                ...prev,
                status: 'LOCAL_READY',
                local_path: `/mnt/storage/videos/${msg.video_id}.mp4`
              }));
              fetchVideos();
            }
          } else if (msg.event === 'PROCESSING_UPDATE') {
            setProcessingJobs((prev) => ({
              ...prev,
              [msg.video_id]: msg
            }));
            setVideos((prev) =>
              prev.map((v) => (v.video_id === msg.video_id ? { ...v, status: 'PROCESSING', processing_info: msg } : v))
            );
            const activeModal = selectedVideoRef.current;
            if (activeModal && activeModal.video_id === msg.video_id) {
              setSelectedVideo((prev) => ({
                ...prev,
                processing_info: msg
              }));
            }
          } else if (msg.event === 'PROCESSING_COMPLETE') {
            setProcessingJobs((prev) => {
              const copy = { ...prev };
              delete copy[msg.video_id];
              return copy;
            });
            setTransfers((prev) => {
              if (prev[msg.video_id]) {
                return {
                  ...prev,
                  [msg.video_id]: {
                    ...prev[msg.video_id],
                    status: 'LOCAL_READY',
                    percentage: 100,
                    speed_mbs: 0,
                    eta_seconds: 0
                  }
                };
              }
              return prev;
            });
            setTimeout(() => {
              setTransfers((prev) => {
                const copy = { ...prev };
                delete copy[msg.video_id];
                return copy;
              });
            }, 5000);
            setVideos((prev) =>
              prev.map((v) => (v.video_id === msg.video_id ? { ...v, ...msg.metadata, status: 'LOCAL_READY', processing_info: null } : v))
            );
            const activeModal = selectedVideoRef.current;
            if (activeModal && activeModal.video_id === msg.video_id) {
              setSelectedVideo((prev) => ({
                ...prev,
                ...msg.metadata,
                status: 'LOCAL_READY',
                processing_info: null
              }));
            }
            fetchVideos();
          }
        } catch (e) {
          console.error('WebSocket parse error:', e);
        }
      };

      ws.onclose = () => {
        reconnectTimer = setTimeout(connectWs, 3000);
      };
      ws.onerror = () => ws.close();
    };

    connectWs();

    return () => {
      if (ws) ws.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [token, fetchVideos]);

  // 4. Trigger On-Demand Drive Download
  const handleTriggerDownload = async (videoId) => {
    try {
      const res = await fetch(`/api/videos/${videoId}/download`, {
        method: 'POST',
        headers: getAuthHeaders()
      });
      if (res.status === 401) {
        handleLogout();
        return;
      }
      fetchVideos();
    } catch (err) {
      console.error('Failed to trigger download:', err);
    }
  };

  // 5. Delete Video
  const handleDeleteVideo = async (videoId) => {
    try {
      const res = await fetch(`/api/videos/${videoId}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      if (res.status === 401) {
        handleLogout();
        return;
      }
      if (res.ok) {
        setVideos((prev) => prev.filter((v) => v.video_id !== videoId));
        if (selectedVideo && selectedVideo.video_id === videoId) {
          setSelectedVideo(null);
        }
      }
    } catch (err) {
      console.error('Failed to delete video:', err);
    }
  };

  const confirmAndDelete = (videoId, title) => {
    if (window.confirm(`Are you sure you want to remove "${title || videoId}" and all cached assets from storage?`)) {
      handleDeleteVideo(videoId);
    }
  };

  // 6. Transcode Video Renditions
  const handleTranscode = async (videoId, quality = '720p', replaceOriginal = false) => {
    try {
      const res = await fetch(`/api/videos/${videoId}/transcode`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ quality, replace_original: replaceOriginal })
      });
      if (res.status === 401) {
        handleLogout();
        return;
      }
      fetchVideos();
    } catch (err) {
      console.error('Failed to trigger transcode:', err);
    }
  };

  // 7. Transcribe AI Subtitles
  const handleTranscribe = async (videoId) => {
    try {
      const res = await fetch(`/api/videos/${videoId}/transcribe`, {
        method: 'POST',
        headers: getAuthHeaders()
      });
      if (res.status === 401) {
        handleLogout();
        return;
      }
      fetchVideos();
    } catch (err) {
      console.error('Failed to trigger transcription:', err);
    }
  };

  // Filtered and Sorted Videos
  const filteredVideos = useMemo(() => {
    let result = videos.filter((video) => {
      const matchesSearch = (video.title || '').toLowerCase().includes(searchQuery.toLowerCase());
      if (!matchesSearch) return false;
      if (activeFilter === 'LOCAL') return video.status === 'LOCAL_READY';
      if (activeFilter === 'CLOUD') return video.status === 'REMOTE_ONLY';
      return true;
    });

    result.sort((a, b) => {
      if (sortBy === 'title') {
        return (a.title || '').localeCompare(b.title || '');
      }
      if (sortBy === 'size') {
        return (b.file_size_bytes || 0) - (a.file_size_bytes || 0);
      }
      if (sortBy === 'duration') {
        return (b.duration_seconds || 0) - (a.duration_seconds || 0);
      }
      // 'newest' default (by created_at or video_id)
      return (b.created_at || b.video_id || '').localeCompare(a.created_at || a.video_id || '');
    });

    return result;
  }, [videos, searchQuery, activeFilter, sortBy]);

  const counts = useMemo(() => {
    const activeDownloads = Object.values(transfers).filter(
      (t) =>
        t.status !== 'FAILED' &&
        t.status !== 'DOWNLOAD_COMPLETE' &&
        t.status !== 'LOCAL_READY' &&
        t.status !== 'DONE' &&
        (t.percentage || 0) < 100 &&
        (t.status === 'DOWNLOADING' || t.status === 'QUEUED' || t.status === 'WAITING')
    ).length;
    const activeProcessing = Object.values(processingJobs).filter(
      (p) => (p.percent || 0) < 100 && p.status !== 'COMPLETED' && p.status !== 'FAILED'
    ).length;

    return {
      all: videos.length,
      local: videos.filter((v) => v.status === 'LOCAL_READY').length,
      cloud: videos.filter((v) => v.status === 'REMOTE_ONLY').length,
      processing: videos.filter((v) => v.status === 'PROCESSING').length,
      active: activeDownloads + activeProcessing
    };
  }, [videos, transfers, processingJobs]);

  const handleDismissTransfer = (videoId) => {
    setTransfers((prev) => {
      const copy = { ...prev };
      delete copy[videoId];
      return copy;
    });
  };

  const handleClearCompletedTransfers = () => {
    setTransfers((prev) => {
      const copy = {};
      Object.entries(prev).forEach(([id, t]) => {
        const isDone =
          t.percentage >= 100 ||
          t.status === 'DOWNLOAD_COMPLETE' ||
          t.status === 'LOCAL_READY' ||
          t.status === 'DONE';
        if (!isDone) {
          copy[id] = t;
        }
      });
      return copy;
    });
  };

  // STRICT AUTH WALL: If not authenticated, render ONLY the Login Page!
  if (!token || !user) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />;
  }

  // Format bytes helper for list view
  const formatBytes = (bytes) => {
    if (!bytes || bytes <= 0) return '0 MB';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const formatDuration = (seconds) => {
    if (!seconds || seconds <= 0) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <div className="min-h-screen bg-[#0a0c14] text-slate-100 flex flex-col selection:bg-sky-500 selection:text-white">
      {/* Top Hardware Telemetry Header */}
      <Navbar
        user={user}
        onLogout={handleLogout}
        onOpenSync={() => setIsSyncModalOpen(true)}
        onOpenUrl={() => setIsUrlModalOpen(true)}
        onOpenMongoDb={() => setIsMongoModalOpen(true)}
        metrics={metrics}
        activeTransfersCount={counts.active}
        onRefresh={() => {
          fetchVideos();
          fetchMetrics();
        }}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* Executive Real-Time Operations Stats Dashboard */}
        <StatsDashboard
          metrics={metrics}
          videos={videos}
          transfers={transfers}
          processingJobs={processingJobs}
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
        />

        {/* Search, Filter & View Controls Toolbar */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pt-1">
          {/* Search Box */}
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search catalog... (Press '/' to focus)"
              className="w-full pl-9 pr-8 py-2 rounded-lg bg-[#010409] border border-[#30363d] text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 transition shadow-inner font-sans"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white p-0.5 rounded transition"
                title="Clear Search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Filter Tabs, Sort, and View Controls */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Filter Tabs (GitHub-style Segmented Pills) */}
            <div className="flex items-center space-x-1 bg-[#161b22] p-1 rounded-lg border border-[#30363d] text-xs font-medium">
              <button
                onClick={() => setActiveFilter('ALL')}
                className={`px-3 py-1 rounded-md transition font-mono ${
                  activeFilter === 'ALL'
                    ? 'bg-[#21262d] text-white shadow-sm border border-[#30363d]'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                All ({counts.all})
              </button>
              <button
                onClick={() => setActiveFilter('LOCAL')}
                className={`px-3 py-1 rounded-md transition font-mono ${
                  activeFilter === 'LOCAL'
                    ? 'bg-emerald-500/20 text-emerald-300 shadow-sm border border-emerald-500/30'
                    : 'text-slate-400 hover:text-emerald-400'
                }`}
              >
                Saved Local ({counts.local})
              </button>
              <button
                onClick={() => setActiveFilter('CLOUD')}
                className={`px-3 py-1 rounded-md transition font-mono ${
                  activeFilter === 'CLOUD'
                    ? 'bg-amber-500/20 text-amber-300 shadow-sm border border-amber-500/30'
                    : 'text-slate-400 hover:text-amber-400'
                }`}
              >
                On Cloud ({counts.cloud})
              </button>
            </div>

            {/* Sort Selector */}
            <div className="flex items-center space-x-1.5 bg-[#161b22] px-2.5 py-1.5 rounded-lg border border-[#30363d] text-xs text-slate-300">
              <ArrowUpDown className="w-3.5 h-3.5 text-slate-400" />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="bg-transparent text-xs text-slate-200 focus:outline-none cursor-pointer font-sans"
              >
                <option value="newest" className="bg-[#161b22] text-white">Recently Added</option>
                <option value="title" className="bg-[#161b22] text-white">Title (A-Z)</option>
                <option value="size" className="bg-[#161b22] text-white">File Size</option>
                <option value="duration" className="bg-[#161b22] text-white">Duration</option>
              </select>
            </div>

            {/* Grid vs List View Mode Toggle */}
            <div className="flex items-center bg-[#161b22] p-1 rounded-lg border border-[#30363d] text-slate-400">
              <button
                onClick={() => setViewMode('grid')}
                title="Grid View"
                className={`p-1.5 rounded-md transition ${viewMode === 'grid' ? 'bg-[#21262d] text-white' : 'hover:text-white'}`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                title="List View"
                className={`p-1.5 rounded-md transition ${viewMode === 'list' ? 'bg-[#21262d] text-white' : 'hover:text-white'}`}
              >
                <List className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Video Catalog Display */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 text-slate-500 space-y-3">
            <RefreshCw className="w-7 h-7 animate-spin text-sky-400" />
            <p className="text-xs font-mono">Querying media catalog & MongoDB records...</p>
          </div>
        ) : filteredVideos.length > 0 ? (
          viewMode === 'grid' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filteredVideos.map((video) => (
                <VideoCard
                  key={video.video_id}
                  video={video}
                  onPlay={(v) => setSelectedVideo(v)}
                  onDelete={handleDeleteVideo}
                  onDownload={handleTriggerDownload}
                  onTranscode={handleTranscode}
                  onTranscribe={handleTranscribe}
                  processingJob={processingJobs[video.video_id]}
                />
              ))}
            </div>
          ) : (
            /* Sleek Table / List View */
            <div className="bg-[#0d1117]/90 border border-[#30363d] rounded-xl overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#161b22] text-slate-400 font-mono uppercase text-[10px] border-b border-[#30363d]">
                    <tr>
                      <th className="px-4 py-3">Title</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Source</th>
                      <th className="px-4 py-3">Duration</th>
                      <th className="px-4 py-3">Size</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#30363d]/60 font-sans">
                    {filteredVideos.map((v) => {
                      const isLocal = v.status === 'LOCAL_READY';
                      const proc = processingJobs[v.video_id] || v.processing_info;
                      const isProcessing = v.status === 'PROCESSING' || Boolean(proc);
                      return (
                        <tr
                          key={v.video_id}
                          onClick={() => setSelectedVideo(v)}
                          className="hover:bg-[#161b22]/70 cursor-pointer transition"
                        >
                          <td className="px-4 py-3 font-medium text-white max-w-xs truncate">
                            <span title={v.title}>{v.title}</span>
                          </td>
                          <td className="px-4 py-3 font-mono text-[11px]">
                            {proc ? (
                              <div className="space-y-1 max-w-[200px]">
                                <span className="inline-flex items-center space-x-1.5 text-purple-300 bg-purple-500/10 px-2 py-0.5 rounded border border-purple-500/20 text-[10px] font-mono">
                                  <Loader2 className="w-3 h-3 animate-spin text-purple-400 shrink-0" />
                                  <span className="truncate">{proc.stage_name || 'Generating Sprites'}: {proc.stage_percent || proc.percent}% {proc.eta_seconds > 0 ? `(${proc.eta_seconds}s left)` : ''}</span>
                                </span>
                                <div className="w-full bg-[#21262d] h-1 rounded-full overflow-hidden">
                                  <div
                                    className="bg-gradient-to-r from-purple-500 to-indigo-500 h-full transition-all duration-300 rounded-full"
                                    style={{ width: `${proc.stage_percent || proc.percent}%` }}
                                  />
                                </div>
                              </div>
                            ) : isProcessing ? (
                              <span className="inline-flex items-center space-x-1.5 text-purple-300 bg-purple-500/10 px-2 py-0.5 rounded border border-purple-500/20 text-[10px] font-mono">
                                <Loader2 className="w-3 h-3 animate-spin text-purple-400 shrink-0" />
                                <span>Generating Sprites (in progress)</span>
                              </span>
                            ) : isLocal ? (
                              <span className="text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                                Saved on Server
                              </span>
                            ) : (
                              <span className="text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                                Cloud Remote
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-slate-400 font-mono text-[11px]">
                            {v.source === 'GDRIVE' ? 'Google Drive' : 'Direct Link'}
                          </td>
                          <td className="px-4 py-3 text-slate-400 font-mono text-[11px]">
                            {formatDuration(v.duration_seconds)}
                          </td>
                          <td className="px-4 py-3 text-slate-400 font-mono text-[11px]">
                            {formatBytes(v.file_size_bytes)}
                          </td>
                          <td className="px-4 py-3 text-right space-x-2" onClick={(e) => e.stopPropagation()}>
                            {!isLocal && (
                              <button
                                onClick={() => handleTriggerDownload(v.video_id)}
                                className="px-2.5 py-1 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20 hover:bg-sky-500/20 transition text-[11px] font-medium"
                              >
                                Fetch
                              </button>
                            )}
                            <button
                              onClick={() => confirmAndDelete(v.video_id, v.title)}
                              className="px-2.5 py-1 rounded text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition text-[11px] font-medium border border-transparent hover:border-red-500/20"
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )
        ) : (
          /* Empty State */
          <div className="flex flex-col items-center justify-center py-20 px-4 text-center bg-[#0d1117]/60 border border-dashed border-[#30363d] rounded-2xl">
            <div className="p-3.5 rounded-2xl bg-[#161b22] text-slate-500 mb-3 border border-[#30363d]">
              <Film className="w-8 h-8 text-sky-400" />
            </div>
            <h3 className="text-sm font-semibold text-white mb-1">No media files in catalog</h3>
            <p className="text-xs text-slate-400 max-w-sm mb-5">
              Sync your Google Drive library with zero disk storage footprint, or ingest high-resolution web streams.
            </p>
            <div className="flex items-center space-x-2.5">
              <button
                onClick={() => setIsSyncModalOpen(true)}
                className="px-3.5 py-2 rounded-lg bg-[#161b22] hover:bg-[#21262d] text-white text-xs font-semibold border border-[#30363d] shadow-sm transition"
              >
                Sync Google Drive
              </button>
              <button
                onClick={() => setIsUrlModalOpen(true)}
                className="px-3.5 py-2 rounded-lg bg-[#238636] hover:bg-[#2ea043] text-white text-xs font-semibold border border-[#2ea043]/50 shadow-sm transition"
              >
                Add External URL
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Video Player Modal with Authenticated Range Streaming */}
      {selectedVideo && (
        <VideoPlayerModal
          video={selectedVideo}
          token={token}
          activeTransfer={transfers[selectedVideo.video_id]}
          processingJob={selectedVideo ? processingJobs[selectedVideo.video_id] : null}
          onClose={() => setSelectedVideo(null)}
          onTriggerDownload={handleTriggerDownload}
          onTranscode={handleTranscode}
          onTranscribe={handleTranscribe}
        />
      )}

      {/* MongoDB Live Explorer Modal */}
      <MongoDbModal
        isOpen={isMongoModalOpen}
        authHeaders={getAuthHeaders()}
        onClose={() => setIsMongoModalOpen(false)}
      />

      {/* Drive Sync Modal */}
      <DriveSyncModal
        isOpen={isSyncModalOpen}
        authHeaders={getAuthHeaders()}
        onClose={() => setIsSyncModalOpen(false)}
        onSyncComplete={fetchVideos}
      />

      {/* External URL Ingestion Modal */}
      <UrlDownloadModal
        isOpen={isUrlModalOpen}
        authHeaders={getAuthHeaders()}
        onClose={() => setIsUrlModalOpen(false)}
        onDownloadStarted={fetchVideos}
      />

      {/* Real-time Transfer Telemetry HUD Drawer */}
      <TransfersDrawer
        transfers={transfers}
        processingJobs={processingJobs}
        onDismiss={handleDismissTransfer}
        onClearCompleted={handleClearCompletedTransfers}
      />
    </div>
  );
}
