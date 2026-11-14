import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Search, Film, RefreshCw, AlertCircle } from 'lucide-react';
import Navbar from './components/Navbar';
import VideoCard from './components/VideoCard';
import VideoPlayerModal from './components/VideoPlayerModal';
import DriveSyncModal from './components/DriveSyncModal';
import UrlDownloadModal from './components/UrlDownloadModal';
import TransfersDrawer from './components/TransfersDrawer';
import LoginModal from './components/LoginModal';
import StatsDashboard from './components/StatsDashboard';

export default function App() {
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('ALL');
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false);
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [transfers, setTransfers] = useState({});
  const [metrics, setMetrics] = useState(null);

  // Polling /api/system/metrics every 3 seconds
  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch('/api/system/metrics');
      if (res.ok) {
        const data = await res.json();
        setMetrics(data);
      }
    } catch (err) {
      console.error('Failed to fetch telemetry metrics:', err);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 3000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  // Auth state
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
  };

  const getAuthHeaders = useCallback(() => {
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  }, [token]);

  // 1. Fetch catalog
  const fetchVideos = useCallback(async () => {
    try {
      const res = await fetch('/api/videos');
      if (res.ok) {
        const data = await res.json();
        setVideos(data);
      }
    } catch (err) {
      console.error('Failed to load videos:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchVideos();
  }, [fetchVideos]);

  // 2. Stable WebSocket connection (UI-01 fix: persistent lifecycle without modal dependency)
  useEffect(() => {
    let ws;
    let reconnectTimer;

    const connectWs = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws/transfers`;
      ws = new WebSocket(wsUrl);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.event === 'TRANSFER_UPDATE') {
            setTransfers((prev) => ({
              ...prev,
              [msg.video_id]: msg
            }));

            // Use ref to check selected video without triggering hook re-creation
            const activeModal = selectedVideoRef.current;
            if (activeModal && activeModal.video_id === msg.video_id && msg.status === 'DOWNLOAD_COMPLETE') {
              setSelectedVideo((prev) => ({
                ...prev,
                status: 'LOCAL_READY',
                local_path: `/mnt/storage/videos/${msg.video_id}.mp4`
              }));
              fetchVideos();
            }
          } else if (msg.event === 'PROCESSING_COMPLETE') {
            setVideos((prev) =>
              prev.map((v) => (v.video_id === msg.video_id ? { ...v, ...msg.metadata, status: 'LOCAL_READY' } : v))
            );
            const activeModal = selectedVideoRef.current;
            if (activeModal && activeModal.video_id === msg.video_id) {
              setSelectedVideo((prev) => ({
                ...prev,
                ...msg.metadata,
                status: 'LOCAL_READY'
              }));
            }
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
  }, [fetchVideos]);

  // 3. Authenticated On-Demand Drive Download
  const handleTriggerDownload = async (videoId) => {
    if (!token) {
      setIsLoginModalOpen(true);
      return;
    }
    try {
      const res = await fetch(`/api/videos/${videoId}/download`, {
        method: 'POST',
        headers: getAuthHeaders()
      });
      if (res.status === 401) {
        setIsLoginModalOpen(true);
        return;
      }
      fetchVideos();
    } catch (err) {
      console.error('Failed to trigger download:', err);
    }
  };

  // 4. Authenticated Delete Video
  const handleDeleteVideo = async (videoId) => {
    if (!token) {
      setIsLoginModalOpen(true);
      return;
    }
    try {
      const res = await fetch(`/api/videos/${videoId}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      if (res.status === 401) {
        setIsLoginModalOpen(true);
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

  const filteredVideos = useMemo(() => {
    return videos.filter((video) => {
      const matchesSearch = video.title.toLowerCase().includes(searchQuery.toLowerCase());
      if (!matchesSearch) return false;
      if (activeFilter === 'LOCAL') return video.status === 'LOCAL_READY';
      if (activeFilter === 'CLOUD') return video.status === 'REMOTE_ONLY';
      return true;
    });
  }, [videos, searchQuery, activeFilter]);

  const counts = useMemo(() => {
    return {
      all: videos.length,
      local: videos.filter((v) => v.status === 'LOCAL_READY').length,
      cloud: videos.filter((v) => v.status === 'REMOTE_ONLY').length,
      active: Object.values(transfers).filter((t) => t.status === 'DOWNLOADING').length
    };
  }, [videos, transfers]);

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      <Navbar
        user={user}
        onOpenLogin={() => setIsLoginModalOpen(true)}
        onLogout={handleLogout}
        onOpenSync={() => (token ? setIsSyncModalOpen(true) : setIsLoginModalOpen(true))}
        onOpenUrl={() => (token ? setIsUrlModalOpen(true) : setIsLoginModalOpen(true))}
        activeTransfersCount={counts.active}
        onRefresh={() => {
          fetchVideos();
          fetchMetrics();
        }}
        metrics={metrics}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Executive-Tier Metrics Dashboard */}
        <StatsDashboard
          metrics={metrics}
          videos={videos}
          transfers={transfers}
          onFilterChange={setActiveFilter}
        />

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search library by title..."
              className="w-full pl-10 pr-4 py-2 rounded-xl bg-slate-900 border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 transition"
            />
          </div>

          <div className="flex items-center space-x-1.5 bg-slate-900/80 p-1 rounded-xl border border-slate-800 text-xs font-medium">
            <button
              onClick={() => setActiveFilter('ALL')}
              className={`px-3 py-1.5 rounded-lg transition ${
                activeFilter === 'ALL' ? 'bg-sky-500 text-white shadow-md' : 'text-slate-400 hover:text-white'
              }`}
            >
              All ({counts.all})
            </button>
            <button
              onClick={() => setActiveFilter('LOCAL')}
              className={`px-3 py-1.5 rounded-lg transition ${
                activeFilter === 'LOCAL' ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-400 hover:text-white'
              }`}
            >
              Saved Local ({counts.local})
            </button>
            <button
              onClick={() => setActiveFilter('CLOUD')}
              className={`px-3 py-1.5 rounded-lg transition ${
                activeFilter === 'CLOUD' ? 'bg-amber-600 text-white shadow-md' : 'text-slate-400 hover:text-white'
              }`}
            >
              On Cloud ({counts.cloud})
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 text-slate-500 space-y-3">
            <RefreshCw className="w-8 h-8 animate-spin text-sky-400" />
            <p className="text-sm">Loading media catalog...</p>
          </div>
        ) : filteredVideos.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {filteredVideos.map((video) => (
              <VideoCard
                key={video.video_id}
                video={video}
                onPlay={(v) => setSelectedVideo(v)}
                onDelete={handleDeleteVideo}
                onDownload={handleTriggerDownload}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 px-4 text-center bg-slate-900/30 border border-dashed border-slate-800 rounded-2xl">
            <div className="p-4 rounded-2xl bg-slate-900 text-slate-500 mb-4">
              <Film className="w-10 h-10" />
            </div>
            <h3 className="text-base font-semibold text-white mb-1">No videos found</h3>
            <p className="text-xs text-slate-400 max-w-sm mb-6">
              Connect your Google Drive to instantly sync catalog metadata with zero disk footprint, or paste external video links.
            </p>
            <div className="flex items-center space-x-3">
              <button
                onClick={() => (token ? setIsSyncModalOpen(true) : setIsLoginModalOpen(true))}
                className="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-white text-xs font-semibold shadow-lg shadow-sky-500/20 transition"
              >
                Sync Google Drive
              </button>
              <button
                onClick={() => (token ? setIsUrlModalOpen(true) : setIsLoginModalOpen(true))}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition"
              >
                Add External Link
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Modals & Telemetry Drawer */}
      {selectedVideo && (
        <VideoPlayerModal
          video={selectedVideo}
          activeTransfer={transfers[selectedVideo.video_id]}
          onClose={() => setSelectedVideo(null)}
          onTriggerDownload={handleTriggerDownload}
        />
      )}

      <DriveSyncModal
        isOpen={isSyncModalOpen}
        authHeaders={getAuthHeaders()}
        onClose={() => setIsSyncModalOpen(false)}
        onSyncComplete={fetchVideos}
      />

      <UrlDownloadModal
        isOpen={isUrlModalOpen}
        authHeaders={getAuthHeaders()}
        onClose={() => setIsUrlModalOpen(false)}
        onDownloadStarted={fetchVideos}
      />

      <LoginModal
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        onLoginSuccess={handleLoginSuccess}
      />

      <TransfersDrawer transfers={transfers} />
    </div>
  );
}
