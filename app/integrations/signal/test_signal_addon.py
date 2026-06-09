"""Tests for signal-addon.py — focused on markdown_to_signal_styles.

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

md2signal = signal_addon.markdown_to_signal_styles
utf16_len = signal_addon._utf16_len
decode_escapes = signal_addon._decode_shell_escapes
has_pending_reply = signal_addon.has_pending_reply


# ---------------------------------------------------------------------------
# UTF-16 length helper
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("text,expected", [
    ("", 0),
    ("abc", 3),
    ("äöü", 3),       # BMP characters, each 1 UTF-16 code unit
    ("a", 1),
    ("😀", 2),        # Outside BMP — surrogate pair, 2 code units
    ("a😀b", 4),
    ("👨‍👩‍👧", 8),   # Joined emoji with ZWJ
])
def test_utf16_len(text, expected):
    assert utf16_len(text) == expected


# ---------------------------------------------------------------------------
# Plain text passes through unchanged
# ---------------------------------------------------------------------------


def test_empty_and_none():
    assert md2signal("") == ("", [])
    assert md2signal(None) == (None, [])


def test_no_markers():
    plain, styles = md2signal("Hello world")
    assert plain == "Hello world"
    assert styles == []


def test_umlauts_preserved():
    plain, styles = md2signal("Mit Umlauten: äöüß")
    assert plain == "Mit Umlauten: äöüß"
    assert styles == []


# ---------------------------------------------------------------------------
# Single-style markers
# ---------------------------------------------------------------------------


def test_bold_asterisks():
    plain, styles = md2signal("**bold**")
    assert plain == "bold"
    assert styles == ["0:4:BOLD"]


def test_bold_underscores():
    plain, styles = md2signal("__bold__")
    assert plain == "bold"
    assert styles == ["0:4:BOLD"]


def test_italic_asterisk():
    plain, styles = md2signal("*italic*")
    assert plain == "italic"
    assert styles == ["0:6:ITALIC"]


def test_italic_underscore():
    plain, styles = md2signal("_italic_")
    assert plain == "italic"
    assert styles == ["0:6:ITALIC"]


def test_strikethrough():
    plain, styles = md2signal("~~strike~~")
    assert plain == "strike"
    assert styles == ["0:6:STRIKETHROUGH"]


def test_inline_code():
    plain, styles = md2signal("`code`")
    assert plain == "code"
    assert styles == ["0:4:MONOSPACE"]


# ---------------------------------------------------------------------------
# Combined / nested
# ---------------------------------------------------------------------------


def test_bold_italic_triple_asterisks():
    plain, styles = md2signal("***x***")
    assert plain == "x"
    assert set(styles) == {"0:1:BOLD", "0:1:ITALIC"}


def test_bold_italic_triple_underscores():
    plain, styles = md2signal("___x___")
    assert plain == "x"
    assert set(styles) == {"0:1:BOLD", "0:1:ITALIC"}


def test_multiple_styles_in_one_line():
    plain, styles = md2signal("**eins** und *zwei* und ~~drei~~")
    assert plain == "eins und zwei und drei"
    # eins → positions 0:4 BOLD
    # " und " → 4 chars, brings us to 9
    # zwei → 9:4 ITALIC
    # " und " → brings us to 18
    # drei → 18:4 STRIKETHROUGH
    assert "0:4:BOLD" in styles
    assert "9:4:ITALIC" in styles
    assert "18:4:STRIKETHROUGH" in styles


def test_positions_with_text_before():
    plain, styles = md2signal("Hallo **Welt**!")
    assert plain == "Hallo Welt!"
    assert styles == ["6:4:BOLD"]


def test_positions_with_emoji():
    # 😀 = 2 UTF-16 units. Position of "bold" should be 3 (after "Hi" + 😀).
    plain, styles = md2signal("Hi😀**bold**")
    assert plain == "Hi😀bold"
    assert styles == ["4:4:BOLD"]


def test_multiline_content():
    plain, styles = md2signal("**eins**\n*zwei*")
    assert plain == "eins\nzwei"
    # eins: 0:4 BOLD, then "\n" = 1 char, then zwei: 5:4 ITALIC
    assert "0:4:BOLD" in styles
    assert "5:4:ITALIC" in styles


def test_markers_span_multiple_lines():
    plain, styles = md2signal("**über\nzwei zeilen**")
    assert plain == "über\nzwei zeilen"
    assert styles == [f"0:{utf16_len('über\nzwei zeilen')}:BOLD"]


# ---------------------------------------------------------------------------
# Edge cases — markers that should NOT be parsed
# ---------------------------------------------------------------------------


def test_lone_asterisk_in_math():
    # "2 * 3 = 6" — single * with spaces around. Should NOT be italic.
    plain, styles = md2signal("2 * 3 = 6")
    assert plain == "2 * 3 = 6"
    assert styles == []


def test_lone_asterisk_in_glob():
    # "file*.py" — should NOT be italic
    plain, styles = md2signal("file*.py")
    assert plain == "file*.py"
    assert styles == []


def test_snake_case_underscores_preserved():
    plain, styles = md2signal("my_var_name")
    assert plain == "my_var_name"
    assert styles == []


def test_snake_case_in_sentence():
    plain, styles = md2signal("call foo_bar_baz() please")
    assert plain == "call foo_bar_baz() please"
    assert styles == []


def test_space_padded_marker_not_italic():
    # "* not italic *" — opener followed by space, closer preceded by space
    plain, styles = md2signal("* not italic *")
    assert plain == "* not italic *"
    assert styles == []


def test_unmatched_opener_left_intact():
    plain, styles = md2signal("**unmatched")
    assert plain == "**unmatched"
    assert styles == []


# ---------------------------------------------------------------------------
# Inline code does not recurse
# ---------------------------------------------------------------------------


def test_code_block_preserves_asterisks():
    # Inside backticks the * should stay as-is (no nested italic).
    plain, styles = md2signal("Use `git *` here")
    assert plain == "Use git * here"
    assert styles == ["4:5:MONOSPACE"]  # "git *" = 5 UTF-16 units


# ---------------------------------------------------------------------------
# Realistic mixed message
# ---------------------------------------------------------------------------


def test_realistic_message():
    src = "Hi Max,\n\n**PR #173** ist offen — _bitte mergen_ wenn ok."
    plain, styles = md2signal(src)
    assert plain == "Hi Max,\n\nPR #173 ist offen — bitte mergen wenn ok."
    # Find expected positions
    bold_start = plain.index("PR #173")
    italic_start = plain.index("bitte mergen")
    assert f"{bold_start}:{utf16_len('PR #173')}:BOLD" in styles
    assert f"{italic_start}:{utf16_len('bitte mergen')}:ITALIC" in styles


def test_quotes_lists_links_left_verbatim():
    # We don't style these; they should pass through unchanged.
    src = "> Quote\n- bullet *one*\n[link](https://x)"
    plain, styles = md2signal(src)
    # Only the italic *one* gets a style; the rest stays raw.
    assert plain == "> Quote\n- bullet one\n[link](https://x)"
    assert any("ITALIC" in s for s in styles)
    assert len(styles) == 1


# ---------------------------------------------------------------------------
# Shell escape decoding — must preserve UTF-8 multi-byte chars
# ---------------------------------------------------------------------------
#
# Regression: Python's `unicode_escape` codec is Latin-1 based. Round-tripping
# UTF-8 bytes through it mojibakes every non-ASCII char ("ö" → "Ã¶", "—" → "â").
# The fix swaps the codec for a regex-driven escape map. These tests pin that
# down so the bug can't come back.


def test_decode_escapes_passes_utf8_through_unchanged():
    assert decode_escapes("Schöne Grüße — Test") == "Schöne Grüße — Test"
    assert decode_escapes("äöüÄÖÜß") == "äöüÄÖÜß"
    assert decode_escapes("emoji 😀 ok") == "emoji 😀 ok"


def test_decode_escapes_newline():
    assert decode_escapes("Hallo\\nWelt") == "Hallo\nWelt"


def test_decode_escapes_tab_and_carriage_return():
    assert decode_escapes("a\\tb\\rc") == "a\tb\rc"


def test_decode_escapes_backslash():
    assert decode_escapes("a\\\\b") == "a\\b"


def test_decode_escapes_quotes():
    assert decode_escapes("say \\\"hi\\\"") == 'say "hi"'
    assert decode_escapes("it\\'s") == "it's"


def test_decode_escapes_mixed_utf8_and_escape():
    assert decode_escapes("Größe\\nTab\\there") == "Größe\nTab\there"
    assert decode_escapes("ö\\nü") == "ö\nü"


def test_decode_escapes_unknown_left_verbatim():
    # \x and \q are not standard shell escapes — leave them as-is so we don't
    # corrupt content the user actually typed.
    assert decode_escapes("\\x literal") == "\\x literal"
    assert decode_escapes("path\\qfoo") == "path\\qfoo"


def test_decode_escapes_null_byte():
    assert decode_escapes("a\\0b") == "a\x00b"


def test_decode_escapes_empty():
    assert decode_escapes("") == ""


def test_decode_escapes_no_escapes():
    assert decode_escapes("plain ascii") == "plain ascii"


# ---------------------------------------------------------------------------
# has_pending_reply — ground truth for the Signal-send Stop hook guard
# ---------------------------------------------------------------------------
#
# The Stop hook calls `signal needs-reply <number>`, which returns 0 when the
# last message in a conversation is inbound (the agent composed but never sent
# a reply — the recurring "Hello?" failure). These tests pin the DB-direction
# logic so that regression can't silently come back.

import sqlite3


def _make_msg_db():
    """In-memory DB matching the get_signal_db messages schema (id-ordered)."""
    db = sqlite3.connect(":memory:")
    db.execute(
        """
        CREATE TABLE messages (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            contact_number  TEXT NOT NULL,
            direction       TEXT NOT NULL DEFAULT 'in',
            body            TEXT NOT NULL DEFAULT '',
            timestamp       TEXT NOT NULL DEFAULT '',
            created_at      TEXT NOT NULL DEFAULT ''
        )
        """
    )
    return db


def _add(db, contact, direction, body=""):
    db.execute(
        "INSERT INTO messages (contact_number, direction, body) VALUES (?, ?, ?)",
        (contact, direction, body),
    )
    db.commit()


def test_pending_when_last_message_inbound():
    db = _make_msg_db()
    _add(db, "+49170", "in", "Hi Atlas")
    assert has_pending_reply(db, "+49170") is True


def test_not_pending_when_last_message_outbound():
    db = _make_msg_db()
    _add(db, "+49170", "in", "Hi Atlas")
    _add(db, "+49170", "out", "Hi Max!")
    assert has_pending_reply(db, "+49170") is False


def test_pending_when_new_inbound_after_a_reply():
    db = _make_msg_db()
    _add(db, "+49170", "in", "Hi")
    _add(db, "+49170", "out", "Hi back")
    _add(db, "+49170", "in", "One more thing")
    assert has_pending_reply(db, "+49170") is True


def test_not_pending_for_unknown_contact():
    db = _make_msg_db()
    _add(db, "+49170", "in", "Hi")
    assert has_pending_reply(db, "+49999") is False


def test_no_history_is_not_pending():
    db = _make_msg_db()
    assert has_pending_reply(db, "+49170") is False


def test_scoped_per_contact():
    # A reply to one contact does not clear a pending inbound from another.
    db = _make_msg_db()
    _add(db, "+49170", "in", "Hi from A")
    _add(db, "+49888", "in", "Hi from B")
    _add(db, "+49888", "out", "Hi back to B")
    assert has_pending_reply(db, "+49170") is True   # A still waiting
    assert has_pending_reply(db, "+49888") is False  # B answered
