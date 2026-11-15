#!/usr/bin/env python3
"""Run offline checks for the canonical frontend and media primitives.

Full live-stack tests (Docker, MongoDB, Google Drive and browsers) must additionally
be run in a suitably provisioned environment; this runner does not claim otherwise.
"""
import shutil
import subprocess
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
commands = [
    [sys.executable, '-m', 'unittest', 'discover', '-s', str(ROOT/'tests'), '-p', 'test_*.py', '-v'],
    ['node', '--check', str(ROOT/'frontend/js/app.js')],
    ['node', '--check', str(ROOT/'frontend/js/login.js')],
    ['node', str(ROOT/'tests/test_frontend.cjs')],
    ['bash', '-n', str(ROOT/'setup.sh')],
    ['bash', '-n', str(ROOT/'update.sh')],
]
for command in commands:
    if not shutil.which(command[0]):
        print(f'Missing required test tool: {command[0]}', file=sys.stderr)
        raise SystemExit(2)
    print('\n+', ' '.join(command), flush=True)
    result = subprocess.run(command, cwd=ROOT)
    if result.returncode:
        raise SystemExit(result.returncode)
print('\nOffline checks passed. Live integration and load tests were NOT run.', flush=True)
