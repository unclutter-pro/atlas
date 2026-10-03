/**
 * Attachments — generic file storage attached to inbox messages.
 *
 * Files are written to disk under HOME/.attachments/<id>.<ext>; metadata is
 * stored in the message_attachments SQLite table. Designed to support audio
 * voice notes today and image / document attachments later without further
 * schema migration (the `kind` column distinguishes them).
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

export type AttachmentKind = "audio" | "image" | "video" | "document" | "other";

export interface Attachment {
  id: string;
  message_id: number;
  kind: AttachmentKind;
  mime_type: string;
  file_name: string;
  file_size: number;
  transcription: string | null;
  created_at: string;
}

// Attachments are ephemeral by design: stored under /tmp so the customer
// pod's PVC stays small and pod restarts auto-clear stale voice notes
// (their transcripts are already in the message content; the original
// audio is only useful immediately after upload for STT-fallback retries).
// Override with ATLAS_ATTACHMENTS_DIR if a different location is needed.
const ATTACHMENTS_DIR = process.env.ATLAS_ATTACHMENTS_DIR
  ?? "/tmp/atlas-attachments";

function ensureDir(): void {
  if (!existsSync(ATTACHMENTS_DIR)) {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  }
}

function inferKind(mimeType: string): AttachmentKind {
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (
    mimeType === "application/pdf"
    || mimeType.startsWith("text/")
    || mimeType.includes("officedocument")
    || mimeType.includes("msword")
  ) return "document";
  return "other";
}

function extensionFor(mimeType: string, fallback: string = "bin"): string {
  // Minimal map covering what we expect (audio + common docs/images).
  const map: Record<string, string> = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "application/pdf": "pdf",
    "text/plain": "txt",
  };
  return map[mimeType] ?? fallback;
}

function sanitiseFilename(name: string): string {
  // Strip path separators and control chars, keep it short.
  return name.replace(/[\/\\\x00-\x1f]/g, "_").slice(0, 200) || "attachment";
}

/**
 * Persist a file to disk and create a message_attachments row. Returns the
 * full attachment metadata so callers can include it in API responses or
 * trigger payloads.
 */
export async function saveAttachment(
  db: Database,
  options: {
    messageId: number;
    file: Blob | File | { arrayBuffer(): Promise<ArrayBuffer>; type?: string; name?: string; size?: number };
    mimeType?: string;
    fileName?: string;
    transcription?: string | null;
    kind?: AttachmentKind;
  },
): Promise<Attachment> {
  ensureDir();
  const id = randomUUID();
  const mimeType = options.mimeType
    ?? (options.file as any).type
    ?? "application/octet-stream";
  const kind = options.kind ?? inferKind(mimeType);
  const fileName = sanitiseFilename(
    options.fileName ?? (options.file as any).name ?? `${id}.${extensionFor(mimeType)}`,
  );
  const ext = extensionFor(mimeType, fileName.split(".").pop() ?? "bin");
  const diskPath = join(ATTACHMENTS_DIR, `${id}.${ext}`);

  const buf = await options.file.arrayBuffer();
  await Bun.write(diskPath, buf);
  const size = (options.file as any).size ?? buf.byteLength;

  db.prepare(
    `INSERT INTO message_attachments (id, message_id, kind, mime_type, file_name, file_size, transcription)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    options.messageId,
    kind,
    mimeType,
    fileName,
    size,
    options.transcription ?? null,
  );

  return {
    id,
    message_id: options.messageId,
    kind,
    mime_type: mimeType,
    file_name: fileName,
    file_size: size,
    transcription: options.transcription ?? null,
    created_at: new Date().toISOString(),
  };
}

/** Return all attachments for a message in insertion order. */
export function getAttachmentsForMessage(db: Database, messageId: number): Attachment[] {
  return db.prepare(
    `SELECT id, message_id, kind, mime_type, file_name, file_size, transcription, created_at
     FROM message_attachments
     WHERE message_id = ?
     ORDER BY created_at ASC, id ASC`,
  ).all(messageId) as Attachment[];
}

/** Look up a single attachment by id. */
export function getAttachment(db: Database, id: string): Attachment | null {
  return (db.prepare(
    `SELECT id, message_id, kind, mime_type, file_name, file_size, transcription, created_at
     FROM message_attachments WHERE id = ?`,
  ).get(id) as Attachment | undefined) ?? null;
}

/** Resolve the on-disk path for an attachment (used to stream the file). */
export function attachmentDiskPath(attachment: Attachment): string {
  const ext = extensionFor(attachment.mime_type, attachment.file_name.split(".").pop() ?? "bin");
  const path = join(ATTACHMENTS_DIR, `${attachment.id}.${ext}`);
  if (!existsSync(path)) {
    throw new Error(`attachment file missing on disk: ${path}`);
  }
  return path;
}

/** True if the on-disk file for the attachment exists and is readable. */
export function attachmentExists(attachment: Attachment): boolean {
  try {
    return statSync(attachmentDiskPath(attachment)).isFile();
  } catch {
    return false;
  }
}

/** Public-facing URL path for an attachment (relative; client/proxy prepends host). */
export function attachmentUrl(id: string): string {
  return `/api/v1/attachments/${id}`;
}

// Match the whole value, including media parameters such as codecs=opus.
// Quoted parameter values may contain commas; unquoted MIME lists may not.
const MEDIA_MIME_RE = /^(audio|video)\/[a-z0-9!#$&^_.+-]+(?:; *[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+-]+|"[\x20-\x21\x23-\x5b\x5d-\x7e]*"))*$/i;
const INLINE_MIME_RE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/i;

/** Response headers for streaming an attachment back to a browser. The stored
 *  mime type is whatever the uploader declared, so only inert media types may
 *  render inline; anything else (html, svg, …) downloads as an opaque blob. */
export function attachmentResponseHeaders(attachment: Attachment): Record<string, string> {
  const mime = attachment.mime_type;
  const inline = !/[\x00-\x1f\x7f]/.test(mime)
    && (MEDIA_MIME_RE.test(mime) || INLINE_MIME_RE.test(mime));
  const name = attachment.file_name.toWellFormed().replace(/["\\\x00-\x1f\x7f]/g, "") || "attachment";
  const fallback = name.replace(/[^\x20-\x7e]/gu, "_");
  let disposition = `${inline ? "inline" : "attachment"}; filename="${fallback}"`;
  if (name !== fallback) {
    // RFC 8187: preserve Unicode in filename* and keep filename ASCII-only.
    const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    disposition += `; filename*=UTF-8''${encoded}`;
  }
  return {
    "Content-Type": inline ? mime : "application/octet-stream",
    "Content-Disposition": disposition,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=3600",
  };
}
