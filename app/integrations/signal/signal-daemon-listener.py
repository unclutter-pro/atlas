#!/usr/bin/env python3
"""
Signal daemon listener.

Connects to signal-cli's UNIX socket, reads JSON-RPC notifications,
and calls 'signal incoming' for each received message.

Run as a supervisord service alongside signal-cli daemon.
See workspace/supervisor.d/ for the service configuration.
"""

import json
import socket
import subprocess
import sys
import time
from datetime import datetime

SOCKET_PATH = "/tmp/signal.sock"


def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def send_read_receipt(sender, timestamp):
    """Send a read receipt back to the sender via the daemon socket."""
    if not sender or not timestamp:
        return
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(10)
        sock.connect(SOCKET_PATH)
        req = json.dumps({
            "jsonrpc": "2.0",
            "id": "receipt",
            "method": "sendReceipt",
            "params": {
                "recipient": sender,
                "targetTimestamp": int(timestamp),
                "type": "read",
            },
        })
        sock.sendall(req.encode() + b"\n")
        # Read response (don't block forever)
        buf = b""
        while b"\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
        sock.close()
        log(f"Read receipt sent to {sender} for ts={timestamp}")
    except Exception as e:
        log(f"Failed to send read receipt to {sender}: {e}")


def connect_socket(path, retries=60, delay=2):
    """Wait for the signal-cli daemon socket to become available."""
    for attempt in range(retries):
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.connect(path)
            return sock
        except (FileNotFoundError, ConnectionRefusedError) as e:
            if attempt < retries - 1:
                log(f"Socket not ready ({e}), retrying in {delay}s...")
                time.sleep(delay)
            else:
                raise


def handle_notification(notification):
    """Process a JSON-RPC receive notification from signal-cli daemon."""
    if notification.get("method") != "receive":
        return

    params = notification.get("params", {})
    envelope = params.get("envelope", {})
    dm = envelope.get("dataMessage", {})

    body = dm.get("message", "")
    attachments = dm.get("attachments", [])
    sender = envelope.get("sourceNumber") or envelope.get("source", "")
    name = envelope.get("sourceName", "")
    ts = str(envelope.get("timestamp", ""))

    # Ignore receipts, typing notifications, and messages with no body AND no attachments
    if not sender or (not body and not attachments):
        return

    log(f"Message from {sender} ({name}): {body[:80] if body else f'[{len(attachments)} attachment(s)]'}")

    cmd = ["signal", "incoming", sender, body or ""]
    if name:
        cmd += ["--name", name]
    if ts:
        cmd += ["--timestamp", ts]
    if attachments:
        cmd += ["--attachments", json.dumps(attachments)]

    try:
        subprocess.run(cmd, timeout=600, check=False)
    except Exception as e:
        log(f"ERROR calling 'signal incoming': {e}")

    # Send read receipt after processing (incl. transcription) so the sender
    # only sees "read" once the message has actually been handled.
    send_read_receipt(sender, ts)


def listen(sock):
    """Read newline-delimited JSON from the socket until connection drops."""
    buf = ""
    while True:
        try:
            data = sock.recv(4096)
        except OSError:
            break
        if not data:
            log("Connection closed by signal-cli daemon")
            break
        buf += data.decode("utf-8", errors="replace")
        while "\n" in buf:
            line, buf = buf.split("\n", 1)
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if "method" in obj:
                    handle_notification(obj)
            except json.JSONDecodeError:
                pass


def main():
    log(f"Signal daemon listener starting (socket={SOCKET_PATH})")
    while True:
        try:
            sock = connect_socket(SOCKET_PATH)
            log("Connected to signal-cli daemon, listening for messages")
            listen(sock)
            sock.close()
        except Exception as e:
            log(f"Connection error: {e}")
        log("Reconnecting in 5s...")
        time.sleep(5)


if __name__ == "__main__":
    main()
