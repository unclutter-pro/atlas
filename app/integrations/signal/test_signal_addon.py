"""Tests for signal-addon.py — focused on strip_markdown.

Run with:
    cd app/integrations/signal
    pip install pytest
    pytest test_signal_addon.py -v
"""
import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Stub out runtime-only deps so imports don't fail.
sys.modules.setdefault("yaml", MagicMock())

_spec = importlib.util.spec_from_file_location(
    "signal_addon", Path(__file__).parent / "signal-addon.py"
)
signal_addon = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(signal_addon)


# ---------------------------------------------------------------------------
# strip_markdown
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("raw,expected", [
    # Bold
    ("**bold**", "bold"),
    ("__bold__", "bold"),
    ("vor **bold** nach", "vor bold nach"),
    # Italic
    ("*italic*", "italic"),
    ("_italic_", "italic"),
    ("vor *italic* nach", "vor italic nach"),
    # Strikethrough
    ("~~strike~~", "strike"),
    # Combined
    ("***bold italic***", "bold italic"),
    ("___bold italic___", "bold italic"),
    # Multiple markers in one line
    ("**eins** und *zwei* und ~~drei~~", "eins und zwei und drei"),
    # Newlines preserved + multiline content
    ("**eins**\n*zwei*", "eins\nzwei"),
    ("**über\nzwei zeilen**", "über\nzwei zeilen"),
])
def test_strip_markdown_basic(raw, expected):
    assert signal_addon.strip_markdown(raw) == expected


def test_strip_markdown_empty():
    assert signal_addon.strip_markdown("") == ""
    assert signal_addon.strip_markdown(None) is None


def test_strip_markdown_no_markers():
    # Plain text untouched
    assert signal_addon.strip_markdown("Hello world") == "Hello world"
    assert signal_addon.strip_markdown("Mit Umlauten: äöüß") == "Mit Umlauten: äöüß"


def test_strip_markdown_preserves_inline_code():
    # Inline code is rare in Signal, and stripping `*` inside backticks would
    # mangle real code. We keep backticks as-is.
    assert signal_addon.strip_markdown("Use `git *` here") == "Use `git *` here"


def test_strip_markdown_preserves_lists_quotes_links():
    # These render fine as plain text and should stay verbatim.
    src = "> Quote\n- bullet *one*\n[link](https://x)"
    out = signal_addon.strip_markdown(src)
    # Italic *one* is still stripped because it's a real italic marker.
    assert out == "> Quote\n- bullet one\n[link](https://x)"


def test_strip_markdown_does_not_eat_lone_asterisks():
    # Single `*` with no closing marker should not be touched.
    assert signal_addon.strip_markdown("2 * 3 = 6") == "2 * 3 = 6"
    assert signal_addon.strip_markdown("file*.py") == "file*.py"


def test_strip_markdown_does_not_eat_word_internal_underscores():
    # snake_case identifiers should stay intact.
    assert signal_addon.strip_markdown("my_var_name") == "my_var_name"
    assert signal_addon.strip_markdown("foo_bar_baz()") == "foo_bar_baz()"


def test_strip_markdown_does_not_eat_whitespace_padded_markers():
    # `* not italic *` (space-padded) is not valid Markdown italic.
    assert signal_addon.strip_markdown("* not italic *") == "* not italic *"
