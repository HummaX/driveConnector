import React from 'react';

/**
 * DriveConnector Official Brand Logo Badge
 * High-definition vector emblem with illuminated gradient squircle,
 * media streaming glyph, and live system beacon.
 */
export default function BrandLogo({ size = 'md', className = '' }) {
  const sizeMap = {
    sm: { box: 'w-7 h-7', svg: 'w-4 h-4' },
    md: { box: 'w-9 h-9', svg: 'w-5 h-5' },
    lg: { box: 'w-11 h-11', svg: 'w-6 h-6' },
    xl: { box: 'w-14 h-14', svg: 'w-8 h-8' }
  };

  const currentSize = sizeMap[size] || sizeMap.md;

  return (
    <div
      className={`relative flex items-center justify-center shrink-0 rounded-xl bg-gradient-to-br from-sky-500/20 via-indigo-500/10 to-slate-900 border border-sky-400/30 shadow-md shadow-sky-500/20 ${currentSize.box} ${className}`}
      style={{
        boxShadow: '0 0 16px rgba(14, 165, 233, 0.25), inset 0 1px 1px rgba(255, 255, 255, 0.2)'
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={`${currentSize.svg} drop-shadow-[0_2px_8px_rgba(56,189,248,0.5)]`}
      >
        <defs>
          <linearGradient id="navBrandGrad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
            <stop stopColor="#38bdf8" />
            <stop offset="0.5" stopColor="#0ea5e9" />
            <stop offset="1" stopColor="#6366f1" />
          </linearGradient>
        </defs>

        {/* Cloud Stream Contour */}
        <path
          d="M7 16H16.5C18.433 16 20 14.433 20 12.5C20 10.67 18.6 9.17 16.8 9.02C16.4 6.75 14.4 5 12 5C10.2 5 8.65 6.05 7.8 7.6C7.55 7.53 7.28 7.5 7 7.5C5.34 7.5 4 8.84 4 10.5C4 10.72 4.02 10.94 4.07 11.15C2.85 11.75 2 13.03 2 14.5C2 16.43 3.57 16 5.5 16"
          stroke="#38bdf8"
          strokeWidth="1.5"
          strokeOpacity="0.45"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Dynamic Center Play Glyph */}
        <path
          d="M10 8.5L16.5 12.5L10 16.5V8.5Z"
          fill="url(#navBrandGrad)"
          stroke="#38bdf8"
          strokeWidth="0.5"
        />

        {/* Live Pulse Beacon */}
        <circle cx="18" cy="7" r="1.5" fill="#10b981" />
        <circle cx="18" cy="7" r="3" stroke="#10b981" strokeWidth="0.6" strokeOpacity="0.5" />
      </svg>
    </div>
  );
}
