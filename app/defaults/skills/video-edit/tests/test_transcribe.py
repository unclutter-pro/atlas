import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("transcribe", Path(__file__).parents[1] / "scripts/transcribe.py")
transcribe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transcribe)


class TranscriptionTests(unittest.TestCase):
    def test_cache_tracks_source_content_and_options(self):
        with tempfile.TemporaryDirectory() as folder:
            video = Path(folder) / "take.mp4"
            transcript = Path(folder) / "take.json"
            video.write_bytes(b"first")
            identity = transcribe.source_identity(video, 0, "de", 1)
            transcript.write_text(json.dumps({"_atlas_source": identity}))
            self.assertTrue(transcribe.cached_transcript(transcript, identity))
            video.write_bytes(b"other")
            self.assertFalse(transcribe.cached_transcript(transcript, transcribe.source_identity(video, 0, "de", 1)))
            video.write_bytes(b"first")
            for track, language, speakers in [(1, "de", 1), (0, "en", 1), (0, "de", 2)]:
                self.assertFalse(transcribe.cached_transcript(transcript, transcribe.source_identity(video, track, language, speakers)))
            transcript.write_text("broken json")
            self.assertFalse(transcribe.cached_transcript(transcript, identity))

    def test_explicit_secret_file_and_environment_precedence(self):
        with tempfile.TemporaryDirectory() as folder:
            key = Path(folder) / "key"
            key.write_text("file-key\n")
            with patch.dict(os.environ, {"ELEVENLABS_API_KEY": "", "ELEVENLABS_API_KEY_FILE": str(key)}):
                self.assertEqual(transcribe.load_api_key(), "file-key")
                os.environ["ELEVENLABS_API_KEY"] = "environment-key"
                self.assertEqual(transcribe.load_api_key(), "environment-key")

    def test_matching_cache_never_extracts_or_uploads(self):
        with tempfile.TemporaryDirectory() as folder:
            video = Path(folder) / "take.mp4"
            video.write_bytes(b"fixture")
            edit = Path(folder) / "edit"
            output = transcribe.transcript_path(edit, video)
            output.parent.mkdir(parents=True)
            output.write_text(json.dumps({"_atlas_source": transcribe.source_identity(video, 0, None, None)}))
            with patch.object(transcribe, "extract_audio") as extract, patch.object(transcribe, "call_scribe") as upload:
                self.assertEqual(transcribe.transcribe_one(video, edit, "unused", verbose=False), output)
                extract.assert_not_called()
                upload.assert_not_called()
