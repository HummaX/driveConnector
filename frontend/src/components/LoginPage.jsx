import React, { useState, useEffect, useRef, useCallback } from 'react';
import BrandLogo from './BrandLogo';
import { Lock, User, Shield, AlertCircle, Loader2, ArrowRight, Globe, Server, Database, Zap } from 'lucide-react';

// ─── Animated Network Graph Background (GitHub-style constellation) ───
export function NetworkCanvas() {
  const canvasRef = useRef(null);
  const animFrameRef = useRef(null);
  const nodesRef = useRef([]);
  const pulseTrailsRef = useRef([]);
  const mouseRef = useRef({ x: -1000, y: -1000 });

  const initNodes = useCallback((w, h) => {
    const count = Math.floor((w * h) / 12000);
    const clamped = Math.max(40, Math.min(count, 180));
    const nodes = [];
    for (let i = 0; i < clamped; i++) {
      nodes.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.35,
        vy: (Math.random() - 0.5) * 0.35,
        radius: Math.random() * 1.8 + 0.8,
        baseAlpha: Math.random() * 0.4 + 0.15,
        pulsePhase: Math.random() * Math.PI * 2,
        // Some nodes are "hubs" – slightly larger and brighter
        isHub: Math.random() < 0.12,
      });
    }
    return nodes;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let w, h;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (nodesRef.current.length === 0) {
        nodesRef.current = initNodes(w, h);
      }
    };
    resize();
    window.addEventListener('resize', resize);

    const handleMouseMove = (e) => {
      mouseRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('mousemove', handleMouseMove);

    // Spawn occasional pulse trails along edges
    const spawnPulse = () => {
      const nodes = nodesRef.current;
      if (nodes.length < 2) return;
      const a = Math.floor(Math.random() * nodes.length);
      let b = Math.floor(Math.random() * nodes.length);
      if (b === a) b = (a + 1) % nodes.length;
      const dx = nodes[b].x - nodes[a].x;
      const dy = nodes[b].y - nodes[a].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 200) {
        pulseTrailsRef.current.push({
          ax: nodes[a].x, ay: nodes[a].y,
          bx: nodes[b].x, by: nodes[b].y,
          t: 0,
          speed: 0.012 + Math.random() * 0.015,
          color: Math.random() < 0.5 ? [56, 189, 248] : [129, 140, 248], // sky-400 or indigo-400
        });
      }
    };

    let frameCount = 0;
    const connectionDist = 160;
    const mouseDist = 220;

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const nodes = nodesRef.current;
      const mx = mouseRef.current.x;
      const my = mouseRef.current.y;
      const time = performance.now() * 0.001;
      frameCount++;

      // Spawn pulse trails periodically
      if (frameCount % 90 === 0) spawnPulse();

      // Update node positions
      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < -20) n.x = w + 20;
        if (n.x > w + 20) n.x = -20;
        if (n.y < -20) n.y = h + 20;
        if (n.y > h + 20) n.y = -20;
      }

      // Draw connections
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x;
          const dy = nodes[j].y - nodes[i].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < connectionDist) {
            const alpha = (1 - dist / connectionDist) * 0.12;
            ctx.beginPath();
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.strokeStyle = `rgba(100, 160, 230, ${alpha})`;
            ctx.lineWidth = 0.6;
            ctx.stroke();
          }
        }
      }

      // Draw mouse-proximity highlight connections
      for (const n of nodes) {
        const dx = n.x - mx;
        const dy = n.y - my;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < mouseDist) {
          const alpha = (1 - dist / mouseDist) * 0.35;
          ctx.beginPath();
          ctx.moveTo(mx, my);
          ctx.lineTo(n.x, n.y);
          ctx.strokeStyle = `rgba(56, 189, 248, ${alpha})`;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }

      // Draw pulse trails (data packets travelling along edges)
      const trails = pulseTrailsRef.current;
      for (let i = trails.length - 1; i >= 0; i--) {
        const p = trails[i];
        p.t += p.speed;
        if (p.t > 1) {
          trails.splice(i, 1);
          continue;
        }
        const px = p.ax + (p.bx - p.ax) * p.t;
        const py = p.ay + (p.by - p.ay) * p.t;
        const alpha = Math.sin(p.t * Math.PI) * 0.9;
        const [r, g, b] = p.color;

        // Glow
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha * 0.3})`;
        ctx.fill();

        // Core dot
        ctx.beginPath();
        ctx.arc(px, py, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
        ctx.fill();
      }

      // Draw nodes
      for (const n of nodes) {
        const pulse = Math.sin(time * 1.5 + n.pulsePhase) * 0.15 + 0.85;
        const dmouse = Math.sqrt((n.x - mx) ** 2 + (n.y - my) ** 2);
        const mouseBoost = dmouse < mouseDist ? (1 - dmouse / mouseDist) * 0.6 : 0;
        const alpha = (n.baseAlpha + mouseBoost) * pulse;
        const r = n.isHub ? n.radius * 1.8 : n.radius;

        // Hub glow ring
        if (n.isHub) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 4, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(56, 189, 248, ${alpha * 0.08})`;
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = n.isHub
          ? `rgba(129, 140, 248, ${alpha})`
          : `rgba(148, 163, 184, ${alpha})`;
        ctx.fill();
      }

      animFrameRef.current = requestAnimationFrame(draw);
    };

    animFrameRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, [initNodes]);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 w-full h-full pointer-events-none"
      style={{ zIndex: 0 }}
    />
  );
}

// ─── Login Page Component ───
export default function LoginPage({ onLoginSuccess }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [shake, setShake] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || 'Invalid username or password');
      }

      const data = await res.json();
      const t = data.access_token || data.token;
      const u = { username: data.username, role: data.role };
      localStorage.setItem('drive_auth_token', t);
      localStorage.setItem('ovh_media_token', t);
      localStorage.setItem('drive_connector_token', t);
      localStorage.setItem('drive_auth_user', JSON.stringify(u));
      document.cookie = `access_token=${t}; path=/; max-age=604800; SameSite=Lax`;
      onLoginSuccess(data);
    } catch (err) {
      setError(err.message);
      setShake(true);
      setTimeout(() => setShake(false), 600);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-[#0a0c14] flex flex-col relative overflow-hidden select-none">
      {/* Animated Network Constellation Background */}
      <NetworkCanvas />

      {/* Radial gradient overlay: center lighter for card focus */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse 60% 50% at 50% 50%, rgba(10,12,20,0.3) 0%, rgba(10,12,20,0.85) 70%, rgba(10,12,20,0.97) 100%)',
          zIndex: 1,
        }}
      />

      {/* Top Navigation Bar */}
      <nav className="relative z-10 w-full px-6 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-2.5">
          <BrandLogo size="sm" />
          <span className="text-sm font-semibold text-white tracking-tight">DriveConnector</span>
        </div>
        <div className="flex items-center space-x-4 text-[11px] text-slate-500">
          <div className="hidden sm:flex items-center space-x-1.5">
            <Globe className="w-3.5 h-3.5" />
            <span>Self-Hosted</span>
          </div>
          <div className="hidden sm:flex items-center space-x-1.5">
            <Server className="w-3.5 h-3.5" />
            <span>1TB NVMe</span>
          </div>
          <div className="hidden md:flex items-center space-x-1.5">
            <Database className="w-3.5 h-3.5" />
            <span>MongoDB</span>
          </div>
        </div>
      </nav>

      {/* Center Content: Hero + Login Card */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-4 sm:px-6 pb-12">
        {/* Hero Text */}
        <div className="text-center mb-8 space-y-3 max-w-lg">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white leading-tight">
            Your media.{' '}
            <span className="bg-gradient-to-r from-sky-400 via-indigo-400 to-purple-400 bg-clip-text text-transparent">
              Your infrastructure.
            </span>
          </h1>
          <p className="text-sm text-slate-400 max-w-md mx-auto leading-relaxed">
            On-demand cloud media ingestion, automated FFmpeg processing, and
            HTTP Range streaming — all from a single self-hosted server.
          </p>
        </div>

        {/* Login Card */}
        <div
          className={`w-full max-w-[420px] bg-[#0d1117]/80 backdrop-blur-2xl border border-slate-700/50 rounded-2xl shadow-2xl shadow-black/40 overflow-hidden transition-transform duration-150 ${
            shake ? 'animate-[shake_0.5s_ease-in-out]' : ''
          }`}
        >
          {/* Card Header */}
          <div className="px-7 pt-7 pb-1">
            <div className="flex items-center space-x-3 mb-1">
              <div className="p-2.5 rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white shadow-lg shadow-sky-500/30">
                <Lock className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white tracking-tight">Sign in</h2>
                <p className="text-[11px] text-slate-400">Authenticate to access the control panel</p>
              </div>
            </div>
          </div>

          {/* Separator */}
          <div className="mx-7 my-4 h-px bg-slate-700/60" />

          {/* Form */}
          <form onSubmit={handleSubmit} className="px-7 pb-7 space-y-4">
            {/* Username */}
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Username
              </label>
              <div className="relative group">
                <User className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-sky-400 transition-colors" />
                <input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  className="w-full pl-9 pr-4 py-2.5 rounded-lg bg-[#010409] border border-slate-700/80 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-sky-500/70 focus:ring-1 focus:ring-sky-500/30 transition-all"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Password
              </label>
              <div className="relative group">
                <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-sky-400 transition-colors" />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full pl-9 pr-4 py-2.5 rounded-lg bg-[#010409] border border-slate-700/80 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-sky-500/70 focus:ring-1 focus:ring-sky-500/30 transition-all"
                />
              </div>
            </div>

            {/* Error */}
            {error && (
              <div className="flex items-start space-x-2 p-3 rounded-lg bg-red-500/8 border border-red-500/20 text-red-400 text-xs">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center space-x-2 py-2.5 rounded-lg text-sm font-semibold bg-[#238636] hover:bg-[#2ea043] text-white border border-[#2ea043]/40 shadow-sm transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Authenticating...</span>
                </>
              ) : (
                <>
                  <span>Sign in</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>

        {/* Info Badge Below Card */}
        <div className="mt-5 flex items-center space-x-4 text-[11px] text-slate-500">
          <div className="flex items-center space-x-1.5 px-3 py-1.5 rounded-full bg-slate-800/40 border border-slate-700/40">
            <Shield className="w-3 h-3 text-sky-500" />
            <span>JWT Encrypted Sessions</span>
          </div>
          <div className="flex items-center space-x-1.5 px-3 py-1.5 rounded-full bg-slate-800/40 border border-slate-700/40">
            <Zap className="w-3 h-3 text-amber-400" />
            <span>Range Stream Ready</span>
          </div>
        </div>

        {/* Default Credentials Hint */}
        <p className="mt-4 text-[11px] text-slate-600">
          Default: <code className="text-slate-500 bg-slate-800/60 px-1 py-0.5 rounded text-[10px]">admin</code>{' '}
          / <code className="text-slate-500 bg-slate-800/60 px-1 py-0.5 rounded text-[10px]">Admin@Drive2026!</code>
        </p>
      </div>

      {/* Footer */}
      <footer className="relative z-10 py-4 text-center text-[10px] text-slate-600">
        DriveConnector · Self-Hosted Media Platform · Powered by FastAPI + MongoDB + FFmpeg
      </footer>

      {/* Tailwind shake keyframe (injected via style tag) */}
      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-8px); }
          40% { transform: translateX(8px); }
          60% { transform: translateX(-5px); }
          80% { transform: translateX(5px); }
        }
      `}</style>
    </div>
  );
}
