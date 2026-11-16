"""Isolated contracts for the standalone dashboard.

Run from a disposable copy of the repository, never against live storage.
The optional browser test uses a fresh profile and a network-denying CSP.
"""
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FRONT = ROOT / 'frontend' / 'index.html'
BACK = ROOT / 'backend' / 'static' / 'index.html'


class FrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = BACK.read_text(encoding='utf-8')

    def test_same_entrypoints_and_one_engine(self):
        self.assertEqual(FRONT.read_bytes(), BACK.read_bytes())
        self.assertNotIn('src="/js/app.js"', self.html)
        self.assertEqual(self.html.count('function openPlayerModal('), 1)

    def test_library_and_accessible_controls(self):
        for token in ('id="library-heading"', 'id="search-input" aria-label=',
                      'id="view-list-btn" aria-label=', 'aria-pressed=',
                      'library-title-button', 'currentViewMode === \'grid\'',
                      'function deleteVideo(id, title)', 'confirm(`Are you sure'):
            self.assertIn(token, self.html)

    def test_player_continuity_and_vtt(self):
        for token in ('const wasPaused =', 'if (!wasPaused) player.play()',
                      'if (activePlayer !== player) return;', 'player-companion-audio',
                      'changePlayerSubtitleTrack', 'getBufferedPercent',
                      'new URL(spriteUrl, new URL(vttUrl, document.baseURI)).href',
                      'addRemoteTextTrack', 'dc_bookmarks_'):
            self.assertIn(token, self.html)
        self.assertNotIn('|| cues[0]', self.html)

    def test_dom_references_present(self):
        ids = set(re.findall(r'''\bid=["']([^"']+)["']''', self.html))
        refs = set(re.findall(r'''getElementById\(["']([^"']+)["']\)''', self.html))
        self.assertEqual(refs - ids, set())

    def test_bookmark_engine_and_paused_quality_in_browser(self):
        browser = next((p for p in [Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe'),
                                    Path(r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')]
                        if p.is_file()), None)
        if not browser:
            self.skipTest('Chrome or Edge not installed')
        bookmarks = self.html.split('    function bookmarkKey()', 1)[1].split('    // Authenticated Player Modal', 1)[0]
        quality = self.html.split('    function changePlayerQuality(q) {', 1)[1].split('    function openTranscodeModal', 1)[0]
        engine = self.html.split("    let currentDownloadEngine = 'auto';", 1)[1].split('    async function triggerUrlDownload', 1)[0]
        script = """
          let activeVideoModal = {video_id:'dummy-video'}, authToken = null, currentPlaybackSpeed = 1;
          let currentSelectedQuality = 'original', currentDownloadEngine = 'auto';
          let callback, played = 0, position = 31, paused = true;
          let activePlayer = {paused:()=>paused, currentTime:(x)=>x === undefined ? position : (position=x),
            playbackRate:()=>{}, src:()=>{}, one:(name, cb)=>callback=cb, play:()=>{played++; return Promise.resolve();}};
          function showBufferingIndicator() {}
        """ + 'function bookmarkKey()' + bookmarks + 'function changePlayerQuality(q) {' + quality + engine + """
          try {
            addPlayerBookmark(); position=12; addPlayerBookmark();
            if (JSON.stringify(readPlayerBookmarks()) !== '[12,31]') throw Error('bookmarks not sorted');
            document.querySelector('#player-bookmarks button').click();
            if (position !== 12) throw Error('bookmark did not seek');
            document.querySelectorAll('#player-bookmarks button')[1].click();
            if (JSON.stringify(readPlayerBookmarks()) !== '[31]') throw Error('bookmark did not remove');
            setDownloadEngine('jdownloader');
            if (currentDownloadEngine !== 'jdownloader' || document.getElementById('engine-btn-jd').getAttribute('aria-pressed') !== 'true') throw Error('engine selection');
            changePlayerQuality('720p'); callback();
            if (played !== 0 || position !== 12) throw Error('paused quality continuity');
            paused=false; changePlayerQuality('original'); callback();
            if (played !== 1) throw Error('playing quality continuity');
            document.body.setAttribute('data-result','PASS');
          } catch(e) { document.body.setAttribute('data-result','FAIL ' + e.message); }
        """
        page = '''<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">
          <div id="player-bookmarks"></div><button id="engine-btn-auto"></button><button id="engine-btn-native"></button><button id="engine-btn-jd"></button>
          <script>''' + script + '</script>'
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'test.html'
            path.write_text(page, encoding='utf-8')
            result = subprocess.run([str(browser), '--headless', '--disable-gpu', '--no-first-run',
                                     '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND',
                                     '--user-data-dir=' + str(Path(tmp) / 'profile'), '--dump-dom', path.as_uri()],
                                    capture_output=True, text=True, timeout=40)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('data-result="PASS"', result.stdout, result.stdout[-2000:])


if __name__ == '__main__':
    unittest.main()
