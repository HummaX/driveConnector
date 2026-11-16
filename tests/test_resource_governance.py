"""Synthetic cgroup fixtures only; never reads or changes the host hierarchy."""
import tempfile
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import resource_governance as rg


class ResourceGovernanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.mount = Path(self.temp.name) / "mount"
        self.mount.mkdir()
        self.parent = self.mount / "parent"
        self.parent.mkdir()
        self.group = self.parent / "media"
        self.group.mkdir()
        self.child = self.group / "worker"
        self.child.mkdir()
        self.write(self.parent, "cpu.max", "150000 100000")
        self.write(self.parent, "memory.max", "7000")
        self.write(self.group, "cpu.max", "200000 100000")
        self.write(self.group, "memory.max", "9000")
        self.write(self.group, "cgroup.type", "domain")
        self.write(self.group, "cgroup.procs", "22\n")
        self.write(self.group, "cpuset.cpus.effective", "0-3")
        self.write(self.child, "cgroup.procs", "11\n")
        self.mount_patch = patch.object(rg, "_mount_for", return_value=self.mount)
        self.mount_patch.start()
        self.addCleanup(self.mount_patch.stop)

    @staticmethod
    def write(path, name, content):
        (path / name).write_text(content, encoding="ascii")

    def assess(self, **kwargs):
        args = dict(group=str(self.group), worker_pids=[11], jdownloader_init_pid=22,
                    max_cpu_cores=2, max_memory_bytes=9000)
        args.update(kwargs)
        return rg.assess_admission(**args)

    def test_tighter_ancestors_reported_but_strict_denied(self):
        result = self.assess()
        self.assertTrue(result.supported)
        self.assertFalse(result.admission_allowed)
        self.assertFalse(result.enforcement_active)
        self.assertEqual(result.effective_cpu_cores, 1.5)
        self.assertEqual(result.effective_memory_bytes, 7000)
        self.assertEqual(result.cpuset_cpus_effective, "0-3")
        self.assertEqual(result.checked_pids, (11, 22))
        self.assertIn("coverage is unverified", result.reason)

    def test_non_strict_explicitly_allows_without_claiming_enforcement(self):
        result = self.assess(strict=False)
        self.assertTrue(result.admission_allowed)
        self.assertFalse(result.enforcement_active)

    def test_missing_anchor_fails_closed(self):
        result = self.assess(jdownloader_init_pid=23)
        self.assertFalse(result.supported)
        self.assertFalse(result.admission_allowed)
        self.assertIn("outside", result.reason)

    def test_unlimited_shared_group_fails_even_if_ancestor_bounded(self):
        self.write(self.group, "memory.max", "max")
        self.assertFalse(self.assess().admission_allowed)
        self.assertIn("finite", self.assess().reason)

    def test_unlimited_cpu_fails(self):
        self.write(self.group, "cpu.max", "max 100000")
        self.assertFalse(self.assess().supported)

    def test_missing_control_file_fails(self):
        (self.parent / "cpu.max").unlink()
        self.assertFalse(self.assess().supported)
        self.assertFalse(self.assess().admission_allowed)

    def test_invalid_caps_and_missing_workers_fail(self):
        for values in ({"worker_pids": []}, {"max_cpu_cores": float("nan")},
                       {"max_memory_bytes": 0}, {"max_cpu_cores": 1},
                       {"max_memory_bytes": 6999}, {"jdownloader_init_pid": 11}):
            with self.subTest(values=values):
                self.assertFalse(self.assess(**values).admission_allowed)

    def test_threaded_group_fails(self):
        self.write(self.group, "cgroup.type", "threaded")
        self.assertFalse(self.assess().supported)

    def test_invalid_procs_fails(self):
        self.write(self.child, "cgroup.procs", "11\nnot-a-pid")
        self.assertFalse(self.assess().supported)

    def test_unknown_platform_fails_closed(self):
        with patch.object(rg, "_mount_for", side_effect=rg.GovernanceError("unsupported")):
            self.assertFalse(self.assess().admission_allowed)
            self.assertFalse(self.assess().enforcement_active)
            self.assertTrue(self.assess(strict=False).admission_allowed)

    def test_proc_parsers(self):
        self.assertEqual(rg._cpu_limit("100000 100000"), 1.0)
        self.assertIsNone(rg._cpu_limit("max 100000"))
        self.assertIsNone(rg._memory_limit("max"))
        for value in ("max 0", "0 100000", "bogus", "1 -2"):
            with self.subTest(value=value), self.assertRaises(rg.GovernanceError):
                rg._cpu_limit(value)


if __name__ == "__main__":
    unittest.main()
