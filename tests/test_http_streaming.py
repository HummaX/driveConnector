"""Exercise the production streaming response and generator without app startup.

The exact helper AST is loaded from main.py so MongoDB, OAuth, and storage
initialization are not imported or mocked as successes by these HTTP tests.
"""
import ast
import importlib.util
from pathlib import Path
import tempfile
import types
import unittest

from fastapi import FastAPI, HTTPException, Request, Response, status
from fastapi.responses import StreamingResponse
from starlette.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("range_helpers", ROOT / "backend/streaming.py")
ranges = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ranges)


def load_helper():
    source = ast.parse((ROOT / "backend/main.py").read_text(encoding="utf-8"))
    helper = next(n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == "stream_local_file")
    scope = {"Path": Path, "Request": Request, "Response": Response,
             "HTTPException": HTTPException, "status": status,
             "StreamingResponse": StreamingResponse,
             "select_byte_range": ranges.select_byte_range,
             "UnsatisfiableRange": ranges.UnsatisfiableRange,
             "STREAM_BURST_CHUNK_SIZE_BYTES": 16,
             "settings": types.SimpleNamespace(STREAM_CHUNK_SIZE_BYTES=3)}
    exec(compile(ast.Module(body=[helper], type_ignores=[]), "main.stream_local_file", "exec"), scope)
    return scope["stream_local_file"]


class HttpStreamingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dc-http-fixture-")
        self.path = Path(self.tmp.name) / "synthetic.mp4"
        self.data = bytes(range(50))
        self.path.write_bytes(self.data)
        helper = load_helper()
        app = FastAPI()

        @app.api_route("/media", methods=["GET", "HEAD"])
        async def media(request: Request):
            return helper(self.path, request, "video/mp4")

        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

    def test_full_generator_private_response(self):
        result = self.client.get("/media")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.content, self.data)
        self.assertEqual(result.headers["content-length"], "50")
        self.assertEqual(result.headers["cache-control"], "private, no-store")

    def test_exact_and_open_ranges_execute_generator(self):
        for header, expected, content_range in (
            ("bytes=3-8", self.data[3:9], "bytes 3-8/50"),
            ("bytes=4-", self.data[4:20], "bytes 4-19/50"),
            ("bytes=45-999", self.data[45:], "bytes 45-49/50"),
        ):
            with self.subTest(header=header):
                result = self.client.get("/media", headers={"Range": header})
                self.assertEqual(result.status_code, 206)
                self.assertEqual(result.content, expected)
                self.assertEqual(result.headers["content-range"], content_range)
                self.assertEqual(int(result.headers["content-length"]), len(expected))

    def test_capped_suffix_still_reaches_eof(self):
        result = self.client.get("/media", headers={"Range": "bytes=-30"})
        self.assertEqual(result.content, self.data[-16:])
        self.assertEqual(result.headers["content-range"], "bytes 34-49/50")

    def test_head_ignores_range_and_never_reads_file(self):
        result = self.client.head("/media", headers={"Range": "bytes=3-8"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.content, b"")
        self.assertEqual(result.headers["content-length"], "50")
        self.assertNotIn("content-range", result.headers)

    def test_rejected_ranges_always_advertise_resource_size(self):
        for header in ("bytes=50-", "bytes=-0", "bytes=9-2", "bytes=1-2,4-5", "bytes=1-2junk"):
            with self.subTest(header=header):
                result = self.client.get("/media", headers={"Range": header})
                self.assertEqual(result.status_code, 416)
                self.assertEqual(result.headers["content-range"], "bytes */50")

    def test_empty_full_response_and_range(self):
        self.path.write_bytes(b"")
        self.assertEqual(self.client.get("/media").content, b"")
        result = self.client.get("/media", headers={"Range": "bytes=0-"})
        self.assertEqual(result.status_code, 416)
        self.assertEqual(result.headers["content-range"], "bytes */0")


if __name__ == "__main__":
    unittest.main()
