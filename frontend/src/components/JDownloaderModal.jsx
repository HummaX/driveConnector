import React, { useState } from 'react';
import { DownloadCloud, X, Copy, Check, ExternalLink, Terminal, ShieldCheck, Key, HelpCircle, HardDrive } from 'lucide-react';

export default function JDownloaderModal({ isOpen, onClose }) {
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedPass, setCopiedPass] = useState(false);

  if (!isOpen) return null;

  const currentHost = typeof window !== 'undefined' ? window.location.hostname : 'SERVER_IP';
  const sshCmd = `ssh -L 5800:127.0.0.1:5800 ubuntu@${currentHost}`;
  const defaultPass = 'admin123';
  const directWebUrl = `http://${currentHost}:5800`;

  const copyToClipboard = (text, setCopied) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="relative w-full max-w-xl bg-[#0d1117] border border-[#30363d] rounded-2xl shadow-2xl p-6 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-[#30363d]">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-400">
              <DownloadCloud className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white tracking-tight flex items-center space-x-2">
                <span>JDownloader 2 Web Desktop</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  Port 5800
                </span>
              </h3>
              <p className="text-xs text-slate-400">Universal Host-Bypassing Downloader (Gofile, 1Fichier, Mega, Rapidgator, etc.)</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-[#161b22] transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="py-5 space-y-4 text-xs text-slate-300">
          <p className="leading-relaxed text-slate-300">
            JDownloader 2 runs on your server with automated decrypter plugins that solve anti-bot gates (like Gofile's <code className="bg-black/40 px-1 py-0.5 rounded font-mono text-sky-300">wt.obf.js</code>), CAPTCHAs, and countdown timers.
          </p>

          {/* Quick Access Card */}
          <div className="p-4 rounded-xl bg-[#161b22] border border-[#30363d] space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-white flex items-center space-x-1.5">
                <ExternalLink className="w-4 h-4 text-sky-400" />
                <span>Web GUI Access</span>
              </span>
              <a
                href={directWebUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-sky-500/15 text-sky-300 border border-sky-500/30 hover:bg-sky-500/25 transition font-semibold"
              >
                <span>Open :5800</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <p className="text-[11px] text-slate-400">
              If your firewall blocks port 5800, open a secure SSH tunnel from your local computer terminal:
            </p>

            <div className="flex items-center justify-between bg-[#010409] px-3 py-2 rounded-lg border border-[#30363d] font-mono text-[11px]">
              <div className="flex items-center space-x-2 truncate">
                <Terminal className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                <span className="text-sky-300 truncate">{sshCmd}</span>
              </div>
              <button
                type="button"
                onClick={() => copyToClipboard(sshCmd, setCopiedCmd)}
                className="ml-2 px-2 py-1 rounded bg-[#161b22] hover:bg-[#21262d] text-slate-300 hover:text-white border border-[#30363d] transition shrink-0 flex items-center space-x-1"
              >
                {copiedCmd ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span className="text-[10px]">{copiedCmd ? 'Copied' : 'Copy'}</span>
              </button>
            </div>

            {/* Password */}
            <div className="flex items-center justify-between bg-[#010409] px-3 py-2 rounded-lg border border-[#30363d] font-mono text-[11px]">
              <div className="flex items-center space-x-2">
                <Key className="w-3.5 h-3.5 text-slate-500" />
                <span className="text-slate-400">Desktop Password:</span>
                <span className="text-emerald-400 font-semibold">{defaultPass}</span>
              </div>
              <button
                type="button"
                onClick={() => copyToClipboard(defaultPass, setCopiedPass)}
                className="px-2 py-1 rounded bg-[#161b22] hover:bg-[#21262d] text-slate-300 hover:text-white border border-[#30363d] transition shrink-0 flex items-center space-x-1"
              >
                {copiedPass ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span className="text-[10px]">{copiedPass ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
          </div>

          {/* Workflow Steps */}
          <div className="p-3.5 rounded-xl bg-emerald-500/5 border border-emerald-500/20 space-y-2">
            <span className="text-[11px] font-semibold text-emerald-400 flex items-center space-x-1.5">
              <HardDrive className="w-3.5 h-3.5" />
              <span>How to Use with DriveConnector</span>
            </span>
            <ol className="list-decimal list-inside space-y-1 text-[11px] text-slate-300 leading-relaxed">
              <li>Open JDownloader Web GUI and paste your Gofile or protected hoster link.</li>
              <li>Files download directly into <code className="bg-black/40 px-1 py-0.5 rounded font-mono text-emerald-300">/mnt/storage/videos</code>.</li>
              <li>Click <strong>Scan Storage</strong> in the DriveConnector navbar to instantly catalog, probe, and stream the video!</li>
            </ol>
          </div>
        </div>

        <div className="flex justify-end pt-2 border-t border-[#30363d]">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-[#21262d] hover:bg-[#30363d] text-white transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
