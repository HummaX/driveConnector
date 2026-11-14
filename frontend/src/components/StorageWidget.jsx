import React, { useEffect, useState } from 'react';
import { HardDrive, Server } from 'lucide-react';

export default function StorageWidget() {
  const [storage, setStorage] = useState(null);

  const fetchStorage = async () => {
    try {
      const res = await fetch('/api/system/storage');
      if (res.ok) {
        const data = await res.json();
        setStorage(data);
      }
    } catch (err) {
      console.error('Failed to fetch storage stats:', err);
    }
  };

  useEffect(() => {
    fetchStorage();
    const interval = setInterval(fetchStorage, 10000); // refresh every 10s
    return () => clearInterval(interval);
  }, []);

  if (!storage) return null;

  const pct = storage.used_percent || 0;
  const barColor = pct > 90 ? 'bg-red-500' : pct > 75 ? 'bg-amber-500' : 'bg-sky-500';

  return (
    <div className="flex items-center space-x-3 bg-slate-900/80 border border-slate-800 rounded-lg px-3 py-1.5 text-xs">
      <div className="p-1.5 rounded-md bg-slate-800 text-sky-400">
        <HardDrive className="w-4 h-4" />
      </div>
      <div className="flex flex-col min-w-[120px]">
        <div className="flex justify-between items-center text-[11px] text-slate-300 font-medium">
          <span>1TB Storage</span>
          <span>{storage.used_gb} GB / {storage.total_gb} GB</span>
        </div>
        <div className="w-full bg-slate-800 h-1.5 rounded-full mt-1 overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ${barColor}`}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
      </div>
    </div>
  );
}
