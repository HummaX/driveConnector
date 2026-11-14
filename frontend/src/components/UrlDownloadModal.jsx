import React, { useState } from 'react';
import { DownloadCloud, X, Loader2, Link2, AlertCircle } from 'lucide-react';

export default function UrlDownloadModal({ isOpen, onClose, onDownloadStarted, authHeaders = {} }) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

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
      <div className="relative w-full max-w-md bg-slate-900 border border-slate-800 rounded-xl shadow-2xl p-6">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition"
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
              className="w-full px-3.5 py-2.5 rounded-lg bg-slate-950 border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition disabled:opacity-50"
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
              placeholder="Leave blank to auto-detect"
              disabled={submitting}
              className="w-full px-3.5 py-2.5 rounded-lg bg-slate-950 border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition disabled:opacity-50"
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
              className="px-4 py-2 rounded-lg text-xs font-medium text-slate-300 hover:bg-slate-800 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center space-x-2 px-4 py-2 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20 transition disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Submitting...</span>
                </>
              ) : (
                <>
                  <DownloadCloud className="w-4 h-4" />
                  <span>Start Ingestion</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
