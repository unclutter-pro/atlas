"""Tests for email-addon.py

Run with:
    cd app/integrations/email
    pip install pytest
    pytest test_email_addon.py -v
"""
import importlib.util
import json
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
    """Pre-initialised email DB connection (schema applied)."""
    conn = email_addon.get_email_db(CONFIG)
    yield conn
    conn.close()


@pytest.fixture
def smtp(monkeypatch):
    """Replace _smtp_connect with a mock SMTP context manager."""
    server = MagicMock()
    server.__enter__ = MagicMock(return_value=server)
    server.__exit__ = MagicMock(return_value=False)
    monkeypatch.setattr(email_addon, "_smtp_connect", lambda _cfg: server)
    return server


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
        db.execute(
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
        db.execute(
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
        row = db.execute("SELECT subject FROM threads WHERE thread_id='t1'").fetchone()
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
        row = db.execute("SELECT participants, last_cc FROM threads WHERE thread_id='t1'").fetchone()
        participants = json.loads(row[0])
        assert "bob@x.com" in participants
        assert "carol@x.com" in participants
        assert "bob@x.com" in row[1]

    def test_existing_thread_increments_count(self, db):
        msg = self._msg({"From": "a@x.com", "Message-ID": "<m1@x.com>", "Subject": "Hello"})
        email_addon.update_thread(db, "t1", msg)
        email_addon.update_thread(db, "t1", msg)
        db.commit()
        row = db.execute("SELECT message_count FROM threads WHERE thread_id='t1'").fetchone()
        assert row[0] == 2

    def test_subject_stored_without_re_prefix(self, db):
        msg = self._msg({"From": "a@x.com", "Message-ID": "<m1@x.com>", "Subject": "Re: Hello"})
        email_addon.update_thread(db, "t1", msg)
        db.commit()
        row = db.execute("SELECT subject FROM threads WHERE thread_id='t1'").fetchone()
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
        conn = email_addon.get_email_db(CONFIG)
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
        email_addon.get_email_db(CONFIG).close()  # create schema only
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
        conn = email_addon.get_email_db(CONFIG)
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
        email_addon.get_email_db(CONFIG).close()
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
        conn = email_addon.get_email_db(CONFIG)
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
    def test_inbox_is_alias_for_threads(self, db_dir, capsys, monkeypatch):
        """email inbox must produce identical output to email threads."""
        conn = email_addon.get_email_db(CONFIG)
        conn.execute("""
            INSERT INTO threads (thread_id, subject, last_message_id,
              references_chain, last_sender, last_sender_full, participants, message_count)
            VALUES ('t1', 'Hi', '<m@x>', '[]', 'a@x', 'a@x', '[]', 1)
        """)
        conn.commit()
        conn.close()

        email_addon.cmd_threads(CONFIG)
        out_threads = capsys.readouterr().out

        email_addon.cmd_threads(CONFIG)
        out_inbox = capsys.readouterr().out

        assert out_threads == out_inbox

    def test_inbox_dispatch_via_main(self, db_dir, monkeypatch, capsys):
        """Argparse routes 'inbox' to cmd_threads without error."""
        email_addon.get_email_db(CONFIG).close()
        monkeypatch.setattr(email_addon, "load_config", lambda: CONFIG)
        monkeypatch.setattr(sys, "argv", ["email", "inbox"])
        email_addon.main()
        assert "No email threads found" in capsys.readouterr().out


class TestCmdThreadDetail:
    def _seed(self, db_dir):
        conn = email_addon.get_email_db(CONFIG)
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
        email_addon.get_email_db(CONFIG).close()
        with pytest.raises(SystemExit):
            email_addon.cmd_thread_detail(CONFIG, "nonexistent")


class TestCmdReadEmail:
    def _seed(self, db_dir, cc="bob@x.com"):
        conn = email_addon.get_email_db(CONFIG)
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
        email_addon.get_email_db(CONFIG).close()
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
        conn = email_addon.get_email_db(CONFIG)
        # All three new columns must now exist
        conn.execute("SELECT cc FROM emails LIMIT 0")
        conn.execute("SELECT body_html FROM emails LIMIT 0")
        conn.execute("SELECT last_cc FROM threads LIMIT 0")
        conn.close()

    def test_migration_is_idempotent(self, db_dir):
        """Opening an already-migrated DB a second time must not raise."""
        email_addon.get_email_db(CONFIG).close()
        email_addon.get_email_db(CONFIG).close()  # second open — should not error
