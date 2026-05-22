---
name: email
description: Send and receive emails. Use for email composition, replies, thread management, and inbox checking.
---

# Email

Send, receive, and manage emails via the configured mail server (IMAP/SMTP).

## CLI Commands

### Send a new email
```bash
email send "recipient@example.com" "Subject line" "Email body text"
```

### Send with CC / BCC
```bash
email send "alice@example.com" "Subject" "Body" --cc bob@example.com --cc carol@example.com --bcc audit@example.com
```

### Send with attachments
```bash
email send "recipient@example.com" "Report" "Please find attached." --attach /path/to/file.pdf --attach /path/to/other.csv
```

### Reply to a thread
By default replies are **reply-all** — anyone on the original `Cc:` line is automatically CC'd again (minus yourself and the new `To:` recipient).

```bash
email reply "thread-id-here" "Reply body text"               # Reply-all (default)
email reply "thread-id-here" "Reply body text" --no-cc       # Reply only to the sender
email reply "thread-id-here" "Reply body" --cc new@x.com     # Replace auto CC list
email reply "thread-id-here" "Reply body" --bcc audit@x.com  # Add a BCC
```

### Reply with attachments
```bash
email reply "thread-id-here" "See attached." --attach /path/to/file.pdf
```

### Inbox triage

Triage commands accept either a single email id or a thread_id. When given a
thread_id, the action applies to all incoming messages in that thread.

```bash
# Focused to-do list: threads with unread messages in INBOX
email inbox

# Generic listing with filters
email threads                       # All threads (any folder, any state)
email threads --folder INBOX        # Threads currently in INBOX
email threads --folder Archive      # Archived threads
email threads --unread              # Threads with at least one unread message
email threads --read                # Threads where every incoming msg is read

# Read state (synced to IMAP \Seen)
email mark-read   <id|thread_id>
email mark-unread <id|thread_id>

# Folder moves (synced via IMAP UID MOVE)
email archive <id|thread_id>        # Move to Archive
email spam    <id|thread_id>        # Move to Junk/Spam
email delete  <id|thread_id>        # Move to Trash (soft delete)
email move    <id|thread_id> <folder>   # Move to any folder (role name or literal)

# Discover server folders
email folders                       # Show server folders + logical role mapping
```

### Reading

```bash
email thread "<thread_id>"          # Full thread (Markdown)
email thread "<thread_id>" --raw    # Raw HTML
email read <email_id>               # Single message by #N from thread view
```

### Polling (manual)

```bash
email poll --once                   # One-shot check
```

## Configuration

Email is configured in `~/config.yml` under the `email:` section:

```yaml
email:
  imap_host: "imap.example.com"     # IMAP server (e.g. imap.gmail.com)
  imap_port: 993                     # 993 for TLS, 143 for STARTTLS
  imap_starttls: false               # true when using port 143
  smtp_host: "smtp.example.com"     # SMTP server (e.g. smtp.gmail.com)
  smtp_port: 587                     # SMTP submission port
  username: "atlas@example.com"     # Email address
  password_file: "/home/agent/secrets/email-password"
  ssl_verify: true                   # set false only for self-signed certs
  folder: "INBOX"
  whitelist: []                      # Empty = accept all
  mark_read: true

  # Optional: pin server folder names for the role lookup. Most servers
  # (Mailcow, Gmail, Outlook, iCloud, Fastmail) advertise these via IMAP
  # SPECIAL-USE (RFC 6154) and auto-discovery just works — only pin if
  # the defaults don't match your setup.
  folders:
    archive: "Archive"
    junk:    "Junk"
    trash:   "Trash"
    sent:    "Sent"
    drafts:  "Drafts"
```

Alternatively, use environment variables: `EMAIL_IMAP_HOST`, `EMAIL_SMTP_HOST`, `EMAIL_USERNAME`, `EMAIL_PASSWORD`, etc.

## Folders and read/unread

The addon mirrors the standard IMAP mental model: every incoming message lives
in a folder (INBOX, Archive, Junk, Trash, …) and carries a read/unread flag.
All `mark-read` / `mark-unread` / `archive` / `spam` / `delete` / `move`
operations sync to the IMAP server (`UID STORE` / `UID MOVE`) so changes show
up in the user's webmail too.

Folder name discovery uses IMAP `SPECIAL-USE` (RFC 6154) so it works against
Mailcow/Dovecot, Gmail, Outlook, iCloud, and Fastmail out of the box without
hard-coded names. Run `email folders` to inspect what the server advertises.

## Background Polling

The email poller runs as a background process (managed by supervisord) using IMAP IDLE for real-time notifications. New emails trigger a Claude session via the `email-handler` trigger.

To start manually:
```bash
email poll
```

## Thread Tracking

Every email conversation is tracked as a thread with a unique ID. Replies preserve proper email threading headers (In-Reply-To, References) so recipients see a clean conversation thread in their mail client.

## Email Files

Received emails are saved as searchable markdown files in `~/.index/email/messages/<thread-id>/`. Attachments are saved in `~/.index/email/attachments/<thread-id>/`.

## Notes

- The email addon supports both implicit TLS (port 993/465) and STARTTLS (port 143/587)
- For internal Mailcow with self-signed certificates, set `ssl_verify: false`
- The `whitelist` setting filters incoming emails — leave empty to accept all
- Email credentials should be stored as K8s secrets and mounted as files
