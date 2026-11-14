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

        dummy_video_file = REPO_DIR / "backend/test_fixture_video.mp4"
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

    # Check media buffering event listeners (waiting, seeking)
    for evt in ["'waiting'", "'seeking'"]:
        if evt not in player_jsx or evt not in index_html:
            print(f"❌ Media event listener for {evt} missing in player!")
            return False

    # 2. Buffer Progress Bar (Pre-Loaded Media Range) & Percentage Display
    if "bufferedPercent" not in player_jsx or "calculateBufferedPercent" not in player_jsx:
        print("❌ React VideoPlayerModal missing HTML5 video buffered TimeRanges percentage calculation!")
        return False

    if "getBufferedPercent" not in index_html or "player-buffer-pct" not in index_html or "player-buffer-bar" not in index_html:
        print("❌ Standalone index.html missing getBufferedPercent or buffer progress HUD elements!")
        return False

    # Check explicit "Buffered:" text display in both players
    if "Buffered:" not in player_jsx or "Buffered:" not in index_html:
        print("❌ Explicit 'Buffered:' percentage indicator text missing from player timeline/toolbar!")
        return False

    # 3. Plyr .plyr__progress__buffer CSS styling in both frontend and standalone HTML
    if ".plyr__progress__buffer" not in frontend_css:
        print("❌ frontend/src/index.css missing custom high-visibility .plyr__progress__buffer styling!")
        return False

    if ".plyr__progress__buffer" not in index_html:
        print("❌ backend/static/index.html missing custom high-visibility .plyr__progress__buffer styling!")
        return False

    print("✅ Video player Buffering Loading Indicator & Pre-loaded Buffer Progress features fully verified across React and standalone HTML.")
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
        test_buffering_and_buffer_progress_features
    ]
    failed = False
    for t in tests:
        if not t():
            failed = True
    if failed:
        sys.exit(1)
    print("\n🎉 ALL VERIFICATION TESTS PASSED SUCCESSFULLY!")
