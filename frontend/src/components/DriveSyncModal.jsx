import React, { useState } from 'react';
import { Cloud, X, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

export default function DriveSyncModal({ isOpen, onClose, onSyncComplete, authHeaders = {} }) {
  const [folderId, setFolderId] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  if (!isOpen) return null;

  const handleSync = async (e) => {
    e.preventDefault();
    setSyncing(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/api/videos/sync-drive', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        },
        body: JSON.stringify({ folder_id: folderId.trim() || null })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || 'Catalog sync failed');
      }

      const data = await res.json();
      setResult(data);
      if (onSyncComplete) onSyncComplete();
    } catch (err) {
      setError(err.message);
    } finally {
      setSyncing(false);
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
          <div className="p-2.5 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-400">
            <Cloud className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Sync Google Drive Catalog</h3>
            <p className="text-xs text-slate-400">Fetches metadata & thumbnails only (0 disk usage)</p>
          </div>
        </div>

        <form onSubmit={handleSync} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Google Drive Folder ID (Optional)
            </label>
            <input
              type="text"
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              placeholder="e.g. 1A2b3C4d... (Leave blank for root/all)"
              disabled={syncing}
              className="w-full px-3.5 py-2.5 rounded-lg bg-slate-950 border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 transition disabled:opacity-50"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              Videos will appear immediately with their posters with status <strong>REMOTE_ONLY</strong>.
            </p>
          </div>

          {error && (
            <div className="flex items-start space-x-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {result && (
            <div className="flex items-start space-x-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Sync completed successfully!</p>
                <p className="text-[11px] text-emerald-500/80">Found and cataloged {result.total_cataloged} videos.</p>
              </div>
            </div>
          )}

          <div className="flex justify-end space-x-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={syncing}
              className="px-4 py-2 rounded-lg text-xs font-medium text-slate-300 hover:bg-slate-800 transition"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={syncing}
              className="flex items-center space-x-2 px-4 py-2 rounded-lg text-xs font-medium bg-sky-500 hover:bg-sky-400 text-white shadow-lg shadow-sky-500/20 transition disabled:opacity-50"
            >
              {syncing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Scanning Drive...</span>
                </>
              ) : (
                <span>Start Sync</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
