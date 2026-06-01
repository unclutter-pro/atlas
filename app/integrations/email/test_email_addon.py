"""Tests for email-addon.py

Run with:
    cd app/integrations/email
    pip install pytest
    pytest test_email_addon.py -v
"""
import importlib.util
import json
import os
import re
import sqlite3
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Stub out runtime-only deps before loading the module so imports don't fail.
sys.modules.setdefault("html2text", MagicMock())
sys.modules.setdefault("yaml", MagicMock())

_spec = importlib.util.spec_from_file_location(
    "email_addon", Path(__file__).parent / "email-addon.py"
)
email_addon = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(email_addon)


# ---------------------------------------------------------------------------
# Shared config + fixtures
# ---------------------------------------------------------------------------

CONFIG = {
    "smtp_host": "smtp.test.local",
    "smtp_port": 587,
    "imap_host": "imap.test.local",
    "imap_port": 993,
    "username": "agent@test.local",
    "password": "secret",
    "folder": "INBOX",
    "whitelist": [],
    "mark_read": True,
    "idle_timeout": 1500,
    "ssl_verify": True,
    "imap_starttls": False,
}


@pytest.fixture
def db_dir(tmp_path, monkeypatch):
    """Redirect EMAIL_DB_DIR to a temp directory for test isolation."""
    monkeypatch.setattr(email_addon, "EMAIL_DB_DIR", str(tmp_path))
    return tmp_path


@pytest.fixture
def db(db_dir):
    """Pre-initialised :class:`EmailDb` (schema + migrations applied).

    Tests that need raw SQL (a small minority) reach the underlying
    connection via ``db.conn``; everything else should call the typed
    methods directly.
    """
    instance = email_addon.open_email_db(CONFIG)
    yield instance
    instance.close()


@pytest.fixture
def smtp(monkeypatch):
    """Replace _smtp_connect with a mock SMTP context manager."""
    server = MagicMock()
    server.__enter__ = MagicMock(return_value=server)
    server.__exit__ = MagicMock(return_value=False)
    monkeypatch.setattr(email_addon, "_smtp_connect", lambda _cfg: server)
    return server


@pytest.fixture
def imap(monkeypatch):
    """Mock :class:`ImapClient` used by every cmd_* triage / poll test.

    All IMAP protocol details live in ``imap_client.py`` now, so tests at
    this layer don't care about ``mail.uid("store", ...)`` plumbing —
    they assert on the *client API* (``set_seen``, ``move``,
    ``discover_folders``, ``fetch_peek`` …). Detailed protocol-level
    behaviour (SPECIAL-USE parsing, UID chunking, MOVE fallback, etc.) is
    covered by ``test_imap_client.py`` instead.

    The returned MagicMock acts both as a context manager (for
    ``with _imap_client(cfg) as c:`` callers) and as a plain client
    (for ``cmd_poll_idle``'s long-lived ``connect()`` / ``logout()``
    flow). Default returns match a Mailcow / Dovecot server profile.
    """
    client = MagicMock()
    client.discover_folders.return_value = {
        "inbox":   "INBOX",
        "sent":    "Sent",
        "drafts":  "Drafts",
        "junk":    "Junk",
        "trash":   "Trash",
        "archive": "Archive",
    }
    client.list_folders.return_value = [
        "INBOX", "Sent", "Drafts", "Junk", "Trash", "Archive",
    ]
    client.supports_move.return_value = True
    client.supports_idle.return_value = True
    # Default: no new mail when search runs, empty fetch_peek_many result.
    # Tests override these per-case.
    client.search_new.return_value = []
    client.fetch_peek_many.return_value = {}
    # ``move()`` now returns a {src_uid: dst_uid} mapping (COPYUID — RFC
    # 4315 / 6851). Default to an empty mapping so triage tests that don't
    # care about the new UID still pass; tests that assert the rebind
    # override this per-case.
    client.move.return_value = {}
    # Context-manager support: ``with _imap_client(cfg) as imap:``
    client.__enter__ = MagicMock(return_value=client)
    client.__exit__ = MagicMock(return_value=False)
    monkeypatch.setattr(email_addon, "_imap_client", lambda _cfg: client)
    return client


def _open_db(db_dir):
    """Open the test DB file for direct assertions."""
    account = re.sub(r"[^a-zA-Z0-9@._-]", "_", CONFIG["username"])
    return sqlite3.connect(str(db_dir / f"{account}.db"))


# ---------------------------------------------------------------------------
# Pure-function unit tests
# ---------------------------------------------------------------------------

class TestSanitizeThreadId:
    def test_strips_angle_brackets(self):
        assert email_addon.sanitize_thread_id("<abc@x.com>") == "abc@x.com"

    def test_replaces_special_chars(self):
        result = email_addon.sanitize_thread_id("<hello world/foo>")
        assert " " not in result
        assert "/" not in result

    def test_truncates_at_128(self):
        assert len(email_addon.sanitize_thread_id("a" * 200)) == 128

    def test_allows_safe_chars(self):
        result = email_addon.sanitize_thread_id("<abc123.def-ghi@x.com>")
        assert result == "abc123.def-ghi@x.com"


class TestCleanSubject:
    def test_strips_re(self):
        assert email_addon._clean_subject("Re: Hello") == "Hello"

    def test_strips_fwd(self):
        assert email_addon._clean_subject("Fwd: Hello") == "Hello"

    def test_strips_fw(self):
        assert email_addon._clean_subject("Fw: Hello") == "Hello"

    def test_strips_aw(self):
        assert email_addon._clean_subject("AW: Hello") == "Hello"

    def test_strips_wg(self):
        assert email_addon._clean_subject("WG: Hello") == "Hello"

    def test_strips_nested(self):
        assert email_addon._clean_subject("Re: Fwd: Hello") == "Hello"

    def test_leaves_clean_subject_unchanged(self):
        assert email_addon._clean_subject("Hello World") == "Hello World"

    def test_case_insensitive(self):
        assert email_addon._clean_subject("re: Hello") == "Hello"

    def test_pathological_prefix_chain_does_not_recurse(self):
        """A subject with 200 ``Re:`` prefixes used to crash the entire
        poll mid-ingestion (Python recursion limit ~1000, plus stack
        frames from the recursive call). Iterative replacement must
        handle this without RecursionError.
        """
        pathological = ("Re: " * 200) + "Hello"
        assert email_addon._clean_subject(pathological) == "Hello"

    def test_mixed_prefix_chain(self):
        assert email_addon._clean_subject("Re: Fwd: AW: WG: Subject") == "Subject"


class TestParseAddressList:
    def test_empty_string_returns_empty(self):
        assert email_addon._parse_address_list("") == []

    def test_none_returns_empty(self):
        assert email_addon._parse_address_list(None) == []

    def test_plain_address(self):
        assert email_addon._parse_address_list("alice@x.com") == ["alice@x.com"]

    def test_display_name_form(self):
        assert email_addon._parse_address_list("Alice <alice@x.com>") == ["alice@x.com"]

    def test_multiple_addresses(self):
        result = email_addon._parse_address_list("alice@x.com, bob@y.com")
        assert set(result) == {"alice@x.com", "bob@y.com"}

    def test_mixed_forms(self):
        result = email_addon._parse_address_list("Alice <alice@x.com>, bob@y.com")
        assert set(result) == {"alice@x.com", "bob@y.com"}


class TestExtractThreadId:
    def _msg(self, headers):
        import email as _emaillib
        raw = "\n".join(f"{k}: {v}" for k, v in headers.items()) + "\n\nBody"
        return _emaillib.message_from_string(raw)

    def test_new_email_derives_id_from_message_id(self, db):
        msg = self._msg({"From": "a@x.com", "Message-ID": "<new123@x.com>", "Subject": "Hi"})
        tid = email_addon.extract_thread_id(msg, db)
        assert "new123" in tid

    def test_no_message_id_generates_timestamp_id(self, db):
        msg = self._msg({"From": "a@x.com", "Subject": "Hi"})
        tid = email_addon.extract_thread_id(msg, db)
        assert tid.startswith("email-")

    def test_reply_threaded_by_in_reply_to(self, db):
        db.conn.execute(
            "INSERT INTO emails (thread_id, message_id, direction, sender, subject, body) "
            "VALUES ('thread-abc', '<orig@x.com>', 'in', 'a@x.com', 'Subj', 'Body')"
        )
        db.commit()
        msg = self._msg({
            "From": "a@x.com",
            "In-Reply-To": "<orig@x.com>",
            "Message-ID": "<reply@x.com>",
            "Subject": "Re: Subj",
        })
        assert email_addon.extract_thread_id(msg, db) == "thread-abc"

    def test_subject_fallback_for_relay_rewrite(self, db):
        """When refs don't match (e.g. SES rewrites Message-ID), fall back to subject."""
        db.conn.execute(
            "INSERT INTO threads (thread_id, subject, last_message_id, "
            "references_chain, last_sender, last_sender_full, participants, message_count) "
            "VALUES ('thread-subj', 'Original Topic', '<orig@x.com>', '[]', "
            "'a@x.com', 'a@x.com', '[]', 1)"
        )
        db.commit()
        msg = self._msg({
            "From": "a@x.com",
            "In-Reply-To": "<rewritten@ses.amazonaws.com>",
            "Message-ID": "<new@x.com>",
            "Subject": "Re: Original Topic",
        })
        assert email_addon.extract_thread_id(msg, db) == "thread-subj"


class TestUpdateThread:
    def _msg(self, headers):
        import email as _emaillib
        raw = "\n".join(f"{k}: {v}" for k, v in headers.items()) + "\n\nBody"
        return _emaillib.message_from_string(raw)

    def test_new_thread_created(self, db):
        msg = self._msg({"From": "a@x.com", "Message-ID": "<m1@x.com>", "Subject": "Hello"})
        email_addon.update_thread(db, "t1", msg)
        db.commit()
        row = db.conn.execute("SELECT subject FROM threads WHERE thread_id='t1'").fetchone()
        assert row[0] == "Hello"

    def test_cc_addresses_added_to_participants(self, db):
        msg = self._msg({
            "From": "a@x.com",
            "Cc": "bob@x.com, carol@x.com",
            "Message-ID": "<m1@x.com>",
            "Subject": "Hello",
        })
        email_addon.update_thread(db, "t1", msg)
        db.commit()
        row = db.conn.execute("SELECT participants, last_cc FROM threads WHERE thread_id='t1'").fetchone()
        participants = json.loads(row[0])
        assert "bob@x.com" in participants
        assert "carol@x.com" in participants
        assert "bob@x.com" in row[1]

    def test_existing_thread_increments_count(self, db):
        msg = self._msg({"From": "a@x.com", "Message-ID": "<m1@x.com>", "Subject": "Hello"})
        email_addon.update_thread(db, "t1", msg)
        email_addon.update_thread(db, "t1", msg)
        db.commit()
        row = db.conn.execute("SELECT message_count FROM threads WHERE thread_id='t1'").fetchone()
        assert row[0] == 2

    def test_subject_stored_without_re_prefix(self, db):
        msg = self._msg({"From": "a@x.com", "Message-ID": "<m1@x.com>", "Subject": "Re: Hello"})
        email_addon.update_thread(db, "t1", msg)
        db.commit()
        row = db.conn.execute("SELECT subject FROM threads WHERE thread_id='t1'").fetchone()
        assert row[0] == "Hello"


# ---------------------------------------------------------------------------
# Command tests
# ---------------------------------------------------------------------------

class TestCmdSend:
    def test_calls_send_message(self, db_dir, smtp):
        email_addon.cmd_send(CONFIG, "bob@x.com", "Hello", "Body")
        smtp.send_message.assert_called_once()

    def test_creates_thread_and_email_rows(self, db_dir, smtp):
        email_addon.cmd_send(CONFIG, "bob@x.com", "Hello", "Body")
        conn = _open_db(db_dir)
        assert conn.execute("SELECT COUNT(*) FROM threads").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM emails").fetchone()[0] == 1
        conn.close()

    def test_output_contains_thread_id_and_reply_hint(self, db_dir, smtp, capsys):
        email_addon.cmd_send(CONFIG, "bob@x.com", "Hello", "Body")
        out = capsys.readouterr().out
        assert "Thread:" in out
        assert 'email reply "' in out

    def test_cc_header_and_db_row(self, db_dir, smtp, capsys):
        email_addon.cmd_send(CONFIG, "bob@x.com", "Hello", "Body", cc=["carol@x.com"])
        msg = smtp.send_message.call_args[0][0]
        assert msg["Cc"] == "carol@x.com"
        conn = _open_db(db_dir)
        cc_in_db = conn.execute("SELECT cc FROM emails").fetchone()[0]
        conn.close()
        assert "carol@x.com" in cc_in_db
        assert "Cc:" in capsys.readouterr().out

    def test_bcc_header_set(self, db_dir, smtp):
        email_addon.cmd_send(CONFIG, "bob@x.com", "Hello", "Body", bcc=["hidden@x.com"])
        msg = smtp.send_message.call_args[0][0]
        assert msg["Bcc"] == "hidden@x.com"

    def test_bcc_not_stored_in_participants(self, db_dir, smtp):
        email_addon.cmd_send(CONFIG, "bob@x.com", "Hello", "Body", bcc=["hidden@x.com"])
        conn = _open_db(db_dir)
        row = conn.execute("SELECT participants FROM threads").fetchone()
        conn.close()
        assert "hidden@x.com" not in row[0]

    def test_multiple_cc_recipients(self, db_dir, smtp):
        email_addon.cmd_send(CONFIG, "bob@x.com", "Hi", "Body",
                             cc=["a@x.com", "b@x.com"])
        msg = smtp.send_message.call_args[0][0]
        assert "a@x.com" in msg["Cc"]
        assert "b@x.com" in msg["Cc"]

    def test_smtp_error_exits(self, db_dir, monkeypatch):
        monkeypatch.setattr(email_addon, "_smtp_connect", lambda _: (_ for _ in ()).throw(Exception("refused")))
        with pytest.raises(SystemExit):
            email_addon.cmd_send(CONFIG, "bob@x.com", "Hello", "Body")


class TestCmdReply:
    def _seed(self, db_dir, last_cc=""):
        conn = email_addon.open_email_db(CONFIG).conn
        conn.execute("""
            INSERT INTO threads
              (thread_id, subject, last_message_id, references_chain,
               last_sender, last_sender_full, last_cc, participants, message_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        """, (
            "thread-1", "Hello", "<orig@x.com>", json.dumps(["<orig@x.com>"]),
            "alice@x.com", "alice@x.com", last_cc,
            json.dumps(["agent@test.local", "alice@x.com"]),
        ))
        conn.commit()
        conn.close()

    def test_sends_reply(self, db_dir, smtp):
        self._seed(db_dir)
        email_addon.cmd_reply(CONFIG, "thread-1", "Thanks!")
        smtp.send_message.assert_called_once()

    def test_reply_all_auto_ccs_thread_cc(self, db_dir, smtp):
        self._seed(db_dir, last_cc="bob@x.com, carol@x.com")
        email_addon.cmd_reply(CONFIG, "thread-1", "Reply")
        msg = smtp.send_message.call_args[0][0]
        assert "bob@x.com" in (msg["Cc"] or "")
        assert "carol@x.com" in (msg["Cc"] or "")

    def test_reply_all_excludes_self(self, db_dir, smtp):
        self._seed(db_dir, last_cc="agent@test.local, bob@x.com")
        email_addon.cmd_reply(CONFIG, "thread-1", "Reply")
        msg = smtp.send_message.call_args[0][0]
        assert "agent@test.local" not in (msg["Cc"] or "")

    def test_reply_all_excludes_to_recipient(self, db_dir, smtp):
        # last_sender (alice) becomes To: — shouldn't be CC'd again
        self._seed(db_dir, last_cc="alice@x.com, bob@x.com")
        email_addon.cmd_reply(CONFIG, "thread-1", "Reply")
        msg = smtp.send_message.call_args[0][0]
        assert "alice@x.com" not in (msg["Cc"] or "")

    def test_no_cc_flag_suppresses_reply_all(self, db_dir, smtp):
        self._seed(db_dir, last_cc="bob@x.com")
        email_addon.cmd_reply(CONFIG, "thread-1", "Reply", no_cc=True)
        msg = smtp.send_message.call_args[0][0]
        assert not msg["Cc"]

    def test_explicit_cc_overrides_auto(self, db_dir, smtp):
        self._seed(db_dir, last_cc="bob@x.com")
        email_addon.cmd_reply(CONFIG, "thread-1", "Reply", cc=["custom@x.com"])
        msg = smtp.send_message.call_args[0][0]
        assert "custom@x.com" in msg["Cc"]
        assert "bob@x.com" not in msg["Cc"]

    def test_bcc_added(self, db_dir, smtp):
        self._seed(db_dir)
        email_addon.cmd_reply(CONFIG, "thread-1", "Reply", bcc=["audit@x.com"])
        msg = smtp.send_message.call_args[0][0]
        assert "audit@x.com" in msg["Bcc"]

    def test_thread_not_found_exits(self, db_dir, smtp, monkeypatch):
        monkeypatch.setattr(email_addon, "EMAIL_DB_DIR", str(db_dir))
        email_addon.open_email_db(CONFIG).close()  # create schema only
        with pytest.raises(SystemExit):
            email_addon.cmd_reply(CONFIG, "nonexistent", "Reply")

    def test_updates_last_cc_in_db(self, db_dir, smtp):
        self._seed(db_dir, last_cc="old@x.com")
        email_addon.cmd_reply(CONFIG, "thread-1", "Reply", cc=["new@x.com"])
        conn = _open_db(db_dir)
        row = conn.execute("SELECT last_cc FROM threads WHERE thread_id='thread-1'").fetchone()
        conn.close()
        assert "new@x.com" in row[0]

    def test_output_contains_thread_id_and_follow_up_hint(self, db_dir, smtp, capsys):
        self._seed(db_dir)
        email_addon.cmd_reply(CONFIG, "thread-1", "Reply")
        out = capsys.readouterr().out
        assert "thread-1" in out
        assert "Follow up" in out

    def test_in_reply_to_header_set(self, db_dir, smtp):
        self._seed(db_dir)
        email_addon.cmd_reply(CONFIG, "thread-1", "Reply")
        msg = smtp.send_message.call_args[0][0]
        assert msg["In-Reply-To"] == "<orig@x.com>"


class TestCmdThreads:
    def _seed(self, db_dir, n=2):
        conn = email_addon.open_email_db(CONFIG).conn
        for i in range(n):
            conn.execute("""
                INSERT INTO threads
                  (thread_id, subject, last_message_id, references_chain,
                   last_sender, last_sender_full, participants, message_count)
                VALUES (?, ?, ?, '[]', ?, ?, '[]', ?)
            """, (f"thread-{i}", f"Subject {i}", f"<m{i}@x>", f"user{i}@x.com", f"user{i}@x.com", i + 1))
        conn.commit()
        conn.close()

    def test_empty(self, db_dir, capsys):
        email_addon.open_email_db(CONFIG).close()
        email_addon.cmd_threads(CONFIG)
        assert "No email threads found" in capsys.readouterr().out

    def test_lists_all_threads(self, db_dir, capsys):
        self._seed(db_dir)
        email_addon.cmd_threads(CONFIG)
        out = capsys.readouterr().out
        assert "thread-0" in out
        assert "thread-1" in out

    def test_thread_id_never_truncated(self, db_dir, capsys):
        long_id = "a" * 100
        conn = email_addon.open_email_db(CONFIG).conn
        conn.execute("""
            INSERT INTO threads (thread_id, subject, last_message_id,
              references_chain, last_sender, last_sender_full, participants, message_count)
            VALUES (?, 'Subj', '<m@x>', '[]', 'a@x', 'a@x', '[]', 1)
        """, (long_id,))
        conn.commit()
        conn.close()
        email_addon.cmd_threads(CONFIG)
        assert long_id in capsys.readouterr().out

    def test_limit_respected(self, db_dir, capsys):
        self._seed(db_dir, n=5)
        email_addon.cmd_threads(CONFIG, limit=2)
        out = capsys.readouterr().out
        matched = sum(1 for i in range(5) if f"thread-{i}" in out)
        assert matched == 2

    def test_output_includes_command_hints(self, db_dir, capsys):
        self._seed(db_dir)
        email_addon.cmd_threads(CONFIG)
        out = capsys.readouterr().out
        assert "email thread" in out
        assert "email reply" in out


class TestCmdInbox:
    """``email inbox`` is the focused to-do list: threads with unread messages
    in INBOX. Anything archived, trashed, or already read is filtered out.
    """

    def _seed_mixed_state(self, db_dir):
        """Three threads spanning every inbox-relevant state."""
        conn = email_addon.open_email_db(CONFIG).conn
        conn.executescript("""
            INSERT INTO threads (thread_id, subject, last_message_id, references_chain,
              last_sender, last_sender_full, participants, message_count) VALUES
              ('inbox-unread', 'Need answer', '<m1@x>', '[]', 'a@x', 'a@x', '[]', 1),
              ('inbox-read',   'Done',        '<m2@x>', '[]', 'a@x', 'a@x', '[]', 1),
              ('archived',     'Old',         '<m3@x>', '[]', 'a@x', 'a@x', '[]', 1);
            INSERT INTO emails (thread_id, message_id, direction, sender, recipient,
              subject, body, folder, is_read) VALUES
              ('inbox-unread', '<m1@x>', 'in', 'a@x', 'me', 'Need answer', 'B', 'INBOX',   0),
              ('inbox-read',   '<m2@x>', 'in', 'a@x', 'me', 'Done',        'B', 'INBOX',   1),
              ('archived',     '<m3@x>', 'in', 'a@x', 'me', 'Old',         'B', 'Archive', 0);
        """)
        conn.commit()
        conn.close()

    def test_inbox_shows_only_unread_inbox_threads(self, db_dir, capsys):
        self._seed_mixed_state(db_dir)
        email_addon.cmd_inbox(CONFIG)
        out = capsys.readouterr().out
        assert "inbox-unread" in out
        assert "inbox-read" not in out      # already read → filtered
        assert "archived" not in out        # not in INBOX → filtered

    def test_inbox_is_not_a_plain_alias_for_threads(self, db_dir, capsys):
        """Regression guard: inbox must differ from threads when state varies."""
        self._seed_mixed_state(db_dir)
        email_addon.cmd_inbox(CONFIG)
        inbox_out = capsys.readouterr().out
        email_addon.cmd_threads(CONFIG)
        threads_out = capsys.readouterr().out
        assert inbox_out != threads_out

    def test_inbox_empty_state_message_mentions_filters(self, db_dir, capsys):
        """When nothing matches, the caption tells the agent what got filtered."""
        email_addon.open_email_db(CONFIG).close()
        email_addon.cmd_inbox(CONFIG)
        out = capsys.readouterr().out
        assert "No email threads found" in out
        assert "INBOX" in out
        assert "unread" in out

    def test_inbox_dispatch_via_main(self, db_dir, monkeypatch, capsys):
        """Argparse routes 'inbox' to cmd_inbox without error."""
        email_addon.open_email_db(CONFIG).close()
        monkeypatch.setattr(email_addon, "load_config", lambda: CONFIG)
        monkeypatch.setattr(sys, "argv", ["email", "inbox"])
        email_addon.main()
        assert "No email threads found" in capsys.readouterr().out


class TestCmdThreadDetail:
    def _seed(self, db_dir):
        conn = email_addon.open_email_db(CONFIG).conn
        conn.execute("""
            INSERT INTO threads (thread_id, subject, last_message_id,
              references_chain, last_sender, last_sender_full, participants, message_count)
            VALUES ('t1', 'Hello', '<m2@x>', '[]', 'alice@x.com', 'alice@x.com',
                    '["agent@test.local","alice@x.com","bob@x.com"]', 2)
        """)
        conn.execute("""
            INSERT INTO emails (thread_id, message_id, direction, sender, recipient, cc, subject, body)
            VALUES ('t1', '<m1@x>', 'in', 'alice@x.com', 'agent@test.local',
                    'bob@x.com', 'Hello', 'Hi there')
        """)
        conn.execute("""
            INSERT INTO emails (thread_id, message_id, direction, sender, recipient, cc, subject, body)
            VALUES ('t1', '<m2@x>', 'out', 'agent@test.local', 'alice@x.com',
                    'bob@x.com', 'Re: Hello', 'Thanks!')
        """)
        conn.commit()
        conn.close()

    def test_shows_subject_and_participants(self, db_dir, capsys):
        self._seed(db_dir)
        email_addon.cmd_thread_detail(CONFIG, "t1")
        out = capsys.readouterr().out
        assert "Hello" in out
        assert "alice@x.com" in out

    def test_shows_cc_on_each_email(self, db_dir, capsys):
        self._seed(db_dir)
        email_addon.cmd_thread_detail(CONFIG, "t1")
        out = capsys.readouterr().out
        assert out.count("bob@x.com") >= 2  # appears on both messages

    def test_reply_hint_contains_thread_id(self, db_dir, capsys):
        self._seed(db_dir)
        email_addon.cmd_thread_detail(CONFIG, "t1")
        out = capsys.readouterr().out
        assert 'email reply "t1"' in out

    def test_inbound_shown_with_arrow(self, db_dir, capsys):
        self._seed(db_dir)
        email_addon.cmd_thread_detail(CONFIG, "t1")
        out = capsys.readouterr().out
        assert "←" in out

    def test_outbound_shown_with_arrow(self, db_dir, capsys):
        self._seed(db_dir)
        email_addon.cmd_thread_detail(CONFIG, "t1")
        out = capsys.readouterr().out
        assert "→" in out

    def test_thread_not_found_exits(self, db_dir):
        email_addon.open_email_db(CONFIG).close()
        with pytest.raises(SystemExit):
            email_addon.cmd_thread_detail(CONFIG, "nonexistent")


class TestCmdReadEmail:
    def _seed(self, db_dir, cc="bob@x.com"):
        conn = email_addon.open_email_db(CONFIG).conn
        conn.execute("""
            INSERT INTO threads (thread_id, subject, last_message_id,
              references_chain, last_sender, last_sender_full, participants, message_count)
            VALUES ('t1', 'Hello', '<m1@x>', '[]', 'alice@x.com', 'alice@x.com', '[]', 1)
        """)
        conn.execute("""
            INSERT INTO emails (thread_id, message_id, direction, sender, recipient, cc, subject, body)
            VALUES ('t1', '<m1@x>', 'in', 'alice@x.com', 'agent@test.local', ?, 'Hello', 'Hi there')
        """, (cc,))
        conn.commit()
        conn.close()

    def test_shows_subject_and_sender(self, db_dir, capsys):
        self._seed(db_dir)
        email_addon.cmd_read_email(CONFIG, 1)
        out = capsys.readouterr().out
        assert "Hello" in out
        assert "alice@x.com" in out

    def test_shows_cc_when_present(self, db_dir, capsys):
        self._seed(db_dir, cc="bob@x.com")
        email_addon.cmd_read_email(CONFIG, 1)
        assert "bob@x.com" in capsys.readouterr().out

    def test_no_cc_line_when_empty(self, db_dir, capsys):
        self._seed(db_dir, cc="")
        email_addon.cmd_read_email(CONFIG, 1)
        assert "**Cc:**" not in capsys.readouterr().out

    def test_shows_thread_id(self, db_dir, capsys):
        self._seed(db_dir)
        email_addon.cmd_read_email(CONFIG, 1)
        assert "t1" in capsys.readouterr().out

    def test_reply_hint_contains_thread_id(self, db_dir, capsys):
        self._seed(db_dir)
        email_addon.cmd_read_email(CONFIG, 1)
        assert 'email reply "t1"' in capsys.readouterr().out

    def test_not_found_exits(self, db_dir):
        email_addon.open_email_db(CONFIG).close()
        with pytest.raises(SystemExit):
            email_addon.cmd_read_email(CONFIG, 999)


# ---------------------------------------------------------------------------
# Database migration tests
# ---------------------------------------------------------------------------

class TestMigrations:
    def test_legacy_db_gets_new_columns(self, tmp_path, monkeypatch):
        """Opening a pre-CC-era DB via get_email_db adds the missing columns."""
        monkeypatch.setattr(email_addon, "EMAIL_DB_DIR", str(tmp_path))
        account = re.sub(r"[^a-zA-Z0-9@._-]", "_", CONFIG["username"])
        db_path = tmp_path / f"{account}.db"

        # Create a legacy schema without cc / body_html / last_cc
        conn = sqlite3.connect(str(db_path))
        conn.executescript("""
            CREATE TABLE threads (
                thread_id TEXT PRIMARY KEY,
                subject TEXT NOT NULL DEFAULT '',
                last_message_id TEXT NOT NULL DEFAULT '',
                references_chain TEXT NOT NULL DEFAULT '[]',
                last_sender TEXT NOT NULL DEFAULT '',
                last_sender_full TEXT NOT NULL DEFAULT '',
                participants TEXT NOT NULL DEFAULT '[]',
                message_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE emails (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_id TEXT NOT NULL,
                message_id TEXT NOT NULL DEFAULT '',
                direction TEXT NOT NULL DEFAULT 'in',
                sender TEXT NOT NULL DEFAULT '',
                recipient TEXT NOT NULL DEFAULT '',
                subject TEXT NOT NULL DEFAULT '',
                body TEXT NOT NULL DEFAULT '',
                headers_json TEXT NOT NULL DEFAULT '{}',
                inbox_msg_id INTEGER,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
        """)
        conn.commit()
        conn.close()

        # Run migrations via get_email_db
        conn = email_addon.open_email_db(CONFIG).conn
        # All new columns must now exist
        conn.execute("SELECT cc FROM emails LIMIT 0")
        conn.execute("SELECT body_html FROM emails LIMIT 0")
        conn.execute("SELECT last_cc FROM threads LIMIT 0")
        conn.execute("SELECT imap_uid FROM emails LIMIT 0")
        conn.execute("SELECT is_read FROM emails LIMIT 0")
        conn.execute("SELECT folder FROM emails LIMIT 0")
        conn.close()

    def test_migration_is_idempotent(self, db_dir):
        """Opening an already-migrated DB a second time must not raise."""
        email_addon.open_email_db(CONFIG).close()
        email_addon.open_email_db(CONFIG).close()  # second open — should not error

    def test_migration_backfills_outgoing_folder_to_sent(self, tmp_path, monkeypatch):
        """Legacy 'out' rows must end up in 'Sent', not INBOX, after migration.

        The default value of the new ``folder`` column is INBOX. Without a
        backfill, every pre-migration outgoing row would falsely appear in
        the INBOX filter — and ``email threads --folder INBOX`` would return
        sent messages, which is wrong.
        """
        monkeypatch.setattr(email_addon, "EMAIL_DB_DIR", str(tmp_path))
        account = re.sub(r"[^a-zA-Z0-9@._-]", "_", CONFIG["username"])
        db_path = tmp_path / f"{account}.db"

        conn = sqlite3.connect(str(db_path))
        conn.executescript("""
            CREATE TABLE threads (thread_id TEXT PRIMARY KEY);
            CREATE TABLE emails (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_id TEXT NOT NULL,
                direction TEXT NOT NULL DEFAULT 'in'
            );
            CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
            INSERT INTO emails (thread_id, direction) VALUES ('t1', 'out'), ('t1', 'in');
        """)
        conn.commit()
        conn.close()

        conn = email_addon.open_email_db(CONFIG).conn
        rows = dict(conn.execute("SELECT direction, folder FROM emails").fetchall())
        conn.close()

        assert rows["out"] == "Sent"
        assert rows["in"] == "INBOX"


# ---------------------------------------------------------------------------
# Folder discovery (IMAP SPECIAL-USE, RFC 6154)
# ---------------------------------------------------------------------------

class TestFolderDiscoveryIntegration:
    """End-to-end: ``email.folders`` config override flows through
    ``load_config()`` and reaches the ImapClient unchanged.

    Protocol-level behaviour of ``ImapClient.discover_folders`` itself
    (SPECIAL-USE parsing, Mailcow/Gmail/Outlook layouts, defaults,
    caching) is exercised in ``test_imap_client.py``.
    """

    @staticmethod
    def _client_for(config):
        """Build an ImapClient backed by a mock connection that advertises
        Junk + Archive — enough to verify the override flows through.
        """
        from imap_client import ImapClient
        mail = MagicMock()
        mail.list.return_value = ("OK", [
            b'(\\HasNoChildren \\Junk)    "/" "Junk"',
            b'(\\HasNoChildren \\Archive) "/" "Archive"',
        ])
        return ImapClient(config, _connection=mail)

    def test_folders_override_survives_load_config_via_runtime_json(self, tmp_path, monkeypatch):
        """End-to-end through the runtime-config (JSON) layer.

        Regression guard for the bug where load_config()'s explicit dict
        literal dropped the new key, making the override silently inert in
        production while every direct-call unit test still passed.
        """
        rt_path = tmp_path / "rt.json"
        rt_path.write_text(json.dumps({
            "email": {
                "imap_host": "imap.test",
                "smtp_host": "smtp.test",
                "username": "agent@test.local",
                "folders": {"junk": "MyCustomJunk", "archive": "MyArchive"},
            }
        }))
        monkeypatch.setattr(email_addon, "CONFIG_PATH", str(tmp_path / "nonexistent.yml"))
        monkeypatch.setattr(email_addon, "RUNTIME_CONFIG_PATH", str(rt_path))

        loaded = email_addon.load_config()
        assert loaded["folders"] == {"junk": "MyCustomJunk", "archive": "MyArchive"}

        # The override must flow through to the ImapClient (the only thing
        # downstream that consumes config["folders"]).
        result = self._client_for(loaded).discover_folders()
        assert result["junk"] == "MyCustomJunk"
        assert result["archive"] == "MyArchive"

    def test_folders_override_survives_load_config_via_config_yml(
        self, tmp_path, monkeypatch, request
    ):
        """Parallel end-to-end through the YAML config.yml layer — the
        documented user-facing surface.

        Skips when pyyaml isn't installed (local dev envs); CI/production
        always have it. The runtime-JSON test above shares the same
        ``_resolve()`` plumbing, so coverage of the bug is never lost.

        Implementation note: the test module installs a MagicMock for ``yaml``
        at import time so other tests don't need pyyaml. ``pytest.importorskip``
        sees that cached stub and returns it, so we must drop the stub first
        and attempt a fresh real import — then restore the stub on teardown
        so unrelated tests keep working.
        """
        import importlib

        saved_stub = sys.modules.pop("yaml", None)

        def _restore_stub():
            if saved_stub is not None:
                sys.modules["yaml"] = saved_stub
            else:
                sys.modules.pop("yaml", None)
        request.addfinalizer(_restore_stub)

        try:
            real_yaml = importlib.import_module("yaml")
        except ImportError:
            pytest.skip("pyyaml not installed in this environment")
        sys.modules["yaml"] = real_yaml  # finalizer restores the stub

        cfg_path = tmp_path / "config.yml"
        cfg_path.write_text(
            "email:\n"
            "  imap_host: imap.test\n"
            "  smtp_host: smtp.test\n"
            "  username: agent@test.local\n"
            "  folders:\n"
            "    junk: MyYamlJunk\n"
            "    archive: MyYamlArchive\n"
        )
        monkeypatch.setattr(email_addon, "CONFIG_PATH", str(cfg_path))
        monkeypatch.setattr(email_addon, "RUNTIME_CONFIG_PATH",
                            str(tmp_path / "no-runtime.json"))

        loaded = email_addon.load_config()
        assert loaded["folders"] == {"junk": "MyYamlJunk", "archive": "MyYamlArchive"}

        result = self._client_for(loaded).discover_folders()
        assert result["junk"] == "MyYamlJunk"
        assert result["archive"] == "MyYamlArchive"


# ---------------------------------------------------------------------------
# Read state (mark-read / mark-unread)
# ---------------------------------------------------------------------------

def _seed_one_incoming(uid=42, folder="INBOX", is_read=0):
    """Insert one thread with a single incoming email row."""
    conn = email_addon.open_email_db(CONFIG).conn
    conn.execute("""
        INSERT INTO threads (thread_id, subject, last_message_id, references_chain,
          last_sender, last_sender_full, participants, message_count)
        VALUES ('t1', 'Hi', '<m1@x>', '[]', 'a@x', 'a@x', '[]', 1)
    """)
    conn.execute("""
        INSERT INTO emails (thread_id, message_id, direction, sender, recipient,
          subject, body, imap_uid, folder, is_read)
        VALUES ('t1', '<m1@x>', 'in', 'a@x', 'agent@test.local',
                'Hi', 'Body', ?, ?, ?)
    """, (uid, folder, is_read))
    conn.commit()
    conn.close()


class TestCmdMarkRead:
    """``cmd_mark_read`` orchestrates: resolve targets → call client.set_seen
    → commit DB. Tests assert on the *client API* (``set_seen``); UID
    chunking, IMAP protocol details, and STORE syntax are covered in
    ``test_imap_client.py``.
    """

    def test_updates_db_is_read(self, db_dir, imap):
        _seed_one_incoming(is_read=0)
        email_addon.cmd_mark_read(CONFIG, "1")
        conn = _open_db(db_dir)
        row = conn.execute("SELECT is_read FROM emails WHERE id=1").fetchone()
        conn.close()
        assert row[0] == 1

    def test_calls_client_set_seen_true(self, db_dir, imap):
        _seed_one_incoming(uid=42)
        email_addon.cmd_mark_read(CONFIG, "1")
        imap.set_seen.assert_called_once()
        folder, uids = imap.set_seen.call_args.args[:2]
        seen = imap.set_seen.call_args.kwargs.get("seen", True)
        assert folder == "INBOX"
        assert uids == [42]
        assert seen is True

    def test_thread_id_passes_all_incoming_uids_in_one_call(self, db_dir, imap):
        """A thread with multiple incoming msgs → one set_seen call carrying
        every UID. Outgoing rows (no imap_uid) are filtered out before the
        client ever sees them.
        """
        conn = email_addon.open_email_db(CONFIG).conn
        conn.execute("""
            INSERT INTO threads (thread_id, subject, last_message_id, references_chain,
              last_sender, last_sender_full, participants, message_count)
            VALUES ('tX', 'Hi', '<m@x>', '[]', 'a@x', 'a@x', '[]', 3)
        """)
        for mid, direction, uid in [("<m1@x>", "in", 10),
                                    ("<m2@x>", "in", 11),
                                    ("<m3@x>", "out", None)]:
            conn.execute("""
                INSERT INTO emails (thread_id, message_id, direction, sender, recipient,
                  subject, body, imap_uid, folder, is_read)
                VALUES ('tX', ?, ?, 'a@x', 'me', 'S', 'B', ?, 'INBOX', 0)
            """, (mid, direction, uid))
        conn.commit()
        conn.close()

        email_addon.cmd_mark_read(CONFIG, "tX")
        imap.set_seen.assert_called_once()
        folder, uids = imap.set_seen.call_args.args[:2]
        assert folder == "INBOX"
        assert set(uids) == {10, 11}     # both incoming UIDs together
        assert None not in uids          # outgoing row never reaches the client

    def test_no_imap_call_when_no_uid(self, db_dir, imap):
        """If the row has no IMAP UID (synthetic test row), skip the client
        entirely but still update the DB mirror.
        """
        conn = email_addon.open_email_db(CONFIG).conn
        conn.execute("""
            INSERT INTO threads (thread_id, subject, last_message_id, references_chain,
              last_sender, last_sender_full, participants, message_count)
            VALUES ('t1', 'Hi', '<m1@x>', '[]', 'a@x', 'a@x', '[]', 1)
        """)
        conn.execute("""
            INSERT INTO emails (thread_id, message_id, direction, sender, recipient,
              subject, body, folder, is_read)
            VALUES ('t1', '<m1@x>', 'in', 'a@x', 'me', 'Hi', 'B', 'INBOX', 0)
        """)
        conn.commit()
        conn.close()

        email_addon.cmd_mark_read(CONFIG, "1")
        imap.set_seen.assert_not_called()
        # …but DB is still updated
        conn = _open_db(db_dir)
        row = conn.execute("SELECT is_read FROM emails WHERE id=1").fetchone()
        conn.close()
        assert row[0] == 1

    def test_no_target_exits(self, db_dir, imap):
        email_addon.open_email_db(CONFIG).close()
        with pytest.raises(SystemExit):
            email_addon.cmd_mark_read(CONFIG, "999")


class TestCmdMarkUnread:
    def test_updates_db_is_read_to_zero(self, db_dir, imap):
        _seed_one_incoming(is_read=1)
        email_addon.cmd_mark_unread(CONFIG, "1")
        conn = _open_db(db_dir)
        row = conn.execute("SELECT is_read FROM emails WHERE id=1").fetchone()
        conn.close()
        assert row[0] == 0

    def test_calls_client_set_seen_false(self, db_dir, imap):
        _seed_one_incoming(uid=42, is_read=1)
        email_addon.cmd_mark_unread(CONFIG, "1")
        imap.set_seen.assert_called_once()
        assert imap.set_seen.call_args.kwargs.get("seen") is False


# ---------------------------------------------------------------------------
# Folder moves (archive / spam / delete / move)
# ---------------------------------------------------------------------------

class TestCmdArchive:
    """``cmd_archive`` / spam / delete all funnel into ``client.move``.
    MOVE-vs-COPY-fallback and UID chunking are covered in test_imap_client.py.
    """

    def test_calls_client_move_to_archive(self, db_dir, imap):
        _seed_one_incoming(uid=42)
        email_addon.cmd_archive(CONFIG, "1")
        imap.move.assert_called_once()
        src, uids, dest = imap.move.call_args.args[:3]
        assert src == "INBOX"
        assert uids == [42]
        assert dest == "Archive"

    def test_updates_db_folder_to_archive(self, db_dir, imap):
        _seed_one_incoming()
        email_addon.cmd_archive(CONFIG, "1")
        conn = _open_db(db_dir)
        row = conn.execute("SELECT folder FROM emails WHERE id=1").fetchone()
        conn.close()
        assert row[0] == "Archive"

    def test_spam_moves_to_junk(self, db_dir, imap):
        _seed_one_incoming(uid=42)
        email_addon.cmd_spam(CONFIG, "1")
        assert imap.move.call_args.args[2] == "Junk"

    def test_delete_moves_to_trash(self, db_dir, imap):
        _seed_one_incoming(uid=42)
        email_addon.cmd_delete(CONFIG, "1")
        assert imap.move.call_args.args[2] == "Trash"

    def test_rebinds_imap_uid_from_copyuid_response(self, db_dir, imap):
        """After MOVE, the row's imap_uid must point at the destination UID
        (parsed from COPYUID — RFC 4315 / 6851). Without this, chained
        triage (archive → un-archive) targets the stale source UID and
        silently no-ops while the DB claims success.
        """
        _seed_one_incoming(uid=42)
        # Server reports the source UID 42 landed as UID 7 in Archive
        imap.move.return_value = {42: 7}
        email_addon.cmd_archive(CONFIG, "1")
        conn = _open_db(db_dir)
        row = conn.execute(
            "SELECT folder, imap_uid FROM emails WHERE id=1"
        ).fetchone()
        conn.close()
        assert row[0] == "Archive"
        assert row[1] == 7, "imap_uid must be rebound to the COPYUID-reported new UID"

    def test_clears_imap_uid_when_uidplus_missing(self, db_dir, imap):
        """Servers without UIDPLUS return no COPYUID; the stale source UID
        is meaningless in the destination folder, so we clear imap_uid.
        Future triage then fails loudly ("no stored UID") instead of
        silently no-op'ing against a UID that doesn't exist in the new
        folder.
        """
        _seed_one_incoming(uid=42)
        imap.move.return_value = {}  # No COPYUID — UIDPLUS-less server
        email_addon.cmd_archive(CONFIG, "1")
        conn = _open_db(db_dir)
        row = conn.execute(
            "SELECT folder, imap_uid FROM emails WHERE id=1"
        ).fetchone()
        conn.close()
        assert row[0] == "Archive"
        assert row[1] is None, "imap_uid must be cleared when UIDPLUS is unavailable"


class TestCmdMove:
    def test_move_to_logical_role_resolves_via_discovery(self, db_dir, imap):
        """Passing 'archive' as the destination resolves to the real folder."""
        _seed_one_incoming(uid=42)
        email_addon.cmd_move(CONFIG, "1", "archive")
        assert imap.move.call_args.args[2] == "Archive"

    def test_move_to_literal_existing_folder(self, db_dir, imap):
        """Literal server folder names (not in role map) are accepted if present."""
        _seed_one_incoming(uid=42)
        email_addon.cmd_move(CONFIG, "1", "Drafts")
        assert imap.move.call_args.args[2] == "Drafts"

    def test_move_to_nonexistent_folder_errors(self, db_dir, imap):
        _seed_one_incoming(uid=42)
        with pytest.raises(SystemExit):
            email_addon.cmd_move(CONFIG, "1", "NonexistentFolder")
        # And the client should never have been called for that bad move
        imap.move.assert_not_called()

    def test_outgoing_only_thread_refuses_move(self, db_dir, imap):
        """A thread with no IMAP-tracked incoming rows can't be moved."""
        conn = email_addon.open_email_db(CONFIG).conn
        conn.execute("""
            INSERT INTO threads (thread_id, subject, last_message_id, references_chain,
              last_sender, last_sender_full, participants, message_count)
            VALUES ('out-only', 'Hi', '<m@x>', '[]', 'a@x', 'a@x', '[]', 1)
        """)
        conn.execute("""
            INSERT INTO emails (thread_id, message_id, direction, sender, recipient,
              subject, body, folder, is_read)
            VALUES ('out-only', '<m@x>', 'out', 'me', 'a@x', 'Hi', 'B', 'Sent', 1)
        """)
        conn.commit()
        conn.close()
        with pytest.raises(SystemExit):
            email_addon.cmd_archive(CONFIG, "out-only")
        imap.move.assert_not_called()


# ---------------------------------------------------------------------------
# IMAP response handling — DB must not drift from server state on failure
# ---------------------------------------------------------------------------

def _seed_mixed_thread(direction_uid_pairs):
    """Seed one thread with the given (direction, imap_uid) rows.

    Returns the thread_id. Outgoing rows go to folder='Sent' / is_read=1 to
    match real cmd_send / cmd_reply output; incoming go to folder='INBOX' /
    is_read=0.
    """
    conn = email_addon.open_email_db(CONFIG).conn
    conn.execute("""
        INSERT INTO threads (thread_id, subject, last_message_id, references_chain,
          last_sender, last_sender_full, participants, message_count)
        VALUES ('mixed', 'Hi', '<m@x>', '[]', 'a@x', 'a@x', '[]', ?)
    """, (len(direction_uid_pairs),))
    for i, (direction, uid) in enumerate(direction_uid_pairs, 1):
        folder, is_read = ("Sent", 1) if direction == "out" else ("INBOX", 0)
        conn.execute("""
            INSERT INTO emails (thread_id, message_id, direction, sender, recipient,
              subject, body, imap_uid, folder, is_read)
            VALUES ('mixed', ?, ?, 'a@x', 'me', 'S', 'B', ?, ?, ?)
        """, (f"<m{i}@x>", direction, uid, folder, is_read))
    conn.commit()
    conn.close()
    return "mixed"


class TestImapFailureRollback:
    """When IMAP rejects an operation, our local DB must NOT pretend it
    succeeded — otherwise mark-read/archive leaves state diverged from the
    server and subsequent commands silently target the wrong folder.

    The client surfaces failures by raising :class:`ImapError`; we test
    that ``cmd_*`` catches it, prints the detail, and skips the DB mirror.
    """

    def test_mark_read_aborts_db_update_on_client_error(self, db_dir, imap):
        _seed_one_incoming(uid=42, is_read=0)
        imap.set_seen.side_effect = email_addon.ImapError(
            "IMAP UID STORE +FLAGS \\Seen on 1 UIDs in INBOX failed: NO quota exceeded"
        )
        with pytest.raises(SystemExit):
            email_addon.cmd_mark_read(CONFIG, "1")
        conn = _open_db(db_dir)
        row = conn.execute("SELECT is_read FROM emails WHERE id=1").fetchone()
        conn.close()
        assert row[0] == 0, "DB must not flip is_read when the client refused the STORE"

    def test_archive_aborts_db_update_on_client_error(self, db_dir, imap):
        _seed_one_incoming(uid=42)
        imap.move.side_effect = email_addon.ImapError(
            "IMAP UID MOVE 1 → Archive failed: NO folder gone"
        )
        with pytest.raises(SystemExit):
            email_addon.cmd_archive(CONFIG, "1")
        conn = _open_db(db_dir)
        row = conn.execute("SELECT folder FROM emails WHERE id=1").fetchone()
        conn.close()
        assert row[0] == "INBOX", "DB must not record folder change when MOVE failed"

    def test_error_message_surfaces_server_detail(self, db_dir, imap, capsys):
        _seed_one_incoming(uid=42)
        imap.set_seen.side_effect = email_addon.ImapError(
            "IMAP UID STORE failed: NO over quota"
        )
        with pytest.raises(SystemExit):
            email_addon.cmd_mark_read(CONFIG, "1")
        err = capsys.readouterr().err
        assert "ERROR" in err
        assert "over quota" in err


class TestSurfaceOutgoingSkip:
    """Triage on a thread with mixed in+out rows must tell the agent that
    outgoing messages were silently bypassed (they have no server UID)."""

    def test_mark_read_thread_with_outgoing_notes_skip(self, db_dir, imap, capsys):
        _seed_mixed_thread([("in", 10), ("in", 11), ("out", None), ("out", None)])
        email_addon.cmd_mark_read(CONFIG, "mixed")
        out = capsys.readouterr().out
        assert "Marked 2" in out
        assert "2 outgoing" in out

    def test_mark_read_thread_with_pre_migration_rows_notes_db_only(
        self, db_dir, imap, capsys
    ):
        """Pre-migration incoming rows have imap_uid=NULL — mark-read can't
        flip the server flag for those. We still mirror them in the DB so
        the agent's view stays consistent, but the user needs to know the
        server's \\Seen state is unchanged for that subset (otherwise the
        webmail-vs-agent discrepancy is invisible).
        """
        # 1 incoming with UID + 1 incoming pre-migration (no UID)
        _seed_mixed_thread([("in", 10), ("in", None)])
        email_addon.cmd_mark_read(CONFIG, "mixed")
        out = capsys.readouterr().out
        assert "Marked 2" in out
        assert "1 of those had no stored UID" in out
        assert "server state unchanged" in out

    def test_archive_thread_with_outgoing_notes_skip(self, db_dir, imap, capsys):
        _seed_mixed_thread([("in", 10), ("out", None)])
        email_addon.cmd_archive(CONFIG, "mixed")
        out = capsys.readouterr().out
        assert "Moved 1" in out
        assert "1 outgoing" in out

    def test_pure_incoming_thread_has_no_skip_note(self, db_dir, imap, capsys):
        """No outgoing rows → no Note: clause cluttering the output."""
        _seed_mixed_thread([("in", 10), ("in", 11)])
        email_addon.cmd_mark_read(CONFIG, "mixed")
        out = capsys.readouterr().out
        assert "outgoing" not in out
        assert "skipped" not in out

    def test_outgoing_only_email_id_errors_clearly(self, db_dir, imap, capsys):
        """A numeric id pointing at an outgoing-only row should refuse, not silently no-op."""
        _seed_mixed_thread([("out", None)])
        with pytest.raises(SystemExit):
            email_addon.cmd_mark_read(CONFIG, "1")
        err = capsys.readouterr().err
        assert "outgoing" in err


class TestIdlePollFlow:
    """IDLE-based polling must still drive _fetch_new_emails on wake-up after
    the schema/PEEK rewrite. Single-folder invariant: SELECT happens against
    ``config['folder']`` (INBOX) both initially and after every wake.
    """

    def _setup_idle(self, monkeypatch, imap_fixture, idle_results):
        """Install mocks so cmd_poll_idle runs one connection cycle.

        ``idle_results`` is the sequence of booleans returned by successive
        ``client.idle()`` calls (True = new mail, False = timeout).
        Shutdown is triggered after the list is exhausted so the outer
        reconnect loop doesn't spin forever.
        """
        # Counters / control
        fetch_calls = []

        def fake_fetch(_imap, _db, _config):
            fetch_calls.append(True)
            return 0
        monkeypatch.setattr(email_addon, "_fetch_new_emails", fake_fetch)

        idle_iter = iter(idle_results)

        def fake_idle(_timeout=None):
            try:
                return next(idle_iter)
            except StopIteration:
                email_addon._shutdown_requested = True
                return False
        imap_fixture.idle.side_effect = fake_idle
        imap_fixture.supports_idle.return_value = True

        # Avoid installing real signal handlers in the test process.
        monkeypatch.setattr(email_addon.signal, "signal",
                            lambda *a, **kw: None)

        return fetch_calls

    def test_idle_wakeup_invokes_fetch(self, db_dir, imap, monkeypatch):
        """A True return from client.idle() must drive a follow-up fetch."""
        fetch_calls = self._setup_idle(monkeypatch, imap, [True])
        email_addon.cmd_poll_idle(dict(CONFIG))
        # Initial fetch + post-IDLE fetch
        assert len(fetch_calls) >= 2

    def test_idle_selects_configured_folder_on_wake(self, db_dir, imap, monkeypatch):
        """After IDLE wakeup, client.select(config['folder']) must run before
        the fetch — single-folder invariant.
        """
        self._setup_idle(monkeypatch, imap, [True])
        cfg = dict(CONFIG, folder="INBOX")
        email_addon.cmd_poll_idle(cfg)

        select_calls = [c.args[0] for c in imap.select.call_args_list]
        assert select_calls.count("INBOX") >= 2, (
            f"expected ≥2 client.select('INBOX') calls (initial + post-wake), "
            f"got {select_calls}"
        )

    def test_idle_timeout_does_not_re_fetch(self, db_dir, imap, monkeypatch):
        """A False return (timeout) → NOOP + back to IDLE, no extra fetch."""
        fetch_calls = self._setup_idle(monkeypatch, imap, [False])
        email_addon.cmd_poll_idle(dict(CONFIG))
        # Only the initial fetch should have run; the timeout path skips it.
        assert len(fetch_calls) == 1
        imap.noop.assert_called()


class TestCmdFolders:
    def test_lists_role_mapping(self, db_dir, imap, capsys):
        email_addon.cmd_folders(CONFIG)
        out = capsys.readouterr().out
        # Every role should appear
        for role in ("inbox", "archive", "sent", "drafts", "junk", "trash"):
            assert role in out
        # And their resolved names
        for name in ("INBOX", "Archive", "Sent", "Drafts", "Junk", "Trash"):
            assert name in out

    def test_lists_all_server_folders(self, db_dir, imap, capsys):
        email_addon.cmd_folders(CONFIG)
        out = capsys.readouterr().out
        assert "All server folders:" in out

    def test_calls_client_discover_and_list(self, db_dir, imap):
        """cmd_folders is a thin wrapper over the client API."""
        email_addon.cmd_folders(CONFIG)
        imap.discover_folders.assert_called_once()
        imap.list_folders.assert_called_once()


# ---------------------------------------------------------------------------
# Thread listing filters
# ---------------------------------------------------------------------------

class TestCmdThreadsFilters:
    """``email threads --folder=X --unread|--read`` filtering semantics."""

    def _seed_filterable(self, db_dir):
        conn = email_addon.open_email_db(CONFIG).conn
        conn.executescript("""
            INSERT INTO threads (thread_id, subject, last_message_id, references_chain,
              last_sender, last_sender_full, participants, message_count) VALUES
              ('inbox-unread', 'Hi',   '<m1>', '[]', 'a@x', 'a@x', '[]', 1),
              ('inbox-read',   'Done', '<m2>', '[]', 'a@x', 'a@x', '[]', 1),
              ('archived',     'Old',  '<m3>', '[]', 'a@x', 'a@x', '[]', 1);
            INSERT INTO emails (thread_id, message_id, direction, sender, recipient,
              subject, body, folder, is_read) VALUES
              ('inbox-unread', '<m1>', 'in', 'a@x', 'me', 'Hi',   'B', 'INBOX',   0),
              ('inbox-read',   '<m2>', 'in', 'a@x', 'me', 'Done', 'B', 'INBOX',   1),
              ('archived',     '<m3>', 'in', 'a@x', 'me', 'Old',  'B', 'Archive', 0);
        """)
        conn.commit()
        conn.close()

    def test_no_filter_shows_all_threads(self, db_dir, capsys):
        self._seed_filterable(db_dir)
        email_addon.cmd_threads(CONFIG)
        out = capsys.readouterr().out
        for tid in ("inbox-unread", "inbox-read", "archived"):
            assert tid in out

    def test_folder_inbox_filter(self, db_dir, capsys):
        self._seed_filterable(db_dir)
        email_addon.cmd_threads(CONFIG, folder="INBOX")
        out = capsys.readouterr().out
        assert "inbox-unread" in out
        assert "inbox-read" in out
        assert "archived" not in out

    def test_folder_archive_filter(self, db_dir, capsys):
        self._seed_filterable(db_dir)
        email_addon.cmd_threads(CONFIG, folder="Archive")
        out = capsys.readouterr().out
        assert "archived" in out
        assert "inbox-unread" not in out
        assert "inbox-read" not in out

    def test_unread_filter(self, db_dir, capsys):
        self._seed_filterable(db_dir)
        email_addon.cmd_threads(CONFIG, unread=True)
        out = capsys.readouterr().out
        assert "inbox-unread" in out
        assert "archived" in out      # also has an unread message
        assert "inbox-read" not in out

    def test_read_filter(self, db_dir, capsys):
        self._seed_filterable(db_dir)
        email_addon.cmd_threads(CONFIG, unread=False)
        out = capsys.readouterr().out
        assert "inbox-read" in out
        assert "inbox-unread" not in out

    def test_combined_folder_and_unread(self, db_dir, capsys):
        """``--folder INBOX --unread`` is exactly what 'inbox' shortcut maps to."""
        self._seed_filterable(db_dir)
        email_addon.cmd_threads(CONFIG, folder="INBOX", unread=True)
        out = capsys.readouterr().out
        assert "inbox-unread" in out
        assert "inbox-read" not in out
        assert "archived" not in out

    def test_folder_sent_explains_outgoing_only_gotcha(self, db_dir, capsys):
        """``--folder Sent`` always returns empty because the filter only
        matches *incoming* messages — outgoing (``direction='out'``) rows
        aren't surfaced here. Without an explicit hint, the user just sees
        an empty list and has no idea why their sent mail is missing.
        """
        self._seed_filterable(db_dir)
        email_addon.cmd_threads(CONFIG, folder="Sent")
        out = capsys.readouterr().out
        assert "No email threads found" in out
        assert "incoming" in out.lower()
        assert "outgoing" in out.lower()

    def test_filter_caption_in_header(self, db_dir, capsys):
        self._seed_filterable(db_dir)
        email_addon.cmd_threads(CONFIG, folder="INBOX", unread=True)
        out = capsys.readouterr().out
        # The caption tells the agent what's filtered
        assert "INBOX" in out
        assert "unread only" in out


class TestCmdThreadsLimitSignalling:
    """``email threads --limit N`` must tell the agent when results were
    truncated, so it can distinguish "only N exist" from "first N of more"
    and decide whether to ask for a larger limit.
    """

    def _seed_n_threads(self, n):
        conn = email_addon.open_email_db(CONFIG).conn
        for i in range(n):
            conn.execute("""
                INSERT INTO threads (thread_id, subject, last_message_id,
                  references_chain, last_sender, last_sender_full,
                  participants, message_count)
                VALUES (?, ?, ?, '[]', 'a@x', 'a@x', '[]', 1)
            """, (f"t{i:03d}", f"S{i}", f"<m{i}@x>"))
        conn.commit()
        conn.close()

    def test_truncation_marker_when_more_exist(self, db_dir, capsys):
        """5 threads, --limit 3 → shows '3+ threads' and a hint to raise --limit."""
        self._seed_n_threads(5)
        email_addon.cmd_threads(CONFIG, limit=3)
        out = capsys.readouterr().out
        assert "3+" in out
        assert "more results exist" in out
        # Concrete recommendation includes a doubled value so the agent has a
        # cheap next-step to try.
        assert "--limit 6" in out

    def test_no_truncation_marker_when_under_limit(self, db_dir, capsys):
        """3 threads, --limit 10 → no '+' and no 'more results' hint."""
        self._seed_n_threads(3)
        email_addon.cmd_threads(CONFIG, limit=10)
        out = capsys.readouterr().out
        assert "+" not in out.split("\n", 1)[0]  # no '+' in the header line
        assert "more results exist" not in out

    def test_exact_limit_does_not_falsely_signal_more(self, db_dir, capsys):
        """Off-by-one guard: exactly --limit results = no truncation marker."""
        self._seed_n_threads(3)
        email_addon.cmd_threads(CONFIG, limit=3)
        out = capsys.readouterr().out
        assert "more results exist" not in out
        # All three thread IDs visible
        for i in range(3):
            assert f"t{i:03d}" in out

    def test_truncation_with_filter_caption(self, db_dir, capsys):
        """Filter caption + truncation both render in the header."""
        # Seed 5 INBOX-unread threads
        conn = email_addon.open_email_db(CONFIG).conn
        for i in range(5):
            conn.execute("""
                INSERT INTO threads (thread_id, subject, last_message_id,
                  references_chain, last_sender, last_sender_full,
                  participants, message_count)
                VALUES (?, ?, ?, '[]', 'a@x', 'a@x', '[]', 1)
            """, (f"u{i}", f"S{i}", f"<m{i}@x>"))
            conn.execute("""
                INSERT INTO emails (thread_id, message_id, direction, sender,
                  recipient, subject, body, folder, is_read)
                VALUES (?, ?, 'in', 'a@x', 'me', 'S', 'B', 'INBOX', 0)
            """, (f"u{i}", f"<m{i}@x>"))
        conn.commit()
        conn.close()

        email_addon.cmd_threads(CONFIG, limit=2, folder="INBOX", unread=True)
        out = capsys.readouterr().out
        # Header line carries both the count+truncation marker AND filter caption
        assert "2+" in out
        assert "INBOX" in out
        assert "unread only" in out


# ---------------------------------------------------------------------------
# Poller: PEEK fetch + UID/folder/is_read persistence
# ---------------------------------------------------------------------------

class TestPollerStoresImapState:
    """Regression guard: ``_fetch_new_emails`` must store imap_uid, folder,
    is_read so that mark-read/archive/etc. can later target the message.

    The poller now goes through ImapClient.search_new + fetch_peek instead
    of raw imaplib, so the test mocks the *client API*. Protocol-level
    behaviour (PEEK syntax, FLAGS parsing) is verified in test_imap_client.py.
    """

    def _build_raw(self, subject="Hi", sender="alice@x.com"):
        return (
            f"From: {sender}\r\n"
            f"To: agent@test.local\r\n"
            f"Subject: {subject}\r\n"
            f"Message-ID: <m1@x>\r\n"
            f"Date: Mon, 1 Jan 2024 00:00:00 +0000\r\n"
            f"\r\n"
            f"Body content"
        ).encode()

    def _patch_side_effects(self, monkeypatch):
        monkeypatch.setattr(email_addon, "write_to_atlas_inbox", lambda *a, **kw: 1)
        monkeypatch.setattr(email_addon, "save_email_file",     lambda *a, **kw: "/tmp/x.md")
        monkeypatch.setattr(email_addon, "extract_attachments", lambda *a, **kw: [])
        monkeypatch.setattr(email_addon, "subprocess", MagicMock())

    def _client(self, raw, uid=42, server_is_read=False):
        """Mock ImapClient that returns one search hit and one batched fetch."""
        client = MagicMock()
        client.search_new.return_value = [uid]
        client.fetch_peek_many.return_value = {uid: (raw, server_is_read)}
        return client

    def test_stores_imap_uid(self, db_dir, monkeypatch):
        """Every fetched message must have its server UID persisted."""
        self._patch_side_effects(monkeypatch)
        client = self._client(self._build_raw(), uid=99)
        db = email_addon.open_email_db(CONFIG)
        try:
            email_addon._fetch_new_emails(client, db, dict(CONFIG))
        finally:
            db.close()

        conn = _open_db(db_dir)
        row = conn.execute(
            "SELECT imap_uid, folder, is_read FROM emails WHERE direction='in'"
        ).fetchone()
        conn.close()
        assert row[0] == 99
        assert row[1] == "INBOX"
        # mark_read=True in default config → is_read should be 1
        assert row[2] == 1

    def test_uses_client_batched_fetch(self, db_dir, monkeypatch):
        """Poller must go through fetch_peek_many — one round-trip per
        UID_BATCH chunk, not one per UID. The PEEK syntax itself is tested
        in test_imap_client.py.
        """
        self._patch_side_effects(monkeypatch)
        client = self._client(self._build_raw())
        db = email_addon.open_email_db(CONFIG)
        try:
            email_addon._fetch_new_emails(client, db, dict(CONFIG))
        finally:
            db.close()
        client.fetch_peek_many.assert_called_once()
        # The poller should call fetch_peek_many, not the single-UID variant
        client.fetch_peek.assert_not_called()
        # search_new is called per-folder; assert the folder arg
        assert client.search_new.call_args.args[0] == "INBOX"

    def test_mark_read_calls_set_seen_with_all_uids(self, db_dir, monkeypatch):
        """When mark_read=True (default), every fetched UID should land in a
        single batched set_seen call after the loop.
        """
        self._patch_side_effects(monkeypatch)
        client = MagicMock()
        client.search_new.return_value = [10, 11, 12]
        client.fetch_peek_many.return_value = {
            uid: (self._build_raw(subject=f"S{uid}", sender=f"a{uid}@x"), False)
            for uid in (10, 11, 12)
        }
        db = email_addon.open_email_db(CONFIG)
        try:
            email_addon._fetch_new_emails(client, db, dict(CONFIG))
        finally:
            db.close()
        client.set_seen.assert_called_once()
        folder, uids = client.set_seen.call_args.args[:2]
        assert folder == "INBOX"
        assert set(uids) == {10, 11, 12}

    def test_no_mark_read_skips_set_seen(self, db_dir, monkeypatch):
        """When mark_read=False, the client.set_seen call must not happen."""
        self._patch_side_effects(monkeypatch)
        client = self._client(self._build_raw(), server_is_read=False)
        cfg = dict(CONFIG, mark_read=False)
        db = email_addon.open_email_db(cfg)
        try:
            email_addon._fetch_new_emails(client, db, cfg)
        finally:
            db.close()
        client.set_seen.assert_not_called()
        conn = _open_db(db_dir)
        row = conn.execute("SELECT is_read FROM emails WHERE direction='in'").fetchone()
        conn.close()
        assert row[0] == 0  # neither server nor config wants this read

    def test_server_seen_flag_reflected_when_mark_read_disabled(self, db_dir, monkeypatch):
        """When mark_read=False but server already says \\Seen, DB matches."""
        self._patch_side_effects(monkeypatch)
        client = self._client(self._build_raw(), server_is_read=True)
        cfg = dict(CONFIG, mark_read=False)
        db = email_addon.open_email_db(cfg)
        try:
            email_addon._fetch_new_emails(client, db, cfg)
        finally:
            db.close()
        conn = _open_db(db_dir)
        row = conn.execute("SELECT is_read FROM emails WHERE direction='in'").fetchone()
        conn.close()
        assert row[0] == 1  # server said seen → DB agrees

    def test_set_seen_failure_leaves_db_unread_to_match_server(self, db_dir, monkeypatch):
        """IMAP-first contract: if the post-fetch ``set_seen`` STORE fails,
        the DB rows must stay ``is_read=0`` to match the server's reality.
        The previous behaviour committed ``is_read=1`` before the STORE was
        attempted, so a failure left the DB permanently claiming "read"
        while the server still showed unread — and the UID watermark
        prevented any reconciliation.
        """
        self._patch_side_effects(monkeypatch)
        client = MagicMock()
        client.search_new.return_value = [10, 11]
        client.fetch_peek_many.return_value = {
            uid: (self._build_raw(subject=f"S{uid}", sender=f"a{uid}@x"), False)
            for uid in (10, 11)
        }
        client.set_seen.side_effect = email_addon.ImapError(
            "IMAP UID STORE +FLAGS \\Seen on 2 UIDs in INBOX failed: NO quota"
        )
        db = email_addon.open_email_db(CONFIG)
        try:
            email_addon._fetch_new_emails(client, db, dict(CONFIG))
        finally:
            db.close()
        conn = _open_db(db_dir)
        rows = conn.execute(
            "SELECT is_read FROM emails WHERE direction='in' ORDER BY id"
        ).fetchall()
        conn.close()
        assert [r[0] for r in rows] == [0, 0], (
            "DB must mirror server reality when set_seen fails — "
            "permanent divergence behind the UID watermark is the bug"
        )

    def test_set_seen_success_flips_db_to_read(self, db_dir, monkeypatch):
        """Happy path: when set_seen succeeds, the DB rows flip to is_read=1
        after the IMAP STORE confirms.
        """
        self._patch_side_effects(monkeypatch)
        client = MagicMock()
        client.search_new.return_value = [10, 11]
        client.fetch_peek_many.return_value = {
            uid: (self._build_raw(subject=f"S{uid}", sender=f"a{uid}@x"), False)
            for uid in (10, 11)
        }
        db = email_addon.open_email_db(CONFIG)
        try:
            email_addon._fetch_new_emails(client, db, dict(CONFIG))
        finally:
            db.close()
        conn = _open_db(db_dir)
        rows = conn.execute(
            "SELECT is_read FROM emails WHERE direction='in' ORDER BY id"
        ).fetchall()
        conn.close()
        assert [r[0] for r in rows] == [1, 1]

    def test_polled_email_records_configured_folder_not_inbox_literal(
        self, db_dir, monkeypatch
    ):
        """``folder`` column must reflect the actual polled folder, not the
        previously-hardcoded ``"INBOX"`` literal. Anyone polling a non-INBOX
        folder would otherwise have all triage commands fail because
        ``UID MOVE`` would target the wrong source folder.
        """
        self._patch_side_effects(monkeypatch)
        client = self._client(self._build_raw())
        cfg = dict(CONFIG, folder="Work")
        db = email_addon.open_email_db(cfg)
        try:
            email_addon._fetch_new_emails(client, db, cfg)
        finally:
            db.close()
        conn = _open_db(db_dir)
        row = conn.execute(
            "SELECT folder FROM emails WHERE direction='in'"
        ).fetchone()
        conn.close()
        assert row[0] == "Work"

    def test_expunged_uid_silently_skipped(self, db_dir, monkeypatch):
        """If a UID was expunged between SEARCH and FETCH the batched fetch
        returns a dict missing that UID. The poller must skip it rather
        than crashing on a None unpacking.
        """
        self._patch_side_effects(monkeypatch)
        client = MagicMock()
        client.search_new.return_value = [10, 999]   # 999 gets expunged
        client.fetch_peek_many.return_value = {10: (self._build_raw(), False)}
        db = email_addon.open_email_db(CONFIG)
        try:
            email_addon._fetch_new_emails(client, db, dict(CONFIG))
        finally:
            db.close()
        conn = _open_db(db_dir)
        count = conn.execute(
            "SELECT COUNT(*) FROM emails WHERE direction='in'"
        ).fetchone()[0]
        conn.close()
        assert count == 1   # only the surviving UID was stored


# ---------------------------------------------------------------------------
# Outgoing rows: folder & is_read sanity
# ---------------------------------------------------------------------------

class TestOutgoingFolderAndReadState:
    """cmd_send / cmd_reply rows must land in 'Sent' and be flagged read,
    so neither inbox filters nor unread filters surface them by mistake."""

    def test_cmd_send_lands_in_sent_and_is_read(self, db_dir, smtp):
        email_addon.cmd_send(CONFIG, "bob@x.com", "Hello", "Body")
        conn = _open_db(db_dir)
        row = conn.execute("SELECT folder, is_read FROM emails WHERE direction='out'").fetchone()
        conn.close()
        assert row[0] == "Sent"
        assert row[1] == 1

    def test_cmd_reply_lands_in_sent_and_is_read(self, db_dir, smtp):
        conn = email_addon.open_email_db(CONFIG).conn
        conn.execute("""
            INSERT INTO threads (thread_id, subject, last_message_id, references_chain,
              last_sender, last_sender_full, participants, message_count)
            VALUES ('t1', 'Hi', '<m@x>', '[]', 'a@x', 'a@x', '["a@x"]', 1)
        """)
        conn.commit()
        conn.close()

        email_addon.cmd_reply(CONFIG, "t1", "Thanks")
        conn = _open_db(db_dir)
        row = conn.execute("SELECT folder, is_read FROM emails WHERE direction='out'").fetchone()
        conn.close()
        assert row[0] == "Sent"
        assert row[1] == 1


# ---------------------------------------------------------------------------
# End-to-end poll path — opens the DB, runs the fetch loop, persists state
# ---------------------------------------------------------------------------

class TestCmdPollEndToEnd:
    """Regression guard for the cmd_poll / cmd_poll_idle → _fetch_new_emails
    handshake. Previous bugs hid here because every other poller test
    bypassed the cmd_* entry point (either calling _fetch_new_emails
    directly or monkeypatching it away). These tests drive the full path
    so a type mismatch between the cmd opener and the fetch loop raises
    immediately.
    """

    def _build_raw_email(self):
        return (
            "From: alice@x.test\r\n"
            "To: agent@test.local\r\n"
            "Subject: Hi\r\n"
            "Message-ID: <m1@x>\r\n"
            "Date: Mon, 1 Jan 2024 00:00:00 +0000\r\n"
            "\r\n"
            "Body content"
        ).encode()

    def _stub_side_effects(self, monkeypatch):
        """Stub out cross-DB / filesystem / subprocess side effects so we
        only exercise the email-DB write path.
        """
        monkeypatch.setattr(email_addon, "write_to_atlas_inbox", lambda *a, **kw: 1)
        monkeypatch.setattr(email_addon, "save_email_file",     lambda *a, **kw: "/tmp/x.md")
        monkeypatch.setattr(email_addon, "extract_attachments", lambda *a, **kw: [])
        monkeypatch.setattr(email_addon, "subprocess", MagicMock())

    def test_cmd_poll_runs_end_to_end_with_one_new_message(
        self, db_dir, imap, monkeypatch
    ):
        """``cmd_poll`` must open the DB, fetch via the client, and persist
        the new row — without any AttributeError from a raw-conn / EmailDb
        type mismatch.
        """
        self._stub_side_effects(monkeypatch)
        imap.search_new.return_value = [42]
        imap.fetch_peek_many.return_value = {42: (self._build_raw_email(), False)}

        email_addon.cmd_poll(CONFIG)

        # The new row must be present, with imap_uid populated
        conn = _open_db(db_dir)
        rows = conn.execute(
            "SELECT imap_uid, folder, is_read FROM emails WHERE direction='in'"
        ).fetchall()
        conn.close()
        assert len(rows) == 1
        assert rows[0] == (42, "INBOX", 1)  # default mark_read=True → is_read=1

    def test_cmd_poll_skips_when_no_new_uids(self, db_dir, imap, monkeypatch):
        """No-new-mail is the common case; must not crash either."""
        self._stub_side_effects(monkeypatch)
        imap.search_new.return_value = []

        email_addon.cmd_poll(CONFIG)

        conn = _open_db(db_dir)
        count = conn.execute("SELECT COUNT(*) FROM emails").fetchone()[0]
        conn.close()
        assert count == 0
        imap.fetch_peek_many.assert_not_called()

    def test_cmd_poll_misconfigured_imap_returns_silently(
        self, db_dir, imap, capsys
    ):
        """No IMAP host configured → ERROR line, no crash, no fetch."""
        cfg = {**CONFIG, "imap_host": ""}
        email_addon.cmd_poll(cfg)
        out = capsys.readouterr().out
        assert "Email not configured" in out
        imap.search_new.assert_not_called()

    def test_cmd_poll_persists_last_uid_across_runs(
        self, db_dir, imap, monkeypatch
    ):
        """First poll stores the max UID; second poll's search uses it as
        the watermark instead of UNSEEN.
        """
        self._stub_side_effects(monkeypatch)
        imap.search_new.return_value = [42]
        imap.fetch_peek_many.return_value = {42: (self._build_raw_email(), False)}

        email_addon.cmd_poll(CONFIG)
        imap.search_new.reset_mock()
        imap.search_new.return_value = []  # nothing new on the second call

        email_addon.cmd_poll(CONFIG)

        # The second call's search_new should have been told the watermark
        # so it could ask UID > 42, not the UNSEEN fallback.
        last_call = imap.search_new.call_args_list[-1]
        assert last_call.args[1] == 42


# ---------------------------------------------------------------------------
# Attachments — the empty-body bug fix
# ---------------------------------------------------------------------------

class TestCmdReadEmailAttachments:
    """Bug being fixed: an attachment-only email rendered as "empty" because
    the display layer never saw the attachment metadata. Pin the rendered
    output so a regression — empty body + present attachment row → silent
    drop — fails loudly here instead of in production.
    """

    def _seed(self, db_dir, *, body="Hi there", attachments=()):
        conn = email_addon.open_email_db(CONFIG).conn
        conn.execute("""
            INSERT INTO threads (thread_id, subject, last_message_id,
              references_chain, last_sender, last_sender_full, participants, message_count)
            VALUES ('t1', 'Hello', '<m1@x>', '[]', 'alice@x.com', 'alice@x.com', '[]', 1)
        """)
        cur = conn.execute("""
            INSERT INTO emails (thread_id, message_id, direction, sender, recipient, cc, subject, body)
            VALUES ('t1', '<m1@x>', 'in', 'alice@x.com', 'agent@test.local', '', 'Hello', ?)
        """, (body,))
        eid = cur.lastrowid
        for a in attachments:
            conn.execute("""
                INSERT INTO attachments (email_id, filename, content_type, size, path)
                VALUES (?, ?, ?, ?, ?)
            """, (eid, a["filename"], a["content_type"], a["size"], a["path"]))
        conn.commit()
        conn.close()
        return eid

    def test_no_attachments_no_section(self, db_dir, capsys):
        self._seed(db_dir)
        email_addon.cmd_read_email(CONFIG, 1)
        out = capsys.readouterr().out
        assert "**Attachments:**" not in out

    def test_single_attachment_shown(self, db_dir, capsys):
        self._seed(db_dir, attachments=[{
            "filename": "WissensWerk.docx",
            "content_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "size": 17113,
            "path": "/home/agent/.index/email/attachments/t1/WissensWerk.docx",
        }])
        out = capsys.readouterr().out
        # cmd_read_email captures first
        email_addon.cmd_read_email(CONFIG, 1)
        out = capsys.readouterr().out
        assert "**Attachments:**" in out
        assert "WissensWerk.docx" in out
        # Path should be present so the agent can pass it to skills/tools
        assert "/home/agent/.index/email/attachments/t1/WissensWerk.docx" in out

    def test_multiple_attachments_each_listed(self, db_dir, capsys):
        self._seed(db_dir, attachments=[
            {"filename": "a.pdf", "content_type": "application/pdf", "size": 1, "path": "/tmp/a.pdf"},
            {"filename": "b.png", "content_type": "image/png",       "size": 2, "path": "/tmp/b.png"},
        ])
        email_addon.cmd_read_email(CONFIG, 1)
        out = capsys.readouterr().out
        assert "a.pdf" in out
        assert "b.png" in out

    def test_attachment_only_email_flagged_explicitly(self, db_dir, capsys):
        """Empty body + attachment must not render as "*(empty)*" alone —
        otherwise the agent reads "empty" and ignores the attachment.
        """
        self._seed(db_dir, body="", attachments=[{
            "filename": "concept.docx",
            "content_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "size": 17113,
            "path": "/tmp/concept.docx",
        }])
        email_addon.cmd_read_email(CONFIG, 1)
        out = capsys.readouterr().out
        # The explicit marker is what distinguishes "genuinely empty" from
        # "body empty because content lives in the attachment".
        assert "empty body" in out.lower()
        assert "1 attachment" in out
        assert "concept.docx" in out

    def test_content_type_and_size_shown(self, db_dir, capsys):
        self._seed(db_dir, attachments=[{
            "filename": "x.pdf", "content_type": "application/pdf",
            "size": 12345, "path": "/tmp/x.pdf",
        }])
        email_addon.cmd_read_email(CONFIG, 1)
        out = capsys.readouterr().out
        assert "application/pdf" in out
        assert "12345" in out


class TestCmdThreadDetailAttachments:
    """Same fix at the thread-level view. The thread view uses a single
    bulk query (``list_attachments_for_thread``) and groups by email_id —
    test that messages-with and messages-without attachments coexist
    correctly, and that the bulk query doesn't issue N queries.
    """

    def _seed(self, db_dir):
        conn = email_addon.open_email_db(CONFIG).conn
        conn.execute("""
            INSERT INTO threads (thread_id, subject, last_message_id,
              references_chain, last_sender, last_sender_full, participants, message_count)
            VALUES ('t1', 'Concept', '<m2@x>', '[]', 'alice@x.com', 'alice@x.com', '[]', 2)
        """)
        c1 = conn.execute("""
            INSERT INTO emails (thread_id, message_id, direction, sender, recipient, cc, subject, body)
            VALUES ('t1', '<m1@x>', 'in', 'alice@x.com', 'agent@test.local', '', 'Concept', 'Have a look at the attached')
        """)
        e1 = c1.lastrowid
        c2 = conn.execute("""
            INSERT INTO emails (thread_id, message_id, direction, sender, recipient, cc, subject, body)
            VALUES ('t1', '<m2@x>', 'in', 'alice@x.com', 'agent@test.local', '', 'Re: Concept', '')
        """)
        e2 = c2.lastrowid
        # e1 has one attachment, e2 has two (and an empty body — the bug case)
        conn.execute("""
            INSERT INTO attachments (email_id, filename, content_type, size, path)
            VALUES (?, 'first.pdf', 'application/pdf', 100, '/tmp/first.pdf')
        """, (e1,))
        conn.execute("""
            INSERT INTO attachments (email_id, filename, content_type, size, path)
            VALUES (?, 'second-a.pdf', 'application/pdf', 200, '/tmp/second-a.pdf'),
                   (?, 'second-b.png', 'image/png',       300, '/tmp/second-b.png')
        """, (e2, e2))
        conn.commit()
        conn.close()
        return e1, e2

    def test_each_message_lists_its_own_attachments(self, db_dir, capsys):
        self._seed(db_dir)
        email_addon.cmd_thread_detail(CONFIG, "t1")
        out = capsys.readouterr().out
        # All three filenames appear in the output
        assert "first.pdf" in out
        assert "second-a.pdf" in out
        assert "second-b.png" in out

    def test_message_without_attachments_has_no_section(self, db_dir, capsys):
        """Seed a thread where only one of two messages has attachments."""
        conn = email_addon.open_email_db(CONFIG).conn
        conn.execute("""
            INSERT INTO threads (thread_id, subject, last_message_id,
              references_chain, last_sender, last_sender_full, participants, message_count)
            VALUES ('t1', 'Mixed', '<m2@x>', '[]', 'a@x', 'a@x', '[]', 2)
        """)
        c1 = conn.execute("""
            INSERT INTO emails (thread_id, message_id, direction, sender, recipient, cc, subject, body)
            VALUES ('t1', '<m1@x>', 'in', 'a@x', 'me', '', 'Mixed', 'plain text only')
        """)
        c2 = conn.execute("""
            INSERT INTO emails (thread_id, message_id, direction, sender, recipient, cc, subject, body)
            VALUES ('t1', '<m2@x>', 'in', 'a@x', 'me', '', 'Re: Mixed', 'has attachment')
        """)
        conn.execute("""
            INSERT INTO attachments (email_id, filename, content_type, size, path)
            VALUES (?, 'doc.pdf', 'application/pdf', 1, '/tmp/doc.pdf')
        """, (c2.lastrowid,))
        conn.commit()
        conn.close()

        email_addon.cmd_thread_detail(CONFIG, "t1")
        out = capsys.readouterr().out
        # Attachments section appears exactly once — for c2 only
        assert out.count("**Attachments:**") == 1
        assert "doc.pdf" in out

    def test_attachment_only_message_marked_in_thread_view(self, db_dir, capsys):
        """In the thread view, an attachment-only message gets the same
        explicit marker as in the single-message view."""
        self._seed(db_dir)
        email_addon.cmd_thread_detail(CONFIG, "t1")
        out = capsys.readouterr().out
        assert "2 attachment(s) below" in out

    def test_thread_view_uses_single_bulk_query_for_attachments(
        self, db_dir, monkeypatch
    ):
        """Performance contract: per-email N+1 queries are bad form for a
        view that already paginates by thread. Spy on the DB layer and
        assert ``list_attachments_for_thread`` is the entry point — not
        ``list_attachments_for_email`` once per message.
        """
        e1, e2 = self._seed(db_dir)
        # Spy by wrapping the methods on the open DB inside cmd_thread_detail
        calls = {"thread": 0, "per_email": 0}
        orig_open = email_addon.open_email_db

        def wrapped_open(cfg):
            db = orig_open(cfg)
            orig_thread = db.list_attachments_for_thread
            orig_per = db.list_attachments_for_email

            def t(tid):
                calls["thread"] += 1
                return orig_thread(tid)

            def p(eid):
                calls["per_email"] += 1
                return orig_per(eid)

            db.list_attachments_for_thread = t
            db.list_attachments_for_email = p
            return db

        monkeypatch.setattr(email_addon, "open_email_db", wrapped_open)
        email_addon.cmd_thread_detail(CONFIG, "t1")
        assert calls["thread"] == 1
        assert calls["per_email"] == 0  # no N+1


class TestPollerPersistsAttachments:
    """End-to-end: ``_fetch_new_emails`` must call ``db.insert_attachments``
    so display commands later see the rows. The unit-level bug — extracting
    attachments to disk but never persisting — lived in this exact gap.
    """

    def _build_raw(self):
        return (
            b"From: alice@x.com\r\n"
            b"To: agent@test.local\r\n"
            b"Subject: With attachment\r\n"
            b"Message-ID: <m-att@x>\r\n"
            b"Date: Mon, 1 Jan 2024 00:00:00 +0000\r\n"
            b"\r\n"
            b"body"
        )

    def _client(self, raw, uid=42):
        client = MagicMock()
        client.search_new.return_value = [uid]
        client.fetch_peek_many.return_value = {uid: (raw, False)}
        return client

    def test_attachments_persisted_to_db(self, db_dir, monkeypatch):
        """Faked extract_attachments returns one row → DB must contain it."""
        fake_atts = [{
            "filename": "concept.docx",
            "content_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "size": 17113,
            "path": "/home/agent/.index/email/attachments/t/concept.docx",
        }]
        monkeypatch.setattr(email_addon, "write_to_atlas_inbox", lambda *a, **kw: 1)
        monkeypatch.setattr(email_addon, "save_email_file",     lambda *a, **kw: "/tmp/x.md")
        monkeypatch.setattr(email_addon, "extract_attachments", lambda *a, **kw: fake_atts)
        monkeypatch.setattr(email_addon, "subprocess", MagicMock())

        client = self._client(self._build_raw())
        db = email_addon.open_email_db(CONFIG)
        try:
            email_addon._fetch_new_emails(client, db, dict(CONFIG))
        finally:
            db.close()

        # Re-open and assert the row landed
        db = email_addon.open_email_db(CONFIG)
        try:
            row = db.conn.execute(
                "SELECT id FROM emails WHERE direction='in'"
            ).fetchone()
            assert row is not None
            atts = db.list_attachments_for_email(row["id"])
            assert len(atts) == 1
            assert atts[0].filename == "concept.docx"
            assert atts[0].size == 17113
            assert atts[0].path.endswith("concept.docx")
        finally:
            db.close()

    def test_no_attachments_does_not_insert_rows(self, db_dir, monkeypatch):
        """Empty list path: insert_attachments(_, []) is a no-op; no spurious
        rows from messages without attachments."""
        monkeypatch.setattr(email_addon, "write_to_atlas_inbox", lambda *a, **kw: 1)
        monkeypatch.setattr(email_addon, "save_email_file",     lambda *a, **kw: "/tmp/x.md")
        monkeypatch.setattr(email_addon, "extract_attachments", lambda *a, **kw: [])
        monkeypatch.setattr(email_addon, "subprocess", MagicMock())

        client = self._client(self._build_raw())
        db = email_addon.open_email_db(CONFIG)
        try:
            email_addon._fetch_new_emails(client, db, dict(CONFIG))
        finally:
            db.close()

        db = email_addon.open_email_db(CONFIG)
        try:
            count = db.conn.execute("SELECT COUNT(*) FROM attachments").fetchone()[0]
            assert count == 0
        finally:
            db.close()


# ---------------------------------------------------------------------------
# Attachment summary: consolidated tool hints (token-efficient)
# ---------------------------------------------------------------------------

class TestAttachmentSummary:
    """Pin the restructured attachment summary in _fetch_new_emails:
    tool hints are emitted ONCE after the file list rather than per-file,
    and only for types that actually appear.
    """

    _RAW = (
        b"From: alice@x.com\r\n"
        b"To: agent@test.local\r\n"
        b"Subject: Test\r\n"
        b"Message-ID: <m-sum@x>\r\n"
        b"Date: Mon, 1 Jan 2024 00:00:00 +0000\r\n"
        b"\r\n"
        b"body text"
    )

    def _run(self, monkeypatch, db_dir, fake_atts):
        """Invoke _fetch_new_emails with faked attachments; return inbox body."""
        captured = {}

        def fake_inbox(sender, content, thread_id):
            captured["content"] = content
            return 1

        monkeypatch.setattr(email_addon, "write_to_atlas_inbox", fake_inbox)
        monkeypatch.setattr(email_addon, "save_email_file", lambda *a, **kw: "/tmp/x.md")
        monkeypatch.setattr(email_addon, "extract_attachments", lambda *a, **kw: fake_atts)
        monkeypatch.setattr(email_addon, "subprocess", MagicMock())

        client = MagicMock()
        client.search_new.return_value = [42]
        client.fetch_peek_many.return_value = {42: (self._RAW, False)}

        db = email_addon.open_email_db(CONFIG)
        try:
            email_addon._fetch_new_emails(client, db, dict(CONFIG))
        finally:
            db.close()

        return captured.get("content", "")

    def test_two_videos_hint_emitted_once(self, db_dir, monkeypatch):
        """2 videos → Tool hints line appears exactly once, mentions both
        stt and unclutter-video-analyze, does NOT repeat per video."""
        fake_atts = [
            {"filename": "clip1.mp4", "content_type": "video/mp4",
             "size": 22020096, "path": "/tmp/clip1.mp4"},
            {"filename": "clip2.mov", "content_type": "video/quicktime",
             "size": 10485760, "path": "/tmp/clip2.mov"},
        ]
        content = self._run(monkeypatch, db_dir, fake_atts)

        assert "clip1.mp4" in content
        assert "clip2.mov" in content
        # Hint line present exactly once
        assert content.count("Tool hints:") == 1
        assert "stt" in content
        assert "unclutter-video-analyze" in content
        # Must NOT repeat per-file (the old inline form had "For video:" each time)
        assert content.count("stt") == 1
        assert content.count("unclutter-video-analyze") == 1

    def test_one_pdf_hint_mentions_document_parse_not_stt(self, db_dir, monkeypatch):
        """1 PDF → Tool hints line mentions document-parse; no stt mention."""
        fake_atts = [
            {"filename": "report.pdf", "content_type": "application/pdf",
             "size": 3145728, "path": "/tmp/report.pdf"},
        ]
        content = self._run(monkeypatch, db_dir, fake_atts)

        assert "report.pdf" in content
        assert content.count("Tool hints:") == 1
        assert "document-parse" in content
        assert "stt" not in content
        assert "unclutter-video-analyze" not in content

    def test_mixed_image_video_pdf_both_clauses(self, db_dir, monkeypatch, tmp_path):
        """1 image (preview) + 1 video + 1 PDF → both video and document
        clauses appear; image preview Original: sub-line is preserved."""
        # Create a real file for the original_path size lookup
        orig_img = str(tmp_path / "photo.png")
        with open(orig_img, "wb") as f:
            f.write(b"\x89PNG" + b"\x00" * (100 * 1024))  # 100 KB stub
        preview_img = str(tmp_path / "photo-preview.jpg")
        with open(preview_img, "wb") as f:
            f.write(b"\xff\xd8" + b"\x00" * (50 * 1024))  # 50 KB preview stub

        fake_atts = [
            {
                "filename": "photo.png",
                "content_type": "image/png",
                "size": 50 * 1024,
                "path": preview_img,
                "is_preview": True,
                "original_path": orig_img,
            },
            {"filename": "Spot.mp4", "content_type": "video/mp4",
             "size": 22020096, "path": "/tmp/Spot.mp4"},
            {"filename": "report.pdf", "content_type": "application/pdf",
             "size": 3145728, "path": "/tmp/report.pdf"},
        ]
        content = self._run(monkeypatch, db_dir, fake_atts)

        # All three filenames present
        assert "photo.png" in content
        assert "Spot.mp4" in content
        assert "report.pdf" in content
        # Image preview sub-line preserved
        assert "Original:" in content
        # Both hint clauses present in a single Tool hints line
        assert content.count("Tool hints:") == 1
        assert "stt" in content
        assert "unclutter-video-analyze" in content
        assert "document-parse" in content

    def test_only_images_no_tool_hints(self, db_dir, monkeypatch, tmp_path):
        """Emails with only image attachments must NOT emit a Tool hints line."""
        orig_img = str(tmp_path / "banner.png")
        with open(orig_img, "wb") as f:
            f.write(b"\x89PNG" + b"\x00" * (100 * 1024))
        preview_img = str(tmp_path / "banner-preview.jpg")
        with open(preview_img, "wb") as f:
            f.write(b"\xff\xd8" + b"\x00" * (50 * 1024))

        fake_atts = [
            {
                "filename": "banner.png",
                "content_type": "image/png",
                "size": 50 * 1024,
                "path": preview_img,
                "is_preview": True,
                "original_path": orig_img,
            },
        ]
        content = self._run(monkeypatch, db_dir, fake_atts)

        assert "banner.png" in content
        assert "Tool hints:" not in content


# ---------------------------------------------------------------------------
# Image preview shrink (_maybe_shrink_image)
# ---------------------------------------------------------------------------

class TestMaybeShrinkImage:
    """Tests for the Pillow-based image pre-shrink helper."""

    def _make_png(self, path: str, width: int, height: int, noisy: bool = False) -> int:
        """Create a PNG test fixture using Pillow and return its file size.

        Use ``noisy=True`` to generate random-pixel content that resists PNG
        compression and reliably exceeds the 800 KB threshold.
        """
        import random
        from PIL import Image
        if noisy:
            pixels = [
                (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
                for _ in range(width * height)
            ]
            img = Image.new("RGB", (width, height))
            img.putdata(pixels)
        else:
            img = Image.new("RGB", (width, height), "red")
        img.save(path, "PNG")
        return os.path.getsize(path)

    def test_large_png_creates_preview_and_swaps_path(self, tmp_path):
        """A PNG larger than 800 KB must get a -preview.jpg beside it,
        with ``path`` swapped to the preview and ``original_path`` set."""
        orig = str(tmp_path / "HUNTER_CHATGPT_01.png")
        # Use noisy (random pixel) content so PNG compression can't shrink it
        # below the 800 KB threshold — solid-color images compress to ~16 KB.
        size = self._make_png(orig, 1200, 800, noisy=True)

        att = {
            "filename": "HUNTER_CHATGPT_01.png",
            "content_type": "image/png",
            "size": size,
            "path": orig,
        }
        result = email_addon._maybe_shrink_image(att)

        preview = str(tmp_path / "HUNTER_CHATGPT_01-preview.jpg")
        assert os.path.exists(preview), "Preview JPEG must be created on disk"
        assert result["path"] == preview, "path must point to the preview"
        assert result["original_path"] == orig, "original_path must be the original file"
        assert result["size"] == os.path.getsize(preview), "size must reflect the preview"
        assert result.get("is_preview") is True

    def test_small_png_skips_preview(self, tmp_path):
        """A PNG smaller than 800 KB must be left unchanged — no preview created."""
        orig = str(tmp_path / "small.png")
        # 100x100 PNG is definitely under 800 KB
        size = self._make_png(orig, 100, 100)
        assert size < email_addon._IMAGE_PREVIEW_SIZE_THRESHOLD, \
            "fixture must be small for this test to be meaningful"

        att = {
            "filename": "small.png",
            "content_type": "image/png",
            "size": size,
            "path": orig,
        }
        result = email_addon._maybe_shrink_image(att)

        assert result["path"] == orig, "path must be unchanged for small images"
        assert "original_path" not in result, "original_path must not be set"
        assert not result.get("is_preview")
        # No -preview.jpg should appear next to the file
        preview = str(tmp_path / "small-preview.jpg")
        assert not os.path.exists(preview)

    def test_svg_skipped_regardless_of_size(self, tmp_path):
        """SVGs are excluded from preview even if large."""
        orig = str(tmp_path / "icon.svg")
        # Write a fake large SVG (just needs to exist and report a big size)
        open(orig, "wb").write(b"<svg>" + b"x" * (900 * 1024) + b"</svg>")
        att = {
            "filename": "icon.svg",
            "content_type": "image/svg+xml",
            "size": os.path.getsize(orig),
            "path": orig,
        }
        result = email_addon._maybe_shrink_image(att)
        assert result["path"] == orig

    def test_non_image_skipped(self, tmp_path):
        """Non-image attachments (video, PDF, etc.) are untouched."""
        orig = str(tmp_path / "Spot.mp4")
        open(orig, "wb").write(b"\x00" * (2 * 1024 * 1024))
        att = {
            "filename": "Spot.mp4",
            "content_type": "video/mp4",
            "size": os.path.getsize(orig),
            "path": orig,
        }
        result = email_addon._maybe_shrink_image(att)
        assert result["path"] == orig

    def test_preview_longest_edge_at_most_1280(self, tmp_path):
        """The preview image must not exceed 1280 px on its longest edge."""
        orig = str(tmp_path / "wide.png")
        size = self._make_png(orig, 3000, 1000, noisy=True)

        att = {
            "filename": "wide.png",
            "content_type": "image/png",
            "size": size,
            "path": orig,
        }
        result = email_addon._maybe_shrink_image(att)

        if result.get("is_preview"):
            from PIL import Image
            img = Image.open(result["path"])
            assert max(img.size) <= 1280, \
                f"Preview longest edge must be ≤1280 px, got {max(img.size)}"

    def test_corrupt_image_leaves_original_and_warns(self, tmp_path, capsys):
        """A corrupt file must not crash — warning on stderr, path unchanged."""
        orig = str(tmp_path / "corrupt.png")
        open(orig, "wb").write(b"this is not a png" + b"\x00" * (900 * 1024))
        att = {
            "filename": "corrupt.png",
            "content_type": "image/png",
            "size": os.path.getsize(orig),
            "path": orig,
        }
        result = email_addon._maybe_shrink_image(att)
        assert result["path"] == orig, "path must be unchanged on error"
        err = capsys.readouterr().err
        assert "WARNING" in err or "could not create preview" in err


# ---------------------------------------------------------------------------
# SMTP connect: STARTTLS + AUTH conditional on advertised capabilities
# ---------------------------------------------------------------------------

class TestSmtpConnect:
    """``_smtp_connect`` must negotiate STARTTLS and AUTH *conditionally* on
    the EHLO response. Production submission MTAs advertise both, so the
    happy path is unchanged. Test servers, internal smarthosts, and
    IP-whitelisted relays don't — and the previous hard-coded
    ``starttls() + login()`` flow broke against every one of them.
    """

    def _make_server(self, monkeypatch, capabilities):
        """Stub smtplib.SMTP. ``capabilities`` is the set of extensions the
        server advertises (lower-case names — matches what smtplib.has_extn
        expects after EHLO).
        """
        import smtplib

        server = MagicMock()
        # has_extn() is the standard smtplib API for "did EHLO advertise X?"
        server.has_extn.side_effect = lambda ext: ext.lower() in capabilities
        monkeypatch.setattr(smtplib, "SMTP", lambda host, port: server)
        return server

    def test_production_tls_plus_auth_path_unchanged(self, monkeypatch):
        """Server advertises both STARTTLS and AUTH (the production case):
        we must still call starttls() and login() exactly as before.
        """
        server = self._make_server(monkeypatch, {"starttls", "auth"})
        result = email_addon._smtp_connect(CONFIG)
        assert result is server
        server.starttls.assert_called_once()
        server.login.assert_called_once_with(CONFIG["username"], CONFIG["password"])

    def test_starttls_skipped_when_not_advertised(self, monkeypatch):
        """Plain-SMTP submission ports (test servers, internal MTAs) don't
        advertise STARTTLS. Calling starttls() against them raises
        SMTPNotSupportedError and kills the session — so we must skip.
        """
        server = self._make_server(monkeypatch, {"auth"})  # AUTH only, no STARTTLS
        email_addon._smtp_connect(CONFIG)
        server.starttls.assert_not_called()
        server.login.assert_called_once()

    def test_auth_skipped_when_not_advertised(self, monkeypatch):
        """IP-whitelisted relays and auth-disabled test servers don't
        advertise AUTH. Sending ``AUTH PLAIN`` is answered with 500 and
        breaks the connection — so we must skip login() too.
        """
        server = self._make_server(monkeypatch, {"starttls"})  # STARTTLS only
        email_addon._smtp_connect(CONFIG)
        server.starttls.assert_called_once()
        server.login.assert_not_called()

    def test_plain_smtp_no_extensions(self, monkeypatch):
        """A bare SMTP server (e.g. GreenMail w/ -Dgreenmail.auth.disabled
        on a non-TLS submission port) advertises neither extension. We
        must connect and send unauthenticated, unencrypted — the
        operator opted into this by pointing us at this host.
        """
        server = self._make_server(monkeypatch, set())
        email_addon._smtp_connect(CONFIG)
        server.starttls.assert_not_called()
        server.login.assert_not_called()

    def test_rehello_after_starttls(self, monkeypatch):
        """RFC 3207: after a successful STARTTLS, the client MUST discard
        any cached EHLO response and re-issue EHLO over the encrypted
        channel — most servers only advertise AUTH after STARTTLS.
        """
        server = self._make_server(monkeypatch, {"starttls", "auth"})
        email_addon._smtp_connect(CONFIG)
        # EHLO once before STARTTLS (capability probe) + once after
        # (post-TLS capability refresh).
        assert server.ehlo.call_count >= 2

    def test_login_smtpnotsupported_is_tolerated(self, monkeypatch):
        """AUTH is advertised but the mechanism set doesn't overlap with
        what smtplib can negotiate (e.g. XOAUTH2-only against a plain
        password). We swallow rather than dropping the message — the
        server will respond with 530/535 on RCPT if auth was actually
        required.
        """
        import smtplib

        server = self._make_server(monkeypatch, {"starttls", "auth"})
        server.login.side_effect = smtplib.SMTPNotSupportedError("no overlap")
        # Should not raise — we want to attempt to send anyway.
        email_addon._smtp_connect(CONFIG)
        server.login.assert_called_once()
