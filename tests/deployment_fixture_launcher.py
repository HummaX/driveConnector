"""Test-only bridge from a Windows Python helper to a synthetic Git driver.

No production tools run here. Git inspection calls are routed to the fixture's
reviewed driver rather than Windows trying to execute an extensionless Bash shim.
"""
import os
import runpy
import subprocess
import sys

original_run = subprocess.run

def fixture_run(command, *args, **kwargs):
    if isinstance(command, (list, tuple)) and command and command[0] == 'git':
        command = [sys.executable, '-I', os.environ['DC_DRIVER_SCRIPT'], 'git', *command[1:]]
    return original_run(command, *args, **kwargs)

subprocess.run = fixture_run
arguments = sys.argv[1:]
if arguments[:1] == ['-I']:
    arguments.pop(0)
script = arguments.pop(0)
sys.argv = [script, *arguments]
runpy.run_path(script, run_name='__main__')
