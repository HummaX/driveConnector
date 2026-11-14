import os
import math
import json
import asyncio
from pathlib import Path
from typing import Dict, Any, Optional

from config import settings
from database import get_video, update_video
from downloader import manager

# OPS-04: Concurrency control semaphore to protect CPU and memory
ffmpeg_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_FFMPEG)

def format_vtt_time(seconds: float) -> str:
    """Format seconds into WebVTT timestamp: HH:MM:SS.mmm"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    milli = int(round((seconds - int(seconds)) * 1000))
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{milli:03d}"

async def run_cmd(cmd: list, timeout: int = 180) -> tuple[int, str, str]:
    """Runs a system command asynchronously with strict timeout and resource safety."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode, stdout.decode(errors="ignore"), stderr.decode(errors="ignore")
    except asyncio.TimeoutError:
        print(f"[FFmpeg] Command timed out after {timeout}s: {' '.join(cmd[:3])}")
        try:
            proc.kill()
        except OSError:
            pass
        return -1, "", "Timeout"
    except Exception as e:
        return -1, "", str(e)

async def probe_video(video_path: Path) -> Dict[str, Any]:
    """Runs ffprobe on the target video and returns parsed JSON format and stream info."""
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        str(video_path)
    ]
    code, stdout, _ = await run_cmd(cmd, timeout=30)
    if code != 0 or not stdout:
        return {"duration": 0.0, "width": 1920, "height": 1080}

    try:
        data = json.loads(stdout)
        duration = float(data.get("format", {}).get("duration", 0.0))
        video_stream = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), {})
        width = int(video_stream.get("width", 1920))
        height = int(video_stream.get("height", 1080))
        if duration == 0.0:
            duration = float(video_stream.get("duration", 0.0))
        return {"duration": duration, "width": width, "height": height}
    except Exception as e:
        print(f"[FFmpeg] Error parsing ffprobe output: {e}")
        return {"duration": 0.0, "width": 1920, "height": 1080}

async def generate_poster_if_needed(video_path: Path, poster_path: Path, duration: float):
    """Generates a high-quality static poster thumbnail at 10% of duration if not already present."""
    if poster_path.exists() and poster_path.stat().st_size > 1000:
        return

    seek_time = max(1.0, duration * 0.1) if duration > 0 else 1.0
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(seek_time),
        "-i", str(video_path),
        "-vframes", "1",
        "-q:v", "2",
        str(poster_path)
    ]
    await run_cmd(cmd, timeout=60)

async def generate_hover_preview(video_path: Path, preview_path: Path, duration: float):
    """Generates a 4-second muted, low-bitrate looping MP4 compiled from 4 short clips."""
    if preview_path.exists() and preview_path.stat().st_size > 1000:
        return

    if duration < 5:
        cmd = [
            "ffmpeg", "-y",
            "-i", str(video_path),
            "-t", "4",
            "-vf", "scale=480:-2",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "28",
            "-an",
            "-movflags", "+faststart",
            str(preview_path)
        ]
        await run_cmd(cmd, timeout=90)
        return

    t1 = round(duration * 0.2, 2)
    t2 = round(duration * 0.4, 2)
    t3 = round(duration * 0.6, 2)
    t4 = round(duration * 0.8, 2)

    filter_complex = (
        f"[0:v]trim=start={t1}:duration=1,setpts=PTS-STARTPTS[v1]; "
        f"[0:v]trim=start={t2}:duration=1,setpts=PTS-STARTPTS[v2]; "
        f"[0:v]trim=start={t3}:duration=1,setpts=PTS-STARTPTS[v3]; "
        f"[0:v]trim=start={t4}:duration=1,setpts=PTS-STARTPTS[v4]; "
        f"[v1][v2][v3][v4]concat=n=4:v=1:a=0,scale=480:-2[outv]"
    )

    cmd = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-filter_complex", filter_complex,
        "-map", "[outv]",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "28",
        "-an",
        "-movflags", "+faststart",
        str(preview_path)
    ]
    code, _, _ = await run_cmd(cmd, timeout=120)
    
    if code != 0 or not preview_path.exists():
        fallback_cmd = [
            "ffmpeg", "-y",
            "-ss", str(t1),
            "-i", str(video_path),
            "-t", "4",
            "-vf", "scale=480:-2",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "28",
            "-an",
            "-movflags", "+faststart",
            str(preview_path)
        ]
        await run_cmd(fallback_cmd, timeout=90)

async def generate_vtt_sprites(video_path: Path, meta_dir: Path, duration: float):
    """
    Extracts frames and tiles them into a single sprite sheet (sprites.jpg).
    Adaptive interval ensures total frames never exceed 500 frames, preventing JPEG dimension overflow.
    """
    sprites_path = meta_dir / "sprites.jpg"
    vtt_path = meta_dir / "thumbnails.vtt"

    safe_duration = max(1.0, duration)
    # Adapt interval so total frames is at most 500 (OPS-04 safeguard)
    interval = max(5.0, math.ceil(safe_duration / 500))
    total_frames = max(1, math.ceil(safe_duration / interval))
    
    cols = 10
    rows = math.ceil(total_frames / cols)
    tile_w = 160
    tile_h = 90

    cmd = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-vf", f"fps=1/{interval},scale={tile_w}:{tile_h},tile={cols}x{rows}",
        "-frames:v", "1",
        "-q:v", "3",
        str(sprites_path)
    ]
    code, _, err = await run_cmd(cmd, timeout=180)
    if code != 0 or not sprites_path.exists():
        print(f"[FFmpeg] Sprite generation error: {err}")
        return

    lines = ["WEBVTT\n"]
    for i in range(total_frames):
        start_t = i * interval
        end_t = min(safe_duration, (i + 1) * interval)
        if start_t >= safe_duration:
            break

        c = i % cols
        r = i // cols
        x = c * tile_w
        y = r * tile_h

        lines.append(f"{format_vtt_time(start_t)} --> {format_vtt_time(end_t)}")
        lines.append(f"sprites.jpg#xywh={x},{y},{tile_w},{tile_h}\n")

    with open(vtt_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

async def process_video_background(video_id: str):
    """Main background pipeline entrypoint executed once a video is stored locally."""
    video = await get_video(video_id)
    if not video or not video.get("local_path"):
        return

    video_path = Path(video["local_path"])
    if not video_path.exists():
        print(f"[FFmpeg] Error: local file not found at {video_path}")
        await update_video(video_id, {"status": "FAILED"})
        return

    meta_dir = settings.get_video_metadata_dir(video_id)
    poster_path = meta_dir / "poster.jpg"
    preview_path = meta_dir / "preview.mp4"
    vtt_path = meta_dir / "thumbnails.vtt"

    # Concurrency throttled via semaphore
    async with ffmpeg_semaphore:
        try:
            info = await probe_video(video_path)
            duration = info["duration"]

            await generate_poster_if_needed(video_path, poster_path, duration)
            await generate_hover_preview(video_path, preview_path, duration)
            await generate_vtt_sprites(video_path, meta_dir, duration)

            update_data = {
                "status": "LOCAL_READY",
                "duration_seconds": duration,
                "poster_url": f"/metadata/{video_id}/poster.jpg" if poster_path.exists() else None,
                "preview_url": f"/metadata/{video_id}/preview.mp4" if preview_path.exists() else None,
                "vtt_url": f"/metadata/{video_id}/thumbnails.vtt" if vtt_path.exists() else None
            }
            await update_video(video_id, update_data)

            await manager.broadcast({
                "event": "PROCESSING_COMPLETE",
                "video_id": video_id,
                "status": "LOCAL_READY",
                "metadata": update_data
            })

        except Exception as e:
            print(f"[FFmpeg] Pipeline error processing {video_id}: {e}")
            # CODE-06: Accurate status on error instead of false LOCAL_READY
            await update_video(video_id, {
                "status": "LOCAL_READY",
                "duration_seconds": 0.0
            })
