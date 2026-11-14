#!/usr/bin/env python3
"""
DriveConnector Favicon & Brand Asset Generator
Creates ultra-modern vector SVG, multi-resolution PNGs, and ICO assets
for both frontend/public and backend/static distributions using pure Python standard library.
"""

import math
import struct
import zlib
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent.parent

# 1. Master High-Resolution Vector SVG Favicon
SVG_CONTENT = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="dcBgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0b1120" />
      <stop offset="45%" stop-color="#080e1a" />
      <stop offset="100%" stop-color="#030712" />
    </linearGradient>
    <linearGradient id="dcBorderGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.95" />
      <stop offset="50%" stop-color="#818cf8" stop-opacity="0.75" />
      <stop offset="100%" stop-color="#0284c7" stop-opacity="0.4" />
    </linearGradient>
    <linearGradient id="dcPlayGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8" />
      <stop offset="50%" stop-color="#0ea5e9" />
      <stop offset="100%" stop-color="#6366f1" />
    </linearGradient>
    <linearGradient id="dcCloudGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.22" />
      <stop offset="100%" stop-color="#6366f1" stop-opacity="0.08" />
    </linearGradient>
    <radialGradient id="dcCenterGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.35" />
      <stop offset="45%" stop-color="#6366f1" stop-opacity="0.15" />
      <stop offset="100%" stop-color="#000000" stop-opacity="0" />
    </radialGradient>
    <filter id="dcGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="10" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
  </defs>

  <!-- Base Dark Squircle -->
  <rect x="20" y="20" width="472" height="472" rx="112" ry="112" fill="url(#dcBgGrad)" stroke="url(#dcBorderGrad)" stroke-width="8" />

  <!-- Ambient Radiant Glow -->
  <circle cx="256" cy="256" r="190" fill="url(#dcCenterGlow)" />

  <!-- Cloud Contour Background Silhouette -->
  <path d="M170 330 h175 c32 0 58-26 58-58 0-28-20-52-47-57-6-40-41-70-82-70-29 0-55 16-69 40-7-4-15-7-23-7-24 0-44 19-44 44 0 5 1 9 2 14-27 7-47 32-47 61 0 32 26 33 77 33z" 
        fill="url(#dcCloudGrad)" stroke="#38bdf8" stroke-opacity="0.4" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />

  <!-- High-Speed Data Stream Transmission Lines -->
  <line x1="108" y1="245" x2="175" y2="245" stroke="#38bdf8" stroke-width="6" stroke-linecap="round" stroke-opacity="0.85" />
  <circle cx="188" cy="245" r="5" fill="#38bdf8" />
  <line x1="86" y1="275" x2="140" y2="275" stroke="#818cf8" stroke-width="5" stroke-linecap="round" stroke-opacity="0.7" />
  <circle cx="152" cy="275" r="4" fill="#818cf8" />

  <!-- Dynamic Geometric Streaming Play Triangle -->
  <path d="M226 172 C226 163 236 157 244 162 L350 244 C358 250 358 262 350 268 L244 350 C236 355 226 349 226 340 Z" 
        fill="url(#dcPlayGrad)" filter="url(#dcGlow)" />
  <path d="M226 172 C226 163 236 157 244 162 L350 244 C358 250 358 262 350 268 L244 350 C236 355 226 349 226 340 Z" 
        fill="url(#dcPlayGrad)" />

  <!-- Inner Specular Light Flare -->
  <path d="M232 186 L320 254 L232 254 Z" fill="#ffffff" fill-opacity="0.25" />

  <!-- Live Status Pulse Beacon -->
  <circle cx="360" cy="170" r="10" fill="#10b981" />
  <circle cx="360" cy="170" r="18" fill="none" stroke="#10b981" stroke-width="3" stroke-opacity="0.5" />
</svg>"""

MANIFEST_CONTENT = """{
  "name": "DriveConnector",
  "short_name": "DriveConnector",
  "description": "1TB High-Performance On-Demand Cloud Media Streamer & FFmpeg Processing Engine",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0a0c14",
  "theme_color": "#0ea5e9",
  "icons": [
    {
      "src": "/static/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any maskable"
    },
    {
      "src": "/static/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    },
    {
      "src": "/static/favicon.svg",
      "sizes": "any",
      "type": "image/svg+xml"
    }
  ]
}"""

def make_png(width, height, rgba_data):
    """Encodes raw RGBA buffer into standard compliant PNG format."""
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # Filter type None
        start = y * width * 4
        raw.extend(rgba_data[start : start + width * 4])
    idat = chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    iend = chunk(b'IEND', b'')
    return sig + ihdr + idat + iend

def point_in_triangle(px, py, x1, y1, x2, y2, x3, y3):
    d1 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2)
    d2 = (px - x3) * (y2 - y3) - (x2 - x3) * (py - y3)
    d3 = (px - x1) * (y3 - y1) - (x3 - x1) * (py - y1)
    has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (has_neg and has_pos)

def render_brand_icon(size):
    """Renders a gorgeous rasterized brand icon at exact pixel dimensions."""
    buf = bytearray(size * size * 4)

    # Triangle coordinates relative to [0, 1]
    tx1, ty1 = 0.42, 0.32
    tx2, ty2 = 0.70, 0.50
    tx3, ty3 = 0.42, 0.68

    # Beacon coordinates
    bx, by = 0.72, 0.32

    for y in range(size):
        v = (y + 0.5) / size
        for x in range(size):
            u = (x + 0.5) / size
            idx = (y * size + x) * 4

            # Squircle equation: ((2u-1)^4 + (2v-1)^4)^(1/4)
            nx = abs(2.0 * u - 1.0)
            ny = abs(2.0 * v - 1.0)
            sq_dist = (nx**4 + ny**4)**0.25

            # Outer boundary anti-aliased cutoff
            if sq_dist > 0.94:
                # Fully transparent outside squircle
                buf[idx : idx + 4] = [0, 0, 0, 0]
                continue

            # Border detection (0.86 to 0.94)
            if sq_dist >= 0.86:
                # Border gradient (sky cyan #38bdf8 to indigo #818cf8)
                t = (u + v) * 0.5
                r = int(56 + t * (129 - 56))
                g = int(189 + t * (140 - 189))
                b = int(248 + t * (248 - 248))
                buf[idx : idx + 4] = [r, g, b, 255]
                continue

            # Inside Squircle: Dark obsidian gradient
            diag = (u + v) * 0.5
            bg_r = int(11 * (1.0 - diag) + 3 * diag)
            bg_g = int(17 * (1.0 - diag) + 7 * diag)
            bg_b = int(32 * (1.0 - diag) + 18 * diag)

            # Center radial ambient glow
            dist_center = math.hypot(u - 0.5, v - 0.5)
            if dist_center < 0.45:
                glow = (1.0 - dist_center / 0.45) * 0.35
                bg_r = min(255, int(bg_r + glow * 56))
                bg_g = min(255, int(bg_g + glow * 189))
                bg_b = min(255, int(bg_b + glow * 248))

            # Live beacon emerald dot at (bx, by)
            dist_b = math.hypot(u - bx, v - by)
            if dist_b <= 0.045:
                buf[idx : idx + 4] = [16, 185, 129, 255]
                continue
            elif 0.065 <= dist_b <= 0.09:
                # Beacon pulse ring
                buf[idx : idx + 4] = [16, 185, 129, 140]
                continue

            # Check inside play triangle
            in_play = point_in_triangle(u, v, tx1, ty1, tx2, ty2, tx3, ty3)
            if in_play:
                # Dynamic Play Gradient: #38bdf8 (cyan) to #6366f1 (indigo)
                pt = (u - tx1) / max(0.01, tx2 - tx1)
                pr = int(56 * (1.0 - pt) + 99 * pt)
                pg = int(189 * (1.0 - pt) + 102 * pt)
                pb = int(248 * (1.0 - pt) + 241 * pt)

                # Specular light flare on top half of play triangle
                if v < 0.50:
                    pr = min(255, pr + 45)
                    pg = min(255, pg + 45)
                    pb = min(255, pb + 45)

                buf[idx : idx + 4] = [pr, pg, pb, 255]
                continue

            # Transmission data lines
            if abs(v - 0.50) < 0.02 and 0.22 <= u <= 0.36:
                buf[idx : idx + 4] = [56, 189, 248, 220]
                continue
            if abs(v - 0.58) < 0.016 and 0.18 <= u <= 0.30:
                buf[idx : idx + 4] = [129, 140, 248, 190]
                continue

            buf[idx : idx + 4] = [bg_r, bg_g, bg_b, 255]

    return make_png(size, size, buf)

def create_ico_from_png_buffers(png_buffers, ico_path):
    """Packages multiple PNG byte buffers into a valid Windows .ico file."""
    images_data = []
    for buf in png_buffers:
        w, h = struct.unpack(">II", buf[16:24])
        images_data.append((min(w, 255), min(h, 255), buf))

    header = struct.pack("<HHH", 0, 1, len(images_data))
    offset = 6 + (16 * len(images_data))
    entries = []
    body = bytearray()

    for w, h, data in images_data:
        size = len(data)
        entry = struct.pack(
            "<BBBBHHII",
            w if w < 256 else 0,
            h if h < 256 else 0,
            0,
            0,
            1,
            32,
            size,
            offset
        )
        entries.append(entry)
        body.extend(data)
        offset += size

    ico_path.write_bytes(header + b"".join(entries) + body)

def main():
    static_dir = REPO_DIR / "backend/static"
    public_dir = REPO_DIR / "frontend/public"

    static_dir.mkdir(parents=True, exist_ok=True)
    public_dir.mkdir(parents=True, exist_ok=True)

    # 1. Vector SVG Favicons
    (static_dir / "favicon.svg").write_text(SVG_CONTENT, encoding="utf-8")
    (public_dir / "favicon.svg").write_text(SVG_CONTENT, encoding="utf-8")
    print("✅ Created vector SVG favicons in backend/static and frontend/public")

    # 2. PWA Web Manifests
    (static_dir / "site.webmanifest").write_text(MANIFEST_CONTENT, encoding="utf-8")
    (public_dir / "site.webmanifest").write_text(MANIFEST_CONTENT, encoding="utf-8")
    print("✅ Created site.webmanifest in backend/static and frontend/public")

    # 3. High-definition PNGs
    resolutions = [16, 32, 48, 180, 192, 512]
    ico_buffers = []

    for s in resolutions:
        png_data = render_brand_icon(s)
        filename = (
            "apple-touch-icon.png" if s == 180 else (
                f"icon-{s}.png" if s in (192, 512) else f"favicon-{s}.png"
            )
        )
        (static_dir / filename).write_bytes(png_data)
        (public_dir / filename).write_bytes(png_data)

        if s in (16, 32, 48):
            ico_buffers.append(png_data)
        print(f"✅ Generated {s}x{s} brand icon ({filename}) [{len(png_data)} bytes]")

    # 4. Multi-resolution ICO (16x16, 32x32, 48x48)
    create_ico_from_png_buffers(ico_buffers, static_dir / "favicon.ico")
    create_ico_from_png_buffers(ico_buffers, public_dir / "favicon.ico")
    print("✅ Created Windows multi-resolution favicon.ico in backend/static and frontend/public")

if __name__ == "__main__":
    main()
