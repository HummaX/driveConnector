"""Run legacy and unit contracts in an offline, disposable source snapshot.

Usage: python -I tests/run_isolated_verifier.py [--baseline HEAD]
No real dotenv, credential, storage, server, Docker or cgroup provisioning is used.
Only tracked sources and explicitly named new modules/tests are copied. The
original scripts/verify_dashboard.py is copied byte-for-byte and never rewritten.
A synthetic Mongo persistence adapter is supplied through database.db/get_db;
application handlers and enqueue_job are never replaced. This is not a MongoDB
integration test or an OS security sandbox.

Browser, stderr-child and Bash deployment fixtures are reported as skipped in
this process-denying envelope; run their audited synthetic suites separately.
The timeout regression may launch only its exact isolated Python sleep fixture.
Backend compilation and the reviewed stdlib prepare_environment helper may
launch isolated Python children; no other external subprocess is permitted.
Artifacts and SHA256 manifests stay in a fresh temp dir.
"""
import argparse
import ast
import tempfile
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

SOURCE = Path(__file__).resolve().parents[1]
BASE = None
SNAPSHOT = None
TESTS = (
    'test_auth_security.py', 'test_streaming.py', 'test_http_streaming.py', 'test_metadata_paths.py', 'test_resource_governance.py',
    'test_media_jobs.py', 'test_deployment_helper.py', 'test_frontend_contract.py',
)
NEW = ('backend/job_events.py', 'tests/memory_mongo.py', 'scripts/deploy_claude.sh', 'backend/job_queue.py', 'backend/media_worker.py', 'backend/resource_governance.py',
       'backend/streaming.py', 'scripts/prepare_environment.py',
       'tests/run_isolated_verifier.py', 'tests/deployment_fixture_launcher.py') + tuple('tests/' + name for name in TESTS)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def supervisor(baseline):
    global BASE, SNAPSHOT
    BASE = Path(tempfile.mkdtemp(prefix='dc-isolated-verifier-')).resolve()
    SNAPSHOT = BASE / 'snapshot'
    if SNAPSHOT.exists():
        raise RuntimeError('Snapshot must be new and empty')
    SNAPSHOT.mkdir()
    tracked = subprocess.check_output(['git', '-C', str(SOURCE), 'ls-files', '-z']).decode().split('\0')
    paths = sorted(set(filter(None, tracked)) | set(NEW))
    manifest = {'head': subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD']).decode().strip(),
                'baseline': baseline, 'started': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
                'files': {}, 'copy_races': [], 'source': str(SOURCE)}
    for rel in paths:
        name = Path(rel).name.lower()
        if name == '.env' or (name.startswith('.env.') and name != '.env.example') or name in ('credentials.json', 'token.json'):
            raise RuntimeError('Disallowed snapshot file: ' + rel)
        src = SOURCE / rel
        if src.is_symlink() or not src.is_file():
            raise RuntimeError('Not a regular allowlisted source: ' + rel)
        data = src.read_bytes()
        dst = SNAPSHOT / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
        manifest['files'][rel] = digest(data)
        if digest(src.read_bytes()) != digest(data):
            manifest['copy_races'].append(rel)
    verifier = SNAPSHOT / 'scripts/verify_dashboard.py'
    original = subprocess.check_output(['git', '-C', str(SOURCE), 'show', baseline + ':scripts/verify_dashboard.py'])
    manifest['verifier_matches_baseline'] = verifier.read_bytes().replace(b'\r\n', b'\n') == original.replace(b'\r\n', b'\n')
    (BASE / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print('SNAPSHOT', SNAPSHOT, flush=True)
    print('VERIFIER_SHA256', manifest['files']['scripts/verify_dashboard.py'], flush=True)
    tree = ast.parse(verifier.read_text(encoding='utf-8'))
    functions = [node.name for node in tree.body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')]
    htmls = {}
    baseline_ids = {}
    for rel in ('backend/static/index.html', 'frontend/index.html'):
        import re
        html = (SNAPSHOT / rel).read_text(encoding='utf-8')
        ids = set(re.findall(r'''\bid=["']([^"']+)["']''', html))
        refs = set(re.findall(r'''getElementById\(["']([^"']+)["']\)''', html))
        old = subprocess.check_output(['git', '-C', str(SOURCE), 'show', baseline + ':' + rel]).decode('utf-8')
        oldids = set(re.findall(r'''\bid=["']([^"']+)["']''', old))
        baseline_ids[rel] = oldids
        htmls[rel] = {'ids': sorted(ids), 'missing_referenced_ids': sorted(refs - ids),
                      'baseline_removed_ids': sorted(oldids - ids), 'new_ids': sorted(ids - oldids)}
    same = (SNAPSHOT / 'backend/static/index.html').read_bytes() == (SNAPSHOT / 'frontend/index.html').read_bytes()
    frontids = set(htmls['frontend/index.html']['ids'])
    backids = set(htmls['backend/static/index.html']['ids'])
    union = baseline_ids['frontend/index.html'] | baseline_ids['backend/static/index.html']
    contracts = {'entrypoints_identical': same, 'frontend_only_ids': sorted(frontids - backids),
                 'backend_only_ids': sorted(backids - frontids),
                 'baseline_union_ids_absent_both': sorted(union - frontids - backids), 'htmls': htmls}
    (BASE / 'frontend_analysis.json').write_text(json.dumps(contracts, indent=2), encoding='utf-8')
    results = []
    targets = [('original-full', 'full')] + [(name, 'unittest:' + name) for name in TESTS]
    original_reached = set()
    for index, (label, target) in enumerate(targets):
        run = BASE / ('fixture-%02d' % index)
        run.mkdir()
        command = [sys.executable, '-I', str(SNAPSHOT / 'tests/run_isolated_verifier.py'),
                   '--child', str(SOURCE), str(SNAPSHOT), str(run), target]
        started = time.monotonic()
        print('RUN', label, flush=True)
        try:
            res = subprocess.run(command, cwd=BASE, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=100)
            text = res.stdout + res.stderr
            code = res.returncode
        except subprocess.TimeoutExpired as exc:
            text = ((exc.stdout or b'').decode('utf-8', errors='replace') if isinstance(exc.stdout, bytes) else exc.stdout or '')
            text += '\nHARNESS_TIMEOUT 100 seconds\n'
            code = 'timeout'
        (BASE / (label + '.log')).write_text(text, encoding='utf-8')
        result = {'label': label, 'target': target, 'returncode': code, 'seconds': round(time.monotonic()-started, 3),
                  'log': str(BASE / (label + '.log'))}
        results.append(result)
        if target == 'full':
            import re
            original_reached.update(re.findall(r'^SUITE_RESULT (test_\w+) ', text, re.MULTILINE))
            # The original runner aborts on uncaught assertions. Run only tests
            # it did not reach, each in a fresh process without changing them.
            targets.extend((name, 'original:' + name) for name in functions if name not in original_reached)
        (BASE / 'results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
        print('RESULT', label, code, result['seconds'], flush=True)
        for line in text.splitlines():
            if any(token in line for token in ('SUITE_RESULT', 'TEST_PROGRESS', 'Ran ', 'FAILED ', 'OK', 'ERROR:', 'FAIL:', 'VERIFIER_EXIT', 'GUARD_BLOCK', 'CHILD_EXCEPTION', 'HARNESS_TIMEOUT')):
                print(' ', line, flush=True)
    changed = []
    for rel, before in manifest['files'].items():
        current = SOURCE / rel
        after = digest(current.read_bytes()) if current.is_file() else None
        if after != before:
            changed.append({'path': rel, 'snapshot': before, 'current': after})
    manifest['source_changes_during_run'] = changed
    manifest['finished'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    (BASE / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print('SOURCE_CHANGES', json.dumps(changed), flush=True)
    print('COMPLETE', len(results), flush=True)
    print('ARTIFACTS', BASE, flush=True)
    return 1 if any(result['returncode'] != 0 for result in results) else 0


def child(source, root, run, target):
    import runpy
    import socket
    import traceback
    import threading
    global SOURCE, BASE
    SOURCE = Path(source).resolve()
    root, run = Path(root).resolve(), Path(run).resolve()
    BASE = root.parent
    os.chdir(run)
    keep = {k: os.environ[k] for k in ('SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC') if k in os.environ}
    os.environ.clear()
    os.environ.update(keep)
    os.environ.update({
        'STORAGE_DIR': str(run / 'storage'), 'HOME': str(run), 'USERPROFILE': str(run),
        'TEMP': str(run), 'TMP': str(run), 'GOOGLE_API_KEY': '', 'GOOGLE_DRIVE_FOLDER_ID': '',
        'GOOGLE_CREDENTIALS_FILE': str(run / 'absent-synthetic-credentials'),
        'GOOGLE_TOKEN_FILE': str(run / 'absent-synthetic-token'),
        'GOOGLE_APPLICATION_CREDENTIALS': str(run / 'absent-synthetic-adc'),
        'MONGODB_URL': 'mongodb://127.0.0.1:1/isolated?serverSelectionTimeoutMS=50&connectTimeoutMS=50',
        'DATABASE_NAME': 'synthetic_fixture_only', 'JWT_SECRET_KEY': 'synthetic-testing-key-not-real-at-least-32-characters',
        'ADMIN_USERNAME': 'synthetic-user', 'ADMIN_DEFAULT_PASSWORD': 'synthetic-private-fixture-password',
        'MONGO_EXPRESS_PASS': 'synthetic-private-fixture-password', 'PYTHONIOENCODING': 'utf-8',
        'PYTHONPYCACHEPREFIX': str(run / 'cache'),
    })
    sys.pycache_prefix = str(run / 'cache')
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    sys.path[:0] = [str(root / 'backend'), str(root), str(root / 'tests')]
    def socketpair_context():
        frame = sys._getframe(1)
        while frame:
            if frame.f_code.co_name in ('socketpair', '_fallback_socketpair') and frame.f_code.co_filename == socket.__file__:
                return True
            frame = frame.f_back
        return False
    def audit(event, args):
        if event in ('socket.connect', 'socket.bind', 'socket.sendto', 'socket.getaddrinfo',
                     'socket.gethostbyname', 'socket.gethostbyname_ex', 'socket.gethostbyaddr'):
            if event in ('socket.connect', 'socket.bind') and socketpair_context():
                return
            print('GUARD_BLOCK', event, flush=True)
            raise OSError('Network/DNS blocked by isolated harness')
        if event in ('os.system', 'os.startfile', 'os.spawn', 'os.exec', 'os.posix_spawn'):
            raise RuntimeError('External process blocked by isolated harness')
        mutations = {'os.remove': 1, 'os.rmdir': 1, 'os.mkdir': 1,
                     'os.rename': 2, 'os.link': 2, 'os.symlink': 2, 'os.chmod': 1}
        if event in mutations:
            for value in args[:mutations[event]]:
                if not isinstance(value, (str, bytes, os.PathLike)):
                    raise RuntimeError('Unresolved filesystem mutation blocked')
                if not Path(os.fsdecode(value)).resolve().is_relative_to(BASE):
                    raise RuntimeError('Filesystem mutation outside temporary fixture blocked')
        if event == 'open' and isinstance(args[0], (str, bytes, os.PathLike)):
            path = Path(os.fsdecode(args[0])).resolve()
            if path.is_relative_to(SOURCE):
                raise RuntimeError('Real checkout access blocked during test execution')
            if path.name in ('.env', 'credentials.json', 'token.json') and not path.is_relative_to(BASE):
                raise RuntimeError('Real credential/configuration access blocked')
            mode, flags = args[1], args[2]
            writing = bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)) if isinstance(flags, int) else False
            if isinstance(mode, str):
                writing = writing or any(c in mode for c in 'wax+')
            if writing and not path.is_relative_to(BASE):
                raise RuntimeError('Write outside temporary fixture blocked: ' + str(path))
    sys.addaudithook(audit)
    def blocked(*args, **kwargs):
        raise OSError('Network/DNS blocked by isolated harness')
    socket.getaddrinfo = blocked
    socket.gethostbyname = blocked
    socket.gethostbyname_ex = blocked
    socket.gethostbyaddr = blocked
    # asyncio on Windows legitimately creates a private local socketpair.
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    def connect(sock, address):
        if socketpair_context():
            return original_connect(sock, address)
        return blocked()
    def connect_ex(sock, address):
        if socketpair_context():
            return original_connect_ex(sock, address)
        return blocked()
    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex
    socket.create_connection = blocked
    import platform
    platform._syscmd_ver = lambda *a, **k: ('Windows', '11', '10.0.26300')
    original_popen = subprocess.Popen
    helper_hash = digest((root / 'scripts/prepare_environment.py').read_bytes())
    synthetic_code = {'import time; time.sleep(30)'}
    def allowed(command):
        if not isinstance(command, (list, tuple)) or not command:
            return False
        if Path(command[0]).resolve() != Path(sys.executable).resolve():
            return False
        args = list(command[1:])
        if args[:1] == ['-I']:
            args = args[1:]
        if len(args) == 3 and args[:2] == ['-m', 'py_compile']:
            return Path(args[2]).resolve().is_relative_to(root / 'backend')
        if len(args) == 2 and args[0] == '-c':
            return target == 'unittest:test_media_jobs.py' and args[1] in synthetic_code
        if len(args) >= 3 and args[1] in ('init', 'validate', 'storage') and target == 'unittest:test_deployment_helper.py':
            path = Path(args[0]).resolve()
            return path.is_relative_to(run) and path.name == 'prepare_environment.py' and digest(path.read_bytes()) == helper_hash
        return False
    class GuardedPopen(original_popen):
        def __init__(self, args, *a, **k):
            if k.get('shell') or not allowed(args):
                print('GUARD_BLOCK external_subprocess', str(args)[:350], flush=True)
                raise RuntimeError('External subprocess blocked by isolated harness')
            args = list(args)
            if args[1:2] != ['-I']:
                args.insert(1, '-I')
            super().__init__(args, *a, **k)
    subprocess.Popen = GuardedPopen
    verifier = str(root / 'scripts/verify_dashboard.py')
    calls = {}
    def trace(frame, event, arg):
        if frame.f_code.co_filename == verifier and frame.f_code.co_name.startswith('test_'):
            name = frame.f_code.co_name
            if event == 'call':
                print('TEST_START', name, flush=True)
            elif event == 'line':
                calls[name] = frame.f_lineno
            elif event == 'exception':
                exc, value, tb = arg
                if exc not in (StopIteration, GeneratorExit):
                    print('TEST_EXCEPTION', name, frame.f_lineno, exc.__name__, str(value), flush=True)
            elif event == 'return':
                print('SUITE_RESULT', name, repr(arg), 'last_line', calls.get(name), flush=True)
        return trace
    sys.settrace(trace)
    threading.settrace(trace)
    code = 0
    persistence = None
    if target == 'full' or target.startswith('original:'):
        persistence = install()
    try:
        if target == 'full':
            runpy.run_path(verifier, run_name='__main__')
        elif target.startswith('original:'):
            name = target.split(':', 1)[1]
            namespace = runpy.run_path(verifier, run_name='isolated_original_verifier')
            code = 0 if namespace[name]() is True else 1
        elif target.startswith('unittest:'):
            import unittest
            name = target.split(':', 1)[1]
            suite = unittest.defaultTestLoader.discover(str(root / 'tests'), pattern=name)
            denied = {
                'test_bookmark_engine_and_paused_quality_in_browser': 'External Chrome launch not permitted; not retried',
                'test_ffmpeg_stderr_is_drained': 'Previously denied stderr subprocess not retried; remains unverified',
            }
            def mark_denied(node):
                if isinstance(node, unittest.TestSuite):
                    for item in node:
                        mark_denied(item)
                elif type(node).__name__ in ('DeploymentIntegrationTests', 'DeploymentFixtureIntegrationTests'):
                    method = getattr(type(node), node._testMethodName)
                    method.__unittest_skip__ = True
                    method.__unittest_skip_why__ = 'Bash fixture integration is run separately outside the network/process-denying envelope'
                elif getattr(node, '_testMethodName', '') in denied:
                    method = getattr(type(node), node._testMethodName)
                    method.__unittest_skip__ = True
                    method.__unittest_skip_why__ = denied[node._testMethodName]
            mark_denied(suite)
            result = unittest.TextTestRunner(verbosity=2).run(suite)
            code = 0 if result.wasSuccessful() else 1
        else:
            raise ValueError(target)
    except SystemExit as exc:
        code = int(exc.code or 0)
        print('VERIFIER_EXIT', code, flush=True)
    except BaseException:
        code = 2
        print('CHILD_EXCEPTION', flush=True)
        traceback.print_exc()
    finally:
        sys.settrace(None)
        threading.settrace(None)
        print('TEST_PROGRESS', json.dumps(calls, sort_keys=True), flush=True)
        if persistence is not None:
            print('PERSISTENCE', json.dumps(persistence.report(), default=str), flush=True)
    raise SystemExit(code)

def install():
    import asyncio
    import database
    import job_queue
    from memory_mongo import MemoryDatabase
    fake = MemoryDatabase()
    database.db = fake
    asyncio.run(job_queue.init_queue())
    return fake


if __name__ == '__main__':
    if not sys.flags.isolated:
        raise SystemExit('Run this harness with python -I')
    if sys.argv[1:2] == ['--child']:
        child(*sys.argv[2:])
    else:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('--baseline', default='HEAD')
        arguments = parser.parse_args()
        raise SystemExit(supervisor(arguments.baseline))
