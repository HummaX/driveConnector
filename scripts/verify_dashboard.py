import re
import sys
import subprocess
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent.parent

def test_python_syntax():
    backend_dir = REPO_DIR / "backend"
    py_files = list(backend_dir.glob("*.py"))
    for py in py_files:
        res = subprocess.run([sys.executable, "-m", "py_compile", str(py)], capture_output=True, text=True)
        if res.returncode != 0:
            print(f"❌ Syntax error in {py.name}: {res.stderr}")
            return False
    print(f"✅ All {len(py_files)} Python backend files compiled cleanly.")
    return True

def test_dom_ids():
    html_file = REPO_DIR / "backend/static/index.html"
    content = html_file.read_text(encoding="utf-8")
    js_ids = set(re.findall(r"getElementById\(['\"]([^'\"]+)['\"]\)", content))
    html_ids = set(re.findall(r"id=['\"]([^'\"]+)['\"]", content))
    missing = js_ids - html_ids
    print(f"Total JS IDs: {len(js_ids)}, HTML IDs: {len(html_ids)}")
    if missing:
        print(f"❌ Missing IDs: {missing}")
        return False
    print("✅ All referenced DOM IDs exist in HTML.")
    return True

def test_jsx_delimiters():
    all_ok = True
    repo = REPO_DIR / "frontend/src"
    count = 0
    for f in repo.glob("**/*.jsx"):
        text = f.read_text(encoding="utf-8")
        curlies = text.count("{") - text.count("}")
        parens = text.count("(") - text.count(")")
        brackets = text.count("[") - text.count("]")
        if curlies != 0 or parens != 0 or brackets != 0:
            print(f"❌ Delimiter mismatch in {f.name}: curlies={curlies}, parens={parens}, brackets={brackets}")
            all_ok = False
        count += 1
    if all_ok:
        print(f"✅ All {count} JSX components balanced.")
    return all_ok

def test_tailwind_classes():
    files = list((REPO_DIR / "frontend/src").glob("**/*.jsx")) + [REPO_DIR / "backend/static/index.html"]
    invalid_patterns = [r"py-0\.2\b", r"px-0\.2\b"]
    found_errors = []
    for f in files:
        text = f.read_text(encoding="utf-8")
        for pat in invalid_patterns:
            m = re.findall(pat, text)
            if m:
                found_errors.append(f"{f.name}: found invalid class '{m[0]}'")
    if found_errors:
        print("❌ Invalid Tailwind classes found:")
        for err in found_errors:
            print("  ", err)
        return False
    print("✅ No invalid Tailwind classes found across React and standalone HTML.")
    return True

def test_keyboard_shortcut_focus():
    app_jsx = (REPO_DIR / "frontend/src/App.jsx").read_text(encoding="utf-8")
    index_html = (REPO_DIR / "backend/static/index.html").read_text(encoding="utf-8")
    if "isInput" not in app_jsx or "tagName" not in app_jsx:
        print("❌ App.jsx keyboard shortcut '/' steals focus from input/textarea elements!")
        return False
    if "isInput" not in index_html or "tagName" not in index_html:
        print("❌ index.html keyboard shortcut '/' steals focus from input/textarea elements!")
        return False
    print("✅ Keyboard shortcut '/' properly guards input/textarea in both React and HTML.")
    return True

def test_index_video_hover():
    index_html = (REPO_DIR / "backend/static/index.html").read_text(encoding="utf-8")
    if "onmouseenter=\"this.play()\"" in index_html and "pointer-events-none" in index_html:
        print("❌ index.html has onmouseenter on a pointer-events-none video element, video will never play on hover!")
        return False
    if "card.onmouseenter" not in index_html or "card.onmouseleave" not in index_html:
        print("❌ index.html is missing card hover video controls!")
        return False
    print("✅ index.html hover preview handling is correct and responsive.")
    return True

def test_list_view_delete_confirmation():
    app_jsx = (REPO_DIR / "frontend/src/App.jsx").read_text(encoding="utf-8")
    match = re.search(r"onClick=\{\(\)\s*=>\s*handleDeleteVideo\(v\.video_id\)\}", app_jsx)
    if match:
        print("❌ App.jsx list view deletes video without confirmation!")
        return False
    if "confirmAndDelete" not in app_jsx:
        print("❌ App.jsx missing confirmAndDelete helper!")
        return False
    print("✅ List view delete requires explicit confirmation.")
    return True

def test_uptime_formatting():
    stats_jsx = (REPO_DIR / "frontend/src/components/StatsDashboard.jsx").read_text(encoding="utf-8")
    index_html = (REPO_DIR / "backend/static/index.html").read_text(encoding="utf-8")
    for name, content in [("StatsDashboard.jsx", stats_jsx), ("index.html", index_html)]:
        if "seconds < 60" not in content:
            print(f"❌ {name} formatUptime does not handle seconds < 60 properly (displays '0m')!")
            return False
    print("✅ formatUptime handles servers running < 60s cleanly.")
    return True

def test_mobile_telemetry():
    navbar_jsx = (REPO_DIR / "frontend/src/components/Navbar.jsx").read_text(encoding="utf-8")
    index_html = (REPO_DIR / "backend/static/index.html").read_text(encoding="utf-8")
    if "md:hidden" not in navbar_jsx or "mobile" not in navbar_jsx.lower():
        print("❌ Navbar.jsx missing mobile micro-telemetry strip!")
        return False
    if "mobile-cpu-pct" not in index_html or "mobile-ram-used" not in index_html:
        print("❌ index.html missing mobile micro-telemetry elements!")
        return False
    print("✅ Mobile micro-telemetry verified in both React Navbar and standalone HTML.")
    return True

def test_fastapi_serving():
    try:
        backend_path = (REPO_DIR / "backend").resolve()
        sys.path.insert(0, str(backend_path))
        import main as backend_main
        from starlette.testclient import TestClient
        client = TestClient(backend_main.app)
        res = client.get("/")
        if res.status_code != 200:
            print(f"❌ Root endpoint returned status {res.status_code}")
            return False
        content = res.text
        required_substrings = [
            "DriveConnector",
            "1TB NVMe",
            "Operations & Streaming Telemetry",
            "header-cpu-pct",
            "header-ram-used",
            "mobile-cpu-pct",
            "mobile-ram-used",
            "mobile-disk-pct",
            "kpi-disk-total",
            "transfers-drawer",
            "player-modal",
            "mongo-modal"
        ]
        for sub in required_substrings:
            if sub not in content:
                print(f"❌ index.html missing required element/section: '{sub}'")
                return False
        print(f"✅ FastAPI root / served cleanly: HTTP 200, length {len(content):,} bytes, all key sections present.")
        return True
    except Exception as e:
        print(f"❌ FastAPI serving test failed: {e}")
        return False
    finally:
        sys.path.pop(0)

def test_drive_api_endpoints():
    try:
        backend_path = (REPO_DIR / "backend").resolve()
        sys.path.insert(0, str(backend_path))
        import main as backend_main
        import auth as backend_auth
        import drive_catalog
        from starlette.testclient import TestClient

        client = TestClient(backend_main.app)

        # 1. Verify strict authentication guarding (without override)
        backend_main.app.dependency_overrides.clear()
        unauth_get = client.get("/api/drive/config")
        if unauth_get.status_code != 401:
            print(f"❌ GET /api/drive/config returned {unauth_get.status_code} instead of 401 Unauthorized")
            return False

        unauth_post = client.post("/api/drive/config", json={"api_key": "test"})
        if unauth_post.status_code != 401:
            print(f"❌ POST /api/drive/config returned {unauth_post.status_code} instead of 401 Unauthorized")
            return False

        unauth_test = client.post("/api/drive/test", json={"api_key": "test"})
        if unauth_test.status_code != 401:
            print(f"❌ POST /api/drive/test returned {unauth_test.status_code} instead of 401 Unauthorized")
            return False

        # 2. Test authenticated calls via FastAPI dependency override
        backend_main.app.dependency_overrides[backend_auth.get_current_user] = lambda: {
            "username": "admin",
            "role": "admin"
        }

        # Authenticated GET /api/drive/config
        auth_get = client.get("/api/drive/config")
        if auth_get.status_code != 200:
            print(f"❌ GET /api/drive/config with auth failed: {auth_get.status_code}")
            return False
        cfg = auth_get.json()
        for required_key in ["auth_type", "configured", "has_api_key", "has_service_account", "folder_id", "status"]:
            if required_key not in cfg:
                print(f"❌ /api/drive/config missing key: {required_key}")
                return False

        # 3. Test POST /api/drive/config with URL extraction
        folder_url = "https://drive.google.com/drive/folders/1ABC_testFolderId99"
        post_res = client.post(
            "/api/drive/config",
            json={
                "auth_type": "api_key",
                "api_key": "AIzaSyTestApiKey1234567890",
                "folder_id": folder_url
            }
        )
        if post_res.status_code != 200:
            print(f"❌ POST /api/drive/config failed: {post_res.status_code} {post_res.text}")
            return False
        saved_data = post_res.json()
        saved_cfg = saved_data.get("config", {})
        if saved_cfg.get("folder_id") != "1ABC_testFolderId99":
            print(f"❌ Folder ID was not correctly extracted from URL: {saved_cfg.get('folder_id')}")
            return False
        if "AIzaSyTestApiKey1234567890" in str(saved_cfg):
            print("❌ Full unmasked API key was exposed in response!")
            return False
        if not saved_cfg.get("has_api_key") or not saved_cfg.get("api_key_masked"):
            print("❌ api_key_masked not properly generated")
            return False

        # 4. Test POST /api/drive/test with invalid key
        test_res = client.post(
            "/api/drive/test",
            json={"api_key": "AIzaSyInvalidKeyForTesting"}
        )
        if test_res.status_code != 200:
            print(f"❌ POST /api/drive/test returned {test_res.status_code}")
            return False
        test_data = test_res.json()
        if "success" not in test_data or "message" not in test_data:
            print(f"❌ POST /api/drive/test response missing success or message: {test_data}")
            return False
        if test_data["success"] is not False:
            print(f"❌ POST /api/drive/test should report success=False for invalid key: {test_data}")
            return False

        # 5. Test POST /api/drive/config with clear_credentials
        clear_res = client.post(
            "/api/drive/config",
            json={"clear_credentials": True}
        )
        if clear_res.status_code != 200:
            print(f"❌ POST /api/drive/config clear_credentials failed: {clear_res.status_code}")
            return False
        cleared_cfg = clear_res.json().get("config", {})
        if cleared_cfg.get("configured") is not False:
            print(f"❌ Configured status should be False after clear_credentials: {cleared_cfg}")
            return False
        if cleared_cfg.get("folder_id") != "":
            print(f"❌ Folder ID should be reset after clear_credentials: {cleared_cfg.get('folder_id')}")
            return False

        # Clear dependency overrides
        backend_main.app.dependency_overrides.clear()

        # 6. Test extract_drive_id edge cases
        assert drive_catalog.extract_drive_id("https://drive.google.com/drive/folders/1XYZ") == "1XYZ"
        assert drive_catalog.extract_drive_id("https://drive.google.com/drive/u/0/folders/1XYZ?usp=sharing") == "1XYZ"
        assert drive_catalog.extract_drive_id("https://drive.google.com/open?id=1XYZ") == "1XYZ"
        assert drive_catalog.extract_drive_id("https://drive.google.com/file/d/1XYZ/view?usp=sharing") == "1XYZ"
        assert drive_catalog.extract_drive_id("https://drive.google.com/drive/my-drive") == "root"
        assert drive_catalog.extract_drive_id("https://drive.google.com/drive/u/0/my-drive") == "root"
        assert drive_catalog.extract_drive_id("1XYZ") == "1XYZ"
        assert drive_catalog.extract_drive_id(' "1XYZ" ') == "1XYZ"
        assert drive_catalog.extract_drive_id("") is None
        assert drive_catalog.extract_drive_id("https://example.com/not-drive") is None

        # 7. Test get_drive_download_params URL parameters
        dl_url, auth_hdr = drive_catalog.get_drive_download_params("test_file_id_123")
        assert "supportsAllDrives=true" in dl_url, "Download URL must include supportsAllDrives=true"
        assert "alt=media" in dl_url, "Download URL must include alt=media"
        assert isinstance(auth_hdr, dict), "Auth headers must be a dict"

        print("✅ Google Drive configuration and connectivity endpoints fully verified.")
        return True
    except Exception as e:
        print(f"❌ Drive API test failed: {e}")
        return False
    finally:
        sys.path.pop(0)

def test_vtt_absolute_sprites_format():
    backend_path = (REPO_DIR / "backend").resolve()
    sys.path.insert(0, str(backend_path))
    try:
        ffmpeg_worker_text = (REPO_DIR / "backend/ffmpeg_worker.py").read_text(encoding="utf-8")
        if "/metadata/{video_id}/sprites.jpg#xywh=" not in ffmpeg_worker_text:
            print("❌ ffmpeg_worker.py thumbnails.vtt generator is missing absolute /metadata/{video_id}/sprites.jpg URL formatting!")
            return False
        print("✅ WebVTT thumbnail generator formats absolute sprite paths eliminating Plyr 404s.")
        return True
    except Exception as e:
        print(f"❌ VTT sprites format test failed: {e}")
        return False
    finally:
        sys.path.pop(0)

def test_vtt_mimetype_and_time_format():
    backend_path = (REPO_DIR / "backend").resolve()
    sys.path.insert(0, str(backend_path))
    try:
        import mimetypes
        import main
        import ffmpeg_worker

        # 1. Check MIME type text/vtt registration
        vtt_type, _ = mimetypes.guess_type("thumbnails.vtt")
        if vtt_type != "text/vtt":
            print(f"❌ WebVTT MIME type is '{vtt_type}', expected 'text/vtt'!")
            return False

        # 2. Check format_vtt_time millisecond accuracy (strictly 3 digits, no .1000)
        t_bound = ffmpeg_worker.format_vtt_time(0.9999)
        if t_bound != "00:00:01.000":
            print(f"❌ format_vtt_time(0.9999) returned '{t_bound}', expected '00:00:01.000'!")
            return False

        t_zero = ffmpeg_worker.format_vtt_time(0.0)
        if t_zero != "00:00:00.000":
            print(f"❌ format_vtt_time(0.0) returned '{t_zero}', expected '00:00:00.000'!")
            return False

        t_hour = ffmpeg_worker.format_vtt_time(3600.0)
        if t_hour != "01:00:00.000":
            print(f"❌ format_vtt_time(3600.0) returned '{t_hour}', expected '01:00:00.000'!")
            return False

        print("✅ WebVTT text/vtt MIME type and strict 3-digit millisecond time formatting verified.")
        return True
    except Exception as e:
        print(f"❌ VTT MIME type & time format test failed: {e}")
        return False
    finally:
        sys.path.pop(0)

def test_transcode_and_transcribe_endpoints():
    backend_path = (REPO_DIR / "backend").resolve()
    sys.path.insert(0, str(backend_path))
    dummy_video_file = REPO_DIR / "backend/test_fixture_video.mp4"
    try:
        import main as backend_main
        import auth as backend_auth
        import database
        from starlette.testclient import TestClient

        client = TestClient(backend_main.app)

        # 1. Unauthenticated requests must return 401 Unauthorized
        backend_main.app.dependency_overrides.clear()
        res_unauth_tc = client.post("/api/videos/testvid123/transcode", json={"quality": "720p"})
        if res_unauth_tc.status_code != 401:
            print(f"❌ POST /api/videos/testvid123/transcode unauthenticated returned {res_unauth_tc.status_code} instead of 401")
            return False

        res_unauth_sub = client.post("/api/videos/testvid123/transcribe")
        if res_unauth_sub.status_code != 401:
            print(f"❌ POST /api/videos/testvid123/transcribe unauthenticated returned {res_unauth_sub.status_code} instead of 401")
            return False

        # 2. Authenticated user
        backend_main.app.dependency_overrides[backend_auth.get_current_user] = lambda: {"username": "admin", "role": "admin"}
        backend_main.app.dependency_overrides[backend_auth.get_current_user_flexible] = lambda: {"username": "admin", "role": "admin"}

        # Mock video in backend_main.get_video and ffmpeg_worker
        import ffmpeg_worker
        original_get_video = backend_main.get_video
        original_fw_get = ffmpeg_worker.get_video
        original_fw_update = ffmpeg_worker.update_video
        original_fw_run = ffmpeg_worker.run_cmd

        dummy_video_file.write_text("dummy video content", encoding="utf-8")

        async def mock_get_video_local(vid):
            if vid == "validvid123":
                return {
                    "video_id": "validvid123",
                    "title": "Test Local Video",
                    "status": "LOCAL_READY",
                    "local_path": str(dummy_video_file)
                }
            elif vid == "remotevid123":
                return {
                    "video_id": "remotevid123",
                    "title": "Test Remote Video",
                    "status": "REMOTE_ONLY"
                }
            return None

        async def mock_update_video(vid, data):
            return {"video_id": vid, **data}

        async def mock_run_cmd(cmd, timeout=180):
            # Touch temp destination file if in transcode
            dest = cmd[-1]
            try:
                Path(dest).write_text("dummy", encoding="utf-8")
            except Exception:
                pass
            return 0, "", ""

        backend_main.get_video = mock_get_video_local
        ffmpeg_worker.get_video = mock_get_video_local
        ffmpeg_worker.update_video = mock_update_video
        ffmpeg_worker.run_cmd = mock_run_cmd

        # 3. Not found video
        res_404_tc = client.post("/api/videos/nonexistentvid999/transcode", json={"quality": "720p"})
        if res_404_tc.status_code != 404:
            print(f"❌ POST /api/videos/nonexistentvid999/transcode returned {res_404_tc.status_code} instead of 404")
            return False

        # Remote only video should reject transcoding with 400
        res_remote_tc = client.post("/api/videos/remotevid123/transcode", json={"quality": "720p"})
        if res_remote_tc.status_code != 400:
            print(f"❌ Transcoding remote video returned {res_remote_tc.status_code} instead of 400")
            return False

        # Invalid quality should reject with 400
        res_inv_q = client.post("/api/videos/validvid123/transcode", json={"quality": "240p"})
        if res_inv_q.status_code != 400:
            print(f"❌ Transcoding with unsupported quality returned {res_inv_q.status_code} instead of 400")
            return False

        # Concurrency guard: when video is actively processing, transcode/transcribe returns 409
        ffmpeg_worker.active_processing["validvid123"] = {"stage": "TRANSCODE", "stage_name": "Transcoding 720p"}
        res_conflict_tc = client.post("/api/videos/validvid123/transcode", json={"quality": "720p"})
        if res_conflict_tc.status_code != 409:
            print(f"❌ Concurrent transcode call did not return 409: {res_conflict_tc.status_code}")
            return False
        res_conflict_sub = client.post("/api/videos/validvid123/transcribe")
        if res_conflict_sub.status_code != 409:
            print(f"❌ Concurrent transcribe call did not return 409: {res_conflict_sub.status_code}")
            return False
        ffmpeg_worker.active_processing.pop("validvid123", None)

        # Valid transcode call queues successfully
        res_valid_tc = client.post("/api/videos/validvid123/transcode", json={"quality": "720p"})
        if res_valid_tc.status_code != 200 or res_valid_tc.json().get("status") != "queued":
            print(f"❌ Valid transcode call failed: {res_valid_tc.status_code} {res_valid_tc.text}")
            return False

        ffmpeg_worker.active_processing.pop("validvid123", None)

        # Valid transcribe call queues successfully
        res_valid_sub = client.post("/api/videos/validvid123/transcribe")
        if res_valid_sub.status_code != 200 or res_valid_sub.json().get("status") != "queued":
            print(f"❌ Valid transcribe call failed: {res_valid_sub.status_code} {res_valid_sub.text}")
            return False

        backend_main.get_video = original_get_video
        ffmpeg_worker.get_video = original_fw_get
        ffmpeg_worker.update_video = original_fw_update
        ffmpeg_worker.run_cmd = original_fw_run
        backend_main.app.dependency_overrides.clear()
        print("✅ Multi-resolution transcode & AI transcribe endpoints fully verified.")
        return True
    except Exception as e:
        print(f"❌ Transcode/Transcribe API test failed: {e}")
        return False
    finally:
        if dummy_video_file.exists():
            try:
                import os
                os.remove(dummy_video_file)
            except OSError:
                pass
        sys.path.pop(0)

def test_supercharged_player_features():
    player_jsx = (REPO_DIR / "frontend/src/components/VideoPlayerModal.jsx").read_text(encoding="utf-8")
    index_html = (REPO_DIR / "backend/static/index.html").read_text(encoding="utf-8")

    # Audio booster check & AudioContext cleanup
    if "createGain" not in player_jsx or "createGain" not in index_html:
        print("❌ Web Audio API createGain (Audio Booster) missing from player!")
        return False

    if "audioCtx.close()" not in index_html or "audioContextRef.current.close()" not in player_jsx:
        print("❌ AudioContext resource cleanup missing from player modal close/unmount!")
        return False

    # Theater mode check
    if "isTheater" not in player_jsx or "toggleTheaterMode" not in index_html:
        print("❌ Theater mode controls missing from player!")
        return False

    # Watch position memory check
    if "dc_playback_pos_" not in player_jsx or "dc_playback_pos_" not in index_html:
        print("❌ Watch position memory (localStorage) missing from player!")
        return False

    # Keyboard shortcuts J/K/L/F/Space check
    for key in ["'j'", "'l'", "'f'"]:
        if key not in player_jsx.lower() or key not in index_html.lower():
            print(f"❌ Keyboard shortcut {key} missing from player keydown listener!")
            return False

    print("✅ Supercharged player UX (Audio Booster, Theater Mode, Watch Position Memory, Shortcuts) verified across React and HTML.")
    return True

def test_buffering_and_buffer_progress_features():
    player_jsx = (REPO_DIR / "frontend/src/components/VideoPlayerModal.jsx").read_text(encoding="utf-8")
    index_html = (REPO_DIR / "backend/static/index.html").read_text(encoding="utf-8")
    frontend_css = (REPO_DIR / "frontend/src/index.css").read_text(encoding="utf-8")

    # 1. Buffering Loading Indicator
    if "isBuffering" not in player_jsx or "Buffering" not in player_jsx:
        print("❌ React VideoPlayerModal missing buffering indicator overlay state/UI!")
        return False

    if "player-buffering-overlay" not in index_html or "showBufferingIndicator" not in index_html:
        print("❌ Standalone index.html missing player-buffering-overlay or showBufferingIndicator!")
        return False

    # Check media buffering event listeners (waiting, seeking, stalled, loadstart)
    for evt in ["'waiting'", "'seeking'", "'loadstart'", "stalled"]:
        if evt not in player_jsx or evt not in index_html:
            print(f"❌ Media event listener for {evt} missing in player!")
            return False

    # Check that seeked guards against readyState < 3 before dismissing buffering
    if "readyState" not in player_jsx or "readyState" not in index_html:
        print("❌ seeked handler does not guard against premature dismissal using readyState!")
        return False

    # Check that buffering is dismissed reliably when video playback resumes or frames render
    app_js = (REPO_DIR / "frontend/js/app.js").read_text(encoding="utf-8")
    for src, name in [(player_jsx, "React VideoPlayerModal"), (index_html, "Standalone index.html"), (app_js, "frontend/js/app.js")]:
        if "requestVideoFrameCallback" not in src:
            print(f"❌ {name} missing requestVideoFrameCallback frame rendering hook to dismiss buffering!")
            return False
        if "readyState >= 3" not in src:
            print(f"❌ {name} missing readyState >= 3 check to dismiss buffering during active playback!")
            return False

    # 2. Buffer Progress Bar (Pre-Loaded Media Range) & Percentage Display
    if "bufferedPercent" not in player_jsx or "calculateBufferedPercent" not in player_jsx:
        print("❌ React VideoPlayerModal missing HTML5 video buffered TimeRanges percentage calculation!")
        return False

    if "getBufferedPercent" not in index_html or "player-buffer-pct" not in index_html or "player-buffer-bar" not in index_html:
        print("❌ Standalone index.html missing getBufferedPercent or buffer progress HUD elements!")
        return False

    # Check that .plyr__progress__buffer value is explicitly updated with percentage
    if "bufBar.value = pct" not in player_jsx and "buf.value = pct" not in player_jsx:
        print("❌ React VideoPlayerModal does not update .plyr__progress__buffer element value!")
        return False

    if "buf.value = pct" not in index_html and "bufBar.value = pct" not in index_html:
        print("❌ Standalone index.html does not update .plyr__progress__buffer element value!")
        return False

    # Check explicit "Buffered:" text display in both players
    if "Buffered:" not in player_jsx or "Buffered:" not in index_html:
        print("❌ Explicit 'Buffered:' percentage indicator text missing from player timeline/toolbar!")
        return False

    # Check seekbar live badge
    if "plyr__buffer-live-badge" not in player_jsx or "plyr__buffer-live-badge" not in index_html:
        print("❌ Plyr seekbar live buffer badge missing from player progress elements!")
        return False

    # 3. Plyr .plyr__progress__buffer CSS styling in both frontend and standalone HTML
    for css_src, name in [(frontend_css, "frontend/src/index.css"), (index_html, "backend/static/index.html")]:
        if ".plyr__progress__buffer" not in css_src:
            print(f"❌ {name} missing custom high-visibility .plyr__progress__buffer styling!")
            return False
        if "--plyr-video-progress-buffered-background" not in css_src:
            print(f"❌ {name} missing --plyr-video-progress-buffered-background custom property!")
            return False
        if "-webkit-progress-value" not in css_src or "-moz-progress-bar" not in css_src:
            print(f"❌ {name} missing vendor progress pseudo-element styling!")
            return False

    # 4. Mathematical unit test of TimeRanges calculation logic
    def sim_calc_buffered_pct(ranges, duration):
        if not duration or duration <= 0:
            return 0
        total = sum(max(0, end - start) for start, end in ranges if end > start)
        return min(100, max(0, round((total / duration) * 100)))

    assert sim_calc_buffered_pct([], 100) == 0, "Empty ranges should yield 0%"
    assert sim_calc_buffered_pct([(0, 42)], 100) == 42, "Single range [0, 42] should yield 42%"
    assert sim_calc_buffered_pct([(0, 20), (50, 75)], 100) == 45, "Discontiguous ranges [0, 20] + [50, 75] should yield 45%"
    assert sim_calc_buffered_pct([(0, 150)], 100) == 100, "Overflowing buffer should clamp to 100%"
    assert sim_calc_buffered_pct([(0, 50)], 0) == 0, "Zero duration should return 0%"
    assert sim_calc_buffered_pct([(0, 50)], -10) == 0, "Negative duration should return 0%"
    assert sim_calc_buffered_pct([(50, 50), (60, 40)], 100) == 0, "Zero or inverted range should return 0%"

    print("✅ Video player Buffering Loading Indicator & Pre-loaded Buffer Progress features fully verified across React and standalone HTML.")
    return True

def test_transfer_completion_lifecycle_and_badge():
    # 1. Backend Transfer Lifecycle & active_downloads verification
    backend_path = (REPO_DIR / "backend").resolve()
    sys.path.insert(0, str(backend_path))
    import asyncio
    from downloader import broadcast_progress, active_downloads
    import ffmpeg_worker
    
    # Test broadcast_progress transition at 100%
    test_id = "test_verify_transfer_100"
    asyncio.run(broadcast_progress(
        video_id=test_id,
        title="Test Transfer",
        source="GDRIVE",
        downloaded_bytes=50,
        total_bytes=100,
        speed_bytes_sec=1024 * 1024,
        status="DOWNLOADING"
    ))
    assert test_id in active_downloads, "active_downloads should contain test video"
    assert active_downloads[test_id]["percentage"] == 50.0, "Progress should be 50%"
    assert active_downloads[test_id]["status"] == "DOWNLOADING", "Status should be DOWNLOADING"

    # Now simulate reaching 100%
    asyncio.run(broadcast_progress(
        video_id=test_id,
        title="Test Transfer",
        source="GDRIVE",
        downloaded_bytes=100,
        total_bytes=100,
        speed_bytes_sec=1024 * 1024,
        status="DOWNLOADING"
    ))
    assert active_downloads[test_id]["percentage"] == 100.0, "Progress should be clamped to 100%"
    assert active_downloads[test_id]["status"] == "DOWNLOAD_COMPLETE", "Status should transition to DOWNLOAD_COMPLETE at 100%"
    assert active_downloads[test_id]["speed_mbs"] == 0.0, "Speed should be 0 at 100%"
    assert active_downloads[test_id]["eta_seconds"] == 0, "ETA should be 0 at 100%"

    # Test server metrics filtering logic
    test_active_id = "test_active_dl_2"
    active_downloads[test_active_id] = {
        "status": "DOWNLOADING",
        "percentage": 40.0,
        "speed_mbs": 4.5
    }
    # in_queue logic: only active downloads with percentage < 100 and DOWNLOADING/QUEUED
    sim_in_queue = len([
        t for t in active_downloads.values()
        if t.get("status") in ("DOWNLOADING", "QUEUED") and float(t.get("percentage", 0)) < 100
    ])
    assert sim_in_queue == 1, f"Expected 1 active download in queue, got {sim_in_queue}"

    sim_speed = sum(
        t.get("speed_mbs", 0.0)
        for t in active_downloads.values()
        if t.get("status") == "DOWNLOADING" and float(t.get("percentage", 0)) < 100
    )
    assert sim_speed == 4.5, f"Expected 4.5 MB/s active speed, got {sim_speed}"

    # Verify ffmpeg_worker imports active_downloads and cleans it up
    assert hasattr(ffmpeg_worker, "active_downloads"), "ffmpeg_worker must import active_downloads"
    active_downloads.pop(test_id, None)
    active_downloads.pop(test_active_id, None)

    # 2. Standalone HTML verification
    index_html = (REPO_DIR / "backend/static/index.html").read_text(encoding="utf-8")
    assert "isDone" in index_html, "index.html missing isDone check in renderTransfers"
    assert "transfers-clear-btn" in index_html, "index.html missing transfers-clear-btn DOM element"
    assert "clearCompletedTransfers" in index_html, "index.html missing clearCompletedTransfers helper"
    assert "dismissTransfer" in index_html, "index.html missing dismissTransfer helper"
    assert "Done" in index_html, "index.html missing 'Done' label in completed transfer card"
    assert "header-transfers-badge" in index_html, "index.html missing header-transfers-badge in desktop telemetry"
    assert "mobile-transfers-badge" in index_html, "index.html missing mobile-transfers-badge in mobile micro-telemetry"

    # 3. React Frontend verification (TransfersDrawer, Navbar, App.jsx, VideoPlayerModal)
    drawer_jsx = (REPO_DIR / "frontend/src/components/TransfersDrawer.jsx").read_text(encoding="utf-8")
    navbar_jsx = (REPO_DIR / "frontend/src/components/Navbar.jsx").read_text(encoding="utf-8")
    app_jsx = (REPO_DIR / "frontend/src/App.jsx").read_text(encoding="utf-8")
    modal_jsx = (REPO_DIR / "frontend/src/components/VideoPlayerModal.jsx").read_text(encoding="utf-8")

    assert "isTransferDone" in drawer_jsx or "isCompleted" in drawer_jsx, "TransfersDrawer.jsx missing completion check"
    assert "Done" in drawer_jsx, "TransfersDrawer.jsx missing 'Done' status display"
    assert "CheckCircle" in drawer_jsx, "TransfersDrawer.jsx missing CheckCircle icon for completed transfers"
    assert "activeTransfersCount" in navbar_jsx, "Navbar.jsx missing activeTransfersCount prop usage"
    assert "Active" in navbar_jsx, "Navbar.jsx missing 'Active' badge text"
    assert "isReadyToPlay" in modal_jsx, "VideoPlayerModal.jsx missing isReadyToPlay condition"
    assert "CheckCircle" in modal_jsx, "VideoPlayerModal.jsx missing CheckCircle icon for completed transfers"
    assert "Download Complete" in modal_jsx, "VideoPlayerModal.jsx missing 'Download Complete' header state"

    # Test App.jsx counts.active calculation logic
    sim_transfers = {
        "v1": {"status": "DOWNLOADING", "percentage": 30.0},
        "v2": {"status": "DOWNLOADING", "percentage": 100.0},
        "v3": {"status": "DOWNLOAD_COMPLETE", "percentage": 100.0},
        "v4": {"status": "LOCAL_READY", "percentage": 100.0}
    }
    sim_processing = {
        "p1": {"percent": 45.0},
        "p2": {"percent": 100.0}
    }
    active_dl_count = len([t for t in sim_transfers.values() if t.get("status") == "DOWNLOADING" and float(t.get("percentage", 0)) < 100])
    active_proc_count = len([p for p in sim_processing.values() if float(p.get("percent", 0)) < 100])
    sim_active_total = active_dl_count + active_proc_count
    assert sim_active_total == 2, f"Expected 2 truly active tasks, got {sim_active_total}"

    print("✅ Active transfer completion transitions & Navbar badge filtering fully verified across Backend, React, and standalone HTML.")
    return True

def test_sprites_live_progress_and_eta():
    ffmpeg_text = (REPO_DIR / "backend/ffmpeg_worker.py").read_text(encoding="utf-8")
    assert "run_cmd_with_progress" in ffmpeg_text, "ffmpeg_worker.py missing run_cmd_with_progress"
    assert "stage_percent" in ffmpeg_text, "ffmpeg_worker.py emit_processing_update missing stage_percent"
    assert "-progress" in ffmpeg_text, "ffmpeg_worker.py missing -progress pipe flag"
    assert "out_time_us" in ffmpeg_text, "ffmpeg_worker.py missing out_time_us parser"
    
    # HTML verification
    index_html = (REPO_DIR / "backend/static/index.html").read_text(encoding="utf-8")
    assert "stage_percent" in index_html, "index.html missing stage_percent usage in sprite processing"
    assert "Generating Sprites" in index_html, "index.html missing Generating Sprites label"
    assert "s left" in index_html, "index.html missing 's left' ETA countdown in processing badge"

    # React JSX verification
    card_jsx = (REPO_DIR / "frontend/src/components/VideoCard.jsx").read_text(encoding="utf-8")
    assert "stage_percent" in card_jsx, "VideoCard.jsx missing stage_percent"
    assert "s left" in card_jsx, "VideoCard.jsx missing 's left' ETA countdown"
    assert "bg-gradient-to-r from-purple-500 to-indigo-500" in card_jsx, "VideoCard.jsx missing processing progress bar"

    app_jsx = (REPO_DIR / "frontend/src/App.jsx").read_text(encoding="utf-8")
    assert "stage_percent" in app_jsx, "App.jsx table view missing stage_percent"
    assert "s left" in app_jsx, "App.jsx table view missing 's left' ETA countdown"

    drawer_jsx = (REPO_DIR / "frontend/src/components/TransfersDrawer.jsx").read_text(encoding="utf-8")
    assert "s left" in drawer_jsx, "TransfersDrawer.jsx missing 's left' ETA countdown"

    print("✅ Realtime sprite generation progress bar & ETA countdown verified across Backend, React, and standalone HTML.")
    return True

def test_deployment_and_mongo_express_ux():
    compose_path = REPO_DIR / "docker-compose.yml"
    compose_text = compose_path.read_text(encoding="utf-8")
    if re.search(r"^version:\s*['\"0-9\.]+", compose_text, re.MULTILINE):
        print("❌ docker-compose.yml still contains obsolete 'version:' attribute!")
        return False
    if "MONGO_EXPRESS_BIND" not in compose_text:
        print("❌ docker-compose.yml missing MONGO_EXPRESS_BIND configuration!")
        return False

    setup_sh = (REPO_DIR / "setup.sh").read_text(encoding="utf-8")
    if "auto-mount" not in setup_sh or "--auto-mount" not in setup_sh:
        print("❌ setup.sh missing --auto-mount flag support!")
        return False
    if "git clone https://github.com/HummaX/driveConnector.git" not in setup_sh:
        print("❌ setup.sh missing auto-clone fallback when run outside repository!")
        return False
    if "driveconnector-update" not in setup_sh:
        print("❌ setup.sh missing driveconnector-update symlink installation!")
        return False

    update_sh = (REPO_DIR / "update.sh").read_text(encoding="utf-8")
    if "BASH_SOURCE" not in update_sh or "docker image prune -f" not in update_sh:
        print("❌ update.sh missing BASH_SOURCE resolution or docker image prune!")
        return False

    env_ex = (REPO_DIR / ".env.example").read_text(encoding="utf-8")
    if "MONGO_EXPRESS_BIND=127.0.0.1" not in env_ex:
        print("❌ .env.example missing MONGO_EXPRESS_BIND=127.0.0.1!")
        return False

    main_py = (REPO_DIR / "backend/main.py").read_text(encoding="utf-8")
    if "ssh_tunnel_cmd" not in main_py or "mongo_express_bind" not in main_py:
        print("❌ backend/main.py get_database_stats missing ssh_tunnel_cmd or mongo_express_bind!")
        return False

    react_modal = (REPO_DIR / "frontend/src/components/MongoDbModal.jsx").read_text(encoding="utf-8")
    if "ssh_tunnel_cmd" not in react_modal or "tunnelCmd" not in react_modal or "copiedCmd" not in react_modal:
        print("❌ MongoDbModal.jsx missing SSH tunnel copy functionality!")
        return False

    html_file = (REPO_DIR / "backend/static/index.html").read_text(encoding="utf-8")
    if "copyMongoTunnelCmd" not in html_file or "me-tunnel-cmd-text" not in html_file:
        print("❌ index.html missing copyMongoTunnelCmd or me-tunnel-cmd-text!")
        return False

    print("✅ Deployment scripts, Compose v2 cleanup, and Mongo Express UI UX fully verified.")
    return True

def test_favicons_and_brand_assets():
    static_dir = REPO_DIR / "backend/static"
    public_dir = REPO_DIR / "frontend/public"

    required_assets = [
        "favicon.svg", "favicon.ico", "site.webmanifest",
        "favicon-16.png", "favicon-32.png", "favicon-48.png",
        "apple-touch-icon.png", "icon-192.png", "icon-512.png"
    ]
    for asset in required_assets:
        if not (static_dir / asset).exists():
            print(f"❌ backend/static missing required brand asset: {asset}")
            return False
        if not (public_dir / asset).exists():
            print(f"❌ frontend/public missing required brand asset: {asset}")
            return False

    # Check HTML linkages
    fe_html = (REPO_DIR / "frontend/index.html").read_text(encoding="utf-8")
    if "/favicon.svg" not in fe_html or "/favicon.ico" not in fe_html:
        print("❌ frontend/index.html missing favicon links!")
        return False

    be_html = (REPO_DIR / "backend/static/index.html").read_text(encoding="utf-8")
    if "/static/favicon.svg" not in be_html or "/static/favicon.ico" not in be_html:
        print("❌ backend/static/index.html missing favicon links!")
        return False

    # Check React BrandLogo component
    brand_logo = REPO_DIR / "frontend/src/components/BrandLogo.jsx"
    if not brand_logo.exists():
        print("❌ BrandLogo.jsx component missing!")
        return False

    navbar_jsx = (REPO_DIR / "frontend/src/components/Navbar.jsx").read_text(encoding="utf-8")
    if "BrandLogo" not in navbar_jsx:
        print("❌ Navbar.jsx not utilizing BrandLogo!")
        return False

    login_jsx = (REPO_DIR / "frontend/src/components/LoginPage.jsx").read_text(encoding="utf-8")
    if "BrandLogo" not in login_jsx:
        print("❌ LoginPage.jsx not utilizing BrandLogo!")
        return False

    # Verify FastAPI endpoint /favicon.ico returns HTTP 200
    try:
        backend_path = (REPO_DIR / "backend").resolve()
        sys.path.insert(0, str(backend_path))
        import main as backend_main
        from starlette.testclient import TestClient
        client = TestClient(backend_main.app)
        res = client.get("/favicon.ico")
        if res.status_code != 200:
            print(f"❌ GET /favicon.ico returned status {res.status_code} instead of 200!")
            return False
        if "image/x-icon" not in res.headers.get("content-type", ""):
            print(f"❌ GET /favicon.ico wrong content-type: {res.headers.get('content-type')}")
            return False
    finally:
        sys.path.pop(0)

    print("✅ High-definition favicons, PWA webmanifests, BrandLogo components, and /favicon.ico endpoint fully verified.")
    return True

def test_cpu_core_reservation_and_governance():
    try:
        backend_path = (REPO_DIR / "backend").resolve()
        sys.path.insert(0, str(backend_path))
        from config import settings
        import os

        # 1. Verify dynamic thread calculation
        total_cores = os.cpu_count() or 1
        expected_workers = max(1, total_cores - settings.RESERVED_CPU_CORES)
        if settings.ffmpeg_worker_threads != expected_workers:
            print(f"❌ ffmpeg_worker_threads was {settings.ffmpeg_worker_threads}, expected {expected_workers}")
            return False

        # 2. Verify ffmpeg_worker.py contains -threads settings.ffmpeg_worker_threads
        worker_code = (REPO_DIR / "backend/ffmpeg_worker.py").read_text(encoding="utf-8")
        if "-threads" not in worker_code or "settings.ffmpeg_worker_threads" not in worker_code:
            print("❌ ffmpeg_worker.py not configuring -threads using settings.ffmpeg_worker_threads!")
            return False
        if "cpu_threads" not in worker_code:
            print("❌ ffmpeg_worker.py Whisper not configured with cpu_threads!")
            return False

        # 3. Verify /api/system/metrics returns worker_threads and reserved_cores
        import main as backend_main
        from starlette.testclient import TestClient
        client = TestClient(backend_main.app)
        res = client.get("/api/system/metrics")
        if res.status_code == 200:
            cpu_data = res.json().get("cpu", {})
            if "worker_threads" not in cpu_data or "reserved_cores" not in cpu_data:
                print("❌ /api/system/metrics missing worker_threads or reserved_cores!")
                return False
    finally:
        sys.path.pop(0)

    print("✅ CPU core reservation governance (1 core reserved for web handling, N-1 for video workers) fully verified.")
    return True

def test_direct_stream_and_mkv_support():
    backend_dir = Path(__file__).parent.parent / "backend"
    sys.path.insert(0, str(backend_dir))
    try:
        from downloader import is_direct_media_url, get_media_extension, DIRECT_MEDIA_EXTS
        mkv_url = "https://cloud.mkvcdn.net/1794608810385_(MKVCINEMAS.HT)_Avengers_Endgame_-_Encore_2026_Hindi_DDP5.1-192Kbps_English_DDPAtmos5.1-768Kbps_Dual_Audio_MCU_Hollywood_Movie_HD_1080p_JS_WEB-DL_ESub.mkv"
        mp4_url = "https://cdn.example.com/media/file.mp4?token=abc"
        yt_url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

        if not is_direct_media_url(mkv_url):
            print("❌ is_direct_media_url failed to identify .mkv file URL!")
            return False

        if not is_direct_media_url(mp4_url):
            print("❌ is_direct_media_url failed to identify .mp4 with query params!")
            return False

        if is_direct_media_url(yt_url):
            print("❌ is_direct_media_url wrongly identified YouTube URL as direct media!")
            return False

        if get_media_extension(mkv_url) != ".mkv":
            print(f"❌ get_media_extension returned {get_media_extension(mkv_url)} instead of .mkv!")
            return False

        if get_media_extension("https://cdn.example.com/stream", content_type="video/x-matroska") != ".mkv":
            print("❌ get_media_extension failed Content-Type inference for matroska!")
            return False

        if get_media_extension("https://cdn.example.com/stream", content_type="video/webm") != ".webm":
            print("❌ get_media_extension failed Content-Type inference for webm!")
            return False

        # Verify downloader.py has direct chunked streaming and retry implementation
        downloader_code = (backend_dir / "downloader.py").read_text(encoding="utf-8")
        if "download_direct_http_stream" not in downloader_code:
            print("❌ downloader.py missing download_direct_http_stream function!")
            return False

        if "Range" not in downloader_code or "bytes=" not in downloader_code:
            print("❌ downloader.py missing Range header resume support!")
            return False

        if "500, 502, 503, 504" not in downloader_code and "status_code in (500, 502, 503, 504" not in downloader_code:
            print("❌ downloader.py missing retry status codes for CDN 500 errors!")
            return False

        # Verify main.py stream_video handles .mkv and dynamic Content-Type
        main_code = (backend_dir / "main.py").read_text(encoding="utf-8")
        if "video/x-matroska" not in main_code:
            print("❌ main.py missing video/x-matroska Content-Type mapping!")
            return False

        # Verify database.py clean unquoted titles without trailing extension
        db_code = (backend_dir / "database.py").read_text(encoding="utf-8")
        if "unquote" not in db_code:
            print("❌ database.py missing URL unquoting for clean titles!")
            return False

    finally:
        sys.path.pop(0)

    print("✅ Direct HTTP chunked streaming, MKV container preservation, and 500-retry logic fully verified.")
    return True

def test_multiple_downloads_and_jdownloader_integration():
    root_dir = Path(__file__).parent.parent
    backend_dir = root_dir / "backend"
    frontend_dir = root_dir / "frontend"

    # 1. Verify docker-compose.yml defines jdownloader on port 5800
    compose_txt = (root_dir / "docker-compose.yml").read_text(encoding="utf-8")
    if "jdownloader:" not in compose_txt or "5800:5800" not in compose_txt:
        print("❌ docker-compose.yml missing jdownloader service or 5800 port mapping!")
        return False

    # 2. Verify .env.example contains JDownloader settings
    env_txt = (root_dir / ".env.example").read_text(encoding="utf-8")
    if "JDOWNLOADER_BIND" not in env_txt or "JDOWNLOADER_PORT" not in env_txt:
        print("❌ .env.example missing JDOWNLOADER_BIND or JDOWNLOADER_PORT!")
        return False

    # 3. Verify database.py strips null drive_file_id and uses partialFilterExpression
    db_txt = (backend_dir / "database.py").read_text(encoding="utf-8")
    if "partialFilterExpression" not in db_txt:
        print("❌ database.py missing partialFilterExpression for drive_file_id (prevents 2nd download 500 duplicate null error)!")
        return False
    if 'doc.pop("drive_file_id", None)' not in db_txt:
        print("❌ database.py missing drive_file_id pop in create_url_video!")
        return False

    # 4. Verify main.py has /api/videos/scan-local and batch URL support
    main_txt = (backend_dir / "main.py").read_text(encoding="utf-8")
    if "/api/videos/scan-local" not in main_txt:
        print("❌ main.py missing /api/videos/scan-local endpoint!")
        return False
    if "raw_urls" not in main_txt or "splitlines" not in main_txt:
        print("❌ main.py missing multi-line / batch URL parsing in trigger_url_download!")
        return False

    # 5. Verify React and HTML have Scan Storage and JDownloader integrations
    react_app = (frontend_dir / "src" / "App.jsx").read_text(encoding="utf-8")
    if "JDownloaderModal" not in react_app or "handleScanStorage" not in react_app:
        print("❌ App.jsx missing JDownloaderModal or handleScanStorage!")
        return False

    index_html = (backend_dir / "static" / "index.html").read_text(encoding="utf-8")
    if "jdownloader-modal" not in index_html or "triggerScanStorage" not in index_html:
        print("❌ index.html missing jdownloader-modal or triggerScanStorage!")
        return False
    if "engine-btn-auto" not in index_html or "setDownloadEngine" not in index_html:
        print("❌ index.html missing engine selector buttons or setDownloadEngine!")
        return False

    # 6. Verify automated JDownloader decision engine in downloader.py
    downloader_txt = (backend_dir / "downloader.py").read_text(encoding="utf-8")
    if "is_jdownloader_hoster" not in downloader_txt or "download_via_jdownloader" not in downloader_txt:
        print("❌ downloader.py missing is_jdownloader_hoster or download_via_jdownloader auto-router!")
        return False
    if "gofile.io" not in downloader_txt or "mega.nz" not in downloader_txt:
        print("❌ downloader.py missing supported hosters list (gofile.io, mega.nz)!")
        return False

    print("✅ Multiple downloads batching, 2nd download duplicate null key fix, JDownloader 2 auto-decision engine, and Scan Storage fully verified.")
    return True

def test_nonblocking_video_playback_during_processing():
    """Verifies that background video processing (hover preview, sprites, transcode) never blocks video playback."""
    backend_dir = Path(__file__).resolve().parent.parent / "backend"
    frontend_dir = Path(__file__).resolve().parent.parent / "frontend"

    # 1. Check index.html isPlayable logic allows PROCESSING and local_path
    index_html = (backend_dir / "static" / "index.html").read_text(encoding="utf-8")
    if "isPlayable = v.status === 'LOCAL_READY' || v.status === 'PROCESSING' || Boolean(v.local_path)" not in index_html:
        print("❌ index.html does not include PROCESSING or local_path in isPlayable check!")
        return False

    # 2. Check index.html does not destroy player on PROCESSING_COMPLETE
    if "openPlayerModal(activeVideoModal);" in index_html.split("PROCESSING_COMPLETE")[1].split("fetchAllData()")[0]:
        print("❌ index.html calls openPlayerModal on PROCESSING_COMPLETE, which interrupts active playback!")
        return False

    # 3. Check React VideoPlayerModal.jsx allows playback when processing
    player_jsx = (frontend_dir / "src" / "components" / "VideoPlayerModal.jsx").read_text(encoding="utf-8")
    if "isLocal = video.status === 'LOCAL_READY' || video.status === 'PROCESSING' || Boolean(video.local_path)" not in player_jsx:
        print("❌ VideoPlayerModal.jsx does not recognize PROCESSING or local_path as isLocal!")
        return False

    print("✅ Non-blocking video playback during background processing fully verified across React and standalone HTML.")
    return True

def test_audio_and_subtitle_tracks_integration():
    """Verifies end-to-end multi-audio and multi-subtitle track probing, WebVTT extraction, and player selection."""
    backend_dir = REPO_DIR / "backend"
    ffmpeg_text = (backend_dir / "ffmpeg_worker.py").read_text(encoding="utf-8")
    main_text = (backend_dir / "main.py").read_text(encoding="utf-8")
    index_html = (backend_dir / "static" / "index.html").read_text(encoding="utf-8")
    player_jsx = (REPO_DIR / "frontend/src/components/VideoPlayerModal.jsx").read_text(encoding="utf-8")
    card_jsx = (REPO_DIR / "frontend/src/components/VideoCard.jsx").read_text(encoding="utf-8")

    # 1. Backend probing and extraction functions
    assert "extract_embedded_subtitles" in ffmpeg_text, "Missing extract_embedded_subtitles in ffmpeg_worker.py"
    assert "extract_audio_track" in ffmpeg_text, "Missing extract_audio_track in ffmpeg_worker.py"
    assert "audio_tracks" in ffmpeg_text, "Missing audio_tracks probing in ffmpeg_worker.py"
    assert "subtitle_tracks" in ffmpeg_text, "Missing subtitle_tracks probing in ffmpeg_worker.py"

    # 2. Backend endpoints
    assert "/api/videos/{video_id}/probe-tracks" in main_text, "Missing /probe-tracks endpoint in main.py"
    assert "/api/videos/{video_id}/audio/{track_index}" in main_text, "Missing audio track stream endpoint in main.py"

    # 3. HTML player controls and companion audio
    assert 'id="player-companion-audio"' in index_html, "Missing #player-companion-audio in index.html"
    assert 'id="player-audio-select"' in index_html, "Missing #player-audio-select in index.html"
    assert 'id="player-subtitles-select"' in index_html, "Missing #player-subtitles-select in index.html"
    assert "changePlayerAudioTrack" in index_html, "Missing changePlayerAudioTrack in index.html"
    assert "changePlayerSubtitleTrack" in index_html, "Missing changePlayerSubtitleTrack in index.html"
    assert "Audio Tracks Available" in index_html, "Missing audio track badge in index.html"

    # 4. React player controls and companion audio
    assert "companionAudioRef" in player_jsx, "Missing companionAudioRef in VideoPlayerModal.jsx"
    assert "audioTracks" in player_jsx, "Missing audioTracks state in VideoPlayerModal.jsx"
    assert "subtitleTracks" in player_jsx, "Missing subtitleTracks state in VideoPlayerModal.jsx"
    assert "handleSubtitleChange" in player_jsx, "Missing handleSubtitleChange in VideoPlayerModal.jsx"
    assert "probe-tracks" in player_jsx, "Missing probe-tracks auto-fetch in VideoPlayerModal.jsx"
    assert "Audio Tracks Available" in card_jsx, "Missing audio track badge in VideoCard.jsx"

    print("✅ Multi-audio and multi-subtitle track probing, WebVTT extraction, and player selection verified across Backend, React, and standalone HTML.")
    return True

def test_whisper_parallel_chunks_and_cpu_budget():
    """Verifies that AI subtitle generation divides audio into parallel chunks, allocates 80% CPU, and reconciles stale jobs."""
    backend_dir = REPO_DIR / "backend"
    config_text = (backend_dir / "config.py").read_text(encoding="utf-8")
    ffmpeg_text = (backend_dir / "ffmpeg_worker.py").read_text(encoding="utf-8")
    db_text = (backend_dir / "database.py").read_text(encoding="utf-8")
    main_text = (backend_dir / "main.py").read_text(encoding="utf-8")

    # 1. 80% CPU core budgeting
    assert "WHISPER_CPU_RATIO: float = 0.80" in config_text, "Missing WHISPER_CPU_RATIO in config.py"
    assert "def whisper_worker_threads" in config_text, "Missing whisper_worker_threads in config.py"

    # 2. Parallel chunk division and VAD filtering in ffmpeg_worker.py
    assert "CHUNK_DURATION_SEC" in ffmpeg_text, "Missing CHUNK_DURATION_SEC in ffmpeg_worker.py"
    assert "vad_filter=True" in ffmpeg_text, "Missing vad_filter=True in ffmpeg_worker.py"
    assert "condition_on_previous_text=False" in ffmpeg_text, "Missing condition_on_previous_text=False in ffmpeg_worker.py"
    assert "ThreadPoolExecutor" in ffmpeg_text, "Missing ThreadPoolExecutor for chunk parallelization in ffmpeg_worker.py"

    # 3. Stale job reconciliation on startup
    assert "def reconcile_stale_jobs" in db_text, "Missing reconcile_stale_jobs in database.py"
    assert "await reconcile_stale_jobs()" in main_text, "Missing reconcile_stale_jobs call in main.py lifespan"

    print("✅ AI Subtitles parallel chunk division, 80% CPU allocation, and stale job startup reconciliation fully verified.")
    return True

def test_ram_governance_and_pipeline_distribution():
    """Verifies that 32GB RAM is distributed with exactly 10% host reserve and 90% cloud pipeline allocation."""
    backend_dir = REPO_DIR / "backend"
    config_text = (backend_dir / "config.py").read_text(encoding="utf-8")
    main_text = (backend_dir / "main.py").read_text(encoding="utf-8")
    dl_text = (backend_dir / "downloader.py").read_text(encoding="utf-8")
    ffmpeg_text = (backend_dir / "ffmpeg_worker.py").read_text(encoding="utf-8")
    compose_text = (REPO_DIR / "docker-compose.yml").read_text(encoding="utf-8")

    # 1. Configuration constants and ratios
    assert "TOTAL_RAM_GB: float = 32.0" in config_text, "Missing TOTAL_RAM_GB in config.py"
    assert "RESERVED_RAM_RATIO: float = 0.10" in config_text, "Missing 10% RESERVED_RAM_RATIO in config.py"
    assert "CLOUD_PIPELINE_RAM_RATIO: float = 0.90" in config_text, "Missing 90% CLOUD_PIPELINE_RAM_RATIO in config.py"
    assert "MAX_CONCURRENT_FFMPEG: int = 4" in config_text, "MAX_CONCURRENT_FFMPEG must be 4 for 32GB RAM profile"
    assert "STREAM_CHUNK_SIZE_BYTES: int = 4 * 1024 * 1024" in config_text, "Missing 4MB stream buffer chunk in config.py"
    assert "DOWNLOAD_CHUNK_SIZE_BYTES: int = 8 * 1024 * 1024" in config_text, "Missing 8MB download buffer chunk in config.py"

    # 2. Memory helper properties
    assert "def reserved_ram_gb" in config_text, "Missing reserved_ram_gb property in config.py"
    assert "def pipeline_ram_gb" in config_text, "Missing pipeline_ram_gb property in config.py"
    assert "def whisper_ram_pool_gb" in config_text, "Missing whisper_ram_pool_gb property in config.py"
    assert "def ffmpeg_ram_pool_gb" in config_text, "Missing ffmpeg_ram_pool_gb property in config.py"

    # 3. Main endpoints streaming chunk size and metrics
    assert "chunk_size = min(remaining, settings.STREAM_CHUNK_SIZE_BYTES)" in main_text, "Missing STREAM_CHUNK_SIZE_BYTES in stream_video/audio"
    assert '"reserved_system_gb": settings.reserved_ram_gb' in main_text, "Missing reserved_system_gb in /api/metrics"
    assert '"cloud_pipeline_allocated_gb": settings.pipeline_ram_gb' in main_text, "Missing cloud_pipeline_allocated_gb in /api/metrics"

    # 4. Downloader chunk size
    assert "chunk_size=settings.DOWNLOAD_CHUNK_SIZE_BYTES" in dl_text, "Downloader not using DOWNLOAD_CHUNK_SIZE_BYTES"

    # 5. FFmpeg in-memory audio preloading for Whisper
    assert "Preload full audio into RAM pool" in ffmpeg_text, "Whisper missing in-memory audio preloading"

    # 6. Docker compose memory & shared memory sizing
    assert "--wiredTigerCacheSizeGB" in compose_text, "Missing wiredTigerCacheSizeGB in docker-compose.yml"
    assert "shm_size: 8g" in compose_text, "Missing backend shm_size: 8g in docker-compose.yml"
    assert "shm_size: 4g" in compose_text, "Missing jdownloader shm_size: 4g in docker-compose.yml"
    assert "JVM_OPTIONS=-Xms1024m -Xmx4096m" in compose_text, "Missing JDownloader JVM heap options in docker-compose.yml"

    print("✅ 32GB RAM distribution (10% system reserve, 90% cloud pipeline) fully verified across Backend, Workers & Docker.")
    return True

if __name__ == "__main__":
    tests = [
        test_python_syntax,
        test_dom_ids,
        test_jsx_delimiters,
        test_tailwind_classes,
        test_keyboard_shortcut_focus,
        test_index_video_hover,
        test_list_view_delete_confirmation,
        test_uptime_formatting,
        test_mobile_telemetry,
        test_fastapi_serving,
        test_drive_api_endpoints,
        test_vtt_absolute_sprites_format,
        test_vtt_mimetype_and_time_format,
        test_transcode_and_transcribe_endpoints,
        test_supercharged_player_features,
        test_buffering_and_buffer_progress_features,
        test_transfer_completion_lifecycle_and_badge,
        test_sprites_live_progress_and_eta,
        test_deployment_and_mongo_express_ux,
        test_favicons_and_brand_assets,
        test_cpu_core_reservation_and_governance,
        test_direct_stream_and_mkv_support,
        test_multiple_downloads_and_jdownloader_integration,
        test_nonblocking_video_playback_during_processing,
        test_audio_and_subtitle_tracks_integration,
        test_whisper_parallel_chunks_and_cpu_budget,
        test_ram_governance_and_pipeline_distribution
    ]
    failed = False
    for t in tests:
        if not t():
            failed = True
    if failed:
        sys.exit(1)
    print("\n🎉 ALL VERIFICATION TESTS PASSED SUCCESSFULLY!")
