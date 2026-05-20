"""Tests for email_config.EmailConfig — isolated from the rest of the add-on.

The class wraps two file layers (config.yml + runtime JSON) plus env-var
overrides. Each test fixes the layers it needs and leaves the others
empty, so we can verify precedence rules independently.

Run with:
    pytest test_email_config.py -v
"""
import importlib
import json
import sys
from unittest.mock import MagicMock

import pytest

# Stub pyyaml at the module level so test runs don't require it. Specific
# YAML-path tests undo this via the ``real_yaml`` fixture below if pyyaml
# is actually installed.
sys.modules.setdefault("yaml", MagicMock())

from email_config import (
    EmailConfig,
    extract_password_from_secret_blob,
)


@pytest.fixture
def real_yaml(request):
    """Swap the module-level pyyaml stub for the real package, if available.

    ``pytest.importorskip("yaml")`` alone doesn't work because the stub is
    already cached in ``sys.modules`` — importorskip would just return the
    MagicMock. So we explicitly drop the stub, attempt a fresh import, and
    restore the stub on teardown via a finalizer.

    Skips the test cleanly when pyyaml isn't installed locally.
    """
    saved_stub = sys.modules.pop("yaml", None)

    def _restore_stub():
        if saved_stub is not None:
            sys.modules["yaml"] = saved_stub
        else:
            sys.modules.pop("yaml", None)
    request.addfinalizer(_restore_stub)

    try:
        real = importlib.import_module("yaml")
    except ImportError:
        pytest.skip("pyyaml not installed in this environment")
    sys.modules["yaml"] = real
    return real


# ── extract_password_from_secret_blob ──────────────────────────────────────

class TestExtractPasswordFromSecretBlob:
    def test_bare_string_returned_as_is(self):
        assert extract_password_from_secret_blob("hunter2") == "hunter2"

    def test_empty_string_returns_empty(self):
        assert extract_password_from_secret_blob("") == ""

    def test_extracts_value_field(self):
        blob = json.dumps({"type": "api_key", "value": "secret-key"})
        assert extract_password_from_secret_blob(blob) == "secret-key"

    def test_extracts_password_field(self):
        blob = json.dumps({"type": "login", "password": "hunter2", "username": "x"})
        assert extract_password_from_secret_blob(blob) == "hunter2"

    def test_password_field_preferred_over_value(self):
        """Order in the canonical-fields loop: password > value."""
        blob = json.dumps({"password": "winner", "value": "loser"})
        assert extract_password_from_secret_blob(blob) == "winner"

    def test_strips_trailing_newline_from_extracted_field(self):
        """A common credential-store accident — must not propagate."""
        blob = json.dumps({"password": "secret\n"})
        assert extract_password_from_secret_blob(blob) == "secret"

    def test_malformed_json_falls_back_to_raw(self):
        # Starts with '{' so the heuristic tries JSON, but parsing fails
        assert extract_password_from_secret_blob("{not json") == "{not json"

    def test_non_dict_json_falls_back_to_raw(self):
        assert extract_password_from_secret_blob('["a", "list"]') == '["a", "list"]'

    def test_dict_without_known_fields_falls_back_to_raw(self):
        blob = json.dumps({"type": "something", "other": "data"})
        assert extract_password_from_secret_blob(blob) == blob

    def test_dict_without_known_fields_warns_on_stderr(self, capsys):
        """Unrecognised JSON shape almost certainly means a misconfig
        (e.g. someone used 'secret' instead of 'password'). We keep the
        raw-blob fallback for legacy compatibility but log a clear
        warning so the bad shape is visible in the poller log.
        """
        blob = json.dumps({"type": "something", "secret": "shh"})
        extract_password_from_secret_blob(blob)
        err = capsys.readouterr().err
        assert "WARN" in err
        assert "password_file" in err
        # The hint must mention both expected shapes
        assert "password" in err and "value" in err

    def test_known_shape_does_not_warn(self, capsys):
        """Successful extraction must stay silent — no stderr noise on
        the happy path."""
        extract_password_from_secret_blob(
            json.dumps({"type": "login", "password": "ok"})
        )
        assert capsys.readouterr().err == ""

    def test_malformed_json_does_not_warn(self, capsys):
        """Bare strings that happen to start with '{' (broken JSON) get
        the raw fallback without a warning — we can't tell whether the
        user meant JSON or a literal password starting with a brace.
        """
        extract_password_from_secret_blob("{not json")
        assert capsys.readouterr().err == ""


# ── Defaults ────────────────────────────────────────────────────────────────

class TestDefaults:
    def test_loads_all_defaults_when_no_files(self, tmp_path):
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(tmp_path / "no.json"),
            env={},
        )
        assert cfg.imap_host    == ""
        assert cfg.imap_port    == 993
        assert cfg.imap_starttls is False
        assert cfg.smtp_host    == ""
        assert cfg.smtp_port    == 587
        assert cfg.username     == ""
        assert cfg.password     == ""
        assert cfg.folder       == "INBOX"
        assert cfg.ssl_verify   is True
        assert cfg.whitelist    == []
        assert cfg.mark_read    is True
        assert cfg.idle_timeout == 1500
        assert cfg.folders      == {}

    def test_each_instance_has_independent_collections(self, tmp_path):
        """``field(default_factory=list)`` must not share state across instances."""
        a = EmailConfig.load(config_path=str(tmp_path / "a.yml"),
                              runtime_path=str(tmp_path / "a.json"), env={})
        b = EmailConfig.load(config_path=str(tmp_path / "b.yml"),
                              runtime_path=str(tmp_path / "b.json"), env={})
        assert a.whitelist is not b.whitelist
        assert a.folders is not b.folders


# ── Layer precedence: env > runtime > yaml > default ────────────────────────

class TestLayerPrecedence:
    """Verify env > runtime JSON > yaml > defaults for every kind of field."""

    def _runtime_with(self, tmp_path, email_block):
        rt = tmp_path / "rt.json"
        rt.write_text(json.dumps({"email": email_block}))
        return str(rt)

    def test_runtime_overrides_default(self, tmp_path):
        rt = self._runtime_with(tmp_path, {"imap_host": "from-runtime"})
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "missing.yml"),
            runtime_path=rt,
            env={},
        )
        assert cfg.imap_host == "from-runtime"

    def test_env_overrides_runtime(self, tmp_path):
        rt = self._runtime_with(tmp_path, {"imap_host": "from-runtime"})
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "missing.yml"),
            runtime_path=rt,
            env={"EMAIL_IMAP_HOST": "from-env"},
        )
        assert cfg.imap_host == "from-env"

    def test_runtime_overrides_yaml_via_real_files(self, tmp_path, real_yaml):
        """Both file layers wired up; runtime wins."""
        cp = tmp_path / "config.yml"
        cp.write_text("email:\n  imap_host: from-yaml\n")
        rt = self._runtime_with(tmp_path, {"imap_host": "from-runtime"})

        cfg = EmailConfig.load(config_path=str(cp), runtime_path=rt, env={})
        assert cfg.imap_host == "from-runtime"

    def test_env_int_conversion(self, tmp_path):
        """Int env vars must round-trip through int()."""
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(tmp_path / "no.json"),
            env={"EMAIL_IMAP_PORT": "143"},
        )
        assert cfg.imap_port == 143
        assert isinstance(cfg.imap_port, int)

    def test_bool_field_not_coerced_via_int_env_path(self, tmp_path):
        """``mark_read`` (bool) has no env override, so the env-int branch
        must not accidentally try ``int("true")`` on it. Regression guard.
        """
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(tmp_path / "no.json"),
            env={},
        )
        assert cfg.mark_read is True

    def test_env_for_string_field(self, tmp_path):
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(tmp_path / "no.json"),
            env={"EMAIL_USERNAME": "agent@x.test"},
        )
        assert cfg.username == "agent@x.test"


# ── Password resolution ─────────────────────────────────────────────────────

class TestPasswordResolution:
    def test_env_password_wins(self, tmp_path):
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(tmp_path / "no.json"),
            env={"EMAIL_PASSWORD": "from-env"},
        )
        assert cfg.password == "from-env"

    def test_password_file_used_when_env_empty(self, tmp_path):
        pf = tmp_path / "pass"
        pf.write_text("file-secret\n")
        rt = tmp_path / "rt.json"
        rt.write_text(json.dumps({"email": {"password_file": str(pf)}}))
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(rt),
            env={},
        )
        assert cfg.password == "file-secret"

    def test_password_file_with_structured_blob(self, tmp_path):
        pf = tmp_path / "pass"
        pf.write_text(json.dumps({"type": "login", "password": "structured-secret"}))
        rt = tmp_path / "rt.json"
        rt.write_text(json.dumps({"email": {"password_file": str(pf)}}))
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(rt),
            env={},
        )
        assert cfg.password == "structured-secret"

    def test_env_password_overrides_password_file(self, tmp_path):
        pf = tmp_path / "pass"
        pf.write_text("from-file")
        rt = tmp_path / "rt.json"
        rt.write_text(json.dumps({"email": {"password_file": str(pf)}}))
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(rt),
            env={"EMAIL_PASSWORD": "from-env"},
        )
        assert cfg.password == "from-env"

    def test_missing_password_file_silently_empty(self, tmp_path):
        rt = tmp_path / "rt.json"
        rt.write_text(json.dumps({"email": {"password_file": "/nonexistent/path"}}))
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(rt),
            env={},
        )
        assert cfg.password == ""

    def test_password_file_pointed_at_directory_does_not_crash(
        self, tmp_path, capsys
    ):
        """``pf.read_text()`` raises IsADirectoryError if password_file is a
        directory (a real user-misconfiguration we've seen). Must log to
        stderr and fall back to empty, matching the YAML/JSON layers'
        "errors never propagate" contract.
        """
        pf_dir = tmp_path / "looks-like-a-file"
        pf_dir.mkdir()
        rt = tmp_path / "rt.json"
        rt.write_text(json.dumps({"email": {"password_file": str(pf_dir)}}))

        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(rt),
            env={},
        )
        assert cfg.password == ""
        err = capsys.readouterr().err
        assert "WARN" in err
        assert "password_file" in err

    def test_unreadable_password_file_does_not_crash(
        self, tmp_path, capsys, monkeypatch
    ):
        """A genuine OSError (e.g. PermissionError) on read also falls back.

        We force the error via ``Path.read_text`` patching rather than
        relying on chmod, which behaves differently across platforms
        (and root would bypass it anyway).
        """
        pf = tmp_path / "pass"
        pf.write_text("ignored")

        from pathlib import Path as _Path
        orig = _Path.read_text

        def boom(self, *a, **kw):
            if str(self) == str(pf):
                raise PermissionError("denied")
            return orig(self, *a, **kw)
        monkeypatch.setattr(_Path, "read_text", boom)

        rt = tmp_path / "rt.json"
        rt.write_text(json.dumps({"email": {"password_file": str(pf)}}))
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(rt),
            env={},
        )
        assert cfg.password == ""
        err = capsys.readouterr().err
        assert "denied" in err


# ── Folders sub-block ───────────────────────────────────────────────────────

class TestFoldersSubBlock:
    """The new ``folders:`` override must round-trip through every layer.

    Regression guard for the earlier bug where ``load_config()``'s
    explicit dict literal dropped the key.
    """

    def test_runtime_folders_override(self, tmp_path):
        rt = tmp_path / "rt.json"
        rt.write_text(json.dumps({
            "email": {"folders": {"junk": "MyJunk", "archive": "MyArchive"}}
        }))
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(rt),
            env={},
        )
        assert cfg.folders == {"junk": "MyJunk", "archive": "MyArchive"}

    def test_yaml_folders_override(self, tmp_path, real_yaml):
        cp = tmp_path / "config.yml"
        cp.write_text(
            "email:\n"
            "  folders:\n"
            "    junk: YamlJunk\n"
            "    trash: YamlTrash\n"
        )
        cfg = EmailConfig.load(
            config_path=str(cp),
            runtime_path=str(tmp_path / "no.json"),
            env={},
        )
        assert cfg.folders == {"junk": "YamlJunk", "trash": "YamlTrash"}

    def test_runtime_folders_override_wins_over_yaml(self, tmp_path, real_yaml):
        cp = tmp_path / "config.yml"
        cp.write_text("email:\n  folders:\n    junk: YamlJunk\n")
        rt = tmp_path / "rt.json"
        rt.write_text(json.dumps({
            "email": {"folders": {"junk": "RuntimeJunk"}}
        }))
        cfg = EmailConfig.load(config_path=str(cp), runtime_path=str(rt), env={})
        assert cfg.folders == {"junk": "RuntimeJunk"}

    def test_folders_defaults_to_empty_dict_not_none(self, tmp_path):
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(tmp_path / "no.json"),
            env={},
        )
        # ImapClient reads cfg.folders.get(role) — must not be None
        assert cfg.folders == {}
        assert isinstance(cfg.folders, dict)


# ── Dict-style compatibility shim ───────────────────────────────────────────

class TestDictCompatibility:
    """Legacy call sites use ``config['foo']``. The shim keeps them working
    during the migration; tests guard against accidental regression.
    """

    def test_getitem(self, tmp_path):
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(tmp_path / "no.json"),
            env={"EMAIL_USERNAME": "agent@x"},
        )
        assert cfg["username"] == "agent@x"
        assert cfg["mark_read"] is True

    def test_getitem_unknown_raises_keyerror(self, tmp_path):
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(tmp_path / "no.json"),
            env={},
        )
        with pytest.raises(KeyError):
            _ = cfg["nonexistent_field"]

    def test_get_with_default(self, tmp_path):
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(tmp_path / "no.json"),
            env={},
        )
        assert cfg.get("imap_host") == ""
        assert cfg.get("nonexistent_field", "fallback") == "fallback"

    def test_to_dict_round_trips(self, tmp_path):
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(tmp_path / "no.json"),
            env={"EMAIL_USERNAME": "agent@x"},
        )
        d = cfg.to_dict()
        assert d["username"] == "agent@x"
        assert "password" in d
        assert "folders" in d

    def test_frozen_instance_is_immutable(self, tmp_path):
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(tmp_path / "no.json"),
            env={},
        )
        with pytest.raises(Exception):
            cfg.imap_host = "mutated"  # type: ignore[misc]


# ── Error-path behaviour ────────────────────────────────────────────────────

class TestErrorPaths:
    def test_missing_yaml_is_silent(self, tmp_path):
        # No config.yml at the configured path; load should still succeed
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "nope.yml"),
            runtime_path=str(tmp_path / "nope.json"),
            env={},
        )
        assert cfg.imap_host == ""

    def test_corrupt_runtime_json_warns_and_falls_back(self, tmp_path, capsys):
        """Corrupt runtime JSON logs to stderr but doesn't crash.

        This is the documented behaviour: silently swallowing the error
        would let a corrupt file drop the agent back to ``config.yml``-only
        state without any signal.
        """
        rt = tmp_path / "rt.json"
        rt.write_text("not valid json {")
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(rt),
            env={},
        )
        # Defaults still applied
        assert cfg.imap_port == 993
        # Error surfaced on stderr
        err = capsys.readouterr().err
        assert "corrupt JSON" in err
        assert str(rt) in err

    def test_runtime_json_not_a_dict_is_ignored(self, tmp_path):
        """JSON that parses but isn't a dict (e.g. a list) → empty layer."""
        rt = tmp_path / "rt.json"
        rt.write_text(json.dumps(["unexpected", "shape"]))
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(rt),
            env={},
        )
        assert cfg.imap_host == ""

    def test_runtime_email_section_missing_uses_defaults(self, tmp_path):
        rt = tmp_path / "rt.json"
        rt.write_text(json.dumps({"signal": {"number": "+1"}}))  # no email key
        cfg = EmailConfig.load(
            config_path=str(tmp_path / "no.yml"),
            runtime_path=str(rt),
            env={},
        )
        assert cfg.imap_host == ""
