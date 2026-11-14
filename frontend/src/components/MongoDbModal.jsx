import React, { useState, useEffect } from 'react';
import { Database, X, RefreshCw, Trash2, Layers, Search, Server } from 'lucide-react';

export default function MongoDbModal({ isOpen, onClose, authHeaders = {} }) {
  const [dbStats, setDbStats] = useState(null);
  const [activeCollection, setActiveCollection] = useState('videos');
  const [documents, setDocuments] = useState([]);
  const [totalDocs, setTotalDocs] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  // 1. Fetch DB Collections and Document Counts
  const fetchStats = async () => {
    try {
      const res = await fetch('/api/db/stats', { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setDbStats(data);
      }
    } catch (err) {
      console.error('Failed to load DB stats:', err);
    }
  };

  // 2. Fetch documents for selected collection
  const fetchDocuments = async (colName) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/db/collections/${colName}`, { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setDocuments(data.documents || []);
        setTotalDocs(data.total || 0);
      }
    } catch (err) {
      console.error('Failed to load documents:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchStats();
      fetchDocuments(activeCollection);
    }
  }, [isOpen, activeCollection]);

  // 3. Delete Document Handler
  const handleDeleteDoc = async (docId) => {
    if (!window.confirm(`Delete document "${docId}" from collection "${activeCollection}"?`)) {
      return;
    }

    try {
      const res = await fetch(`/api/db/collections/${activeCollection}/${docId}`, {
        method: 'DELETE',
        headers: authHeaders
      });
      if (res.ok) {
        fetchDocuments(activeCollection);
        fetchStats();
      }
    } catch (err) {
      console.error('Failed to delete document:', err);
    }
  };

  if (!isOpen) return null;

  const filteredDocs = documents.filter((doc) => {
    if (!search.trim()) return true;
    return JSON.stringify(doc).toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-fade-in">
      <div className="relative w-full max-w-5xl bg-[#0d1117] border border-[#30363d] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-[#161b22] border-b border-[#30363d]">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white flex items-center space-x-2">
                <span>MongoDB Live Explorer</span>
                <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  media_db
                </span>
              </h3>
              <p className="text-[11px] text-slate-400">
                Direct collection inspection & live document state
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={() => {
                fetchStats();
                fetchDocuments(activeCollection);
              }}
              title="Refresh DB State"
              className="p-2 rounded-lg bg-[#010409] border border-[#30363d] text-slate-400 hover:text-white transition"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-[#21262d] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Toolbar & Collections Tabs */}
        <div className="px-6 py-3 bg-[#161b22]/50 border-b border-[#30363d] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center space-x-2">
            <span className="text-xs text-slate-400 font-medium">Collections:</span>
            {dbStats?.collections?.map((col) => (
              <button
                key={col.name}
                onClick={() => setActiveCollection(col.name)}
                className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                  activeCollection === col.name
                    ? 'bg-emerald-600 text-white shadow-md'
                    : 'bg-[#010409] text-slate-400 hover:text-white border border-[#30363d]'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                <span>{col.name}</span>
                <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-black/40 font-mono">
                  {col.count}
                </span>
              </button>
            ))}
          </div>

          {/* Quick search in documents */}
          <div className="relative w-64 max-w-full">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter current collection..."
              className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-[#010409] border border-[#30363d] text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            />
          </div>
        </div>

        {/* Documents Viewer */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-500 space-y-2">
              <RefreshCw className="w-6 h-6 animate-spin text-emerald-400" />
              <p className="text-xs">Querying MongoDB documents...</p>
            </div>
          ) : filteredDocs.length > 0 ? (
            <div className="space-y-3">
              {filteredDocs.map((doc, idx) => {
                const docId = doc.video_id || doc.username || idx;
                return (
                  <div
                    key={docId}
                    className="bg-[#010409] border border-[#30363d] rounded-xl p-4 font-mono text-xs text-slate-300 relative group"
                  >
                    <div className="flex items-center justify-between pb-2 mb-2 border-b border-[#30363d]/80 text-[11px] text-slate-400">
                      <span className="text-emerald-400 font-bold">
                        {activeCollection === 'videos' ? `Video: ${doc.title || doc.video_id}` : `User: ${doc.username}`}
                      </span>
                      <div className="flex items-center space-x-2">
                        {doc.status && (
                          <span className="px-2 py-0.5 rounded bg-[#161b22] border border-[#30363d] text-[10px] text-slate-300">
                            Status: {doc.status}
                          </span>
                        )}
                        <button
                          onClick={() => handleDeleteDoc(doc.video_id || doc.username)}
                          title="Delete Document"
                          className="text-slate-500 hover:text-red-400 p-1 rounded hover:bg-red-500/10 transition"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <pre className="overflow-x-auto text-[11px] leading-relaxed text-slate-300">
                      {JSON.stringify(doc, null, 2)}
                    </pre>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-16 text-center text-slate-500 text-xs">
              No documents found matching criteria in collection <strong>{activeCollection}</strong>
            </div>
          )}
        </div>

        {/* Footer with Mongo Express Instructions */}
        <div className="px-6 py-3 bg-[#161b22] border-t border-[#30363d] flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
          <div className="flex items-center space-x-2">
            <span className="font-semibold text-slate-300">Total in {activeCollection}:</span>
            <span>{totalDocs} documents</span>
          </div>

          <div className="flex items-center space-x-2 text-[11px] bg-[#010409] px-3 py-1.5 rounded-lg border border-[#30363d] text-slate-400 font-mono">
            <span>Mongo Express Port: 8081</span>
            <span>•</span>
            <span className="text-emerald-400">Local SSH tunnel: ssh -L 8081:localhost:8081 user@server</span>
          </div>
        </div>
      </div>
    </div>
  );
}
