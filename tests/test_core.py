"""Offline regression tests. Live service tests are deliberately not faked as passes."""
import ast
import math
import subprocess
import asyncio
import importlib.util
import os
import re
import shutil
import sys
import tempfile
import time
import types
import unittest
from html.parser import HTMLParser
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from range_http import parse_byte_range, RangeNotSatisfiable, MultipleRanges

class RangeTests(unittest.TestCase):
    def test_explicit_range_is_not_truncated(self):
        r = parse_byte_range('bytes=10-70', 100, 16)
        self.assertEqual((r.start, r.end, r.length), (10, 70, 61))
    def test_open_ended_range_honors_burst(self):
        r = parse_byte_range('bytes=10-', 100, 16)
        self.assertEqual((r.start, r.end), (10, 25))
    def test_suffix_includes_actual_end_even_over_burst(self):
        r = parse_byte_range('bytes=-32', 100, 16)
        self.assertEqual((r.start, r.end), (68, 99))
    def test_suffix_larger_than_file(self):
        r = parse_byte_range('bytes=-200', 100, 16)
        self.assertEqual((r.start, r.end), (0, 99))
    def test_end_is_clamped_to_size(self):
        self.assertEqual(parse_byte_range('bytes=90-999', 100).end, 99)
    def test_bad_and_unsatisfiable_ranges(self):
        for header, size in [('bytes=100-',100),('bytes=-0',100),('bytes=8-7',100),('bytes=-',100),('items=0-1',100),('bytes=0-',0),('bytes=0-1junk',100)]:
            with self.subTest(header=header), self.assertRaises(RangeNotSatisfiable): parse_byte_range(header,size,16)
    def test_multiple_ranges_are_explicitly_ignored(self):
        with self.assertRaises(MultipleRanges): parse_byte_range('bytes=0-2,4-6', 100)

class FakeHTTPException(Exception):
    def __init__(self, status_code, detail, headers=None):
        super().__init__(detail); self.status_code=status_code; self.headers=headers or {}
class FakeResponse:
    def __init__(self, body=None, status_code=200, headers=None):
        self.body=body; self.status_code=status_code; self.headers=headers or {}

def extract_defs(file, names, namespace):
    tree=ast.parse(file.read_text(encoding='utf8'))
    defs=[node for node in tree.body if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)) and node.name in names]
    if len(defs)!=len(names): raise AssertionError(f'Missing extracted functions: {names}')
    future=ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0)
    module=ast.fix_missing_locations(ast.Module(body=[future,*defs],type_ignores=[]))
    exec(compile(module,str(file),'exec'),namespace)
    return namespace

class StreamingResponseTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.path=Path(self.tmp.name)/'video.mp4'; self.path.write_bytes(bytes(range(100)))
        env={'parse_byte_range':parse_byte_range,'RangeNotSatisfiable':RangeNotSatisfiable,'MultipleRanges':MultipleRanges,'settings':SimpleNamespace(STREAM_BURST_CHUNK_SIZE_BYTES=16,STREAM_CHUNK_SIZE_BYTES=7),'HTTPException':FakeHTTPException,'Response':FakeResponse,'StreamingResponse':FakeResponse}
        self.make=extract_defs(ROOT/'backend/main.py',{'make_media_response'},env)['make_media_response']
    def tearDown(self): self.tmp.cleanup()
    def request(self, range_value=None, method='GET'):
        headers={} if range_value is None else {'range':range_value}
        return self.make(self.path, SimpleNamespace(headers=headers,method=method),'video/mp4')
    def test_actual_suffix_response(self):
        r=self.request('bytes=-32'); self.assertEqual(r.status_code,206); self.assertEqual(r.headers['Content-Range'],'bytes 68-99/100'); self.assertEqual(b''.join(r.body),bytes(range(68,100)))
    def test_actual_open_ended_burst(self):
        r=self.request('bytes=10-'); self.assertEqual(r.headers['Content-Length'],'16'); self.assertEqual(b''.join(r.body),bytes(range(10,26)))
    def test_explicit_range_not_capped(self):
        r=self.request('bytes=10-70'); self.assertEqual(len(b''.join(r.body)),61)
    def test_multiple_ranges_get_full_200(self):
        r=self.request('bytes=0-1,4-5'); self.assertEqual(r.status_code,200); self.assertEqual(len(b''.join(r.body)),100)
    def test_416_reports_file_size(self):
        with self.assertRaises(FakeHTTPException) as e: self.request('bytes=100-')
        self.assertEqual(e.exception.headers['Content-Range'],'bytes */100')
    def test_head_has_headers_but_no_body(self):
        r=self.request('bytes=0-2','HEAD'); self.assertEqual(r.status_code,206); self.assertIsNone(r.body); self.assertEqual(r.headers['Content-Length'],'3')
    def test_private_cache(self): self.assertIn('private', self.request().headers['Cache-Control'])

class AsyncWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_unknown_total_does_not_complete(self):
        messages=[]
        class Manager:
            async def broadcast(self,item): messages.append(item)
        ns={'active_downloads':{},'manager':Manager()}
        extract_defs(ROOT/'backend/downloader.py',{'broadcast_progress','format_bytes'},ns)
        await ns['broadcast_progress']('x','Title','Direct',100,0,20,'DOWNLOADING')
        self.assertEqual(messages[-1]['status'],'DOWNLOADING'); self.assertEqual(messages[-1]['percentage'],0.0)
    async def test_final_bytes_do_not_imply_finalized_file(self):
        messages=[]
        class Manager:
            async def broadcast(self,item): messages.append(item)
        ns={'active_downloads':{},'manager':Manager()}
        extract_defs(ROOT/'backend/downloader.py',{'broadcast_progress','format_bytes'},ns)
        await ns['broadcast_progress']('x','Title','Direct',100,100,20,'DOWNLOADING')
        self.assertEqual(messages[-1]['status'],'DOWNLOADING'); self.assertLess(messages[-1]['percentage'],100)
        await ns['broadcast_progress']('x','Title','Direct',100,100,0,'DOWNLOAD_COMPLETE')
        self.assertEqual(messages[-1]['percentage'],100)
    @unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg is not installed')
    async def test_real_ffmpeg_generates_sprite_and_vtt(self):
        async def emit_processing_update(**kwargs): pass
        ns={'asyncio':asyncio,'time':time,'math':math,'emit_processing_update':emit_processing_update,
            'settings':SimpleNamespace(ffmpeg_worker_threads=1)}
        extract_defs(ROOT/'backend/ffmpeg_worker.py',{'run_cmd_with_progress','format_vtt_time','generate_vtt_sprites'},ns)
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); video=root/'sample.mp4'
            result=subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','color=c=blue:s=160x90:r=2:d=10','-c:v','mpeg4',str(video)],capture_output=True,text=True,timeout=20)
            self.assertEqual(result.returncode,0,result.stderr)
            await asyncio.wait_for(ns['generate_vtt_sprites']('sample',video,root,10.0),timeout=20)
            self.assertTrue((root/'sprites.jpg').is_file())
            cues=(root/'thumbnails.vtt').read_text()
            self.assertIn('WEBVTT',cues); self.assertIn('/metadata/sample/sprites.jpg#xywh=0,0,160,90',cues)

    async def test_worker_drains_full_stderr_without_deadlock(self):
        async def emit_processing_update(**kwargs): pass
        ns={'asyncio':asyncio,'time':time,'emit_processing_update':emit_processing_update}
        func=extract_defs(ROOT/'backend/ffmpeg_worker.py',{'run_cmd_with_progress'},ns)['run_cmd_with_progress']
        script="import sys; sys.stderr.write('x'*300000); sys.stderr.flush(); print('out_time_us=1000',flush=True)"
        code,out,err=await asyncio.wait_for(func([sys.executable,'-c',script],1,5,'x','TEST','test'),timeout=6)
        self.assertEqual(code,0); self.assertTrue(err); self.assertLessEqual(len(err),65536)

class DownloaderIsolationTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_jobs_cannot_claim_each_others_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); video_dir = root / 'videos'; video_dir.mkdir()
            records = {'one': {'title': 'First'}, 'two': {'title': 'Second'}}
            async def get_video(vid): return records[vid]
            async def update_video(vid, data): records[vid].update(data)
            async def progress(**kwargs): pass
            async def process(_vid): pass
            waiting = 0; ready = asyncio.Event()
            async def mocked_sleep(_seconds):
                nonlocal waiting
                if not ready.is_set():
                    waiting += 1
                    if waiting == 2:
                        for vid in ('one', 'two'):
                            target = video_dir / '.jobs' / vid / 'result.mp4'
                            target.parent.mkdir(parents=True, exist_ok=True)
                            target.write_bytes(b'media-data')
                        ready.set()
                    await ready.wait()
                await asyncio.sleep(0)
            shim = SimpleNamespace(sleep=mocked_sleep, create_task=asyncio.create_task)
            ns = {'settings': SimpleNamespace(STORAGE_DIR=str(root), videos_dir=video_dir), 'get_video': get_video,
                  'update_video': update_video, 'broadcast_progress': progress, 'urlparse': __import__('urllib.parse',fromlist=['urlparse']).urlparse,
                  'unquote': __import__('urllib.parse',fromlist=['unquote']).unquote, 'Path':Path, 'os':SimpleNamespace(chown=lambda *args: None, chmod=os.chmod, getuid=lambda: 1000, remove=os.remove), 'time':time,
                  'shutil':shutil, 'tempfile':tempfile, 'DIRECT_MEDIA_EXTS':{'.mp4'}, 'active_downloads':{}, 'asyncio':shim}
            fn = extract_defs(ROOT/'backend/downloader.py', {'download_via_jdownloader'}, ns)['download_via_jdownloader']
            original = sys.modules.get('ffmpeg_worker')
            sys.modules['ffmpeg_worker'] = SimpleNamespace(process_video_background=process)
            try:
                await asyncio.wait_for(asyncio.gather(fn('one','https://example.invalid/first'), fn('two','https://example.invalid/second')), 5)
                self.assertNotEqual(records['one']['local_path'], records['two']['local_path'])
                self.assertEqual(Path(records['one']['local_path']).name, 'one.mp4')
                self.assertEqual(Path(records['two']['local_path']).name, 'two.mp4')
            finally:
                if original is None: sys.modules.pop('ffmpeg_worker', None)
                else: sys.modules['ffmpeg_worker'] = original

    async def test_transcode_will_not_replace_original(self):
        fn=extract_defs(ROOT/'backend/ffmpeg_worker.py',{'transcode_video'},{})['transcode_video']
        with self.assertRaises(ValueError): await fn('one','720p',True)

class HTMLIds(HTMLParser):
    def __init__(self): super().__init__(); self.ids=[]
    def handle_starttag(self,tag,attrs):
        for key,val in attrs:
            if key=='id': self.ids.append(val)

class CanonicalFrontendTests(unittest.TestCase):
    def test_all_backend_sources_compile(self):
        for source in (ROOT/'backend').glob('*.py'):
            with self.subTest(source=source.name): compile(source.read_bytes(), str(source), 'exec')
    def test_script_id_references_exist(self):
        parser=HTMLIds();parser.feed((ROOT/'frontend/index.html').read_text(encoding='utf8'))
        self.assertEqual(len(parser.ids), len(set(parser.ids)), 'Duplicate IDs in canonical frontend')
        js=(ROOT/'frontend/js/app.js').read_text(encoding='utf8')
        references=set(re.findall(r"\$\(['\"]([a-zA-Z0-9_-]+)['\"]\)",js))
        self.assertFalse(references-set(parser.ids), f'Missing IDs: {references-set(parser.ids)}')
    def test_no_dynamic_inner_html(self):
        js=(ROOT/'frontend/js/app.js').read_text(encoding='utf8')
        self.assertNotIn('.innerHTML',js); self.assertNotIn('insertAdjacentHTML',js)
    def test_single_ui_source(self):
        main=(ROOT/'backend/main.py').read_text(encoding='utf8')
        self.assertNotIn('backend/static/index.html', main)
        self.assertFalse((ROOT/'backend/static/index.html').exists())
        self.assertFalse((ROOT/'frontend/src').exists())
    def test_safety_basics_and_auth_assets(self):
        main=(ROOT/'backend/main.py').read_text(encoding='utf8')
        self.assertIn('Depends(get_current_user_flexible)',main)
        self.assertIn('@app.get("/metadata/{video_id}/{filename}")',main)
        self.assertNotIn('app.mount("/metadata"',main)
        self.assertIn('httponly=True',main)
        self.assertIn('if payload.replace_original:',main)
    def test_no_destructive_installer_or_update(self):
        for file in ['setup.sh','update.sh']:
            text=(ROOT/file).read_text(encoding='utf8')
            for dangerous in ('mkfs.', 'wipefs ', 'git reset --hard'):
                self.assertNotIn(dangerous,text)

if __name__ == '__main__': unittest.main(verbosity=2)
