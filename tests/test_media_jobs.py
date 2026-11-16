"""Isolated unit tests for media jobs; no network or real storage required."""
import asyncio
import contextvars
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

# Execute these tests only against a scratch copy of the backend. Stub config
# and persistence so importing the modules cannot contact external services.
tmp = tempfile.TemporaryDirectory()
storage = Path(tmp.name)
settings = types.SimpleNamespace(STORAGE_DIR=str(storage), videos_dir=storage,
                                 MAX_CONCURRENT_FFMPEG=2,
                                 DOWNLOAD_CHUNK_SIZE_BYTES=4096)
config = types.ModuleType('config')
config.settings = settings
sys.modules['config'] = config
database = types.ModuleType('database')
database.get_video = AsyncMock(return_value=None)
database.update_video = AsyncMock()
database.get_db = lambda: None
sys.modules['database'] = database
sys.modules['drive_catalog'] = types.ModuleType('drive_catalog')

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / 'backend'), str(Path(__file__).resolve().parent)]
from memory_mongo import MemoryDatabase
import job_queue
import job_events
import downloader
import ffmpeg_worker
import media_worker


class MediaTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db = MemoryDatabase()
        self.db_patch = patch.object(job_queue, 'get_db', return_value=self.db)
        self.db_patch.start()
        self.addCleanup(self.db_patch.stop)
        await job_queue.init_queue()

    async def test_progress_requires_finalization(self):
        with patch.object(downloader.manager, 'broadcast', new_callable=AsyncMock):
            await downloader.broadcast_progress('v', 'title', 'source', 10, 10, 100,
                                                transfer_verified=False)
        self.assertNotEqual(downloader.active_downloads['v']['status'], 'DOWNLOAD_COMPLETE')
        downloader.active_downloads.pop('v', None)

    async def test_legacy_progress_contract(self):
        with patch.object(downloader.manager, 'broadcast', new_callable=AsyncMock):
            await downloader.broadcast_progress('v', 'title', 'source', 10, 10, 100)
        self.assertEqual(downloader.active_downloads['v']['status'], 'DOWNLOAD_COMPLETE')
        downloader.active_downloads.pop('v', None)

    async def test_ffmpeg_stderr_is_drained(self):
        # A child writes more than a pipe buffer before producing progress.
        code, _, stderr = await ffmpeg_worker.run_cmd_with_progress(
            [sys.executable, '-c', 'import sys; sys.stderr.write("x"*200000); sys.stderr.flush(); print("out_time_us=1000000")'],
            duration=1, timeout=10, video_id='v', stage='x', stage_name='x')
        self.assertEqual(code, 0)
        self.assertTrue(stderr.endswith('x' * 100))
        self.assertLessEqual(len(stderr), 65536)

    async def test_timeout_reaps_subprocess(self):
        code, _, error = await ffmpeg_worker.run_cmd(
            [sys.executable, '-c', 'import time; time.sleep(30)'], timeout=0.2)
        self.assertEqual((code, error), (-1, 'Timeout'))

    async def test_worker_awaits_inline_processing(self):
        async def fake_download(video_id):
            self.assertTrue(downloader.worker_inline_processing.get())
        job = {'kind': 'download_drive', 'video_id': 'v', 'payload': {}}
        with patch.object(downloader, 'download_drive_video', fake_download), \
             patch.object(database, 'get_video', AsyncMock(return_value={'status': 'LOCAL_READY'})):
            await media_worker.execute(job)
        self.assertFalse(downloader.worker_inline_processing.get())

    async def test_unsupported_isolation_stalls_without_launching(self):
        job = {'_id': 'v', 'claim_token': 'c', 'attempts': 1, 'max_attempts': 3}
        with patch.object(media_worker, 'isolation_supported', return_value=False), \
             patch.object(job_queue, 'stall_job', AsyncMock(return_value=True)) as stall, \
             patch.object(job_queue, 'finish_job', AsyncMock()) as finish:
            await media_worker.run_claim(job)
        stall.assert_awaited_once()
        finish.assert_not_awaited()

    async def test_lease_completion_fenced(self):
        fake = types.SimpleNamespace(update_one=AsyncMock(return_value=types.SimpleNamespace(modified_count=0)))
        job = {'_id': 'v', 'claim_token': 'old', 'attempts': 1, 'max_attempts': 2}
        with patch.object(job_queue, 'collection', return_value=fake):
            self.assertFalse(await job_queue.finish_job(job, process_stopped=True))
        query = fake.update_one.await_args.args[0]
        self.assertEqual(query['claim_token'], 'old')
        self.assertIn('$gt', query['lease_until'])

    async def test_finalization_never_overwrites_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            source, dest = Path(directory) / 'partial', Path(directory) / 'video'
            source.write_bytes(b'new')
            dest.write_bytes(b'original')
            with self.assertRaises(FileExistsError):
                downloader.finalize_download(source, dest)
            self.assertEqual(dest.read_bytes(), b'original')
            self.assertEqual(source.read_bytes(), b'new')
            dest.unlink()
            downloader.finalize_download(source, dest)
            self.assertEqual(dest.read_bytes(), b'new')
            self.assertFalse(source.exists())

    async def test_enqueue_rejects_duplicate(self):
        self.assertTrue(await job_queue.enqueue_job('v', 'process'))
        self.assertFalse(await job_queue.enqueue_job('v', 'process'))

    async def test_distinct_operations_queue_but_never_run_together(self):
        self.assertTrue(await job_queue.enqueue_job('v', 'transcode'))
        self.assertTrue(await job_queue.enqueue_job('v', 'transcribe'))
        first = await job_queue.claim_job('worker-one')
        self.assertIsNotNone(first)
        self.assertIsNone(await job_queue.claim_job('worker-two'))
        self.assertTrue(await job_queue.finish_job(first, process_stopped=True))
        second = await job_queue.claim_job('worker-two')
        self.assertIsNotNone(second)
        self.assertNotEqual(first['kind'], second['kind'])

    async def test_expired_lease_stalls_and_blocks_other_kinds(self):
        await job_queue.enqueue_job('v', 'process')
        await job_queue.enqueue_job('v', 'transcribe')
        first = await job_queue.claim_job('worker-one')
        await job_queue.collection().update_one({'_id': first['_id']}, {'$set': {'lease_until': datetime.utcnow() - timedelta(seconds=1)}})
        self.assertIsNone(await job_queue.claim_job('worker-two'))
        self.assertEqual((await job_queue.collection().find_one({'_id': first['_id']}))['state'], 'stalled')
        with self.assertRaises(ValueError):
            await job_queue.recover_stalled('v', first['claim_token'])

    async def test_queue_capacity_cannot_be_exceeded(self):
        from unittest.mock import patch
        with patch.object(job_queue, 'capacity', return_value=1):
            self.assertTrue(await job_queue.enqueue_job('one', 'process'))
            with self.assertRaises(job_queue.QueueFull):
                await job_queue.enqueue_job('two', 'process')

    async def test_unknown_shutdown_never_releases_claim(self):
        with self.assertRaises(ValueError):
            await job_queue.finish_job({'_id': 'v'})

    async def test_maintenance_excludes_future_worker_claims(self):
        ownership = await job_queue.acquire_maintenance('v')
        self.assertIsNotNone(ownership)
        self.assertTrue(await job_queue.enqueue_job('v', 'process'))
        self.assertIsNone(await job_queue.claim_job('worker'))
        self.assertTrue(await job_queue.finish_job(ownership, process_stopped=True))
        self.assertIsNotNone(await job_queue.claim_job('worker'))

    async def test_maintenance_refuses_existing_work(self):
        await job_queue.enqueue_job('v', 'process')
        self.assertIsNone(await job_queue.acquire_maintenance('v'))

    async def test_verified_rendition_recovers_without_reencoding(self):
        with tempfile.TemporaryDirectory(dir=storage) as directory:
            directory = Path(directory)
            original = directory / 'source.mp4'
            original.write_bytes(b'original synthetic source')
            partial, rendition = directory / 'partial', directory / 'recovered_720p.mp4'
            partial.write_bytes(b'verified synthetic rendition')
            downloader.finalize_download(partial, rendition)
            video = {'video_id': 'recovered', 'local_path': str(original), 'status': 'LOCAL_READY', 'renditions': {}}
            with patch.object(settings, 'videos_dir', directory), \
                 patch.object(ffmpeg_worker, 'get_video', AsyncMock(return_value=video)), \
                 patch.object(ffmpeg_worker, 'update_video', AsyncMock()) as update, \
                 patch.object(ffmpeg_worker, 'run_cmd_with_progress', AsyncMock()) as encode, \
                 patch.object(downloader.manager, 'broadcast', AsyncMock()):
                await ffmpeg_worker.transcode_video('recovered', '720p')
            encode.assert_not_awaited()
            self.assertEqual(update.await_args.args[1]['renditions']['720p']['path'], str(rendition))
            self.assertEqual(original.read_bytes(), b'original synthetic source')

    async def test_relay_broadcast_does_not_republish(self):
        with patch.object(job_events, 'publish', AsyncMock()) as publish:
            await downloader.manager.broadcast({'event': 'TRANSFER_UPDATE', 'video_id': 'v'})
            publish.assert_not_awaited()


if __name__ == '__main__':
    unittest.main()
