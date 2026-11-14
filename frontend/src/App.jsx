import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Search, Film, RefreshCw, AlertCircle } from 'lucide-react';
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
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false);
  const [isMongoModalOpen, setIsMongoModalOpen] = useState(false);
  const [transfers, setTransfers] = useState({});
  const [metrics, setMetrics] = useState(null);

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
            setTransfers((prev) => ({
              ...prev,
              [msg.video_id]: msg
            }));

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

  const filteredVideos = useMemo(() => {
    return videos.filter((video) => {
      const matchesSearch = (video.title || '').toLowerCase().includes(searchQuery.toLowerCase());
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

  // STRICT AUTH WALL: If not authenticated, render ONLY the Login Page!
  if (!token || !user) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />;
  }

  // Once authenticated, unlock the full platform
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col selection:bg-sky-500 selection:text-white">
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
          videosCount={counts}
          activeTransfers={transfers}
        />

        {/* Search & Filter Toolbar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pt-2">
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

        {/* Video Grid */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-500 space-y-3">
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
                onClick={() => setIsSyncModalOpen(true)}
                className="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-white text-xs font-semibold shadow-lg shadow-sky-500/20 transition"
              >
                Sync Google Drive
              </button>
              <button
                onClick={() => setIsUrlModalOpen(true)}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition"
              >
                Add External Link
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
          onClose={() => setSelectedVideo(null)}
          onTriggerDownload={handleTriggerDownload}
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
      <TransfersDrawer transfers={transfers} />
    </div>
  );
}
