## Email Integration Setup

**Step 1: Configure `~/config.yml`**

```yaml
email:
  imap_host: "imap.gmail.com"
  imap_port: 993
  smtp_host: "smtp.gmail.com"
  smtp_port: 587
  username: "atlas@example.com"
  password_file: "/home/agent/secrets/email-password"
  folder: "INBOX"
  whitelist: []   # empty = accept all; or ["alice@example.com", "example.org"]
  mark_read: true
```

**Step 2: Store password**

```bash
echo "your-app-password" > /home/agent/secrets/email-password
chmod 600 /home/agent/secrets/email-password
```

For Gmail: use an App Password, not your main password.

**Step 3: Check provisioning**

On container startup, `init.sh` provisions `email-handler` and the `email-poller` service when an IMAP host is configured. Check `trigger list` and `supervisorctl status email-poller` before creating anything. If configuration was added to a running container, use the background-service pattern in the parent skill to add `/atlas/app/bin/email poll` and create the missing trigger with channel `email`, persistent sessions, and prompt `{{payload}}`. Run only one poller.

Thread tracking uses `In-Reply-To`/`References` headers — replies in the same thread share one persistent session.

**CLI tools available in trigger sessions:**

```bash
email reply <thread_id> "Reply body"
email send recipient@example.com "Subject" "Body text"
email threads
email thread <thread_id>
```
