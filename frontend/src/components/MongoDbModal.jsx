import React, { useState, useEffect } from 'react';
import { Database, X, RefreshCw, Trash2, Layers, Search, Server, Copy, Check, ExternalLink, Terminal, ShieldCheck, Key } from 'lucide-react';

export default function MongoDbModal({ isOpen, onClose, authHeaders = {} }) {
  const [dbStats, setDbStats] = useState(null);
  const [activeCollection, setActiveCollection] = useState('videos');
  const [documents, setDocuments] = useState([]);
  const [totalDocs, setTotalDocs] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedPass, setCopiedPass] = useState(false);

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

  const currentHost = window.location.hostname || 'localhost';
  const port = dbStats?.mongo_express_port || 8081;
  const isPublic = Boolean(dbStats?.mongo_express_is_public);
  const tunnelCmd = dbStats?.ssh_tunnel_cmd || `ssh -L ${port}:127.0.0.1:${port} ubuntu@${currentHost}`;
  const mongoExpressUrl = dbStats?.mongo_express_url || `http://${currentHost}:${port}/`;
  const username = dbStats?.mongo_express_user || 'admin';
  const password = dbStats?.mongo_express_pass || 'expresspassword';

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

        {/* Mongo Express Access & SSH Tunnel Helper Card */}
        {isPublic ? (
          <div className="px-6 py-3 bg-emerald-950/20 border-b border-emerald-500/20 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center space-x-2 text-emerald-400">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span className="font-semibold">Mongo Express Web UI is public on port {port}</span>
              <span className="text-[11px] text-slate-400 font-mono">
                (User: <span className="text-emerald-300 font-bold">{username}</span>)
              </span>
            </div>
            <a
              href={mongoExpressUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition shadow-sm"
            >
              <span>Open Mongo Express ({port})</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        ) : (
          <div className="px-6 py-3 bg-[#161b22] border-b border-[#30363d] flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
            <div className="space-y-1">
              <div className="flex items-center space-x-2 text-slate-200 font-semibold">
                <Terminal className="w-4 h-4 text-emerald-400" />
                <span>Mongo Express Web UI (Port {port})</span>
                <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  Bound to 127.0.0.1 (SSH Tunnel Required)
                </span>
              </div>
              <div className="flex items-center space-x-3 text-[11px] text-slate-400">
                <span>User: <strong className="text-slate-200 font-mono">{username}</strong></span>
                <span>•</span>
                <span>Pass: <strong className="text-slate-200 font-mono">{password}</strong></span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(password);
                    setCopiedPass(true);
                    setTimeout(() => setCopiedPass(false), 2000);
                  }}
                  className="text-[10px] text-sky-400 hover:text-sky-300 transition"
                >
                  {copiedPass ? 'Copied Password!' : 'Copy Password'}
                </button>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <div className="flex items-center bg-[#010409] border border-[#30363d] rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-emerald-400 select-all max-w-xs md:max-w-md overflow-x-auto">
                <span className="truncate">{tunnelCmd}</span>
              </div>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(tunnelCmd);
                  setCopiedCmd(true);
                  setTimeout(() => setCopiedCmd(false), 2000);
                }}
                title="Copy SSH Tunnel Command"
                className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg bg-[#21262d] hover:bg-[#30363d] text-slate-200 border border-[#30363d] transition shrink-0"
              >
                {copiedCmd ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-[11px] text-emerald-400 font-medium">Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-slate-300" />
                    <span className="text-[11px] font-medium">Copy Command</span>
                  </>
                )}
              </button>
              <a
                href={`http://localhost:${port}`}
                target="_blank"
                rel="noopener noreferrer"
                title="Open localhost:8081 after starting SSH tunnel"
                className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 border border-emerald-500/30 transition shrink-0 font-medium text-[11px]"
              >
                <span>Open :8081</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
        )}

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
            <span>Mongo Express Port: {port}</span>
            <span>•</span>
            <span className="text-emerald-400">
              {isPublic ? `Public: http://${currentHost}:${port}/` : `Tunnel: ${tunnelCmd}`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
