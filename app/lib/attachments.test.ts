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
  test.each([
    "audio/ogg", "video/mp4", "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain",
    "audio/webm;codecs=opus", "audio/ogg; codecs=opus", 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"', "Audio/OGG",
  ])(
    "renders %s inline",
    (mime) => {
      const response = new Response("media", { headers: attachmentResponseHeaders(attachment(mime)) });
      expect(response.headers.get("Content-Type")).toBe(mime);
      expect(response.headers.get("Content-Disposition")).toStartWith("inline;");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    },
  );

  test.each([
    "text/html", "image/svg+xml", "application/xhtml+xml", "text/plain; charset=utf-8", "application/javascript",
    "audio/ogg, text/html", "video/mp4, text/html", "audio/ogg; codecs=opus, text/html",
    'video/mp4; codecs="avc1", text/html', 'audio/ogg; codecs="opus',
    "audio/", "video/", "audio/ogg/text/html", "audio/ogg\r\nX-Injected: 1", "image/png\n",
    "audio/ogg\u0000", "audio/ogg\u007f", "",
  ])(
    "forces %s to download as an opaque blob",
    (mime) => {
      const response = new Response("<script>alert(1)</script>", { headers: attachmentResponseHeaders(attachment(mime)) });
      expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(response.headers.get("Content-Disposition")).toStartWith("attachment;");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    },
  );

  test("always sets nosniff", () => {
    expect(attachmentResponseHeaders(attachment("audio/ogg"))["X-Content-Type-Options"]).toBe("nosniff");
  });

  test("strips quotes, backslashes and CRLF from the filename", () => {
    const h = attachmentResponseHeaders(attachment("audio/ogg", 'a"b\\c\r\nX-Injected: 1'));
    expect(h["Content-Disposition"]).toBe('inline; filename="abcX-Injected: 1"');
  });

  test.each(["text/plain", "text/html"])("serves Unicode filenames with %s", (mime) => {
    const response = new Response("file", { headers: attachmentResponseHeaders(attachment(mime, "日本語 📄.txt")) });
    const disposition = response.headers.get("Content-Disposition")!;
    expect(disposition).toStartWith(mime === "text/plain" ? "inline;" : "attachment;");
    expect(disposition).toContain('filename="___ _.txt"');
    expect(disposition).toContain("filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E%20%F0%9F%93%84.txt");
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]!)).toBe("日本語 📄.txt");
  });

  test("encodes reserved characters in the extended filename", () => {
    const response = new Response("file", { headers: attachmentResponseHeaders(attachment("text/plain", "Grüße '()*%.txt")) });
    expect(response.headers.get("Content-Disposition")).toContain("filename*=UTF-8''Gr%C3%BC%C3%9Fe%20%27%28%29%2A%25.txt");
  });

  test("removes control characters before constructing response headers", () => {
    const response = new Response("file", { headers: attachmentResponseHeaders(attachment("text/plain", "a\u0000\t\u007fb.txt")) });
    expect(response.headers.get("Content-Disposition")).toBe('inline; filename="ab.txt"');
  });

  test("uses a fallback when the sanitized filename is empty", () => {
    const response = new Response("file", { headers: attachmentResponseHeaders(attachment("text/plain", '"\\\r\n')) });
    expect(response.headers.get("Content-Disposition")).toBe('inline; filename="attachment"');
  });

  test("replaces lone surrogates before encoding the filename", () => {
    const response = new Response("file", { headers: attachmentResponseHeaders(attachment("text/plain", "\ud800.txt")) });
    expect(response.headers.get("Content-Disposition")).toContain("filename*=UTF-8''%EF%BF%BD.txt");
  });
});
