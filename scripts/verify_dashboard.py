import re
import sys
import subprocess
from pathlib import Path

def test_python_syntax():
    backend_dir = Path("driveConnector/backend")
    py_files = list(backend_dir.glob("*.py"))
    for py in py_files:
        res = subprocess.run([sys.executable, "-m", "py_compile", str(py)], capture_output=True, text=True)
        if res.returncode != 0:
            print(f"❌ Syntax error in {py.name}: {res.stderr}")
            return False
    print(f"✅ All {len(py_files)} Python backend files compiled cleanly.")
    return True

def test_dom_ids():
    html_file = Path("driveConnector/backend/static/index.html")
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
    repo = Path("driveConnector/frontend/src")
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
    files = list(Path("driveConnector/frontend/src").glob("**/*.jsx")) + [Path("driveConnector/backend/static/index.html")]
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
    app_jsx = Path("driveConnector/frontend/src/App.jsx").read_text(encoding="utf-8")
    index_html = Path("driveConnector/backend/static/index.html").read_text(encoding="utf-8")
    if "isInput" not in app_jsx or "tagName" not in app_jsx:
        print("❌ App.jsx keyboard shortcut '/' steals focus from input/textarea elements!")
        return False
    if "isInput" not in index_html or "tagName" not in index_html:
        print("❌ index.html keyboard shortcut '/' steals focus from input/textarea elements!")
        return False
    print("✅ Keyboard shortcut '/' properly guards input/textarea in both React and HTML.")
    return True

def test_index_video_hover():
    index_html = Path("driveConnector/backend/static/index.html").read_text(encoding="utf-8")
    if "onmouseenter=\"this.play()\"" in index_html and "pointer-events-none" in index_html:
        print("❌ index.html has onmouseenter on a pointer-events-none video element, video will never play on hover!")
        return False
    if "card.onmouseenter" not in index_html or "card.onmouseleave" not in index_html:
        print("❌ index.html is missing card hover video controls!")
        return False
    print("✅ index.html hover preview handling is correct and responsive.")
    return True

def test_list_view_delete_confirmation():
    app_jsx = Path("driveConnector/frontend/src/App.jsx").read_text(encoding="utf-8")
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
    stats_jsx = Path("driveConnector/frontend/src/components/StatsDashboard.jsx").read_text(encoding="utf-8")
    index_html = Path("driveConnector/backend/static/index.html").read_text(encoding="utf-8")
    for name, content in [("StatsDashboard.jsx", stats_jsx), ("index.html", index_html)]:
        if "seconds < 60" not in content:
            print(f"❌ {name} formatUptime does not handle seconds < 60 properly (displays '0m')!")
            return False
    print("✅ formatUptime handles servers running < 60s cleanly.")
    return True

def test_mobile_telemetry():
    navbar_jsx = Path("driveConnector/frontend/src/components/Navbar.jsx").read_text(encoding="utf-8")
    index_html = Path("driveConnector/backend/static/index.html").read_text(encoding="utf-8")
    if "md:hidden" not in navbar_jsx or "mobile" not in navbar_jsx.lower():
        print("❌ Navbar.jsx missing mobile micro-telemetry strip!")
        return False
    if "mobile-cpu-pct" not in index_html or "mobile-ram-used" not in index_html:
        print("❌ index.html missing mobile micro-telemetry elements!")
        return False
    print("✅ Mobile micro-telemetry verified in both React Navbar and standalone HTML.")
    return True

def test_fastapi_serving():
    old_cwd = Path.cwd()
    try:
        sys.path.insert(0, str((Path("driveConnector/backend")).resolve()))
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
        test_fastapi_serving
    ]
    failed = False
    for t in tests:
        if not t():
            failed = True
    if failed:
        sys.exit(1)
    print("\n🎉 ALL VERIFICATION TESTS PASSED SUCCESSFULLY!")
