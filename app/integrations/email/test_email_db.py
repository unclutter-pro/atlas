"""Tests for email_db.EmailDb — isolated repository tests.

The repository wraps a real SQLite database (in-memory or on tmp_path) —
no IMAP, no SMTP, no config files. Each test seeds via the typed
methods where possible and reads back via the same API.

Run with:
    pytest test_email_db.py -v
"""
import json
import sqlite3

import pytest

from email_db import (
    Attachment,
    Email,
    EmailDb,
    EmailDbSchemaError,
    EmailTarget,
    Thread,
)


CONFIG = {"username": "agent@test.local"}


# ── Fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture
def db(tmp_path):
    """Fresh EmailDb backed by a temp on-disk file."""
    instance = EmailDb.open(CONFIG, db_dir=str(tmp_path))
    yield instance
    instance.close()


def _seed_thread(db, thread_id="t1", subject="Hi", count=1, last_cc=""):
    db.conn.execute(
        """INSERT INTO threads (thread_id, subject, last_message_id,
              references_chain, last_sender, last_sender_full, last_cc,
              participants, message_count)
           VALUES (?, ?, '<m@x>', '[]', 'a@x', 'a@x', ?, '["a@x"]', ?)""",
        (thread_id, subject, last_cc, count),
    )
    db.commit()


def _seed_email(db, *, thread_id="t1", direction="in", uid=42,
                folder="INBOX", is_read=0, message_id=None, subject="Hi"):
    if message_id is None:
        message_id = f"<m-{direction}-{uid}@x>"
    cur = db.conn.execute(
        """INSERT INTO emails (thread_id, message_id, direction, sender, recipient,
              cc, subject, body, body_html, imap_uid, folder, is_read)
           VALUES (?, ?, ?, 'a@x', 'me', '', ?, 'body', '', ?, ?, ?)""",
        (thread_id, message_id, direction, subject, uid, folder, is_read),
    )
    db.commit()
    return cur.lastrowid


# ── Open / lifecycle ────────────────────────────────────────────────────────

class TestOpen:
    def test_creates_db_file_at_sanitized_path(self, tmp_path):
        db = EmailDb.open({"username": "alice/strange?name@x"}, db_dir=str(tmp_path))
        files = list(tmp_path.iterdir())
        db.close()
        # Filename uses only safe chars: '/' → '_', '?' → '_'
        names = [f.name for f in files]
        assert any("alice_strange_name@x.db" == n for n in names), names

    def test_open_is_idempotent(self, tmp_path):
        a = EmailDb.open(CONFIG, db_dir=str(tmp_path))
        b = EmailDb.open(CONFIG, db_dir=str(tmp_path))  # same file, schema already in place
        a.close()
        b.close()

    def test_context_manager_closes(self, tmp_path):
        with EmailDb.open(CONFIG, db_dir=str(tmp_path)) as db:
            assert db.get_last_uid() == 0
        # close() ran via __exit__; using the conn would raise
        with pytest.raises(Exception):
            db.conn.execute("SELECT 1")

    def test_accepts_emailconfig_object(self, tmp_path):
        """EmailDb.open should accept any object with a .username attr."""
        class Cfg:
            username = "agent@x.test"
        db = EmailDb.open(Cfg(), db_dir=str(tmp_path))
        assert (tmp_path / "agent@x.test.db").exists()
        db.close()


# ── Schema + migrations ─────────────────────────────────────────────────────

class TestSchema:
    def test_creates_all_tables(self, db):
        tables = {
            r[0] for r in db.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        assert {"threads", "emails", "state"}.issubset(tables)

    def test_has_indexes_on_filter_columns(self, db):
        idx = {
            r[0] for r in db.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index'"
            ).fetchall()
        }
        for required in (
            "idx_emails_thread",
            "idx_emails_direction",
            "idx_emails_folder",
            "idx_emails_is_read",
            "idx_emails_message_id",
        ):
            assert required in idx, f"missing index: {required}"


class TestSchemaProbe:
    """Validate that the post-bootstrap schema probe fails loud on drift.

    A regression here would let an email-handler session run for hours
    against a half-migrated DB, surfacing only as ``OperationalError``
    inside the graceful-degradation paths (see 2026-05-26 post-mortem).
    """

    def _db_path_for(self, tmp_path) -> str:
        from re import sub
        account = sub(r"[^a-zA-Z0-9@._-]", "_", CONFIG["username"])
        return str(tmp_path / f"{account}.db")

    def test_healthy_db_passes_probe(self, db):
        # Probe already ran inside the fixture's EmailDb.open — if it
        # had raised, the fixture would never have yielded.
        present = {
            r[1]
            for r in db.conn.execute("PRAGMA table_info(emails)").fetchall()
        }
        # Spot-check the columns the postmortem explicitly cited as missing
        # in the broken session — ``sender`` is the modern equivalent of
        # the legacy ``from_addr``.
        assert {"sender", "recipient", "folder", "is_read"}.issubset(present)

    def test_missing_table_raises_loudly(self, tmp_path, monkeypatch):
        """Dropping a required table after bootstrap must surface on next open."""
        path = self._db_path_for(tmp_path)
        EmailDb.open(CONFIG, db_dir=str(tmp_path)).close()

        # Simulate a corrupted DB: drop ``state`` between opens.
        conn = sqlite3.connect(path)
        conn.execute("DROP TABLE state")
        conn.commit()
        conn.close()

        # The probe runs after _bootstrap_schema, which itself uses
        # ``CREATE TABLE IF NOT EXISTS``. Re-creation would mask the
        # original problem, so simulate a regression by neutering
        # _bootstrap_schema for one call — equivalent to a future
        # migration forgetting to add a new required table.
        original = EmailDb._bootstrap_schema
        monkeypatch.setattr(EmailDb, "_bootstrap_schema", lambda self: None)
        try:
            with pytest.raises(EmailDbSchemaError) as exc:
                EmailDb.open(CONFIG, db_dir=str(tmp_path))
            assert "state" in str(exc.value)
            assert path in str(exc.value)
        finally:
            monkeypatch.setattr(EmailDb, "_bootstrap_schema", original)

    def test_missing_column_raises_loudly(self, tmp_path, monkeypatch):
        """A required column missing from a present table must fail loud."""
        path = self._db_path_for(tmp_path)
        EmailDb.open(CONFIG, db_dir=str(tmp_path)).close()

        # Rebuild ``emails`` without ``sender`` — sqlite has no DROP COLUMN
        # before 3.35, so swap the table out wholesale.
        conn = sqlite3.connect(path)
        conn.executescript("""
            ALTER TABLE emails RENAME TO emails_old;
            CREATE TABLE emails (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_id    TEXT NOT NULL,
                message_id   TEXT NOT NULL DEFAULT '',
                direction    TEXT NOT NULL DEFAULT 'in',
                recipient    TEXT NOT NULL DEFAULT '',
                cc           TEXT NOT NULL DEFAULT '',
                subject      TEXT NOT NULL DEFAULT '',
                body         TEXT NOT NULL DEFAULT '',
                body_html    TEXT NOT NULL DEFAULT '',
                headers_json TEXT NOT NULL DEFAULT '{}',
                inbox_msg_id INTEGER,
                imap_uid     INTEGER,
                is_read      INTEGER NOT NULL DEFAULT 0,
                folder       TEXT NOT NULL DEFAULT 'INBOX',
                created_at   TEXT NOT NULL DEFAULT (datetime('now'))
            );
            DROP TABLE emails_old;
        """)
        conn.commit()
        conn.close()

        # Skip bootstrap so the missing column survives long enough
        # for the probe to catch it (the live migration loop would
        # otherwise ALTER the column back in).
        monkeypatch.setattr(EmailDb, "_bootstrap_schema", lambda self: None)
        with pytest.raises(EmailDbSchemaError) as exc:
            EmailDb.open(CONFIG, db_dir=str(tmp_path))
        msg = str(exc.value)
        assert "emails" in msg
        assert "sender" in msg


class TestLegacyMigration:
    """Opening an old schema must add the new columns + run the backfill."""

    def _make_legacy_db(self, tmp_path):
        """Build a pre-cc/pre-folder DB file matching the very first release."""
        from re import sub
        account = sub(r"[^a-zA-Z0-9@._-]", "_", CONFIG["username"])
        path = tmp_path / f"{account}.db"
        conn = sqlite3.connect(str(path))
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
                direction TEXT NOT NULL DEFAULT 'in'
            );
            CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
            INSERT INTO emails (thread_id, direction) VALUES ('t1', 'out'), ('t1', 'in');
        """)
        conn.commit()
        conn.close()

    def test_legacy_db_gets_new_columns(self, tmp_path):
        self._make_legacy_db(tmp_path)
        db = EmailDb.open(CONFIG, db_dir=str(tmp_path))
        try:
            # All migrated columns must exist
            for col in ("cc", "body_html", "imap_uid", "is_read", "folder"):
                db.conn.execute(f"SELECT {col} FROM emails LIMIT 0")
            db.conn.execute("SELECT last_cc FROM threads LIMIT 0")
        finally:
            db.close()

    def test_legacy_outgoing_rows_backfilled_to_sent(self, tmp_path):
        """The default of 'INBOX' is wrong for pre-existing 'out' rows."""
        self._make_legacy_db(tmp_path)
        db = EmailDb.open(CONFIG, db_dir=str(tmp_path))
        rows = dict(db.conn.execute(
            "SELECT direction, folder FROM emails"
        ).fetchall())
        db.close()
        assert rows["out"] == "Sent"
        assert rows["in"]  == "INBOX"

    def test_backfill_runs_only_once_across_reopens(self, tmp_path):
        """The backfill UPDATE must be gated on a state key so the IDLE
        poller's frequent reconnects don't take a write lock for nothing.

        After the first open, a stray ``out`` row deliberately put back
        into ``folder='INBOX'`` must survive a subsequent open — proof
        that the backfill didn't re-fire.
        """
        self._make_legacy_db(tmp_path)
        # First open: backfill runs.
        EmailDb.open(CONFIG, db_dir=str(tmp_path)).close()

        # Inject a row that the backfill would otherwise hit on the next open.
        from re import sub
        account = sub(r"[^a-zA-Z0-9@._-]", "_", CONFIG["username"])
        conn = sqlite3.connect(str(tmp_path / f"{account}.db"))
        conn.execute(
            "INSERT INTO emails (thread_id, direction, folder, imap_uid) "
            "VALUES ('t1', 'out', 'INBOX', NULL)"
        )
        conn.commit()
        conn.close()

        # Second open: backfill is gated, the stray INBOX row stays put.
        db = EmailDb.open(CONFIG, db_dir=str(tmp_path))
        rows = db.conn.execute(
            "SELECT folder FROM emails WHERE direction='out' AND imap_uid IS NULL"
        ).fetchall()
        db.close()
        folders = {r[0] for r in rows}
        assert "INBOX" in folders, (
            "backfill re-ran on the second open — it should be gated by a state key"
        )


# ── State ────────────────────────────────────────────────────────────────────

class TestState:
    def test_last_uid_default(self, db):
        assert db.get_last_uid() == 0

    def test_set_and_get_last_uid(self, db):
        db.set_last_uid(99)
        db.commit()
        assert db.get_last_uid() == 99

    def test_overwriting_last_uid(self, db):
        db.set_last_uid(10)
        db.set_last_uid(20)
        db.commit()
        assert db.get_last_uid() == 20


# ── Threads ─────────────────────────────────────────────────────────────────

class TestGetThread:
    def test_missing_thread_returns_none(self, db):
        assert db.get_thread("nope") is None

    def test_returns_thread_with_decoded_json_columns(self, db):
        _seed_thread(db)
        t = db.get_thread("t1")
        assert isinstance(t, Thread)
        assert t.thread_id == "t1"
        # JSON columns must come back as Python lists
        assert isinstance(t.participants, list)
        assert isinstance(t.references_chain, list)


class TestUpsertIncomingThread:
    def test_first_message_creates_thread(self, db):
        info = db.upsert_incoming_thread(
            thread_id="t1",
            subject_clean="Hi",
            last_message_id="<m1@x>",
            references=["<m1@x>"],
            sender_addr="alice@x.com",
            sender_full="Alice <alice@x.com>",
            cc_raw="",
            cc_addrs=[],
        )
        db.commit()
        t = db.get_thread("t1")
        assert t.message_count == 1
        assert t.last_sender == "alice@x.com"
        assert info["thread_id"] == "t1"

    def test_second_message_increments_count(self, db):
        for _ in range(2):
            db.upsert_incoming_thread(
                thread_id="t1", subject_clean="Hi", last_message_id="<m@x>",
                references=["<m@x>"], sender_addr="a@x", sender_full="a@x",
                cc_raw="", cc_addrs=[],
            )
        db.commit()
        assert db.get_thread("t1").message_count == 2

    def test_merges_cc_into_participants(self, db):
        db.upsert_incoming_thread(
            thread_id="t1", subject_clean="Hi", last_message_id="<m@x>",
            references=[], sender_addr="alice@x",
            sender_full="Alice <alice@x>",
            cc_raw="bob@x, carol@x",
            cc_addrs=["bob@x", "carol@x"],
        )
        db.commit()
        t = db.get_thread("t1")
        assert "bob@x" in t.participants
        assert "carol@x" in t.participants
        assert "alice@x" in t.participants
        assert "bob@x" in t.last_cc


class TestInsertOutgoingThread:
    def test_creates_new_thread(self, db):
        db.insert_outgoing_thread(
            thread_id="t1", subject="Hello", last_message_id="<m@x>",
            username="me@x", cc_raw="", participants=["me@x", "bob@x"],
        )
        db.commit()
        t = db.get_thread("t1")
        assert t.subject == "Hello"
        assert t.message_count == 1
        assert "me@x" in t.participants

    def test_ignores_existing_thread(self, db):
        """INSERT OR IGNORE — don't clobber an existing row in a race."""
        _seed_thread(db, "t1", subject="Original", count=5)
        db.insert_outgoing_thread(
            thread_id="t1", subject="Different", last_message_id="<m@x>",
            username="me@x", cc_raw="", participants=[],
        )
        db.commit()
        assert db.get_thread("t1").subject == "Original"
        assert db.get_thread("t1").message_count == 5


class TestUpdateThreadAfterReply:
    def test_appends_to_chain_and_bumps_count(self, db):
        _seed_thread(db, "t1", count=1)
        db.update_thread_after_reply(
            thread_id="t1",
            last_message_id="<reply@x>",
            references=["<orig@x>", "<reply@x>"],
            last_cc="bob@x",
        )
        db.commit()
        t = db.get_thread("t1")
        assert t.message_count == 2
        assert t.last_message_id == "<reply@x>"
        assert t.references_chain == ["<orig@x>", "<reply@x>"]
        assert t.last_cc == "bob@x"


class TestAddThreadParticipants:
    def test_merges_new_addresses(self, db):
        _seed_thread(db)  # seeds participants=["a@x"]
        db.add_thread_participants("t1", ["bob@x", "carol@x"])
        db.commit()
        p = db.get_thread("t1").participants
        assert "a@x" in p and "bob@x" in p and "carol@x" in p

    def test_no_duplicate_addresses(self, db):
        _seed_thread(db)
        db.add_thread_participants("t1", ["a@x", "a@x"])
        db.commit()
        p = db.get_thread("t1").participants
        assert p.count("a@x") == 1

    def test_missing_thread_is_silent(self, db):
        """Adding to a non-existent thread shouldn't raise."""
        db.add_thread_participants("ghost", ["a@x"])  # no exception


# ── list_threads filters ────────────────────────────────────────────────────

class TestListThreads:
    def _seed_filterable(self, db):
        # Three threads spanning every relevant state
        db.conn.executescript("""
            INSERT INTO threads (thread_id, subject, last_message_id,
              references_chain, last_sender, last_sender_full, participants,
              message_count) VALUES
              ('inbox-unread', 'Hi',   '<m1>', '[]', 'a@x', 'a@x', '[]', 1),
              ('inbox-read',   'Done', '<m2>', '[]', 'a@x', 'a@x', '[]', 1),
              ('archived',     'Old',  '<m3>', '[]', 'a@x', 'a@x', '[]', 1);
            INSERT INTO emails (thread_id, message_id, direction, sender, recipient,
              subject, body, folder, is_read) VALUES
              ('inbox-unread', '<m1>', 'in', 'a@x', 'me', 'Hi',   'B', 'INBOX',   0),
              ('inbox-read',   '<m2>', 'in', 'a@x', 'me', 'Done', 'B', 'INBOX',   1),
              ('archived',     '<m3>', 'in', 'a@x', 'me', 'Old',  'B', 'Archive', 0);
        """)
        db.commit()

    def test_no_filter_returns_all(self, db):
        self._seed_filterable(db)
        threads, has_more = db.list_threads()
        ids = {t.thread_id for t in threads}
        assert ids == {"inbox-unread", "inbox-read", "archived"}
        assert has_more is False

    def test_filter_by_folder_inbox(self, db):
        self._seed_filterable(db)
        threads, _ = db.list_threads(folder="INBOX")
        assert {t.thread_id for t in threads} == {"inbox-unread", "inbox-read"}

    def test_filter_by_folder_archive(self, db):
        self._seed_filterable(db)
        threads, _ = db.list_threads(folder="Archive")
        assert {t.thread_id for t in threads} == {"archived"}

    def test_filter_unread_true(self, db):
        self._seed_filterable(db)
        threads, _ = db.list_threads(unread=True)
        ids = {t.thread_id for t in threads}
        assert "inbox-unread" in ids
        assert "archived" in ids       # also has an unread incoming
        assert "inbox-read" not in ids

    def test_filter_unread_false(self, db):
        self._seed_filterable(db)
        threads, _ = db.list_threads(unread=False)
        assert {t.thread_id for t in threads} == {"inbox-read"}

    def test_combined_folder_inbox_unread_true(self, db):
        """The combination that ``email inbox`` uses."""
        self._seed_filterable(db)
        threads, _ = db.list_threads(folder="INBOX", unread=True)
        assert {t.thread_id for t in threads} == {"inbox-unread"}

    def test_truncation_flag(self, db):
        """Limit-1 row → has_more=True; limit+1 row → False."""
        for i in range(5):
            _seed_thread(db, f"t{i}")
        threads, has_more = db.list_threads(limit=3)
        assert len(threads) == 3
        assert has_more is True
        # Asking for ≥ total rows → no truncation marker
        threads, has_more = db.list_threads(limit=10)
        assert has_more is False


# ── Thread-id derivation ────────────────────────────────────────────────────

class TestThreadIdLookup:
    def test_find_by_message_id_matches_raw_form(self, db):
        _seed_thread(db, "t1")
        _seed_email(db, message_id="<orig@x>")
        assert db.find_thread_id_by_message_ids(["<orig@x>"]) == "t1"

    def test_find_by_message_id_matches_stripped_form(self, db):
        _seed_thread(db, "t1")
        _seed_email(db, message_id="<orig@x>")
        # Caller passes the bare ID without brackets
        assert db.find_thread_id_by_message_ids(["orig@x"]) == "t1"

    def test_find_by_message_id_none_when_no_match(self, db):
        assert db.find_thread_id_by_message_ids(["<missing@x>"]) is None

    def test_find_by_message_id_empty_input(self, db):
        assert db.find_thread_id_by_message_ids([]) is None

    def test_find_by_subject_within_window(self, db):
        _seed_thread(db, "t1", subject="My Topic")
        assert db.find_thread_id_by_subject("My Topic") == "t1"

    def test_find_by_subject_outside_window_returns_none(self, db):
        """Threads updated longer ago than the window are ignored."""
        _seed_thread(db, "t1", subject="My Topic")
        # Push updated_at into the distant past
        db.conn.execute(
            "UPDATE threads SET updated_at = datetime('now', '-30 days') "
            "WHERE thread_id = 't1'"
        )
        db.commit()
        assert db.find_thread_id_by_subject("My Topic", max_age_days=14) is None

    def test_find_by_subject_empty_returns_none(self, db):
        assert db.find_thread_id_by_subject("") is None


# ── Emails ──────────────────────────────────────────────────────────────────

class TestInsertOutgoingEmail:
    def test_inserts_with_sent_folder_and_read(self, db):
        _seed_thread(db)
        eid = db.insert_outgoing_email(
            thread_id="t1", message_id="<reply@x>", sender="me@x",
            recipient="alice@x", cc="", subject="Re: Hi", body="Hello",
        )
        db.commit()
        e = db.get_email(eid)
        assert e.direction == "out"
        assert e.folder == "Sent"
        assert e.is_read == 1
        assert e.imap_uid is None  # outgoing rows never have one

    def test_truncates_body_to_8000_chars(self, db):
        _seed_thread(db)
        long_body = "a" * 20000
        eid = db.insert_outgoing_email(
            thread_id="t1", message_id="<m@x>", sender="me", recipient="a",
            cc="", subject="x", body=long_body,
        )
        db.commit()
        assert len(db.get_email(eid).body) == 8000


class TestInsertIncomingEmail:
    def test_stores_imap_uid_folder_is_read(self, db):
        _seed_thread(db)
        eid = db.insert_incoming_email(
            thread_id="t1", message_id="<m@x>", sender_addr="alice@x",
            cc="", subject="Hi", body="body", body_html="<p>body</p>",
            imap_uid=99, folder="INBOX", is_read=1,
        )
        db.commit()
        e = db.get_email(eid)
        assert e.direction == "in"
        assert e.imap_uid == 99
        assert e.folder == "INBOX"
        assert e.is_read == 1

    def test_body_html_truncated_to_50000(self, db):
        _seed_thread(db)
        html = "x" * 100000
        eid = db.insert_incoming_email(
            thread_id="t1", message_id="<m@x>", sender_addr="a", cc="",
            subject="x", body="x", body_html=html,
            imap_uid=1, folder="INBOX", is_read=0,
        )
        db.commit()
        assert len(db.get_email(eid).body_html) == 50000


class TestSetInboxMsgId:
    def test_updates_inbox_msg_id_on_matching_row(self, db):
        _seed_thread(db)
        eid = db.insert_incoming_email(
            thread_id="t1", message_id="<unique@x>", sender_addr="a", cc="",
            subject="x", body="x", body_html="",
            imap_uid=1, folder="INBOX", is_read=0,
        )
        db.set_inbox_msg_id(thread_id="t1", message_id="<unique@x>",
                            inbox_msg_id=123)
        db.commit()
        assert db.get_email(eid).inbox_msg_id == 123


class TestListThreadEmails:
    def test_returns_emails_in_created_order(self, db):
        _seed_thread(db)
        _seed_email(db, message_id="<m1@x>", direction="in")
        _seed_email(db, message_id="<m2@x>", direction="out")
        emails = db.list_thread_emails("t1")
        assert len(emails) == 2
        assert [e.direction for e in emails] == ["in", "out"]


# ── resolve_targets ─────────────────────────────────────────────────────────

class TestResolveTargets:
    def test_numeric_ident_returns_single_row(self, db):
        _seed_thread(db)
        eid = _seed_email(db)
        targets = db.resolve_targets(str(eid))
        assert len(targets) == 1
        assert isinstance(targets[0], EmailTarget)
        assert targets[0].id == eid

    def test_thread_id_returns_all_rows_both_directions(self, db):
        _seed_thread(db)
        _seed_email(db, direction="in",  uid=10)
        _seed_email(db, direction="in",  uid=11)
        _seed_email(db, direction="out", uid=None)
        targets = db.resolve_targets("t1")
        assert len(targets) == 3
        directions = sorted(t.direction for t in targets)
        assert directions == ["in", "in", "out"]

    def test_unknown_thread_returns_empty(self, db):
        assert db.resolve_targets("ghost") == []


# ── set_emails_is_read / set_emails_folder ──────────────────────────────────

class TestSetEmailsState:
    def test_set_is_read_to_one(self, db):
        _seed_thread(db)
        eid = _seed_email(db, is_read=0)
        db.set_emails_is_read([eid], is_read=True)
        db.commit()
        assert db.get_email(eid).is_read == 1

    def test_set_is_read_to_zero(self, db):
        _seed_thread(db)
        eid = _seed_email(db, is_read=1)
        db.set_emails_is_read([eid], is_read=False)
        db.commit()
        assert db.get_email(eid).is_read == 0

    def test_empty_ids_is_noop(self, db):
        # Just ensures no crash on the f-string with zero placeholders
        db.set_emails_is_read([], is_read=True)
        db.set_emails_folder([], folder="Archive")

    def test_set_folder_updates_all_listed_ids(self, db):
        _seed_thread(db)
        e1 = _seed_email(db, uid=1, folder="INBOX")
        e2 = _seed_email(db, uid=2, folder="INBOX")
        db.set_emails_folder([e1, e2], folder="Archive")
        db.commit()
        assert db.get_email(e1).folder == "Archive"
        assert db.get_email(e2).folder == "Archive"

    def test_set_folder_uses_parameter_binding(self, db):
        """Folder name with a quote shouldn't break SQL — defensive guard."""
        _seed_thread(db)
        eid = _seed_email(db)
        db.set_emails_folder([eid], folder="O'Reilly's archive")
        db.commit()
        assert db.get_email(eid).folder == "O'Reilly's archive"


# ── Attachments ────────────────────────────────────────────────────────────

class TestAttachments:
    """The attachments table is the fix for the empty-body bug — without
    it, attachment-only messages looked empty to the agent because
    display commands read from the DB while the bytes lived only on disk.
    These tests pin the insert/list contracts the display layer relies on.
    """

    def _att(self, **overrides):
        base = {
            "filename": "doc.pdf",
            "content_type": "application/pdf",
            "size": 12345,
            "path": "/tmp/doc.pdf",
        }
        base.update(overrides)
        return base

    def test_insert_returns_row_ids_in_insert_order(self, db):
        _seed_thread(db)
        eid = _seed_email(db)
        ids = db.insert_attachments(eid, [
            self._att(filename="a.pdf"),
            self._att(filename="b.pdf"),
        ])
        assert len(ids) == 2
        assert ids[0] < ids[1]  # autoincrement order

    def test_empty_attachments_is_noop(self, db):
        _seed_thread(db)
        eid = _seed_email(db)
        assert db.insert_attachments(eid, []) == []
        assert db.insert_attachments(eid, None) == []

    def test_list_returns_attachments_in_insert_order(self, db):
        _seed_thread(db)
        eid = _seed_email(db)
        db.insert_attachments(eid, [
            self._att(filename="first.pdf"),
            self._att(filename="second.pdf"),
        ])
        atts = db.list_attachments_for_email(eid)
        assert [a.filename for a in atts] == ["first.pdf", "second.pdf"]

    def test_list_for_email_returns_empty_when_none(self, db):
        _seed_thread(db)
        eid = _seed_email(db)
        assert db.list_attachments_for_email(eid) == []

    def test_metadata_round_trip_preserves_all_fields(self, db):
        _seed_thread(db)
        eid = _seed_email(db)
        db.insert_attachments(eid, [self._att(
            filename="WissensWerk.docx",
            content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size=17113,
            path="/home/agent/.index/email/attachments/t1/WissensWerk.docx",
        )])
        [a] = db.list_attachments_for_email(eid)
        assert a.filename == "WissensWerk.docx"
        assert a.content_type.startswith("application/vnd.openxml")
        assert a.size == 17113
        assert a.path.endswith("WissensWerk.docx")
        assert a.email_id == eid

    def test_missing_fields_coerced_to_safe_defaults(self, db):
        """Real-world MIME parts sometimes lack filename or content_type —
        we still want a row so the display layer can show *something*
        rather than silently dropping the attachment."""
        _seed_thread(db)
        eid = _seed_email(db)
        db.insert_attachments(eid, [{
            # filename + content_type missing on purpose
            "size": 100,
            "path": "/tmp/x",
        }])
        [a] = db.list_attachments_for_email(eid)
        assert a.filename == ""
        assert a.content_type == ""
        assert a.size == 100

    def test_list_for_thread_groups_across_emails(self, db):
        _seed_thread(db)
        e1 = _seed_email(db, uid=1, message_id="<m1@x>")
        e2 = _seed_email(db, uid=2, message_id="<m2@x>")
        db.insert_attachments(e1, [self._att(filename="from-1.pdf")])
        db.insert_attachments(e2, [
            self._att(filename="from-2a.pdf"),
            self._att(filename="from-2b.pdf"),
        ])
        atts = db.list_attachments_for_thread("t1")
        # Ordered by email_id, then insert order — display loops over emails
        # in the same order and groups by email_id, so this contract matters.
        assert [(a.email_id, a.filename) for a in atts] == [
            (e1, "from-1.pdf"),
            (e2, "from-2a.pdf"),
            (e2, "from-2b.pdf"),
        ]

    def test_list_for_thread_empty_thread(self, db):
        _seed_thread(db, thread_id="empty")
        assert db.list_attachments_for_thread("empty") == []

    def test_attachments_table_has_email_id_index(self, db):
        """Without idx_attachments_email, the list_attachments_for_thread
        join scales linearly with the attachments table — fine for now,
        ugly later. Pin the index so a refactor can't quietly drop it."""
        rows = db.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='attachments'"
        ).fetchall()
        names = [r["name"] for r in rows]
        assert "idx_attachments_email" in names

    def test_attachments_table_created_on_fresh_db(self, tmp_path):
        """The CREATE TABLE IF NOT EXISTS in _bootstrap_schema is what
        gives a brand-new account the table without any migration step."""
        db = EmailDb.open({"username": "fresh@x"}, db_dir=str(tmp_path))
        try:
            rows = db.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='attachments'"
            ).fetchall()
            assert len(rows) == 1
        finally:
            db.close()

    def test_attachments_table_added_to_legacy_db(self, tmp_path):
        """A pre-attachments database opened by EmailDb.open() should pick
        up the new table via CREATE TABLE IF NOT EXISTS — no manual
        migration, no exception. This is the production upgrade path."""
        import os, re
        account = re.sub(r"[^a-zA-Z0-9@._-]", "_", "legacy@x")
        path = tmp_path / f"{account}.db"
        # Hand-build a pre-attachments schema (threads + emails + state only)
        conn = sqlite3.connect(str(path))
        conn.executescript("""
            CREATE TABLE threads (thread_id TEXT PRIMARY KEY);
            CREATE TABLE emails (id INTEGER PRIMARY KEY AUTOINCREMENT,
                                 thread_id TEXT, message_id TEXT, direction TEXT,
                                 sender TEXT, recipient TEXT, subject TEXT, body TEXT,
                                 created_at TEXT DEFAULT (datetime('now')));
            CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT);
        """)
        conn.commit()
        conn.close()

        # Opening should silently add the attachments table + index
        db = EmailDb.open({"username": "legacy@x"}, db_dir=str(tmp_path))
        try:
            rows = db.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='attachments'"
            ).fetchall()
            assert len(rows) == 1
            # And the index landed too
            idx = db.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_attachments_email'"
            ).fetchall()
            assert len(idx) == 1
        finally:
            db.close()


# ── reply_pending — Stop-hook reply guard ground truth ──────────────────────

class TestReplyPending:
    def test_inbound_only_is_pending(self, db):
        _seed_thread(db, thread_id="t1")
        _seed_email(db, thread_id="t1", direction="in", uid=1)
        assert db.reply_pending("t1") is True

    def test_outbound_after_inbound_not_pending(self, db):
        _seed_thread(db, thread_id="t1")
        _seed_email(db, thread_id="t1", direction="in", uid=1)
        _seed_email(db, thread_id="t1", direction="out", uid=2)
        assert db.reply_pending("t1") is False

    def test_new_inbound_after_reply_is_pending(self, db):
        _seed_thread(db, thread_id="t1")
        _seed_email(db, thread_id="t1", direction="in", uid=1)
        _seed_email(db, thread_id="t1", direction="out", uid=2)
        _seed_email(db, thread_id="t1", direction="in", uid=3)
        assert db.reply_pending("t1") is True

    def test_unknown_thread_not_pending(self, db):
        assert db.reply_pending("does-not-exist") is False

    def test_scoped_per_thread(self, db):
        _seed_thread(db, thread_id="t1")
        _seed_thread(db, thread_id="t2")
        _seed_email(db, thread_id="t1", direction="in", uid=1)
        _seed_email(db, thread_id="t2", direction="in", uid=2)
        _seed_email(db, thread_id="t2", direction="out", uid=3)
        assert db.reply_pending("t1") is True    # t1 still waiting
        assert db.reply_pending("t2") is False   # t2 answered
