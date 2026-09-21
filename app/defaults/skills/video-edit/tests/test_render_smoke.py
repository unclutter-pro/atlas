"""Offline FFmpeg smoke test; no media upload or API credentials needed."""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg and ffprobe required")
class RenderSmokeTests(unittest.TestCase):
    def test_two_cuts_and_output_timeline_subtitles(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "take.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30",
                            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3",
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(source)], check=True)
            (root / "transcripts").mkdir()
            words = [{"type": "word", "text": "Hello", "start": 0.2, "end": 0.5},
                     {"type": "word", "text": "World", "start": 1.3, "end": 1.6}]
            (root / "transcripts/take.json").write_text(json.dumps({"words": words}))
            edl = {"version": 1, "sources": {"take": str(source)}, "ranges": [
                {"source": "take", "start": 0.1, "end": 0.9},
                {"source": "take", "start": 1.2, "end": 2.0}]}
            (root / "edl.json").write_text(json.dumps(edl))
            renderer = Path(__file__).parents[1] / "scripts/render.py"
            result = subprocess.run([sys.executable, str(renderer), str(root / "edl.json"),
                                     "-o", str(root / "final.mp4"), "--draft", "--build-subtitles", "--no-loudnorm"],
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_format", "-show_streams",
                                                        "-of", "json", str(root / "final.mp4")]))
            self.assertAlmostEqual(float(probe["format"]["duration"]), 1.6, delta=0.15)
            self.assertEqual({s["codec_type"] for s in probe["streams"]}, {"audio", "video"})
            subtitles = (root / "master.srt").read_text()
            self.assertIn("00:00:00,900", subtitles)
            self.assertIn("WORLD", subtitles.upper())
