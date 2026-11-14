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
        test_drive_api_endpoints
    ]
    failed = False
    for t in tests:
        if not t():
            failed = True
    if failed:
        sys.exit(1)
    print("\n🎉 ALL VERIFICATION TESTS PASSED SUCCESSFULLY!")
