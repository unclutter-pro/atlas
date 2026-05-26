"""
Tests for signal-addon.py markdown_to_signal function.
"""

import pytest
import importlib.util

# Load the module directly from file path (signal-addon.py is a standalone script, not a package)
_spec = importlib.util.spec_from_file_location(
    "signal_addon",
    "/home/agent/projects/atlas/app/integrations/signal/signal-addon.py"
)
_signal_addon = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_signal_addon)
markdown_to_signal = _signal_addon.markdown_to_signal


class TestMarkdownToSignal:
    """Test cases for markdown_to_signal function."""

    def test_bold_double_asterisk(self):
        """**bold** should become plain 'bold' with bold style."""
        plain, styles = markdown_to_signal("**bold**")
        assert plain == "bold"
        assert styles == [(0, 8, "bold")]  # 8 UTF-16 units for "bold"

    def test_bold_double_underscore(self):
        """__bold__ should become plain 'bold' with bold style."""
        plain, styles = markdown_to_signal("__bold__")
        assert plain == "bold"
        assert styles == [(0, 8, "bold")]

    def test_italic_single_asterisk(self):
        """*italic* should become plain 'italic' with italic style."""
        plain, styles = markdown_to_signal("*italic*")
        assert plain == "italic"
        assert styles == [(0, 12, "italic")]  # 12 UTF-16 units for "italic"

    def test_strikethrough(self):
        """~~strike~~ should become plain 'strike' with strikethrough style."""
        plain, styles = markdown_to_signal("~~strike~~")
        assert plain == "strike"
        assert styles == [(0, 12, "strikethrough")]

    def test_code_preserved(self):
        """`code` should be preserved as-is without any style."""
        plain, styles = markdown_to_signal("`code`")
        assert plain == "`code`"
        assert styles == []

    def test_no_formatting(self):
        """Plain text should pass through unchanged."""
        plain, styles = markdown_to_signal("Hello world")
        assert plain == "Hello world"
        assert styles == []

    def test_bold_in_sentence(self):
        """Bold in the middle of a sentence."""
        plain, styles = markdown_to_signal("This is **bold** text")
        assert plain == "This is bold text"
        assert len(styles) == 1
        # "This is " = 8 chars = 16 UTF-16 units
        assert styles[0] == (16, 8, "bold")

    def test_mixed_bold_and_italic(self):
        """Multiple styles in one message."""
        plain, styles = markdown_to_signal("**bold** and *italic*")
        assert plain == "bold and italic"
        assert len(styles) == 2
        assert styles[0] == (0, 8, "bold")
        assert styles[1] == (18, 12, "italic")

    def test_bold_not_italic(self):
        """**bold** should NOT be treated as italic."""
        plain, styles = markdown_to_signal("**bold**")
        # Should have bold style, not italic
        assert styles == [(0, 8, "bold")]
        # Check no italic style
        italic_styles = [s for s in styles if s[2] == "italic"]
        assert len(italic_styles) == 0

    def test_asterisks_adjacent_to_words(self):
        """Single *word* surrounded by non-asterisk chars should be italic."""
        plain, styles = markdown_to_signal("a *b* c")
        assert plain == "a b c"
        # "a " = 2 chars = 4 UTF-16 units, "b" = 1 char = 2 UTF-16 units
        assert styles == [(4, 2, "italic")]

    def test_text_after_style(self):
        """Text after a styled section should be preserved."""
        plain, styles = markdown_to_signal("**bold** and normal")
        assert plain == "bold and normal"
        assert len(styles) == 1
        assert styles[0] == (0, 8, "bold")

    def test_underscore_italic(self):
        """_italic_ should become plain 'italic' with italic style."""
        plain, styles = markdown_to_signal("_italic_")
        assert plain == "italic"
        assert styles == [(0, 12, "italic")]

    def test_strikethrough_in_sentence(self):
        """Strikethrough in a sentence."""
        plain, styles = markdown_to_signal("This is ~~deleted~~ text")
        assert plain == "This is deleted text"
        assert len(styles) == 1
        # "This is " = 8 chars = 16 UTF-16 units, "deleted" = 7 chars = 14 UTF-16 units
        assert styles[0] == (16, 14, "strikethrough")

    def test_multiple_strikethrough(self):
        """Multiple strikethrough sections."""
        plain, styles = markdown_to_signal("~~a~~ and ~~b~~")
        assert plain == "a and b"
        assert len(styles) == 2

    def test_empty_string(self):
        """Empty string returns empty."""
        plain, styles = markdown_to_signal("")
        assert plain == ""
        assert styles == []

    def test_code_with_special_chars(self):
        """Code blocks preserve content including asterisks (no styling applied)."""
        plain, styles = markdown_to_signal("Use `**bold**` for bold")
        # Code blocks are preserved literally — asterisks inside are not parsed
        assert plain == "Use `**bold**` for bold"
        assert styles == []

    def test_bold_underscore_combination(self):
        """__bold__ and _italic_ together."""
        plain, styles = markdown_to_signal("__bold__ and _italic_")
        assert plain == "bold and italic"
        assert len(styles) == 2


class TestUtf16Positions:
    """Test UTF-16 position calculations."""

    def test_simple_ascii(self):
        """ASCII characters are 2 bytes in UTF-16."""
        plain, styles = markdown_to_signal("**ab**")
        assert plain == "ab"
        assert styles == [(0, 4, "bold")]  # 2 chars * 2 bytes = 4

    def test_position_after_text(self):
        """Position should account for all preceding characters."""
        plain, styles = markdown_to_signal("prefix **bold**")
        assert plain == "prefix bold"
        # "prefix " = 7 chars = 14 UTF-16 units
        assert styles == [(14, 8, "bold")]

    def test_position_complex_sentence(self):
        """Complex positioning with mixed content."""
        plain, styles = markdown_to_signal("Hello **world** how are *you*?")
        assert plain == "Hello world how are you?"
        assert len(styles) == 2
        # "Hello " = 6 chars = 12 UTF-16 units
        assert styles[0] == (12, 10, "bold")  # "world" starts at 12
        # "Hello world how are " = 20 chars = 40 UTF-16 units
        assert styles[1] == (40, 6, "italic")  # "you" starts at 40


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
