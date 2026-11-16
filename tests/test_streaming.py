"""Regression tests for byte-range selection without filesystem or network access."""

import importlib.util
from pathlib import Path
import unittest


MODULE = Path(__file__).resolve().parents[1] / "backend" / "streaming.py"
spec = importlib.util.spec_from_file_location("driveconnector_streaming", MODULE)
streaming = importlib.util.module_from_spec(spec)
spec.loader.exec_module(streaming)


class SelectByteRangeTests(unittest.TestCase):
    def test_no_range_and_empty_resource(self):
        self.assertIsNone(streaming.select_byte_range(None, 0, 16))
        with self.assertRaises(streaming.UnsatisfiableRange):
            streaming.select_byte_range("bytes=0-", 0, 16)

    def test_bounded_open_and_clamped_ranges(self):
        self.assertEqual(streaming.select_byte_range("bytes=3-8", 50, 16), (3, 8))
        self.assertEqual(streaming.select_byte_range("bytes=3-", 50, 16), (3, 18))
        self.assertEqual(streaming.select_byte_range("bytes=45-999", 50, 16), (45, 49))
        self.assertEqual(streaming.select_byte_range("BYTES=0-99", 100, 16), (0, 15))

    def test_suffix_includes_end_even_when_larger_than_limit(self):
        self.assertEqual(streaming.select_byte_range("bytes=-4", 50, 16), (46, 49))
        self.assertEqual(streaming.select_byte_range("bytes=-30", 50, 16), (34, 49))
        self.assertEqual(streaming.select_byte_range("bytes=-500", 10, 16), (0, 9))

    def test_invalid_or_unsatisfiable_values(self):
        for header in ("", "items=1-2", "bytes=-", "bytes=-0", "bytes=9-2",
                       "bytes=50-", "bytes=0-1,3-4", "bytes=0-1garbage",
                       "bytes=" + "9" * 130 + "-"):
            with self.subTest(header=header):
                with self.assertRaises(streaming.UnsatisfiableRange):
                    streaming.select_byte_range(header, 50, 16)

    def test_invalid_server_parameters_are_not_range_errors(self):
        for size, limit in ((-1, 16), (10, 0), (10, -1)):
            with self.subTest(size=size, limit=limit):
                with self.assertRaises(ValueError):
                    streaming.select_byte_range(None, size, limit)


if __name__ == "__main__":
    unittest.main()
