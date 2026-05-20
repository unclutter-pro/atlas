"""Tests for imap_client.ImapClient — isolated from the email add-on.

The client is exercised against a ``MagicMock`` of the underlying ``imaplib``
connection (injected via the ``_connection`` constructor kwarg), so no real
sockets are opened. Each test focuses on one method's protocol behaviour:
status checking, chunking, fallback paths, caching, etc.

Run with:
    pytest test_imap_client.py -v
"""
from unittest.mock import MagicMock

import pytest

from imap_client import (
    DEFAULT_FOLDERS,
    UID_BATCH,
    ImapClient,
    ImapError,
    parse_list_response,
)


# ── Fixtures ────────────────────────────────────────────────────────────────

CONFIG = {
    "imap_host": "imap.test.local",
    "imap_port": 993,
    "username": "agent@test.local",
    "password": "secret",
    "ssl_verify": True,
    "imap_starttls": False,
}


def _make_mail(
    list_response=None,
    capabilities=b"IMAP4rev1 MOVE IDLE LITERAL+",
):
    """Build a MagicMock pre-seeded with sensible OK responses."""
    mail = MagicMock()
    mail.list.return_value = (
        "OK",
        list_response if list_response is not None else [
            b'(\\HasNoChildren) "/" "INBOX"',
            b'(\\HasNoChildren \\Sent) "/" "Sent"',
            b'(\\HasNoChildren \\Drafts) "/" "Drafts"',
            b'(\\HasNoChildren \\Junk) "/" "Junk"',
            b'(\\HasNoChildren \\Trash) "/" "Trash"',
            b'(\\HasNoChildren \\Archive) "/" "Archive"',
        ],
    )
    mail.capability.return_value = ("OK", [capabilities])
    mail.select.return_value = ("OK", [b"1"])
    mail.uid.return_value = ("OK", [b""])
    mail.expunge.return_value = ("OK", [b""])
    mail.noop.return_value = ("OK", [b""])
    return mail


def _client(mail=None, config=None) -> ImapClient:
    """Build an ImapClient with an injected mock connection."""
    return ImapClient(config or CONFIG, _connection=mail or _make_mail())


# ── parse_list_response ─────────────────────────────────────────────────────

class TestParseListResponse:
    def test_quoted_name(self):
        attrs, name = parse_list_response(b'(\\HasNoChildren \\Sent) "/" "Sent"')
        assert b"\\Sent" in attrs
        assert name == "Sent"

    def test_quoted_name_with_spaces(self):
        attrs, name = parse_list_response(
            b'(\\HasNoChildren \\All) "/" "[Gmail]/All Mail"'
        )
        assert name == "[Gmail]/All Mail"

    def test_unquoted_atom_name(self):
        result = parse_list_response(b'() "/" INBOX')
        assert result is not None
        assert result[1] == "INBOX"

    def test_malformed_returns_none(self):
        assert parse_list_response(b"random garbage") is None

    def test_non_bytes_returns_none(self):
        assert parse_list_response("a string") is None

    def test_tuple_literal_payload(self):
        """imaplib can return (metadata, payload) for LIST entries."""
        attrs, name = parse_list_response(
            (b'(\\HasNoChildren) "/" "Folder"', b"ignored")
        )
        assert name == "Folder"


# ── Selection / idempotency ─────────────────────────────────────────────────

class TestSelect:
    def test_select_calls_mail_select(self):
        mail = _make_mail()
        client = _client(mail)
        client.select("INBOX")
        mail.select.assert_called_once_with("INBOX")
        assert client.selected == "INBOX"

    def test_select_is_idempotent(self):
        """Repeated select() on the same folder must not re-hit the server."""
        mail = _make_mail()
        client = _client(mail)
        client.select("INBOX")
        client.select("INBOX")
        assert mail.select.call_count == 1

    def test_select_switches_folder(self):
        mail = _make_mail()
        client = _client(mail)
        client.select("INBOX")
        client.select("Archive")
        assert mail.select.call_count == 2
        assert client.selected == "Archive"

    def test_select_no_response_raises(self):
        mail = _make_mail()
        mail.select.return_value = ("NO", [b"folder gone"])
        client = _client(mail)
        with pytest.raises(ImapError) as ei:
            client.select("Gone")
        assert "SELECT Gone" in str(ei.value)
        assert "folder gone" in str(ei.value)


# ── Capabilities ────────────────────────────────────────────────────────────

class TestCapabilities:
    def test_supports_move_true(self):
        mail = _make_mail(capabilities=b"IMAP4rev1 MOVE IDLE")
        assert _client(mail).supports_move() is True

    def test_supports_move_false(self):
        mail = _make_mail(capabilities=b"IMAP4rev1 IDLE")
        assert _client(mail).supports_move() is False

    def test_supports_idle_true(self):
        mail = _make_mail(capabilities=b"IMAP4rev1 IDLE")
        assert _client(mail).supports_idle() is True

    def test_supports_idle_false(self):
        mail = _make_mail(capabilities=b"IMAP4rev1")
        assert _client(mail).supports_idle() is False

    def test_capability_cached(self):
        """Repeated supports_*() calls hit the server only once."""
        mail = _make_mail()
        client = _client(mail)
        client.supports_move()
        client.supports_idle()
        client.supports_move()
        assert mail.capability.call_count == 1

    def test_capability_error_returns_false(self):
        """A broken capability() call shouldn't crash — just disable the feature."""
        mail = _make_mail()
        mail.capability.side_effect = Exception("boom")
        assert _client(mail).supports_move() is False


# ── Folder discovery ────────────────────────────────────────────────────────

class TestDiscoverFolders:
    def test_mailcow_default_layout(self):
        result = _client().discover_folders()
        assert result == {
            "inbox":   "INBOX",
            "sent":    "Sent",
            "drafts":  "Drafts",
            "junk":    "Junk",
            "trash":   "Trash",
            "archive": "Archive",
        }

    def test_gmail_layout(self):
        mail = _make_mail(list_response=[
            b'(\\HasNoChildren) "/" "INBOX"',
            b'(\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"',
            b'(\\HasNoChildren \\Junk) "/" "[Gmail]/Spam"',
            b'(\\HasNoChildren \\Trash) "/" "[Gmail]/Trash"',
            b'(\\HasNoChildren \\All) "/" "[Gmail]/All Mail"',
        ])
        result = _client(mail).discover_folders()
        assert result["sent"]    == "[Gmail]/Sent Mail"
        assert result["junk"]    == "[Gmail]/Spam"
        assert result["archive"] == "[Gmail]/All Mail"

    def test_outlook_layout(self):
        mail = _make_mail(list_response=[
            b'(\\HasNoChildren) "/" "Inbox"',
            b'(\\HasNoChildren \\Sent) "/" "Sent Items"',
            b'(\\HasNoChildren \\Junk) "/" "Junk Email"',
            b'(\\HasNoChildren \\Trash) "/" "Deleted Items"',
            b'(\\HasNoChildren \\Archive) "/" "Archive"',
        ])
        result = _client(mail).discover_folders()
        assert result["sent"]  == "Sent Items"
        assert result["junk"]  == "Junk Email"
        assert result["trash"] == "Deleted Items"

    def test_fallback_to_dovecot_defaults_when_no_special_use(self):
        mail = _make_mail(list_response=[b'(\\HasNoChildren) "/" "INBOX"'])
        result = _client(mail).discover_folders()
        assert result == {"inbox": "INBOX", **DEFAULT_FOLDERS}

    def test_config_override_wins(self):
        config = {**CONFIG, "folders": {"junk": "MyCustomJunk"}}
        result = _client(config=config).discover_folders()
        assert result["junk"] == "MyCustomJunk"

    def test_inbox_is_always_inbox(self):
        mail = _make_mail(list_response=[])
        assert _client(mail).discover_folders()["inbox"] == "INBOX"

    def test_list_failure_returns_defaults(self):
        mail = _make_mail()
        mail.list.side_effect = Exception("boom")
        result = _client(mail).discover_folders()
        assert result["junk"] == "Junk"
        assert result["archive"] == "Archive"

    def test_result_is_cached(self):
        mail = _make_mail()
        client = _client(mail)
        client.discover_folders()
        client.discover_folders()
        assert mail.list.call_count == 1

    def test_list_folders_uses_discovery_cache(self):
        """A single LIST pass populates both the role map AND the full list."""
        mail = _make_mail()
        client = _client(mail)
        client.discover_folders()
        names = client.list_folders()
        assert mail.list.call_count == 1
        assert set(names) == {"INBOX", "Sent", "Drafts", "Junk", "Trash", "Archive"}

    def test_list_folders_standalone_runs_discovery(self):
        """Called first without discovery, ``list_folders`` still works."""
        mail = _make_mail()
        client = _client(mail)
        names = client.list_folders()
        assert set(names) == {"INBOX", "Sent", "Drafts", "Junk", "Trash", "Archive"}


# ── Search / fetch ──────────────────────────────────────────────────────────

class TestSearchNew:
    def test_search_above_watermark(self):
        mail = _make_mail()
        mail.uid.return_value = ("OK", [b"42 43 44"])
        client = _client(mail)
        uids = client.search_new("INBOX", last_uid=41)
        # Expected to send UID SEARCH "UID 42:*"
        call = mail.uid.call_args_list[0]
        assert call.args[0] == "search"
        assert call.args[2] == "UID 42:*"
        assert uids == [42, 43, 44]

    def test_search_unseen_when_no_watermark(self):
        mail = _make_mail()
        mail.uid.return_value = ("OK", [b"1 2"])
        client = _client(mail)
        uids = client.search_new("INBOX", last_uid=0)
        call = mail.uid.call_args_list[0]
        assert call.args[2] == "UNSEEN"
        assert uids == [1, 2]

    def test_empty_search_returns_empty_list(self):
        mail = _make_mail()
        mail.uid.return_value = ("OK", [b""])
        assert _client(mail).search_new("INBOX", 0) == []

    def test_search_no_raises(self):
        mail = _make_mail()
        mail.uid.return_value = ("NO", [b"oops"])
        with pytest.raises(ImapError):
            _client(mail).search_new("INBOX", 0)


class TestFetchPeek:
    def _setup_fetch(self, mail, flags=""):
        meta = f"1 (UID 42 FLAGS ({flags}) BODY[] {{12}}".encode()
        body = b"raw email"
        mail.uid.return_value = ("OK", [(meta, body), b")"])

    def test_uses_body_peek(self):
        mail = _make_mail()
        self._setup_fetch(mail)
        _client(mail).fetch_peek("INBOX", 42)
        # The PEEK spec preserves \Seen — never RFC822 (which auto-marks)
        spec = mail.uid.call_args.args[2]
        assert "PEEK" in spec
        assert "FLAGS" in spec
        assert "RFC822" not in spec

    def test_returns_raw_bytes_and_seen_flag(self):
        mail = _make_mail()
        self._setup_fetch(mail, flags="\\Seen")
        raw, seen = _client(mail).fetch_peek("INBOX", 42)
        assert raw == b"raw email"
        assert seen is True

    def test_unseen_flag_reflected(self):
        mail = _make_mail()
        self._setup_fetch(mail, flags="")
        _, seen = _client(mail).fetch_peek("INBOX", 42)
        assert seen is False

    def test_empty_response_returns_none(self):
        mail = _make_mail()
        mail.uid.return_value = ("OK", [None])
        # The shape `[None]` mimics imaplib's "no such UID" response after EXPUNGE
        raw, seen = _client(mail).fetch_peek("INBOX", 999)
        assert raw is None or raw == b""  # tolerant: empty or None both acceptable
        assert seen is False


class TestFetchPeekMany:
    """Multi-UID fetch — collapses N round-trips into ⌈N/UID_BATCH⌉."""

    def _entry(self, uid, body, flags=""):
        """One imaplib FETCH response entry: (metadata_bytes, body_bytes)."""
        meta = f"1 (UID {uid} FLAGS ({flags}) BODY[] {{{len(body)}}}".encode()
        return (meta, body)

    def test_returns_dict_keyed_by_uid(self):
        mail = _make_mail()
        mail.uid.return_value = ("OK", [
            self._entry(10, b"body-10"), b")",
            self._entry(11, b"body-11"), b")",
        ])
        result = _client(mail).fetch_peek_many("INBOX", [10, 11])
        assert set(result.keys()) == {10, 11}
        assert result[10] == (b"body-10", False)
        assert result[11] == (b"body-11", False)

    def test_extracts_seen_flag_per_entry(self):
        mail = _make_mail()
        mail.uid.return_value = ("OK", [
            self._entry(10, b"a", flags="\\Seen"), b")",
            self._entry(11, b"b", flags=""),       b")",
        ])
        result = _client(mail).fetch_peek_many("INBOX", [10, 11])
        assert result[10][1] is True
        assert result[11][1] is False

    def test_single_uid_FETCH_per_chunk(self):
        """250 UIDs → at most ⌈250/100⌉ = 3 round-trips, not 250."""
        mail = _make_mail()
        # Same response payload each call — we're counting calls, not parsing
        mail.uid.return_value = ("OK", [self._entry(1, b"x"), b")"])
        _client(mail).fetch_peek_many("INBOX", list(range(1, 251)))
        fetch_calls = [c for c in mail.uid.call_args_list if c.args[0] == "fetch"]
        assert len(fetch_calls) == 3, (
            f"expected ≤3 batched FETCH calls, got {len(fetch_calls)}"
        )
        for c in fetch_calls:
            assert len(c.args[1].split(",")) <= UID_BATCH

    def test_empty_uids_is_noop(self):
        mail = _make_mail()
        assert _client(mail).fetch_peek_many("INBOX", []) == {}
        # No SELECT / no FETCH issued
        mail.select.assert_not_called()
        assert not any(c.args[0] == "fetch" for c in mail.uid.call_args_list)

    def test_uses_body_peek_in_spec(self):
        mail = _make_mail()
        mail.uid.return_value = ("OK", [self._entry(1, b"x"), b")"])
        _client(mail).fetch_peek_many("INBOX", [1])
        spec = next(c for c in mail.uid.call_args_list if c.args[0] == "fetch").args[2]
        assert "PEEK" in spec
        assert "FLAGS" in spec
        assert "RFC822" not in spec

    def test_uid_missing_from_response_omitted(self):
        """Servers may drop UIDs that were expunged between SEARCH and FETCH —
        the caller iterates the input and uses ``dict.get`` to skip.
        """
        mail = _make_mail()
        mail.uid.return_value = ("OK", [self._entry(10, b"body-10"), b")"])
        result = _client(mail).fetch_peek_many("INBOX", [10, 999])
        assert 10 in result
        assert 999 not in result

    def test_out_of_order_response_still_keyed_correctly(self):
        """Server is allowed to return entries in any order."""
        mail = _make_mail()
        mail.uid.return_value = ("OK", [
            self._entry(11, b"second"), b")",
            self._entry(10, b"first"),  b")",
        ])
        result = _client(mail).fetch_peek_many("INBOX", [10, 11])
        assert result[10] == (b"first",  False)
        assert result[11] == (b"second", False)

    def test_fetch_no_raises_imaperror(self):
        mail = _make_mail()
        mail.uid.return_value = ("NO", [b"some error"])
        with pytest.raises(ImapError):
            _client(mail).fetch_peek_many("INBOX", [1])

    def test_single_uid_via_convenience_wrapper(self):
        """``fetch_peek(...)`` is now a wrapper around fetch_peek_many."""
        mail = _make_mail()
        mail.uid.return_value = ("OK", [self._entry(42, b"hello"), b")"])
        raw, seen = _client(mail).fetch_peek("INBOX", 42)
        assert raw == b"hello"
        assert seen is False


# ── set_seen ────────────────────────────────────────────────────────────────

class TestSetSeen:
    def test_plus_flags_seen(self):
        mail = _make_mail()
        _client(mail).set_seen("INBOX", [42], seen=True)
        call = [c for c in mail.uid.call_args_list if c.args[0] == "store"][0]
        assert call.args[2] == "+FLAGS"
        assert call.args[3] == "\\Seen"
        assert "42" in call.args[1]

    def test_minus_flags_unseen(self):
        mail = _make_mail()
        _client(mail).set_seen("INBOX", [42], seen=False)
        call = [c for c in mail.uid.call_args_list if c.args[0] == "store"][0]
        assert call.args[2] == "-FLAGS"

    def test_selects_folder_first(self):
        mail = _make_mail()
        _client(mail).set_seen("INBOX", [1])
        mail.select.assert_called_once_with("INBOX")

    def test_empty_uids_is_noop(self):
        mail = _make_mail()
        _client(mail).set_seen("INBOX", [])
        # No SELECT, no STORE — nothing to do
        mail.select.assert_not_called()
        store_calls = [c for c in mail.uid.call_args_list if c.args[0] == "store"]
        assert store_calls == []

    def test_chunks_large_uid_sets(self):
        mail = _make_mail()
        _client(mail).set_seen("INBOX", list(range(1, 251)))
        store_calls = [c for c in mail.uid.call_args_list if c.args[0] == "store"]
        assert len(store_calls) == 3  # 100 + 100 + 50
        for c in store_calls:
            assert len(c.args[1].split(",")) <= UID_BATCH

    def test_no_response_raises_and_surfaces_detail(self):
        mail = _make_mail()
        mail.uid.return_value = ("NO", [b"quota exceeded"])
        with pytest.raises(ImapError) as ei:
            _client(mail).set_seen("INBOX", [1])
        assert "quota exceeded" in str(ei.value)


# ── move ────────────────────────────────────────────────────────────────────

class TestMove:
    def test_uid_move_when_supported(self):
        mail = _make_mail(capabilities=b"IMAP4rev1 MOVE IDLE")
        _client(mail).move("INBOX", [42], "Archive")
        verbs = [c.args[0] for c in mail.uid.call_args_list]
        assert "MOVE" in verbs
        assert "COPY" not in verbs

    def test_falls_back_to_copy_store_expunge(self):
        mail = _make_mail(capabilities=b"IMAP4rev1 IDLE")  # no MOVE
        _client(mail).move("INBOX", [42], "Archive")
        verbs = [c.args[0] for c in mail.uid.call_args_list]
        assert "COPY"  in verbs
        assert "STORE" in verbs
        mail.expunge.assert_called_once()
        assert "MOVE" not in verbs

    def test_chunks_large_uid_sets(self):
        mail = _make_mail(capabilities=b"IMAP4rev1 MOVE")
        _client(mail).move("INBOX", list(range(1, 251)), "Archive")
        move_calls = [c for c in mail.uid.call_args_list if c.args[0] == "MOVE"]
        assert len(move_calls) == 3
        for c in move_calls:
            assert len(c.args[1].split(",")) <= UID_BATCH

    def test_no_op_when_src_equals_dest(self):
        mail = _make_mail()
        _client(mail).move("INBOX", [42], "INBOX")
        # No MOVE/COPY/STORE/EXPUNGE issued
        assert all(c.args[0] not in ("MOVE", "COPY", "STORE") for c in mail.uid.call_args_list)
        mail.expunge.assert_not_called()

    def test_empty_uids_is_noop(self):
        mail = _make_mail()
        _client(mail).move("INBOX", [], "Archive")
        assert all(c.args[0] not in ("MOVE", "COPY") for c in mail.uid.call_args_list)

    def test_move_failure_raises(self):
        mail = _make_mail()
        mail.uid.return_value = ("NO", [b"folder gone"])
        with pytest.raises(ImapError):
            _client(mail).move("INBOX", [42], "Archive")


# ── Context manager ─────────────────────────────────────────────────────────

class TestContextManager:
    def test_enter_returns_self(self):
        mail = _make_mail()
        client = _client(mail)
        with client as c:
            assert c is client

    def test_exit_calls_logout(self):
        mail = _make_mail()
        client = _client(mail)
        with client:
            pass
        mail.logout.assert_called_once()

    def test_logout_is_idempotent(self):
        mail = _make_mail()
        client = _client(mail)
        client.logout()
        client.logout()  # second call should be a no-op
        mail.logout.assert_called_once()

    def test_logout_clears_selected(self):
        mail = _make_mail()
        client = _client(mail)
        client.select("INBOX")
        client.logout()
        assert client.selected is None


# ── ImapError surfacing ─────────────────────────────────────────────────────

class TestErrorSurfacing:
    def test_malformed_response_raises(self):
        """A non-tuple response (or wrong length) is caught — not silently ignored."""
        mail = _make_mail()
        mail.uid.return_value = "garbage"  # not a (status, data) tuple
        with pytest.raises(ImapError) as ei:
            _client(mail).set_seen("INBOX", [1])
        assert "malformed response" in str(ei.value)

    def test_error_message_includes_operation(self):
        mail = _make_mail()
        mail.select.return_value = ("NO", [b"oops"])
        with pytest.raises(ImapError) as ei:
            _client(mail).select("Bad")
        # Operation context is in the message so users know what failed
        assert "SELECT Bad" in str(ei.value)
