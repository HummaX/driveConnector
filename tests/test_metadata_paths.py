"""Load actual metadata path guards without importing the running application."""
import ast
import os
from pathlib import Path
import re
import tempfile
from typing import Union
import types
import unittest
from fastapi import HTTPException, status


class MetadataPathTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='dc-metadata-paths-')
        self.addCleanup(self.tmp.cleanup)
        self.storage = Path(self.tmp.name) / 'storage'
        self.storage.mkdir()
        self.metadata = self.storage / 'metadata'
        self.metadata.mkdir()
        (self.metadata / 'video').mkdir()
        source = ast.parse((Path(__file__).resolve().parents[1] / 'backend/main.py').read_text(encoding='utf-8'))
        names = {'validate_video_id', 'validate_storage_path', 'resolve_metadata_asset'}
        nodes = [n for n in source.body if isinstance(n, ast.FunctionDef) and n.name in names]
        self.scope = {'Path': Path, 'Union': Union, 'os': os, 'HTTPException': HTTPException,
                      'status': status, 'SAFE_ID_REGEX': re.compile(r'^[a-zA-Z0-9_-]{1,64}$'),
                      'settings': types.SimpleNamespace(STORAGE_DIR=str(self.storage))}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), 'production_metadata_guards', 'exec'), self.scope)

    def test_existing_asset_stays_in_selected_video(self):
        result = self.scope['resolve_metadata_asset']('video', 'poster.jpg')
        self.assertEqual(result, (self.metadata / 'video/poster.jpg').resolve())

    def test_traversal_and_invalid_identifiers_are_rejected(self):
        for video, asset in [('video', '../../private'), ('video', '../other/poster.jpg'), ('../other', 'poster.jpg')]:
            with self.subTest(video=video, asset=asset):
                with self.assertRaises(HTTPException):
                    self.scope['resolve_metadata_asset'](video, asset)

    def test_symlinked_metadata_cannot_escape_storage(self):
        (self.metadata / 'video').rmdir()
        self.metadata.rmdir()
        outside = Path(self.tmp.name) / 'outside'
        outside.mkdir()
        try:
            self.metadata.symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest('Directory symlink creation requires privileges on this host')
        with self.assertRaises(HTTPException):
            self.scope['resolve_metadata_asset']('video', 'poster.jpg')


if __name__ == '__main__':
    unittest.main()
