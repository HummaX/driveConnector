"""Read-only cgroup v2 diagnostics and a conservative media admission gate.

This module does not create cgroups, move processes, or discover all media work.
Run it in the host PID and cgroup namespaces. See docs/resource-governance.md.
"""
from dataclasses import dataclass
from pathlib import Path
import os
import re
from typing import Optional, Sequence, Tuple


@dataclass(frozen=True)
class GovernanceStatus:
    supported: bool
    admission_allowed: bool
    enforcement_active: bool
    reason: str
    group: str
    effective_cpu_cores: Optional[float] = None
    effective_memory_bytes: Optional[int] = None
    cpuset_cpus_effective: Optional[str] = None
    checked_pids: Tuple[int, ...] = ()


class GovernanceError(ValueError):
    """The cgroup cannot be inspected or is unsuitable for strict admission."""


def _cpu_limit(text: str) -> Optional[float]:
    parts = text.split()
    if len(parts) != 2 or not parts[1].isdigit() or int(parts[1]) <= 0:
        raise GovernanceError("invalid cpu.max")
    if parts[0] == "max":
        return None
    if not parts[0].isdigit() or int(parts[0]) <= 0:
        raise GovernanceError("invalid cpu.max")
    return int(parts[0]) / int(parts[1])


def _memory_limit(text: str) -> Optional[int]:
    text = text.strip()
    if text == "max":
        return None
    if not text.isdigit() or int(text) <= 0:
        raise GovernanceError("invalid memory.max")
    return int(text)


def _unescape_mount(value: str) -> str:
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), value)


def _mount_for(group: Path) -> Path:
    if os.name != "posix" or not Path("/proc/self/mountinfo").is_file():
        raise GovernanceError("Linux cgroup v2 mount information unavailable")
    candidates = []
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        before, sep, after = line.partition(" - ")
        fields = before.split()
        if not sep or not after.startswith("cgroup2 ") or len(fields) < 5:
            continue
        mount = Path(_unescape_mount(fields[4])).resolve()
        if group == mount or mount in group.parents:
            candidates.append(mount)
    if not candidates:
        raise GovernanceError("group is not on a visible cgroup v2 mount")
    return max(candidates, key=lambda p: len(p.parts))


def _inspect_tree(group: Path, mount: Path, pids: Sequence[int]):
    """Inspect a located hierarchy; separated for synthetic tests."""
    group, mount = group.resolve(strict=True), mount.resolve(strict=True)
    if group == mount or mount not in group.parents:
        raise GovernanceError("a non-root cgroup under the mount is required")
    if (group / "cgroup.type").read_text().strip() != "domain":
        raise GovernanceError("media group must be a domain cgroup")
    cpus, memories = [], []
    current = group
    while current != mount:
        cpu = _cpu_limit((current / "cpu.max").read_text())
        memory = _memory_limit((current / "memory.max").read_text())
        if current == group and (cpu is None or memory is None):
            raise GovernanceError("shared media group must have finite cpu.max and memory.max")
        if cpu is not None:
            cpus.append(cpu)
        if memory is not None:
            memories.append(memory)
        current = current.parent
    members = set()
    def walk_error(error):
        raise error
    for directory, dirs, _ in os.walk(group, followlinks=False, onerror=walk_error):
        dirs[:] = [d for d in dirs if not (Path(directory) / d).is_symlink()]
        for pid in (Path(directory) / "cgroup.procs").read_text().split():
            if not pid.isdigit() or int(pid) <= 0:
                raise GovernanceError("invalid cgroup.procs")
            members.add(int(pid))
    if not set(pids).issubset(members):
        raise GovernanceError("required process anchors are outside the shared media group")
    cpuset_file = group / "cpuset.cpus.effective"
    cpuset = cpuset_file.read_text().strip() if cpuset_file.exists() else None
    return min(cpus), min(memories), cpuset


def assess_admission(group: str, worker_pids: Sequence[int], jdownloader_init_pid: int,
                     max_cpu_cores: float, max_memory_bytes: int, *, strict: bool = True) -> GovernanceStatus:
    """Inspect caps and host PID anchors; fail strict admission without coverage.

    The application has not yet implemented authoritative workload discovery or
    an isolated media launcher. Consequently this function cannot establish that
    the anchors cover all media work and strict admission remains denied even if
    the named PIDs and limits check out. Non-strict admission is explicitly
    ungoverned and is never reported as enforcement_active.
    """
    try:
        import math
        if not math.isfinite(max_cpu_cores) or max_cpu_cores <= 0 or isinstance(max_memory_bytes, bool) or not isinstance(max_memory_bytes, int) or max_memory_bytes <= 0:
            raise GovernanceError("positive finite expected CPU and integer memory caps are required")
        if not worker_pids:
            raise GovernanceError("at least one media worker anchor is required")
        pids = tuple(worker_pids) + (jdownloader_init_pid,)
        if any(isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0 for pid in pids):
            raise GovernanceError("host PID anchors must be positive integers")
        if jdownloader_init_pid in worker_pids:
            raise GovernanceError("JDownloader and media worker anchors must differ")
        path = Path(group).resolve(strict=True)
        mount = _mount_for(path)
        cpu, memory, cpuset = _inspect_tree(path, mount, pids)
        if cpu > max_cpu_cores or memory > max_memory_bytes:
            raise GovernanceError("effective limits exceed the requested caps")
        return GovernanceStatus(True, not strict, False,
            "named anchors and limits verified; complete workload coverage is unverified",
            str(path), cpu, memory, cpuset, pids)
    except (OSError, ValueError, TypeError, OverflowError) as exc:
        return GovernanceStatus(False, not strict, False, str(exc), str(group))
