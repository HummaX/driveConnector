import React, { useState } from 'react';
import { DownloadCloud, X, Loader2, Link2, AlertCircle, AlertTriangle } from 'lucide-react';

export default function UrlDownloadModal({ isOpen, onClose, onDownloadStarted, authHeaders = {} }) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const isGoogleVideoCdn = url.includes('googlevideo.com') || url.includes('videoplayback');

  if (!isOpen) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/videos/download-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        },
        body: JSON.stringify({
          url: url.trim(),
          title: title.trim() || null
        })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || 'Download request failed');
      }

      const data = await res.json();
      if (onDownloadStarted) onDownloadStarted(data.video);
      setUrl('');
      setTitle('');
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="relative w-full max-w-md bg-[#0d1117] border border-[#30363d] rounded-xl shadow-2xl p-6">
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
            <p className="text-xs text-slate-400">Direct MP4 URL, YouTube, Vimeo, Twitch, etc.</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Video / Stream URL *
            </label>
            <input
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/video.mp4 or YouTube URL"
              disabled={submitting}
              className="w-full px-3.5 py-2.5 rounded-lg bg-[#010409] border border-[#30363d] text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition disabled:opacity-50"
            />
            {isGoogleVideoCdn && (
              <div className="flex items-start space-x-2.5 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs mt-2.5">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
                <div className="space-y-1">
                  <p className="font-semibold text-amber-200">Google Video CDN Stream Detected</p>
                  <p className="text-[11px] text-amber-300/90 leading-relaxed">
                    This raw stream URL is cryptographically tied to your personal browser IP and will trigger an <code className="bg-black/40 px-1 py-0.5 rounded font-mono text-amber-200">HTTP 403 Forbidden</code> on the server. Please copy and paste the public YouTube video URL (e.g. <span className="font-mono text-white">https://www.youtube.com/watch?v=...</span> or <span className="font-mono text-white">https://youtu.be/...</span>) instead.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Custom Title (Optional)
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Leave blank to auto-detect"
              disabled={submitting}
              className="w-full px-3.5 py-2.5 rounded-lg bg-[#010409] border border-[#30363d] text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition disabled:opacity-50"
            />
          </div>

          {error && (
            <div className="flex items-start space-x-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
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
                  <span>Dispatching Ingestion...</span>
                </>
              ) : (
                <span>Start Ingest</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
