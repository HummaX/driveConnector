import React, { useState } from 'react';
import { DownloadCloud, X, Loader2, Link2, AlertCircle, AlertTriangle, Layers, FileVideo } from 'lucide-react';

export default function UrlDownloadModal({ isOpen, onClose, onDownloadStarted, onOpenJDownloader, authHeaders = {} }) {
  const [mode, setMode] = useState('single'); // 'single' or 'batch'
  const [url, setUrl] = useState('');
  const [batchUrls, setBatchUrls] = useState('');
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  const isGoogleVideoCdn = (mode === 'single' ? url : batchUrls).includes('googlevideo.com') || (mode === 'single' ? url : batchUrls).includes('videoplayback');
  const isGofileLink = (mode === 'single' ? url : batchUrls).includes('gofile.io');

  if (!isOpen) return null;

  const getCleanBatchList = () => {
    return batchUrls
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    const payload = {};
    if (mode === 'single') {
      if (!url.trim()) return;
      payload.url = url.trim();
      if (title.trim()) payload.title = title.trim();
    } else {
      const list = getCleanBatchList();
      if (list.length === 0) {
        setError('Please enter at least one video URL in the batch box.');
        return;
      }
      payload.urls = list;
    }

    setSubmitting(true);

    try {
      const res = await fetch('/api/videos/download-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'Download request failed');
      }

      if (onDownloadStarted) onDownloadStarted(data.video || data.queued?.[0]);
      setUrl('');
      setBatchUrls('');
      setTitle('');
      setSuccessMsg(data.message || 'Downloads queued successfully!');
      setTimeout(() => {
        onClose();
        setSuccessMsg(null);
      }, 1200);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const batchCount = getCleanBatchList().length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="relative w-full max-w-lg bg-[#0d1117] border border-[#30363d] rounded-xl shadow-2xl p-6">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-white p-1 rounded-lg hover:bg-[#161b22] transition"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center space-x-3 mb-4">
          <div className="p-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
            <Link2 className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">External Video Downloader</h3>
            <p className="text-xs text-slate-400">Direct MKV/MP4 CDN streams, YouTube, Vimeo, Twitch, and multi-URL queueing</p>
          </div>
        </div>

        {/* Mode Selector Toggle: Single vs Multi-URL Batch */}
        <div className="flex rounded-lg bg-[#010409] p-1 border border-[#30363d] mb-4">
          <button
            type="button"
            onClick={() => { setMode('single'); setError(null); }}
            className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition flex items-center justify-center space-x-1.5 ${
              mode === 'single'
                ? 'bg-[#21262d] text-white shadow-sm border border-slate-600/50'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileVideo className="w-3.5 h-3.5" />
            <span>Single Video URL</span>
          </button>
          <button
            type="button"
            onClick={() => { setMode('batch'); setError(null); }}
            className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition flex items-center justify-center space-x-1.5 ${
              mode === 'batch'
                ? 'bg-[#21262d] text-white shadow-sm border border-slate-600/50'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Multi-URL Batch Download</span>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'single' ? (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Video / Stream URL *
                </label>
                <input
                  type="text"
                  required
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/video.mkv or YouTube URL"
                  disabled={submitting}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#010409] border border-[#30363d] text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition disabled:opacity-50"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Custom Title (Optional)
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Leave blank to auto-detect from filename"
                  disabled={submitting}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#010409] border border-[#30363d] text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition disabled:opacity-50"
                />
              </div>
            </>
          ) : (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-slate-300">
                  Multiple Video URLs (One per line) *
                </label>
                {batchCount > 0 && (
                  <span className="text-[11px] font-mono font-semibold text-sky-400">
                    {batchCount} URL{batchCount === 1 ? '' : 's'} detected
                  </span>
                )}
              </div>
              <textarea
                rows={5}
                required
                value={batchUrls}
                onChange={(e) => setBatchUrls(e.target.value)}
                placeholder="https://example.com/video1.mkv&#10;https://example.com/video2.mp4&#10;https://www.youtube.com/watch?v=..."
                disabled={submitting}
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#010409] border border-[#30363d] text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition disabled:opacity-50 resize-y"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                Each link will be queued and downloaded concurrently with live progress tracking in the Transfers drawer.
              </p>
            </div>
          )}

          {/* Gofile / Protected hoster callout */}
          {isGofileLink && (
            <div className="flex items-start space-x-2.5 p-3 rounded-lg bg-sky-500/10 border border-sky-500/30 text-sky-300 text-xs">
              <DownloadCloud className="w-4 h-4 mt-0.5 shrink-0 text-sky-400" />
              <div className="space-y-1">
                <p className="font-semibold text-sky-200">Gofile / Protected Hoster Detected</p>
                <p className="text-[11px] text-sky-300/90 leading-relaxed">
                  Gofile uses interactive JavaScript verification (<code className="bg-black/40 px-1 py-0.5 rounded font-mono text-sky-200">wt.obf.js</code>). To download from Gofile or filehosters, use the built-in <strong>JDownloader 2 Web Desktop</strong> (Port 5800), which downloads straight into your storage.
                </p>
                {onOpenJDownloader && (
                  <button
                    type="button"
                    onClick={() => { onClose(); onOpenJDownloader(); }}
                    className="inline-flex items-center space-x-1 mt-1 text-[11px] text-sky-400 hover:text-white underline font-medium"
                  >
                    <span>Open JDownloader 2 Desktop</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Google Video CDN warning */}
          {isGoogleVideoCdn && (
            <div className="flex items-start space-x-2.5 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
              <div className="space-y-1">
                <p className="font-semibold text-amber-200">Google Video CDN Stream Detected</p>
                <p className="text-[11px] text-amber-300/90 leading-relaxed">
                  Raw stream chunks are IP-locked to your personal browser. Please paste the public YouTube URL instead.
                </p>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start space-x-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="break-words leading-tight">{error}</span>
            </div>
          )}

          {successMsg && (
            <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-medium">
              {successMsg}
            </div>
          )}

          <div className="flex justify-end space-x-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 rounded-lg text-xs font-medium text-slate-300 hover:bg-[#161b22] border border-transparent transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center space-x-2 px-4 py-2 rounded-lg text-xs font-semibold bg-[#238636] hover:bg-[#2ea043] text-white shadow-sm border border-[#2ea043]/50 transition disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Queueing Download{mode === 'batch' ? 's' : ''}...</span>
                </>
              ) : (
                <span>Queue Download{mode === 'batch' ? ` (${batchCount || 0})` : ''}</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
