#!/usr/bin/env python3
"""
Signal daemon start: receive pending messages, then enter daemon mode.

On startup, runs a one-shot signal-cli receive to grab any messages that
arrived while the daemon was down. Processes them via 'signal incoming' so
they get stored, triggered, and receive read receipts. Then execs into
signal-cli daemon mode for ongoing message reception.

This prevents the race condition where the daemon would fetch messages from
Signal's server before the listener is connected to the Unix socket.

Environment variables:
  SIGNAL_CLI_BIN    Path to signal-cli binary (auto-detected if not set)
  SIGNAL_NUMBER     Signal account number (required)
  SIGNAL_SOCKET_PATH  Unix socket path (default: /tmp/signal.sock)
"""

import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime

MAX_CATCHUP = 10


def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] catchup: {msg}", flush=True)


def _find_signal_cli_bin():
    """Locate the signal-cli binary: check PATH first, then known locations."""
    explicit = os.environ.get("SIGNAL_CLI_BIN")
    if explicit:
        return explicit
    if shutil.which("signal-cli"):
        return "signal-cli"
    home = os.environ.get("HOME", os.path.expanduser("~"))
    for p in [home + "/bin/signal-cli-bin", home + "/bin/signal-cli"]:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def receive_pending(signal_cli, number):
    """One-shot receive to grab pending messages from Signal server."""
    try:
        result = subprocess.run(
            [signal_cli, "-a", number, "-o", "json", "receive", "--timeout=5"],
            capture_output=True, text=True, timeout=30,
        )
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        log("receive timed out (expected if no pending messages)")
        return ""
    except Exception as e:
        log(f"receive failed: {e}")
        return ""


def parse_messages(output):
    """Parse signal-cli JSON output into message dicts."""
    messages = []
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        envelope = msg.get("envelope", {})
        dm = envelope.get("dataMessage", {})
        sender = envelope.get("sourceNumber", envelope.get("source", ""))
        body = dm.get("message", "")
        name = envelope.get("sourceName", "")
        ts = str(envelope.get("timestamp", ""))
        attachments = dm.get("attachments", [])

        if not sender or (not body and not attachments):
            continue

        messages.append({
            "sender": sender,
            "body": body or "",
            "name": name,
            "timestamp": ts,
            "attachments": attachments,
        })

    return messages[:MAX_CATCHUP]


def inject_message(msg):
    """Inject a single message via 'signal incoming'."""
    cmd = ["signal", "incoming", msg["sender"], msg["body"]]
    if msg["name"]:
        cmd += ["--name", msg["name"]]
    if msg["timestamp"]:
        cmd += ["--timestamp", msg["timestamp"]]
    if msg["attachments"]:
        cmd += ["--attachments", json.dumps(msg["attachments"])]

    try:
        subprocess.run(cmd, timeout=300, check=False)
        return True
    except Exception as e:
        log(f"inject failed for {msg['sender']}: {e}")
        return False


def main():
    number = os.environ.get("SIGNAL_NUMBER", "")
    if not number:
        log("ERROR: SIGNAL_NUMBER environment variable is required")
        sys.exit(1)

    socket_path = os.environ.get("SIGNAL_SOCKET_PATH", "/tmp/signal.sock")

    signal_cli = _find_signal_cli_bin()
    if not signal_cli:
        log("ERROR: signal-cli binary not found (set SIGNAL_CLI_BIN or add to PATH)")
        sys.exit(1)

    log(f"Starting catch-up (number={number}, max={MAX_CATCHUP})")

    # Remove stale socket from previous daemon
    if os.path.exists(socket_path):
        try:
            os.unlink(socket_path)
            log("Removed stale daemon socket")
        except OSError:
            pass

    # One-shot receive to catch pending messages
    output = receive_pending(signal_cli, number)
    if output:
        messages = parse_messages(output)
        if messages:
            log(f"Found {len(messages)} pending message(s), injecting...")
            for msg in messages:
                log(f"  -> {msg['sender']}: {msg['body'][:60]}")
                inject_message(msg)
                # Small delay between injections to avoid trigger race
                time.sleep(0.5)
            log(f"Catch-up complete: {len(messages)} message(s) processed")
        else:
            log("No actionable messages in receive output")
    else:
        log("No pending messages")

    # Now exec into daemon mode
    log("Starting signal-cli daemon...")
    os.execvp(signal_cli, [
        signal_cli, "-a", number,
        "daemon", "--socket", socket_path,
    ])


if __name__ == "__main__":
    main()
