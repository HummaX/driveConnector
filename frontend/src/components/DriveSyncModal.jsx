import React, { useState, useEffect } from 'react';
import { 
  Cloud, X, Loader2, CheckCircle2, AlertCircle, Key, FileText, 
  ExternalLink, ChevronDown, ChevronUp, Zap, Eye, EyeOff, Save, Check 
} from 'lucide-react';

export default function DriveSyncModal({ isOpen, onClose, onSyncComplete, authHeaders = {} }) {
  const [activeTab, setActiveTab] = useState('apiKey'); // 'apiKey' | 'serviceAccount'
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [serviceAccountJson, setServiceAccountJson] = useState('');
  const [folderId, setFolderId] = useState('');
  const [showGuide, setShowGuide] = useState(false);

  const [loadingConfig, setLoadingConfig] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const [testResult, setTestResult] = useState(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [error, setError] = useState(null);
  const [existingConfig, setExistingConfig] = useState(null);

  // Load active Drive configuration when modal opens
  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    setError(null);
    setTestResult(null);
    setSyncResult(null);
    setSaveSuccess(false);
    setLoadingConfig(true);

    fetch('/api/drive/config', {
      headers: { ...authHeaders }
    })
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load drive settings');
        return res.json();
      })
      .then((data) => {
        if (!isMounted) return;
        setExistingConfig(data);
        if (data.folder_id) setFolderId(data.folder_id);
        if (data.has_service_account && !data.has_api_key) {
          setActiveTab('serviceAccount');
        } else {
          setActiveTab('apiKey');
        }
      })
      .catch((err) => {
        if (isMounted) console.warn('[DriveSyncModal] Config notice:', err.message);
      })
      .finally(() => {
        if (isMounted) setLoadingConfig(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  // 1. One-Click Test Connectivity
  const handleTestConnection = async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    setSaveSuccess(false);

    try {
      const payload = {
        auth_type: activeTab === 'apiKey' ? 'api_key' : 'service_account',
        api_key: apiKey.trim() || undefined,
        service_account_json: serviceAccountJson.trim() || undefined,
        folder_id: folderId.trim() || undefined
      };

      const res = await fetch('/api/drive/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      setTestResult(data);
      if (!data.success) {
        setError(data.message || 'Connection test failed.');
      }
    } catch (err) {
      setError(err.message || 'Failed to reach Drive test endpoint.');
    } finally {
      setTesting(false);
    }
  };

  // 2. Save Configuration
  const handleSaveConfig = async () => {
    setSaving(true);
    setError(null);
    setSaveSuccess(false);

    try {
      const payload = {
        auth_type: activeTab === 'apiKey' ? 'api_key' : 'service_account',
        folder_id: folderId.trim() || undefined
      };

      if (apiKey.trim()) {
        payload.api_key = apiKey.trim();
      }
      if (serviceAccountJson.trim()) {
        payload.service_account_json = serviceAccountJson.trim();
      }

      const res = await fetch('/api/drive/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || 'Failed to save configuration');
      }

      const data = await res.json();
      setExistingConfig(data.config);
      setSaveSuccess(true);
      setApiKey('');
      setServiceAccountJson('');
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // 3. Start Catalog Sync
  const handleSync = async (e) => {
    if (e) e.preventDefault();
    setSyncing(true);
    setError(null);
    setSyncResult(null);

    try {
      // If user typed provisional credentials, save them first
      if (apiKey.trim() || serviceAccountJson.trim() || (folderId.trim() !== (existingConfig?.folder_id || ''))) {
        await handleSaveConfig();
      }

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
      setSyncResult(data);
      if (onSyncComplete) onSyncComplete();
    } catch (err) {
      setError(err.message);
    } finally {
      setSyncing(false);
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target?.result;
        setServiceAccountJson(typeof content === 'string' ? content : '');
      } catch (err) {
        setError('Failed to read selected JSON file');
      }
    };
    reader.readAsText(file);
  };

  const isConfigured = existingConfig?.configured || Boolean(apiKey.trim()) || Boolean(serviceAccountJson.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in overflow-y-auto">
      <div className="relative w-full max-w-lg bg-[#0d1117] border border-[#30363d] rounded-2xl shadow-2xl p-6 my-8">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-white p-1 rounded-lg hover:bg-[#161b22] transition"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Modal Header */}
        <div className="flex items-center space-x-3 mb-5">
          <div className="p-2.5 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-400">
            <Cloud className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h3 className="text-lg font-bold text-white tracking-tight">Google Drive Integration</h3>
              {existingConfig?.status === 'connected' ? (
                <span className="flex items-center space-x-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/25">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span>Connected</span>
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono text-slate-400 bg-slate-800/80 border border-slate-700">
                  {existingConfig?.configured ? 'Configured' : 'Setup Required'}
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">Sync video metadata and stream on-demand with zero initial storage</p>
          </div>
        </div>

        {/* Auth Method Selector Tabs */}
        <div className="flex rounded-lg bg-[#010409] p-1 border border-[#30363d] mb-4">
          <button
            type="button"
            onClick={() => setActiveTab('apiKey')}
            className={`flex-1 flex items-center justify-center space-x-2 py-2 px-3 rounded-md text-xs font-semibold transition ${
              activeTab === 'apiKey'
                ? 'bg-[#161b22] text-sky-400 shadow-sm border border-[#30363d]'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Key className="w-3.5 h-3.5" />
            <span>Google API Key</span>
            <span className="px-1.5 py-0.5 rounded text-[9px] bg-sky-500/20 text-sky-300 font-normal">Fastest</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('serviceAccount')}
            className={`flex-1 flex items-center justify-center space-x-2 py-2 px-3 rounded-md text-xs font-semibold transition ${
              activeTab === 'serviceAccount'
                ? 'bg-[#161b22] text-sky-400 shadow-sm border border-[#30363d]'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Service Account JSON</span>
          </button>
        </div>

        {/* Tab 1: Google Drive API Key */}
        {activeTab === 'apiKey' && (
          <div className="space-y-3 mb-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-slate-300 flex items-center space-x-1.5">
                  <span>Google Drive API Key</span>
                  {existingConfig?.has_api_key && (
                    <span className="text-[10px] text-emerald-400 font-mono">
                      (Active: {existingConfig.api_key_masked})
                    </span>
                  )}
                </label>
                <button
                  type="button"
                  onClick={() => setShowGuide(!showGuide)}
                  className="text-[11px] text-sky-400 hover:text-sky-300 flex items-center space-x-1"
                >
                  <span>How to get key?</span>
                  {showGuide ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
              </div>

              <div className="relative">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    existingConfig?.has_api_key
                      ? 'Keep existing key or paste new AIzaSy... to change'
                      : 'AIzaSy...'
                  }
                  disabled={syncing || testing}
                  className="w-full pl-3.5 pr-10 py-2.5 rounded-lg bg-[#010409] border border-[#30363d] text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 transition disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-200"
                  tabIndex={-1}
                >
                  {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[11px] text-slate-400 mt-1">
                Ideal for public/shared Google Drive folders. Make sure folder sharing is set to{' '}
                <strong className="text-slate-300">&quot;Anyone with the link can view&quot;</strong>.
              </p>
            </div>

            {/* Quick 2-Minute Setup Accordion */}
            {showGuide && (
              <div className="p-3.5 rounded-xl bg-[#161b22] border border-sky-500/20 text-xs text-slate-300 space-y-2">
                <div className="flex items-center justify-between text-sky-400 font-semibold">
                  <span>How to generate an API Key in 2 minutes:</span>
                  <a
                    href="https://console.cloud.google.com/apis/credentials"
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center space-x-1 text-[11px] hover:underline"
                  >
                    <span>Console</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <ol className="list-decimal list-inside space-y-1 text-[11px] text-slate-300">
                  <li>
                    Open{' '}
                    <a
                      href="https://console.cloud.google.com/"
                      target="_blank"
                      rel="noreferrer"
                      className="text-sky-400 underline"
                    >
                      Google Cloud Console
                    </a>{' '}
                    and select or create a project.
                  </li>
                  <li>
                    Go to <strong>APIs &amp; Services &gt; Library</strong>, search{' '}
                    <strong>Google Drive API</strong>, and click <strong>Enable</strong>.
                  </li>
                  <li>
                    Go to <strong>APIs &amp; Services &gt; Credentials</strong>, click{' '}
                    <strong>+ Create Credentials &gt; API key</strong>.
                  </li>
                  <li>Copy your generated key, paste it into the field above, and click Test!</li>
                </ol>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Service Account JSON */}
        {activeTab === 'serviceAccount' && (
          <div className="space-y-3 mb-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-slate-300 flex items-center space-x-1.5">
                  <span>Service Account JSON Key</span>
                  {existingConfig?.has_service_account && (
                    <span className="text-[10px] text-emerald-400 font-mono">
                      (Configured: {existingConfig.service_account_email || 'Active'})
                    </span>
                  )}
                </label>
                <label className="cursor-pointer text-[11px] text-sky-400 hover:text-sky-300">
                  <span>Upload .json</span>
                  <input
                    type="file"
                    accept=".json,application/json"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </label>
              </div>
              <textarea
                rows={4}
                value={serviceAccountJson}
                onChange={(e) => setServiceAccountJson(e.target.value)}
                placeholder={
                  existingConfig?.has_service_account
                    ? 'Service Account is already active. Paste new JSON here only if you wish to replace it.'
                    : '{\n  "type": "service_account",\n  "project_id": "...",\n  "private_key": "..."\n}'
                }
                disabled={syncing || testing}
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#010409] border border-[#30363d] text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 transition disabled:opacity-50"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                For private Drives. Remember to share your target Drive folder with the Service Account&apos;s{' '}
                <code className="text-sky-400 bg-slate-800/60 px-1 py-0.5 rounded">client_email</code>.
              </p>
            </div>
          </div>
        )}

        {/* Target Google Drive Folder ID / URL */}
        <div className="mb-4">
          <label className="block text-xs font-medium text-slate-300 mb-1">
            Google Drive Folder Link or ID (Optional)
          </label>
          <input
            type="text"
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
            placeholder="e.g. 1A2b3C... or https://drive.google.com/drive/folders/..."
            disabled={syncing}
            className="w-full px-3.5 py-2.5 rounded-lg bg-[#010409] border border-[#30363d] text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 transition disabled:opacity-50"
          />
          <p className="text-[11px] text-slate-400 mt-1">
            Paste any Google Drive folder URL or ID. Leave blank to scan root or all accessible files.
          </p>
        </div>

        {/* Test Result / Status Messages */}
        {testing && (
          <div className="flex items-center space-x-2 p-3 mb-3 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-400 text-xs">
            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
            <span>Testing connectivity to Google Drive API v3...</span>
          </div>
        )}

        {testResult && testResult.success && !error && (
          <div className="flex items-start space-x-2 p-3 mb-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold">{testResult.message}</p>
              {testResult.folder_name && (
                <p className="text-[11px] text-emerald-500/80">
                  Folder: <strong>{testResult.folder_name}</strong>
                </p>
              )}
            </div>
          </div>
        )}

        {saveSuccess && (
          <div className="flex items-center space-x-2 p-3 mb-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
            <Check className="w-4 h-4 shrink-0" />
            <span>Credentials saved to server database.</span>
          </div>
        )}

        {syncResult && (
          <div className="flex items-start space-x-2 p-3 mb-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold">Catalog sync complete!</p>
              <p className="text-[11px] text-emerald-500/80">
                Found and cataloged {syncResult.total_cataloged} videos.
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-start space-x-2 p-3 mb-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="break-words max-w-full">
              <p className="font-semibold">Error</p>
              <p className="text-[11px] text-red-300">{error}</p>
            </div>
          </div>
        )}

        {/* Actions Footer */}
        <div className="flex items-center justify-between pt-3 border-t border-[#30363d] mt-2">
          {/* Test Button */}
          <button
            type="button"
            onClick={handleTestConnection}
            disabled={testing || syncing || loadingConfig}
            className="flex items-center space-x-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-sky-400 hover:text-sky-300 bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 transition disabled:opacity-50"
          >
            {testing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Zap className="w-3.5 h-3.5" />
            )}
            <span>Test Connection</span>
          </button>

          {/* Right Actions */}
          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={handleSaveConfig}
              disabled={saving || syncing}
              className="flex items-center space-x-1.5 px-3 py-2 rounded-lg text-xs font-medium text-slate-300 hover:bg-[#161b22] border border-[#30363d] hover:border-slate-500 transition disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              <span>Save</span>
            </button>

            <button
              type="button"
              onClick={handleSync}
              disabled={syncing || (!isConfigured && !apiKey.trim() && !serviceAccountJson.trim())}
              className="flex items-center space-x-2 px-4 py-2 rounded-lg text-xs font-semibold bg-[#238636] hover:bg-[#2ea043] text-white shadow-sm border border-[#2ea043]/50 transition disabled:opacity-50"
            >
              {syncing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Scanning Drive...</span>
                </>
              ) : (
                <>
                  <Cloud className="w-3.5 h-3.5" />
                  <span>Start Sync</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
