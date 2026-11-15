import os
import uuid
import math
import json
import asyncio
import time
from pathlib import Path
from typing import Dict, Any, Optional, List

from config import settings
from database import get_video, update_video
from downloader import manager, active_downloads

# Concurrency control semaphore to protect CPU and memory
ffmpeg_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_FFMPEG)

# Active processing jobs dictionary for telemetry tracking
active_processing: Dict[str, Dict[str, Any]] = {}

def resolve_video_file_path(video: Dict[str, Any]) -> Optional[Path]:
    """
    Robustly resolves the on-disk file path for a video document.
    Handles exact local_path, filename in settings.videos_dir, and {video_id}.* candidates.
    """
    if not video:
        return None
    local_p = video.get("local_path")
    if local_p:
        p = Path(local_p)
        if p.exists():
            return p
        alt_p = settings.videos_dir / p.name
        if alt_p.exists():
            return alt_p
    vid = video.get("video_id")
    if vid:
        candidate = next((p for p in settings.videos_dir.glob(f"{vid}.*") if not p.name.endswith(".part") and not p.name.endswith(".tmp")), None)
        if candidate and candidate.exists():
            return candidate
    return None

def format_vtt_time(seconds: float) -> str:
    """Format seconds into WebVTT timestamp: HH:MM:SS.mmm (strictly 3 ASCII digits for milliseconds)."""
    total_ms = max(0, int(round(seconds * 1000)))
    hours = total_ms // 3600000
    minutes = (total_ms % 3600000) // 60000
    secs = (total_ms % 60000) // 1000
    milli = total_ms % 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{milli:03d}"

async def emit_processing_update(
    video_id: str,
    stage: str,
    stage_name: str,
    percent: float,
    eta_seconds: int,
    details: str,
    stage_percent: Optional[float] = None
):
    """Broadcasts live processing telemetry to all connected WebSocket clients."""
    sp = stage_percent if stage_percent is not None else percent
    payload = {
        "event": "PROCESSING_UPDATE",
        "video_id": video_id,
        "stage": stage,
        "stage_name": stage_name,
        "percent": min(100.0, max(0.0, round(percent, 1))),
        "stage_percent": min(100.0, max(0.0, round(sp, 1))),
        "eta_seconds": max(0, int(eta_seconds)),
        "details": details
    }
    active_processing[video_id] = payload
    try:
        v = await get_video(video_id)
        is_already_local = bool(v and (v.get("status") == "LOCAL_READY" or v.get("local_path")))
        new_status = "LOCAL_READY" if is_already_local else "PROCESSING"
        await update_video(video_id, {"processing_info": payload, "status": new_status})
    except Exception:
        pass
    await manager.broadcast(payload)

async def run_cmd_with_progress(
    cmd: list,
    duration: float,
    timeout: int,
    video_id: str,
    stage: str,
    stage_name: str,
    base_percent: float = 40.0,
    span_percent: float = 55.0
) -> tuple[int, str, str]:
    """
    Executes an FFmpeg command with live '-progress pipe:1' monitoring,
    streaming realtime percentage and countdown ETA to WebSocket clients.
    """
    progress_cmd = list(cmd)
    if "-progress" not in progress_cmd:
        progress_cmd.extend(["-progress", "pipe:1", "-nostats"])

    safe_duration = max(1.0, duration)
    start_time = time.time()
    last_broadcast = 0.0

    try:
        proc = await asyncio.create_subprocess_exec(
            *progress_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
    except Exception as e:
        return -1, "", str(e)

    speed_val = 1.0

    async def monitor_stdout():
        nonlocal last_broadcast, speed_val
        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="ignore").strip()
                if text.startswith("speed="):
                    s_str = text.split("=")[1].replace("x", "").strip()
                    try:
                        speed_val = max(0.05, float(s_str))
                    except Exception:
                        pass
                elif text.startswith("out_time_us="):
                    try:
                        us = int(text.split("=")[1])
                        sec = us / 1_000_000.0
                        ratio = min(1.0, max(0.0, sec / safe_duration))
                        now = time.time()
                        if (now - last_broadcast >= 0.4) or (ratio >= 0.99):
                            last_broadcast = now
                            stage_pct = min(99, max(1, int(ratio * 100)))
                            overall_pct = min(99.0, round(base_percent + (ratio * span_percent), 1))
                            rem_sec = max(0.0, safe_duration - sec)

                            if speed_val > 0.05:
                                eta_seconds = max(1, int(rem_sec / speed_val))
                            else:
                                elapsed = now - start_time
                                if ratio > 0.03:
                                    eta_seconds = max(1, int((elapsed / ratio) - elapsed))
                                else:
                                    eta_seconds = max(1, int(safe_duration * 0.3))

                            await emit_processing_update(
                                video_id=video_id,
                                stage=stage,
                                stage_name=stage_name,
                                percent=overall_pct,
                                stage_percent=stage_pct,
                                eta_seconds=eta_seconds,
                                details=f"{stage_name}: {stage_pct}% ({eta_seconds}s left)"
                            )
                    except Exception:
                        pass
        except Exception:
            pass

    try:
        await asyncio.wait_for(
            asyncio.gather(monitor_stdout(), proc.wait()),
            timeout=timeout
        )
        _, stderr_bytes = await proc.communicate()
        stderr_text = stderr_bytes.decode(errors="ignore") if stderr_bytes else ""
        return proc.returncode, "", stderr_text
    except asyncio.TimeoutError:
        print(f"[FFmpeg] Command timed out after {timeout}s: {' '.join(cmd[:3])}")
        try:
            proc.kill()
        except OSError:
            pass
        return -1, "", "Timeout"
    except Exception as e:
        return -1, "", str(e)

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
    """Runs ffprobe on the target video and returns parsed JSON format and stream info including all audio, subtitle tracks, and chapter markers."""
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        "-show_chapters",
        str(video_path)
    ]
    code, stdout, _ = await run_cmd(cmd, timeout=45)
    if code != 0 or not stdout:
        return {
            "duration": 0.0,
            "width": 1920,
            "height": 1080,
            "has_audio": True,
            "audio_tracks": [],
            "subtitle_tracks": [],
            "chapters": []
        }

    try:
        data = json.loads(stdout)
        duration = float(data.get("format", {}).get("duration", 0.0))
        streams = data.get("streams", [])
        video_stream = next((s for s in streams if s.get("codec_type") == "video"), {})
        width = int(video_stream.get("width", 1920))
        height = int(video_stream.get("height", 1080))
        if duration == 0.0:
            duration = float(video_stream.get("duration", 0.0))

        lang_names = {
            "hin": "Hindi", "hi": "Hindi",
            "eng": "English", "en": "English",
            "spa": "Spanish", "es": "Spanish",
            "fra": "French", "fre": "French", "fr": "French",
            "deu": "German", "ger": "German", "de": "German",
            "ita": "Italian", "it": "Italian",
            "jpn": "Japanese", "ja": "Japanese",
            "kor": "Korean", "ko": "Korean",
            "zho": "Chinese", "chi": "Chinese", "zh": "Chinese",
            "rus": "Russian", "ru": "Russian",
            "tam": "Tamil", "ta": "Tamil",
            "tel": "Telugu", "te": "Telugu",
            "mal": "Malayalam", "ml": "Malayalam",
            "kan": "Kannada", "kn": "Kannada",
            "pan": "Punjabi", "pa": "Punjabi",
            "urd": "Urdu", "ur": "Urdu",
            "ara": "Arabic", "ar": "Arabic",
            "por": "Portuguese", "pt": "Portuguese",
            "und": "Audio Track"
        }

        audio_tracks = []
        subtitle_tracks = []
        audio_idx = 0
        sub_idx = 0

        for s in streams:
            ctype = s.get("codec_type")
            idx = s.get("index", 0)
            tags = s.get("tags") or {}
            lang = (tags.get("language") or tags.get("lang") or "und").lower()
            title = (tags.get("title") or tags.get("handler_name") or "").strip()
            disp = s.get("disposition") or {}
            is_default = bool(disp.get("default", 0))

            if ctype == "audio":
                codec = s.get("codec_name", "aac")
                channels = int(s.get("channels", 2))
                layout = s.get("channel_layout", "")
                lang_disp = lang_names.get(lang, lang.upper())

                channel_str = f"{channels}ch" if not layout else layout
                parts = [lang_disp]
                if title and title.lower() != lang_disp.lower():
                    parts.append(f"[{title}]")
                parts.append(f"({codec.upper()} {channel_str})")
                label = " ".join(parts)

                audio_tracks.append({
                    "index": audio_idx,
                    "stream_index": idx,
                    "codec": codec,
                    "language": lang,
                    "language_name": lang_disp,
                    "channels": channels,
                    "channel_layout": layout,
                    "title": title,
                    "label": label,
                    "is_default": is_default
                })
                audio_idx += 1

            elif ctype == "subtitle":
                codec = s.get("codec_name", "srt")
                is_text = codec.lower() in ("subrip", "srt", "ass", "ssa", "mov_text", "webvtt")
                lang_disp = lang_names.get(lang, lang.upper() if lang != "und" else "Subtitle")
                label = f"{lang_disp} [{title}]" if title else f"{lang_disp} ({codec.upper()})"

                subtitle_tracks.append({
                    "index": sub_idx,
                    "stream_index": idx,
                    "codec": codec,
                    "language": lang,
                    "language_name": lang_disp,
                    "title": title,
                    "label": label,
                    "is_text": is_text,
                    "is_default": is_default,
                    "url": None
                })
                sub_idx += 1

        raw_chapters = data.get("chapters", [])
        chapters = []
        for ch in raw_chapters:
            ch_tags = ch.get("tags") or {}
            start_sec = 0.0
            end_sec = 0.0
            try:
                start_sec = float(ch.get("start_time", 0.0))
            except (ValueError, TypeError):
                tb = ch.get("time_base", "1/1000")
                if "/" in str(tb):
                    try:
                        num, den = str(tb).split("/", 1)
                        start_sec = float(ch.get("start", 0)) * float(num) / float(den)
                    except Exception:
                        start_sec = float(ch.get("start", 0.0))
            try:
                end_sec = float(ch.get("end_time", 0.0))
            except (ValueError, TypeError):
                tb = ch.get("time_base", "1/1000")
                if "/" in str(tb):
                    try:
                        num, den = str(tb).split("/", 1)
                        end_sec = float(ch.get("end", 0)) * float(num) / float(den)
                    except Exception:
                        end_sec = float(ch.get("end", 0.0))

            title = ch_tags.get("title") or f"Chapter {ch.get('id', len(chapters) + 1)}"
            chapters.append({
                "id": ch.get("id", len(chapters)),
                "start": start_sec,
                "end": end_sec,
                "start_time": start_sec,
                "end_time": end_sec,
                "title": title,
                "tags": ch_tags
            })

        return {
            "duration": duration,
            "width": width,
            "height": height,
            "has_audio": len(audio_tracks) > 0,
            "audio_tracks": audio_tracks,
            "subtitle_tracks": subtitle_tracks,
            "chapters": chapters
        }
    except Exception as e:
        print(f"[FFmpeg] Error parsing ffprobe output: {e}")
        return {
            "duration": 0.0,
            "width": 1920,
            "height": 1080,
            "has_audio": True,
            "audio_tracks": [],
            "subtitle_tracks": [],
            "chapters": []
        }

async def extract_embedded_subtitles(
    video_id: str,
    video_path: Path,
    meta_dir: Path,
    subtitle_tracks: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    Extracts embedded text subtitle streams (SRT, ASS, MOV_TEXT, WebVTT)
    into standard WebVTT files so they can be loaded by web browsers via Plyr.
    """
    updated_tracks = []
    meta_dir.mkdir(parents=True, exist_ok=True)

    for st in subtitle_tracks:
        track = dict(st)
        if not track.get("is_text"):
            updated_tracks.append(track)
            continue

        sub_filename = f"sub_{track['index']}_{track['language']}.vtt"
        sub_path = meta_dir / sub_filename

        # If already extracted and valid, keep existing
        if sub_path.exists() and sub_path.stat().st_size > 50:
            track["url"] = f"/metadata/{video_id}/{sub_filename}"
            updated_tracks.append(track)
            continue

        try:
            cmd = [
                "ffmpeg", "-y",
                "-i", str(video_path),
                "-map", f"0:{track['stream_index']}",
                "-c:s", "webvtt",
                str(sub_path)
            ]
            code, _, _ = await run_cmd(cmd, timeout=30)
            if code == 0 and sub_path.exists() and sub_path.stat().st_size > 50:
                track["url"] = f"/metadata/{video_id}/{sub_filename}"
                print(f"[FFmpeg] Extracted subtitle track {track['index']} ({track['label']}) -> {sub_path.name}")
            else:
                track["url"] = None
        except Exception as e:
            print(f"[FFmpeg] Subtitle extraction error for track {track['index']}: {e}")
            track["url"] = None

        updated_tracks.append(track)

    return updated_tracks

_audio_extraction_locks: Dict[str, asyncio.Lock] = {}

async def extract_audio_track(video_id: str, track_index: int) -> Optional[Path]:
    """
    Extracts a specific audio track to AAC .m4a format for companion audio streaming
    in web browsers when dual-audio switching is requested.
    """
    video = await get_video(video_id)
    if not video:
        return None

    video_path = resolve_video_file_path(video)
    if not video_path or not video_path.exists():
        return None

    meta_dir = settings.get_video_metadata_dir(video_id)
    meta_dir.mkdir(parents=True, exist_ok=True)
    audio_dest = meta_dir / f"audio_track_{track_index}.m4a"

    if audio_dest.exists() and audio_dest.stat().st_size > 1000:
        return audio_dest

    lock_key = f"{video_id}_{track_index}"
    if lock_key not in _audio_extraction_locks:
        _audio_extraction_locks[lock_key] = asyncio.Lock()

    async with _audio_extraction_locks[lock_key]:
        # Double check after acquiring lock
        if audio_dest.exists() and audio_dest.stat().st_size > 1000:
            return audio_dest

        audio_tracks = video.get("audio_tracks") or []
        if not audio_tracks:
            info = await probe_video(video_path)
            audio_tracks = info.get("audio_tracks", [])

        # Flexible matching: by index, stream_index, 0-based list offset, or 1-based list offset
        target_track = next((t for t in audio_tracks if t.get("index") == track_index), None)
        if not target_track:
            target_track = next((t for t in audio_tracks if t.get("stream_index") == track_index), None)
        if not target_track and 0 <= track_index < len(audio_tracks):
            target_track = audio_tracks[track_index]
        if not target_track and 1 <= track_index <= len(audio_tracks):
            target_track = audio_tracks[track_index - 1]

        # If not matched yet, freshly probe video container
        if not target_track:
            fresh_info = await probe_video(video_path)
            audio_tracks = fresh_info.get("audio_tracks", [])
            target_track = next((t for t in audio_tracks if t.get("index") == track_index), None)
            if not target_track:
                target_track = next((t for t in audio_tracks if t.get("stream_index") == track_index), None)
            if not target_track and 0 <= track_index < len(audio_tracks):
                target_track = audio_tracks[track_index]
            if not target_track and 1 <= track_index <= len(audio_tracks):
                target_track = audio_tracks[track_index - 1]

        if not target_track:
            print(f"[FFmpeg] No audio track metadata matching index/stream {track_index} found in {video_path}; attempting direct 0:a:{track_index} extraction")

        # Check if canonical track index was already extracted
        target_idx = target_track.get("index") if target_track else track_index
        if target_idx is not None:
            canonical_dest = meta_dir / f"audio_track_{target_idx}.m4a"
            if canonical_dest.exists() and canonical_dest.stat().st_size > 1000:
                if canonical_dest != audio_dest and not audio_dest.exists():
                    try:
                        import shutil
                        shutil.copyfile(canonical_dest, audio_dest)
                    except Exception:
                        pass
                return canonical_dest

        stream_idx = target_track.get("stream_index") if target_track else None

        # Robust multi-track FFmpeg mapping resolution:
        # Prioritize 0:a:{target_idx} (audio stream index) which is immune to non-audio container streams (subtitles, chapters, fonts)
        candidate_maps = []
        if target_idx is not None:
            candidate_maps.append(f"0:a:{target_idx}")
        if f"0:a:{track_index}" not in candidate_maps:
            candidate_maps.append(f"0:a:{track_index}")
        if stream_idx is not None and f"0:{stream_idx}" not in candidate_maps:
            candidate_maps.append(f"0:{stream_idx}")

        temp_dest = meta_dir / f"tmp_audio_track_{track_index}_{uuid.uuid4().hex[:6]}.m4a"
        if temp_dest.exists():
            try:
                temp_dest.unlink()
            except Exception:
                pass

        extracted = False
        for map_arg in candidate_maps:
            cmd = [
                "ffmpeg", "-y",
                "-threads", str(settings.ffmpeg_worker_threads),
                "-i", str(video_path),
                "-map", map_arg,
                "-vn", "-sn", "-dn",
                "-c:a", "aac",
                "-b:a", "192k",
                "-movflags", "+faststart",
                "-f", "mp4",
                str(temp_dest)
            ]
            code, _, err = await run_cmd(cmd, timeout=300)
            if code == 0 and temp_dest.exists() and temp_dest.stat().st_size > 1000:
                temp_dest.replace(audio_dest)
                extracted = True
                if target_idx is not None and target_idx != track_index:
                    canonical_dest = meta_dir / f"audio_track_{target_idx}.m4a"
                    if not canonical_dest.exists():
                        try:
                            import shutil
                            shutil.copyfile(audio_dest, canonical_dest)
                        except Exception:
                            pass
                break
            else:
                print(f"[FFmpeg] Audio extraction candidate {map_arg} failed (code {code}): {err}")
                if temp_dest.exists():
                    try:
                        temp_dest.unlink()
                    except Exception:
                        pass

        if extracted and audio_dest.exists() and audio_dest.stat().st_size > 1000:
            return audio_dest

        print(f"[FFmpeg] All audio extraction candidates failed for track {track_index} in {video_path}")
        return None

async def generate_poster_if_needed(video_path: Path, poster_path: Path, duration: float):
    """Generates a high-quality static poster thumbnail at 10% of duration if not already present."""
    if poster_path.exists() and poster_path.stat().st_size > 1000:
        return

    seek_time = max(1.0, duration * 0.1) if duration > 0 else 1.0
    cmd = [
        "ffmpeg", "-y",
        "-threads", str(settings.ffmpeg_worker_threads),
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

    threads = str(settings.ffmpeg_worker_threads)

    if duration < 5:
        cmd = [
            "ffmpeg", "-y",
            "-threads", threads,
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
        "-threads", threads,
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
            "-threads", threads,
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

async def generate_vtt_sprites(video_id: str, video_path: Path, meta_dir: Path, duration: float):
    """
    Extracts frames and tiles them into a single sprite sheet (sprites.jpg).
    WebVTT image paths are written with absolute URLs: /metadata/{video_id}/sprites.jpg#xywh=...
    This prevents Plyr 404 relative resolution issues on seekbar scrub.
    """
    sprites_path = meta_dir / "sprites.jpg"
    vtt_path = meta_dir / "thumbnails.vtt"

    safe_duration = max(1.0, duration)
    # Adapt interval so total frames is at most 500 (safeguard)
    interval = max(5.0, math.ceil(safe_duration / 500))
    total_frames = max(1, math.ceil(safe_duration / interval))
    
    cols = 10
    rows = math.ceil(total_frames / cols)
    tile_w = 160
    tile_h = 90

    cmd = [
        "ffmpeg", "-y",
        "-threads", str(settings.ffmpeg_worker_threads),
        "-i", str(video_path),
        "-vf", f"fps=1/{interval},scale={tile_w}:{tile_h},tile={cols}x{rows}",
        "-frames:v", "1",
        "-q:v", "3",
        str(sprites_path)
    ]
    code, _, err = await run_cmd_with_progress(
        cmd=cmd,
        duration=safe_duration,
        timeout=300,
        video_id=video_id,
        stage="SPRITES",
        stage_name="Generating Sprites",
        base_percent=45.0,
        span_percent=50.0
    )
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
        # Absolute URL eliminates Plyr relative path 404s
        lines.append(f"/metadata/{video_id}/sprites.jpg#xywh={x},{y},{tile_w},{tile_h}\n")

    with open(vtt_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

async def process_video_background(video_id: str):
    """Main background pipeline entrypoint executed once a video is stored locally."""
    video = await get_video(video_id)
    if not video:
        active_downloads.pop(video_id, None)
        active_processing.pop(video_id, None)
        return

    video_path = resolve_video_file_path(video)
    if not video_path or not video_path.exists():
        print(f"[FFmpeg] Error: local file not found for video {video_id}")
        active_downloads.pop(video_id, None)
        active_processing.pop(video_id, None)
        await update_video(video_id, {"status": "FAILED"})
        return

    meta_dir = settings.get_video_metadata_dir(video_id)
    poster_path = meta_dir / "poster.jpg"
    preview_path = meta_dir / "preview.mp4"
    vtt_path = meta_dir / "thumbnails.vtt"

    async with ffmpeg_semaphore:
        try:
            info = await probe_video(video_path)
            duration = info["duration"]
            audio_tracks = info.get("audio_tracks", [])
            raw_subtitles = info.get("subtitle_tracks", [])
            chapters = info.get("chapters", [])

            # Extract embedded text subtitles to WebVTT
            extracted_subtitles = await extract_embedded_subtitles(
                video_id=video_id,
                video_path=video_path,
                meta_dir=meta_dir,
                subtitle_tracks=raw_subtitles
            )

            # Stage 1: Poster Thumbnail
            await emit_processing_update(
                video_id=video_id,
                stage="POSTER",
                stage_name="Generating Poster Thumbnail",
                percent=15.0,
                eta_seconds=12,
                details="Extracting high-definition poster..."
            )
            await generate_poster_if_needed(video_path, poster_path, duration)
            await emit_processing_update(
                video_id=video_id,
                stage="POSTER",
                stage_name="Generating Poster Thumbnail",
                percent=30.0,
                eta_seconds=10,
                details="Poster thumbnail ready."
            )

            # Stage 2: Hover Preview
            await emit_processing_update(
                video_id=video_id,
                stage="PREVIEW",
                stage_name="Generating Hover Preview",
                percent=45.0,
                eta_seconds=8,
                details="Encoding 4-second preview loop..."
            )
            await generate_hover_preview(video_path, preview_path, duration)
            await emit_processing_update(
                video_id=video_id,
                stage="PREVIEW",
                stage_name="Generating Hover Preview",
                percent=65.0,
                eta_seconds=5,
                details="Hover preview compiled."
            )

            # Stage 3: Sprite Sheet with Live Progress & Time Left
            await emit_processing_update(
                video_id=video_id,
                stage="SPRITES",
                stage_name="Generating Sprites",
                percent=45.0,
                stage_percent=0.0,
                eta_seconds=max(3, int(duration * 0.15)),
                details="Starting sprite tile extraction..."
            )
            await generate_vtt_sprites(video_id, video_path, meta_dir, duration)
            await emit_processing_update(
                video_id=video_id,
                stage="SPRITES",
                stage_name="Generating Sprites",
                percent=95.0,
                stage_percent=100.0,
                eta_seconds=1,
                details="Sprite sheet & WebVTT index ready."
            )

            active_processing.pop(video_id, None)
            active_downloads.pop(video_id, None)

            update_data = {
                "status": "LOCAL_READY",
                "duration_seconds": duration,
                "poster_url": f"/metadata/{video_id}/poster.jpg" if poster_path.exists() else None,
                "preview_url": f"/metadata/{video_id}/preview.mp4" if preview_path.exists() else None,
                "vtt_url": f"/metadata/{video_id}/thumbnails.vtt" if vtt_path.exists() else None,
                "audio_tracks": audio_tracks,
                "subtitle_tracks": extracted_subtitles,
                "chapters": chapters,
                "processing_info": None
            }
            if not video.get("subtitles_url"):
                default_sub = next((s["url"] for s in extracted_subtitles if s.get("url") and s.get("language") in ("eng", "en")), None)
                if not default_sub:
                    default_sub = next((s["url"] for s in extracted_subtitles if s.get("url")), None)
                if default_sub:
                    update_data["subtitles_url"] = default_sub
            await update_video(video_id, update_data)

            await manager.broadcast({
                "event": "PROCESSING_COMPLETE",
                "video_id": video_id,
                "status": "LOCAL_READY",
                "metadata": update_data
            })

        except Exception as e:
            print(f"[FFmpeg] Pipeline error processing {video_id}: {e}")
            active_processing.pop(video_id, None)
            active_downloads.pop(video_id, None)
            fallback_data = {
                "status": "LOCAL_READY",
                "duration_seconds": 0.0,
                "processing_info": None
            }
            await update_video(video_id, fallback_data)
            await manager.broadcast({
                "event": "PROCESSING_COMPLETE",
                "video_id": video_id,
                "status": "LOCAL_READY",
                "metadata": fallback_data
            })

QUALITY_PRESETS = {
    "720p": {"vf": "scale=-2:720", "crf": "23", "audio_br": "128k", "maxrate": "2500k", "bufsize": "5000k"},
    "480p": {"vf": "scale=-2:480", "crf": "24", "audio_br": "96k", "maxrate": "1200k", "bufsize": "2400k"},
    "360p": {"vf": "scale=-2:360", "crf": "26", "audio_br": "64k", "maxrate": "800k", "bufsize": "1600k"},
}

async def transcode_video(video_id: str, target_quality: str = "720p", replace_original: bool = False):
    """
    Transcodes a video down to lower resolution (720p, 480p, 360p).
    If replace_original is True, replaces original source file to optimize disk storage.
    """
    preset = QUALITY_PRESETS.get(target_quality.lower())
    if not preset:
        print(f"[FFmpeg] Unknown transcode quality preset: {target_quality}")
        return

    video = await get_video(video_id)
    if not video:
        return

    video_path = resolve_video_file_path(video)
    if not video_path or not video_path.exists():
        return

    dest_rendition = settings.videos_dir / f"{video_id}_{target_quality}.mp4"
    temp_rendition = settings.videos_dir / f"tmp_{video_id}_{target_quality}.mp4"

    async with ffmpeg_semaphore:
        try:
            duration = float(video.get("duration_seconds") or 0.0)
            if duration <= 0:
                info = await probe_video(video_path)
                duration = float(info.get("duration") or 0.0)

            cmd = [
                "ffmpeg", "-y",
                "-threads", str(settings.ffmpeg_worker_threads),
                "-i", str(video_path),
                "-vf", preset["vf"],
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-crf", preset["crf"],
                "-maxrate", preset["maxrate"],
                "-bufsize", preset["bufsize"],
                "-c:a", "aac",
                "-b:a", preset["audio_br"],
                "-movflags", "+faststart",
                "-f", "mp4",
                str(temp_rendition)
            ]

            # Track progress during transcode with live progress pipe
            await emit_processing_update(
                video_id=video_id,
                stage="TRANSCODE",
                stage_name=f"Transcoding {target_quality}",
                percent=10.0,
                stage_percent=0.0,
                eta_seconds=max(5, int(duration * 0.25)) if duration > 0 else 25,
                details=f"Starting {target_quality} encoding..."
            )

            code, _, err = await run_cmd_with_progress(
                cmd=cmd,
                duration=duration,
                timeout=600,
                video_id=video_id,
                stage="TRANSCODE",
                stage_name=f"Transcoding {target_quality}",
                base_percent=10.0,
                span_percent=85.0
            )

            if code != 0 or not temp_rendition.exists():
                print(f"[FFmpeg] Transcode failed: {err}")
                active_processing.pop(video_id, None)
                active_downloads.pop(video_id, None)
                if temp_rendition.exists():
                    try:
                        os.remove(temp_rendition)
                    except OSError:
                        pass
                await update_video(video_id, {
                    "processing_info": None,
                    "status": "LOCAL_READY"
                })
                await manager.broadcast({
                    "event": "PROCESSING_COMPLETE",
                    "video_id": video_id,
                    "status": "LOCAL_READY",
                    "action": "TRANSCODE_FAILED",
                    "quality": target_quality,
                    "error": "Transcoding failed or timed out"
                })
                return

            if dest_rendition.exists():
                try:
                    os.remove(dest_rendition)
                except OSError:
                    pass
            temp_rendition.rename(dest_rendition)

            renditions = video.get("renditions") or {}
            new_size = dest_rendition.stat().st_size

            if replace_original:
                # Replace the primary file to reclaim disk space
                original_size = video_path.stat().st_size
                primary_target = settings.videos_dir / f"{video_id}.mp4"
                backup_path = settings.videos_dir / f"{video_id}.orig"
                try:
                    if backup_path.exists():
                        os.remove(backup_path)
                    video_path.rename(backup_path)
                    dest_rendition.rename(primary_target)
                    if backup_path.exists():
                        os.remove(backup_path)
                    renditions[target_quality] = {
                        "path": str(primary_target),
                        "file_size_bytes": new_size,
                        "resolution": target_quality,
                        "replaced_original": True
                    }
                    await update_video(video_id, {
                        "local_path": str(primary_target),
                        "file_size_bytes": new_size,
                        "renditions": renditions,
                        "processing_info": None
                    })
                except Exception as e:
                    print(f"[FFmpeg] Error replacing original with {target_quality}: {e}")
            else:
                renditions[target_quality] = {
                    "path": str(dest_rendition),
                    "file_size_bytes": new_size,
                    "resolution": target_quality,
                    "replaced_original": False
                }
                await update_video(video_id, {
                    "renditions": renditions,
                    "processing_info": None
                })

            active_processing.pop(video_id, None)
            active_downloads.pop(video_id, None)

            await manager.broadcast({
                "event": "PROCESSING_COMPLETE",
                "video_id": video_id,
                "status": "LOCAL_READY",
                "action": "TRANSCODE_COMPLETE",
                "quality": target_quality,
                "metadata": {
                    "renditions": renditions,
                    "file_size_bytes": dest_rendition.stat().st_size if not replace_original else new_size
                }
            })

        except Exception as e:
            print(f"[FFmpeg] Error in transcode_video {video_id}: {e}")
            active_processing.pop(video_id, None)
            active_downloads.pop(video_id, None)
            if temp_rendition.exists():
                try:
                    os.remove(temp_rendition)
                except OSError:
                    pass
            await update_video(video_id, {
                "processing_info": None,
                "status": "LOCAL_READY"
            })
            await manager.broadcast({
                "event": "PROCESSING_COMPLETE",
                "video_id": video_id,
                "status": "LOCAL_READY",
                "action": "TRANSCODE_FAILED",
                "quality": target_quality,
                "error": str(e)
            })

def run_whisper_transcription(audio_path: Path, total_duration: float = 60.0, progress_callback=None) -> Optional[List[Dict[str, Any]]]:
    """
    Transcribes audio by dividing the work into parallel chunks and utilizing 80% of CPU cores.
    Uses faster-whisper with Silero VAD to skip silence/music and prevent hallucination/repetition loops.
    """
    import wave
    import numpy as np
    import concurrent.futures

    if not audio_path.exists() or audio_path.stat().st_size < 1000:
        return None

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("[Whisper] faster_whisper not installed")
        return None

    # Calculate 80% CPU allocation
    total_whisper_cores = settings.whisper_worker_threads

    # 180 seconds (3 minutes) per chunk provides fine-grained parallel progress and fast VAD skipping
    CHUNK_DURATION_SEC = 180.0

    full_audio = None
    try:
        with wave.open(str(audio_path), "rb") as wf:
            framerate = wf.getframerate()
            nchannels = wf.getnchannels()
            sampwidth = wf.getsampwidth()
            total_frames = wf.getnframes()
            exact_duration = total_frames / float(framerate) if framerate > 0 else total_duration
            # Preload full audio into RAM pool to eliminate parallel disk I/O contention
            if sampwidth == 2:
                raw_bytes_all = wf.readframes(total_frames)
                full_audio = np.frombuffer(raw_bytes_all, dtype=np.int16).astype(np.float32) / 32768.0
                if nchannels > 1:
                    full_audio = full_audio.reshape(-1, nchannels).mean(axis=1)
                print(f"[Whisper] Preloaded {len(full_audio)} audio samples into RAM pool ({round(full_audio.nbytes / (1024**2), 1)} MB)")
    except Exception as e:
        print(f"[Whisper] Wave header read error: {e}, falling back to total_duration")
        exact_duration = total_duration
        framerate = 16000
        nchannels = 1
        sampwidth = 2
        total_frames = int(exact_duration * framerate)

    # Divide work into chunks
    chunks = []
    curr = 0.0
    while curr < exact_duration:
        chunk_len = min(CHUNK_DURATION_SEC, exact_duration - curr)
        if chunk_len > 0.5:  # Ignore trailing tiny slivers
            chunks.append((len(chunks), curr, chunk_len))
        curr += chunk_len

    if not chunks:
        chunks = [(0, 0.0, exact_duration)]

    total_chunks = len(chunks)

    # Worker allocation targeting 80% CPU:
    if total_chunks == 1 or total_whisper_cores <= 1:
        num_workers = 1
        threads_per_worker = total_whisper_cores
    elif total_whisper_cores >= 8:
        num_workers = min(4, total_chunks)
        threads_per_worker = max(1, total_whisper_cores // num_workers)
    elif total_whisper_cores >= 4:
        num_workers = min(3, total_chunks)
        threads_per_worker = max(1, total_whisper_cores // num_workers)
    else:
        num_workers = min(2, total_chunks)
        threads_per_worker = max(1, total_whisper_cores // num_workers)

    print(
        f"[Whisper] Dividing work: {total_chunks} chunks ({CHUNK_DURATION_SEC}s each) across "
        f"{num_workers} parallel workers ({threads_per_worker} threads/worker, "
        f"total {num_workers * threads_per_worker} cores = 80% CPU target)"
    )

    try:
        model = WhisperModel(
            "tiny",
            device="cpu",
            compute_type="int8",
            cpu_threads=threads_per_worker,
            num_workers=num_workers
        )
    except Exception as e:
        print(f"[Whisper] Model load error: {e}")
        return None

    def process_chunk(chunk_tuple):
        chunk_idx, start_sec, dur_sec = chunk_tuple
        start_frame = int(start_sec * framerate)
        frames_to_read = int(dur_sec * framerate)

        try:
            if full_audio is not None:
                end_frame = min(len(full_audio), start_frame + frames_to_read)
                if start_frame >= len(full_audio):
                    return chunk_idx, []
                audio_arr = full_audio[start_frame:end_frame]
            else:
                with wave.open(str(audio_path), "rb") as wf:
                    wf.setpos(start_frame)
                    raw_bytes = wf.readframes(frames_to_read)

                if not raw_bytes:
                    return chunk_idx, []

                audio_arr = np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float32) / 32768.0

            segs, info = model.transcribe(
                audio_arr,
                beam_size=1,
                best_of=1,
                temperature=0.0,
                vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=500),
                condition_on_previous_text=False
            )

            chunk_segments = []
            for s in segs:
                txt = s.text.strip()
                if txt:
                    chunk_segments.append({
                        "start": round(float(s.start) + start_sec, 3),
                        "end": round(float(s.end) + start_sec, 3),
                        "text": txt
                    })
            return chunk_idx, chunk_segments
        except Exception as e:
            print(f"[Whisper] Chunk {chunk_idx} error: {e}")
            return chunk_idx, []

    chunk_results = {}
    completed_count = 0
    start_time = time.time()

    with concurrent.futures.ThreadPoolExecutor(max_workers=num_workers) as executor:
        future_map = {executor.submit(process_chunk, c): c for c in chunks}
        for future in concurrent.futures.as_completed(future_map):
            chunk_idx, segs = future.result()
            chunk_results[chunk_idx] = segs
            completed_count += 1

            if progress_callback:
                elapsed = time.time() - start_time
                avg_time_per_chunk = elapsed / max(1, completed_count)
                remaining_chunks = total_chunks - completed_count
                eta_sec = max(1, int(remaining_chunks * (avg_time_per_chunk / num_workers)))
                pct = min(85.0, 20.0 + (completed_count / total_chunks) * 65.0)
                pct_int = int((completed_count / total_chunks) * 100)
                details = f"Transcribing AI Subtitles: chunk {completed_count}/{total_chunks} ({pct_int}%, {eta_sec}s left) [80% CPU active]..."
                try:
                    progress_callback(pct, eta_sec, details)
                except Exception:
                    pass

    # Assemble in chronological order
    all_segments = []
    for idx in range(total_chunks):
        if idx in chunk_results:
            all_segments.extend(chunk_results[idx])

    return all_segments

async def transcribe_video(video_id: str):
    """
    Extracts audio stream via FFmpeg, transcribes speech locally using faster-whisper,
    and produces subtitles.vtt with sentence/word timestamps for Plyr captions.
    """
    video = await get_video(video_id)
    if not video:
        active_downloads.pop(video_id, None)
        active_processing.pop(video_id, None)
        return

    video_path = resolve_video_file_path(video)
    if not video_path or not video_path.exists():
        active_downloads.pop(video_id, None)
        active_processing.pop(video_id, None)
        return

    meta_dir = settings.get_video_metadata_dir(video_id)
    audio_path = meta_dir / "audio_extract.wav"
    vtt_path = meta_dir / "subtitles.vtt"

    async with ffmpeg_semaphore:
        try:
            await emit_processing_update(
                video_id=video_id,
                stage="TRANSCRIBE",
                stage_name="Generating AI Subtitles",
                percent=15.0,
                eta_seconds=20,
                details="Extracting 16kHz audio stream via FFmpeg..."
            )

            # Probe audio stream existence and pick best language track (e.g. English)
            probe_info = await probe_video(video_path)
            has_audio = probe_info.get("has_audio", True)
            audio_tracks = probe_info.get("audio_tracks", [])

            target_stream = None
            for t in audio_tracks:
                if t.get("language") in ("eng", "en"):
                    target_stream = t.get("stream_index")
                    break
            if target_stream is None and audio_tracks:
                target_stream = audio_tracks[0].get("stream_index")

            segments = None
            if has_audio:
                map_args = ["-map", f"0:{target_stream}"] if target_stream is not None else []
                # Extract 16kHz mono audio for Whisper model with 10-minute timeout for large files
                cmd = [
                    "ffmpeg", "-y",
                    "-threads", str(settings.ffmpeg_worker_threads),
                    "-i", str(video_path),
                    *map_args,
                    "-vn",
                    "-acodec", "pcm_s16le",
                    "-ar", "16000",
                    "-ac", "1",
                    str(audio_path)
                ]
                code, _, err = await run_cmd(cmd, timeout=600)
                if code == 0 and audio_path.exists():
                    total_dur = float(probe_info.get("duration") or (video.get("duration_seconds") or 60.0))
                    initial_eta = max(10, int(total_dur * 0.15))
                    await emit_processing_update(
                        video_id=video_id,
                        stage="TRANSCRIBE",
                        stage_name="Generating AI Subtitles",
                        percent=20.0,
                        eta_seconds=initial_eta,
                        details="Dividing audio into parallel chunks (80% CPU)..."
                    )
                    loop = asyncio.get_running_loop()

                    def on_whisper_progress(pct: float, eta: int, details_str: str):
                        asyncio.run_coroutine_threadsafe(
                            emit_processing_update(
                                video_id=video_id,
                                stage="TRANSCRIBE",
                                stage_name="Generating AI Subtitles",
                                percent=pct,
                                eta_seconds=eta,
                                details=details_str
                            ),
                            loop
                        )

                    # Execute parallel chunked transcription in background thread pool with live progress updates
                    segments = await asyncio.to_thread(run_whisper_transcription, audio_path, total_dur, on_whisper_progress)
                else:
                    print(f"[Whisper] Audio extraction notice (proceeding to fallback): {err}")

            await emit_processing_update(
                video_id=video_id,
                stage="TRANSCRIBE",
                stage_name="Generating AI Subtitles",
                percent=85.0,
                eta_seconds=4,
                details="Compiling WebVTT captions track..."
            )

            # Build WebVTT file content
            vtt_lines = ["WEBVTT\n"]
            if segments and len(segments) > 0:
                for seg in segments:
                    start_s = seg["start"]
                    end_s = max(start_s + 0.5, seg["end"])
                    text = seg["text"]
                    if text:
                        vtt_lines.append(f"{format_vtt_time(start_s)} --> {format_vtt_time(end_s)}")
                        vtt_lines.append(f"{text}\n")
            else:
                # Graceful fallback: produce valid WebVTT cues based on video duration
                dur = float(video.get("duration_seconds") or probe_info.get("duration") or 10.0)
                vtt_lines.append(f"{format_vtt_time(0.0)} --> {format_vtt_time(min(5.0, dur))}")
                vtt_lines.append(f"[AI Subtitles: Audio track analyzed - no speech detected]\n")

            with open(vtt_path, "w", encoding="utf-8") as f:
                f.write("\n".join(vtt_lines))

            # Clean up temporary audio extract
            if audio_path.exists():
                try:
                    os.remove(audio_path)
                except OSError:
                    pass

            subtitles_url = f"/metadata/{video_id}/subtitles.vtt"
            await update_video(video_id, {
                "subtitles_url": subtitles_url,
                "processing_info": None
            })

            active_processing.pop(video_id, None)
            active_downloads.pop(video_id, None)

            await manager.broadcast({
                "event": "PROCESSING_COMPLETE",
                "video_id": video_id,
                "status": "LOCAL_READY",
                "action": "TRANSCRIBE_COMPLETE",
                "metadata": {
                    "subtitles_url": subtitles_url
                }
            })

        except Exception as e:
            print(f"[Whisper] Pipeline transcription error: {e}")
            active_processing.pop(video_id, None)
            active_downloads.pop(video_id, None)
            if audio_path.exists():
                try:
                    os.remove(audio_path)
                except OSError:
                    pass
            await update_video(video_id, {
                "processing_info": None,
                "status": "LOCAL_READY"
            })
            await manager.broadcast({
                "event": "PROCESSING_COMPLETE",
                "video_id": video_id,
                "status": "LOCAL_READY",
                "action": "TRANSCRIBE_FAILED",
                "error": str(e)
            })
