"""Typed configuration for the email add-on.

Centralises everything related to *reading* the user's email settings —
the precedence rules, environment-variable overrides, password-file
extraction, and the YAML/JSON file layers — behind one
:class:`EmailConfig` dataclass.

Resolution order (highest priority wins):

  1. Environment variables (e.g. ``EMAIL_IMAP_HOST``)
  2. Runtime config (``~/.atlas-runtime-config.json``) — written by the
     web UI's ``/api/v1/config`` endpoint
  3. ``config.yml`` (the user-edited file)
  4. Built-in defaults

This module never touches the network or the DB. It only parses input
files and merges values. Errors in the runtime-config layer are surfaced
to stderr (so they show up in the poller log) but never propagated —
a corrupt file falls back gracefully to ``config.yml``-only state.

The legacy code passed a plain ``dict`` around. :class:`EmailConfig`
preserves a dict-like ``__getitem__`` interface so any not-yet-migrated
call site keeps working during the cutover.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import MISSING, dataclass, field, fields
from pathlib import Path
from typing import Any, Mapping, Optional


__all__ = ["EmailConfig", "extract_password_from_secret_blob"]


# ── Password-file helper ────────────────────────────────────────────────────

def extract_password_from_secret_blob(raw: str) -> str:
    """Return the bare password from a password_file's contents.

    Atlas standardises on a structured secret-file format for forward
    compatibility with credential managers, vault drivers and sync
    sidecars that mount richer metadata alongside the value::

        {"type": "api_key", "value": "<password>"}
        {"type": "login",   "password": "<password>", "username": "..."}

    Bare-string password files keep working unchanged. Parse leniently:
    if the content looks like JSON, extract the canonical password
    field; else fall back to the raw text.

    Whitespace is stripped from the extracted field — values stored
    with a trailing newline (a common accident when a value is piped
    into a credential store) would otherwise survive through the JSON
    layer and crash the IMAP login with a malformed password.
    """
    if not raw:
        return raw
    if not raw.startswith("{"):
        return raw
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return raw
    if not isinstance(parsed, dict):
        return raw
    for key in ("password", "value"):
        candidate = parsed.get(key)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    # JSON parsed cleanly but has neither ``password`` nor ``value`` — almost
    # certainly a misconfiguration (e.g. someone used a non-canonical key
    # name like ``secret``). The legacy contract is to fall back to the raw
    # blob, which we keep so anyone with a literal JSON-shaped password
    # isn't broken silently. But we also surface a warning so the
    # mis-shaped file is visible in the poller log instead of producing
    # mysterious "bad credentials" rejections downstream.
    print(
        "[email config] WARN: password_file looks like JSON but contains "
        "neither 'password' nor 'value' — falling back to the raw blob. "
        "Expected shapes: {\"type\":\"login\",\"password\":...} or "
        "{\"type\":\"api_key\",\"value\":...}",
        file=sys.stderr,
        flush=True,
    )
    return raw


# ── Typed config ────────────────────────────────────────────────────────────

# Default paths — overridable by the caller (used in tests).
DEFAULT_CONFIG_PATH = os.environ.get("HOME", "") + "/config.yml"
DEFAULT_RUNTIME_CONFIG_PATH = os.environ.get("HOME", "") + "/.atlas-runtime-config.json"


@dataclass(frozen=True)
class EmailConfig:
    """Resolved email configuration. Frozen so it can be safely shared.

    Field defaults match the original ``load_config()`` dict literal, so
    swapping the dict for this class is a zero-behaviour-change change.
    """

    imap_host:     str  = ""
    imap_port:     int  = 993
    imap_starttls: bool = False
    smtp_host:     str  = ""
    smtp_port:     int  = 587
    username:      str  = ""
    password:      str  = ""
    password_file: str  = ""
    folder:        str  = "INBOX"
    ssl_verify:    bool = True
    whitelist:     list = field(default_factory=list)
    mark_read:     bool = True
    idle_timeout:  int  = 1500
    # Per-role folder name overrides (junk/trash/archive/sent/drafts).
    # ``ImapClient.discover_folders`` reads this; always a dict so the
    # client's ``.get()`` call doesn't need a None check.
    folders:       dict = field(default_factory=dict)

    # --- Dict-like access for back-compat ----------------------------------

    def __getitem__(self, key: str) -> Any:
        """Legacy code reads ``config["foo"]``. Keep that working."""
        try:
            return getattr(self, key)
        except AttributeError as e:
            raise KeyError(key) from e

    def get(self, key: str, default: Any = None) -> Any:
        """Mapping-style get(). Mirrors ``dict.get``."""
        return getattr(self, key, default)

    def to_dict(self) -> dict:
        """Plain-dict copy for code paths that expect ``dict`` exactly."""
        return {f.name: getattr(self, f.name) for f in fields(self)}

    # --- Construction ------------------------------------------------------

    @classmethod
    def load(
        cls,
        config_path: Optional[str] = None,
        runtime_path: Optional[str] = None,
        env: Optional[Mapping[str, str]] = None,
    ) -> "EmailConfig":
        """Load + merge all configuration layers into a typed instance.

        Args:
            config_path: Path to ``config.yml`` (default:
                ``$HOME/config.yml``). Missing file is fine.
            runtime_path: Path to ``.atlas-runtime-config.json`` (default:
                ``$HOME/.atlas-runtime-config.json``). Missing file is
                fine; corrupt JSON logs to stderr and falls back.
            env: Environment-variable mapping (default: ``os.environ``).
                Lets tests inject a synthetic environment.
        """
        cp = config_path if config_path is not None else DEFAULT_CONFIG_PATH
        rp = runtime_path if runtime_path is not None else DEFAULT_RUNTIME_CONFIG_PATH
        environ = env if env is not None else os.environ

        cfg_layer = _read_yaml_layer(cp)
        rt_layer  = _read_runtime_layer(rp)

        # Per-field type-aware env override.
        # The pre-class implementation only handled int/str env values;
        # everything else fell through unchanged. We keep that contract.
        env_keys = {
            "imap_host":    "EMAIL_IMAP_HOST",
            "imap_port":    "EMAIL_IMAP_PORT",
            "smtp_host":    "EMAIL_SMTP_HOST",
            "smtp_port":    "EMAIL_SMTP_PORT",
            "username":     "EMAIL_USERNAME",
            "folder":       "EMAIL_FOLDER",
            "idle_timeout": "EMAIL_IDLE_TIMEOUT",
        }

        resolved: dict = {}
        for f in fields(cls):
            if f.name == "password":
                # ``password`` has only an env override + the password_file
                # fallback below; never read from the file layers (no one
                # should be writing a literal password to config.yml).
                resolved[f.name] = environ.get("EMAIL_PASSWORD", "")
                continue

            default = _field_default(f)
            file_val    = cfg_layer.get(f.name, default)
            runtime_val = rt_layer.get(f.name)
            base = runtime_val if runtime_val is not None else file_val

            env_var = env_keys.get(f.name)
            if env_var and (env_raw := environ.get(env_var)) is not None:
                # The original code converted str → int when the default was
                # int (bool is a subclass of int, so guard against it).
                if isinstance(default, int) and not isinstance(default, bool):
                    base = int(env_raw)
                else:
                    base = env_raw

            resolved[f.name] = base

        # password_file fallback (only if no env-provided password).
        # Errors must not propagate — same contract as the YAML/JSON
        # layers above. A permission glitch or a directory mistakenly
        # pointed at by ``password_file`` would otherwise crash the
        # poller at startup; instead we log to stderr and fall back to
        # an empty password (the caller decides whether that's fatal).
        if not resolved["password"] and resolved["password_file"]:
            pf = Path(resolved["password_file"])
            if pf.exists():
                try:
                    raw = pf.read_text().strip()
                except OSError as e:
                    print(
                        f"[email config] WARN: could not read password_file "
                        f"{resolved['password_file']}: {e}",
                        file=sys.stderr,
                        flush=True,
                    )
                else:
                    resolved["password"] = extract_password_from_secret_blob(raw)

        return cls(**resolved)


# ── Internal helpers ────────────────────────────────────────────────────────

def _field_default(f) -> Any:
    """Resolve a dataclass field's default value, whether literal or factory."""
    if f.default is not MISSING:
        return f.default
    if f.default_factory is not MISSING:  # type: ignore[misc]
        return f.default_factory()
    return None


# ── Internal layer readers ─────────────────────────────────────────────────

def _read_yaml_layer(path: str) -> dict:
    """Read the ``email:`` block from ``config.yml``.

    Missing file or missing pyyaml → empty dict (caller's defaults win).
    """
    if not path or not os.path.exists(path):
        return {}
    try:
        import yaml  # local import — pyyaml is optional in some setups
    except ImportError:
        return {}
    try:
        with open(path) as f:
            data = yaml.safe_load(f) or {}
    except Exception as e:
        print(
            f"[email config] WARN: could not parse {path}: {e}",
            file=sys.stderr,
            flush=True,
        )
        return {}
    email_block = data.get("email", {}) if isinstance(data, dict) else {}
    return email_block if isinstance(email_block, dict) else {}


def _read_runtime_layer(path: str) -> dict:
    """Read the ``email:`` block from the runtime-config JSON.

    Corrupt JSON or unreadable file logs to stderr (so the poller log
    surfaces it) and returns ``{}`` — we never let a transient runtime
    glitch silently drop the agent back to ``config.yml``-only state.
    """
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path) as f:
            rt_data = json.load(f)
    except json.JSONDecodeError as e:
        print(
            f"[email config] ERROR: {path} is corrupt JSON "
            f"({e}); falling back to config.yml. Manual recovery may be required.",
            file=sys.stderr,
            flush=True,
        )
        return {}
    except OSError as e:
        print(
            f"[email config] WARN: could not read {path}: {e}",
            file=sys.stderr,
            flush=True,
        )
        return {}
    email_block = rt_data.get("email", {}) if isinstance(rt_data, dict) else {}
    return email_block if isinstance(email_block, dict) else {}
