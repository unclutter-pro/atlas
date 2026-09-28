import { describe, expect, test } from "bun:test";
import { attachmentResponseHeaders, type Attachment } from "./attachments";

const attachment = (mime_type: string, file_name = "note.bin"): Attachment => ({
  id: "a1",
  message_id: 1,
  kind: "other",
  mime_type,
  file_name,
  file_size: 10,
  transcription: null,
  created_at: "2026-01-01 00:00:00",
});

describe("attachmentResponseHeaders", () => {
  test.each(["audio/ogg", "video/mp4", "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"])(
    "renders %s inline",
    (mime) => {
      const h = attachmentResponseHeaders(attachment(mime));
      expect(h["Content-Type"]).toBe(mime);
      expect(h["Content-Disposition"]).toStartWith("inline;");
    },
  );

  test.each(["text/html", "image/svg+xml", "application/xhtml+xml", "text/plain; charset=utf-8", "application/javascript"])(
    "forces %s to download as an opaque blob",
    (mime) => {
      const h = attachmentResponseHeaders(attachment(mime));
      expect(h["Content-Type"]).toBe("application/octet-stream");
      expect(h["Content-Disposition"]).toStartWith("attachment;");
    },
  );

  test("always sets nosniff", () => {
    expect(attachmentResponseHeaders(attachment("audio/ogg"))["X-Content-Type-Options"]).toBe("nosniff");
  });

  test("strips quotes, backslashes and CRLF from the filename", () => {
    const h = attachmentResponseHeaders(attachment("audio/ogg", 'a"b\\c\r\nX-Injected: 1'));
    expect(h["Content-Disposition"]).toBe('inline; filename="abcX-Injected: 1"');
  });
});
