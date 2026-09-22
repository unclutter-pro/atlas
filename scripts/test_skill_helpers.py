"""Offline CLI contract tests. STT tools are stubbed; no provider receives audio."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform == "linux", "STT helper uses Linux mktemp")
class SttTests(unittest.TestCase):
    def test_chunking_errors_and_download_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            binaries = root / "bin"
            binaries.mkdir()
            temporary = root / "tmp"
            temporary.mkdir()
            log = root / "requests"
            stubs = {
                "ffmpeg": 'from pathlib import Path; import sys; Path(sys.argv[-1]).touch()',
                "ffprobe": 'import os,json; print(json.dumps({"format":{"duration":os.environ["TEST_DURATION"]}}))',
                "curl": '''import os,sys
from pathlib import Path
args=sys.argv[1:]
if '-o' in args:
    Path(args[args.index('-o')+1]).touch()
else:
    with open(os.environ['TEST_REQUESTS'], 'a') as f: f.write('request\\n')
    if os.environ.get('TEST_HTTP_ERROR'): sys.exit(22)
    print(os.environ.get('TEST_RESPONSE', '{"text":"chunk"}'))
''',
            }
            for name, source in stubs.items():
                file = binaries / name
                file.write_text(f"#!{sys.executable}\n" + source + "\n")
                file.chmod(0o755)
            env = {**os.environ, "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
                   "ATLAS_STT_URL": "http://unused.invalid", "TMPDIR": str(temporary),
                   "TEST_DURATION": "250", "TEST_REQUESTS": str(log)}
            script = ROOT / "app/defaults/skills/stt/scripts/stt.sh"
            def run(extra=None):
                return subprocess.run(["bash", str(script), "https://unused.invalid/input.wav"],
                                      env={**env, **(extra or {})}, capture_output=True, text=True)
            result = run()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "chunk chunk chunk")
            self.assertEqual(len(log.read_text().splitlines()), 3)
            self.assertEqual(list(temporary.iterdir()), [])
            self.assertNotEqual(run({"TEST_HTTP_ERROR": "1"}).returncode, 0)
            self.assertNotEqual(run({"TEST_RESPONSE": '{"error":"bad"}'}).returncode, 0)
            self.assertEqual(list(temporary.iterdir()), [])


class LauncherTests(unittest.TestCase):
    def test_pdf_launcher_uses_own_resource_path_from_another_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            result = subprocess.run(["bash", str(ROOT / "app/bin/build-pdf"), "--help"],
                                    cwd=folder, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Templates bundled", result.stdout)

    def test_office_imports_resolve_to_one_implementation(self):
        paths = [ROOT / f"app/defaults/skills/{name}/scripts/office" for name in ("docx", "pptx", "xlsx")]
        self.assertEqual(len({p.resolve(strict=True) for p in paths}), 1)
        self.assertTrue((paths[0] / "schemas/ISO-IEC29500-4_2016/wml.xsd").is_file())


if __name__ == "__main__":
    unittest.main()
