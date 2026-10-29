"""Run with: pytest app/integrations/telegram/test_telegram_addon.py -v"""
import importlib.util
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

os.environ["HOME"] = tempfile.mkdtemp()
sys.modules.setdefault("yaml", MagicMock())

_spec = importlib.util.spec_from_file_location(
    "telegram_addon", Path(__file__).parent / "telegram-addon.py"
)
addon = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(addon)


def test_incoming_passes_payload_and_session_key_positionally():
    with patch.object(addon.subprocess, "Popen") as popen:
        addon.cmd_incoming({}, "4711", "hello <world>", name="Alice")

    argv = popen.call_args.args[0]
    # trigger-runner.ts: <trigger-name> [payload] [session-key]
    assert argv[:2] == [addon.TRIGGER_SCRIPT, addon.TRIGGER_NAME]
    assert len(argv) == 4
    assert argv[2].startswith('<telegram-message from="4711" name="Alice"')
    assert "hello &lt;world&gt;" in argv[2]
    assert argv[3] == "4711"
