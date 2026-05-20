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

### Check for new emails (one-time)
```bash
email poll --once
```

### List email threads
```bash
email threads --limit 20
```

### Show thread detail
```bash
email thread "thread-id-here"
```

## Configuration

Email is configured in `~/config.yml` under the `email:` section:

```yaml
email:
  imap_host: "mailcow.mail.svc.cluster.local"  # IMAP server
  imap_port: 143                                 # 993 for TLS, 143 for STARTTLS
  imap_starttls: true                            # Use STARTTLS on port 143
  smtp_host: "mailcow.mail.svc.cluster.local"   # SMTP server
  smtp_port: 587                                  # SMTP submission port
  username: "agent@ai.unclutter.pro"             # Email address
  password_file: "/home/agent/secrets/email-password"
  ssl_verify: false                               # false for self-signed certs
  folder: "INBOX"
  whitelist: []                                   # Empty = accept all
  mark_read: true
```

Alternatively, use environment variables: `EMAIL_IMAP_HOST`, `EMAIL_SMTP_HOST`, `EMAIL_USERNAME`, `EMAIL_PASSWORD`, etc.

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
