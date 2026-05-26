#!/usr/bin/env bun
/**
 * WhatsApp Daemon.
 *
 * Uses Baileys (WhiskeySockets/Baileys) to connect to WhatsApp via the
 * multi-device linked-devices protocol. Handles both incoming message
 * routing and outgoing sends via a UNIX socket (JSON-RPC, same protocol
 * as signal-cli daemon).
 *
 * Incoming messages → calls `whatsapp incoming <sender> <body> [--name ...] [--timestamp ...] [--attachments ...]`
 * Outgoing sends   → listens on /tmp/whatsapp.sock for JSON-RPC `send` requests
 *
 * Auth state is persisted to ~/.local/share/whatsapp/auth/ so QR scanning
 * is only required on first run (or if the session is revoked).
 *
 * Run as a supervisord service: see ~/supervisor.d/whatsapp.conf
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type BaileysEventMap,
  type WAMessage,
  downloadMediaMessage,
  getContentType,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { createServer, type Server } from "net";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join, extname } from "path";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import pino from "pino";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOME = process.env.HOME ?? "/home/agent";
const AUTH_DIR = join(HOME, ".local/share/whatsapp/auth");
const ATTACHMENTS_DIR = join(HOME, ".local/share/whatsapp/attachments");
const SOCKET_PATH = "/tmp/whatsapp.sock";
const LOG_FILE = "/atlas/logs/whatsapp-daemon.log";
const QR_IMAGE_PATH = join(HOME, ".local/share/whatsapp/qr-code.png");
const QR_STATUS_PATH = join(HOME, ".local/share/whatsapp/status.json");

// Rate limiting: minimum delay between outgoing messages (ms)
const SEND_RATE_LIMIT_MS = 1500;

// Audio MIME types for voice messages
const AUDIO_MIME_TYPES = new Set([
  "audio/aac", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav",
  "audio/x-m4a", "audio/m4a", "audio/webm", "audio/flac",
  "audio/ogg; codecs=opus",
]);

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({
  level: "info",
  transport: {
    target: "pino/file",
    options: { destination: 1 }, // stdout (supervisord captures)
  },
});

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
}

// ---------------------------------------------------------------------------
// JID Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a phone number (e.g. "+491701234567") to a WhatsApp JID
 * (e.g. "491701234567@s.whatsapp.net").
 */
function phoneToJid(phone: string): string {
  // Strip everything except digits
  const digits = phone.replace(/[^0-9]/g, "");
  return `${digits}@s.whatsapp.net`;
}

/**
 * Convert a WhatsApp JID to a phone number (e.g. "+491701234567").
 */
function jidToPhone(jid: string): string {
  const digits = jid.replace(/@.*$/, "");
  return `+${digits}`;
}

/**
 * Check if a JID is a personal DM (not a group).
 */
function isPersonalJid(jid: string): boolean {
  return jid.endsWith("@s.whatsapp.net");
}

// ---------------------------------------------------------------------------
// MIME → extension mapping
// ---------------------------------------------------------------------------

const MIME_EXT: Record<string, string> = {
  "audio/ogg": ".ogg",
  "audio/ogg; codecs=opus": ".ogg",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/aac": ".aac",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "audio/flac": ".flac",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/3gpp": ".3gp",
  "application/pdf": ".pdf",
};

function mimeToExt(mime: string): string {
  return MIME_EXT[mime] ?? "";
}

// ---------------------------------------------------------------------------
// Send rate limiter
// ---------------------------------------------------------------------------

let lastSendTime = 0;

async function rateLimitedWait(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastSendTime;
  if (elapsed < SEND_RATE_LIMIT_MS) {
    await Bun.sleep(SEND_RATE_LIMIT_MS - elapsed);
  }
  lastSendTime = Date.now();
}

// ---------------------------------------------------------------------------
// Incoming message handler
// ---------------------------------------------------------------------------

async function handleIncomingMessage(sock: WASocket, msg: WAMessage): Promise<void> {
  const jid = msg.key.remoteJid;
  if (!jid || !isPersonalJid(jid)) return;

  // Skip own messages
  if (msg.key.fromMe) return;

  // Skip status broadcasts
  if (jid === "status@broadcast") return;

  const sender = jidToPhone(jid);
  const pushName = msg.pushName ?? "";
  const timestamp = String(msg.messageTimestamp ?? Date.now());

  // Extract message content
  const messageContent = msg.message;
  if (!messageContent) return;

  const contentType = getContentType(messageContent);
  let body = "";
  const attachments: Array<{
    id: string;
    contentType: string;
    size: number;
    path?: string;
  }> = [];

  // Text messages
  if (contentType === "conversation") {
    body = messageContent.conversation ?? "";
  } else if (contentType === "extendedTextMessage") {
    body = messageContent.extendedTextMessage?.text ?? "";
  }

  // Media messages (audio, image, video, document)
  const mediaTypes = [
    "audioMessage",
    "imageMessage",
    "videoMessage",
    "documentMessage",
    "stickerMessage",
  ] as const;

  for (const mt of mediaTypes) {
    if (contentType === mt && messageContent[mt]) {
      const mediaMsg = messageContent[mt]!;
      const mime = (mediaMsg as { mimetype?: string }).mimetype ?? "application/octet-stream";
      const fileSize = (mediaMsg as { fileLength?: number | Long }).fileLength ?? 0;

      // Add caption as body if present
      if ("caption" in mediaMsg && (mediaMsg as { caption?: string }).caption) {
        body = (mediaMsg as { caption?: string }).caption ?? "";
      }

      // Download media
      try {
        const buffer = await downloadMediaMessage(msg, "buffer", {});
        const attId = randomUUID();
        const ext = mimeToExt(mime) || "";
        const filename = `${attId}${ext}`;
        const filepath = join(ATTACHMENTS_DIR, filename);
        mkdirSync(ATTACHMENTS_DIR, { recursive: true });
        writeFileSync(filepath, buffer as Buffer);

        attachments.push({
          id: attId,
          contentType: mime,
          size: Number(fileSize),
          path: filepath,
        });

        log(`Downloaded attachment: ${filename} (${mime}, ${Number(fileSize)} bytes)`);
      } catch (err) {
        log(`ERROR downloading media: ${err}`);
      }
    }
  }

  // Skip if no body and no attachments
  if (!body && attachments.length === 0) return;

  log(`Message from ${sender} (${pushName}): ${body ? body.slice(0, 80) : `[${attachments.length} attachment(s)]`}`);

  // Call whatsapp incoming
  const cmd = ["whatsapp", "incoming", sender, body || ""];
  if (pushName) cmd.push("--name", pushName);
  if (timestamp) cmd.push("--timestamp", timestamp);
  if (attachments.length > 0) cmd.push("--attachments", JSON.stringify(attachments));

  try {
    const proc = spawn(cmd[0], cmd.slice(1), {
      stdio: "inherit",
      timeout: 30_000,
    });
    proc.on("error", (err) => log(`ERROR calling 'whatsapp incoming': ${err}`));
  } catch (err) {
    log(`ERROR spawning 'whatsapp incoming': ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Send socket server (JSON-RPC)
// ---------------------------------------------------------------------------

function startSendServer(sock: WASocket): Server {
  // Remove stale socket file
  if (existsSync(SOCKET_PATH)) {
    try { unlinkSync(SOCKET_PATH); } catch {}
  }

  const server = createServer((conn) => {
    let buf = "";

    conn.on("data", (data) => {
      buf += data.toString();
      while (buf.includes("\n")) {
        const [line, rest] = buf.split("\n", 2);
        buf = rest ?? "";
        handleJsonRpc(sock, line.trim(), conn);
      }
    });

    conn.on("end", () => {
      // Handle remaining buffer (no trailing newline)
      if (buf.trim()) {
        handleJsonRpc(sock, buf.trim(), conn);
      }
    });
  });

  server.listen(SOCKET_PATH, () => {
    log(`Send socket listening on ${SOCKET_PATH}`);
  });

  // Cleanup on exit
  const cleanup = () => {
    try { unlinkSync(SOCKET_PATH); } catch {}
    server.close();
  };
  process.on("exit", cleanup);
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });

  return server;
}

async function handleJsonRpc(
  sock: WASocket,
  line: string,
  conn: import("net").Socket
): Promise<void> {
  if (!line) return;

  let req: {
    jsonrpc: string;
    id: number;
    method: string;
    params: {
      recipient: string[];
      message: string;
      attachments?: string[];
    };
  };

  try {
    req = JSON.parse(line);
  } catch {
    conn.write(JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    }) + "\n");
    return;
  }

  if (req.method !== "send") {
    conn.write(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    }) + "\n");
    return;
  }

  const { recipient, message, attachments } = req.params;
  if (!recipient?.length || !message) {
    conn.write(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32602, message: "Missing recipient or message" },
    }) + "\n");
    return;
  }

  try {
    for (const to of recipient) {
      const jid = phoneToJid(to);
      await rateLimitedWait();

      // Send text message
      await sock.sendMessage(jid, { text: message });

      // Send attachments if any
      if (attachments?.length) {
        for (const filePath of attachments) {
          await rateLimitedWait();
          await sendAttachment(sock, jid, filePath);
        }
      }
    }

    conn.write(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      result: { success: true },
    }) + "\n");
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`ERROR sending message: ${errorMessage}`);
    conn.write(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32000, message: errorMessage },
    }) + "\n");
  }
}

async function sendAttachment(sock: WASocket, jid: string, filePath: string): Promise<void> {
  const { readFileSync } = await import("fs");
  const buffer = readFileSync(filePath);
  const mime = getMimeType(filePath);
  const filename = filePath.split("/").pop() ?? "file";

  if (mime.startsWith("image/")) {
    await sock.sendMessage(jid, { image: buffer, mimetype: mime });
  } else if (mime.startsWith("audio/")) {
    await sock.sendMessage(jid, { audio: buffer, mimetype: mime });
  } else if (mime.startsWith("video/")) {
    await sock.sendMessage(jid, { video: buffer, mimetype: mime });
  } else {
    await sock.sendMessage(jid, {
      document: buffer,
      mimetype: mime,
      fileName: filename,
    });
  }
}

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp",
    ".mp4": "video/mp4", ".3gp": "video/3gpp",
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
    ".aac": "audio/aac", ".wav": "audio/wav", ".webm": "audio/webm",
    ".flac": "audio/flac",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return map[ext] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Main connection loop
// ---------------------------------------------------------------------------

async function connectWhatsApp(): Promise<void> {
  mkdirSync(AUTH_DIR, { recursive: true });
  mkdirSync(ATTACHMENTS_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  log(`Starting WhatsApp daemon (Baileys v${version.join(".")})`);

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger as any),
    },
    logger: logger as any,
    printQRInTerminal: true,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  let sendServer: Server | null = null;

  // Handle connection events
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log("QR code generated — scan with WhatsApp mobile app (Settings → Linked Devices → Link a Device)");
      // QR is printed to terminal by printQRInTerminal: true
      // Also save as PNG image so the Atlas agent can send it to the user
      try {
        await QRCode.toFile(QR_IMAGE_PATH, qr, { width: 512, margin: 2 });
        writeFileSync(QR_STATUS_PATH, JSON.stringify({
          status: "waiting_for_scan",
          qrImagePath: QR_IMAGE_PATH,
          updatedAt: new Date().toISOString(),
          message: "QR-Code bereit. Bitte mit WhatsApp scannen: Einstellungen → Verknüpfte Geräte → Gerät hinzufügen",
        }));
        log(`QR code saved to ${QR_IMAGE_PATH}`);
      } catch (err) {
        log(`Failed to save QR image: ${err}`);
      }
    }

    if (connection === "open") {
      log("Connected to WhatsApp");
      // Update status file
      try {
        writeFileSync(QR_STATUS_PATH, JSON.stringify({
          status: "connected",
          updatedAt: new Date().toISOString(),
          message: "WhatsApp ist verbunden.",
        }));
        // Clean up QR image
        if (existsSync(QR_IMAGE_PATH)) unlinkSync(QR_IMAGE_PATH);
      } catch {}
      // Start send socket server
      if (!sendServer) {
        sendServer = startSendServer(sock);
      }
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (statusCode === DisconnectReason.loggedOut) {
        log("ERROR: Session logged out — delete auth state and restart to re-scan QR code");
        log(`Auth state directory: ${AUTH_DIR}`);
        // Clean up send server
        if (sendServer) {
          try { unlinkSync(SOCKET_PATH); } catch {}
          sendServer.close();
          sendServer = null;
        }
        process.exit(1);
      }

      if (shouldReconnect) {
        log(`Connection closed (status=${statusCode}), reconnecting in 5s...`);
        // Clean up send server before reconnecting
        if (sendServer) {
          try { unlinkSync(SOCKET_PATH); } catch {}
          sendServer.close();
          sendServer = null;
        }
        setTimeout(() => connectWhatsApp(), 5000);
      }
    }
  });

  // Save credentials on update
  sock.ev.on("creds.update", saveCreds);

  // Handle incoming messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // Only process new messages (not history sync)
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        await handleIncomingMessage(sock, msg);
      } catch (err) {
        log(`ERROR handling message: ${err}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

log("WhatsApp daemon starting...");
connectWhatsApp().catch((err) => {
  log(`FATAL: ${err}`);
  process.exit(1);
});
