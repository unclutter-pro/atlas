/**
 * Speech-to-text for voice messages (moved from index.ts unchanged).
 * Whisper-compatible endpoint; ffmpeg/ffprobe convert and chunk long audio.
 */

import { existsSync, unlinkSync } from "fs";

// STT — Whisper-compatible endpoint (parakeet on the cluster, by default).
// Set ATLAS_STT_URL to override.
const STT_URL = process.env.ATLAS_STT_URL
  ?? "http://parakeet.shared-stt.svc.cluster.local:5092/v1/audio/transcriptions";
const STT_TIMEOUT_MS = 30_000;

// --- Chunked STT helpers (ported from signal-addon.py) ---

const NATIVE_STT_FORMATS = new Set([".wav", ".flac", ".ogg"]);
const CHUNK_THRESHOLD_SECS = 120;
const CHUNK_SIZE_SECS = 120;
const CHUNK_OVERLAP_SECS = 1;

/** Map common audio MIME types to file extensions. */
export function inferExtFromMime(mime: string): string {
  const map: Record<string, string> = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/wave": ".wav",
    "audio/mp3": ".mp3",
  };
  // strip codec params like "audio/webm; codecs=opus"
  const base = mime.split(";")[0].trim().toLowerCase();
  return map[base] ?? ".bin";
}

/** Convert an audio file to 16 kHz mono WAV via ffmpeg. Returns path or null. */
export async function convertToWav(inputPath: string, outputPath: string): Promise<boolean> {
  const proc = Bun.spawn(
    ["ffmpeg", "-i", inputPath, "-ar", "16000", "-ac", "1", "-y", outputPath],
    { stdout: "ignore", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const errText = await new Response(proc.stderr).text();
    console.error("[chat] STT ffmpeg conversion failed:", errText.slice(0, 200));
    return false;
  }
  return true;
}

/** Get audio duration in seconds via ffprobe. Returns 0 on failure. */
export async function getAudioDuration(filePath: string): Promise<number> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", filePath],
    { stdout: "pipe", stderr: "ignore" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) return 0;
  try {
    const out = await new Response(proc.stdout).text();
    const info = JSON.parse(out) as { format?: { duration?: string } };
    return parseFloat(info.format?.duration ?? "0") || 0;
  } catch {
    return 0;
  }
}

/**
 * Split a WAV file into overlapping CHUNK_SIZE_SECS chunks via ffmpeg.
 * Returns an array of temp file paths (caller must clean them up).
 * If splitting fails, returns [wavPath] (the original).
 */
export async function splitWavChunks(wavPath: string, duration: number): Promise<string[]> {
  const chunks: string[] = [];
  let start = 0;
  let idx = 0;
  while (start < duration) {
    const chunkPath = `/tmp/${crypto.randomUUID()}_chunk${idx}.wav`;
    const proc = Bun.spawn(
      [
        "ffmpeg", "-y", "-i", wavPath,
        "-ss", String(start),
        "-t", String(CHUNK_SIZE_SECS),
        "-ar", "16000", "-ac", "1",
        chunkPath,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    const chunkFile = Bun.file(chunkPath);
    if (exitCode === 0 && await chunkFile.exists() && chunkFile.size > 100) {
      chunks.push(chunkPath);
    } else {
      const errText = await new Response(proc.stderr).text();
      console.error(`[chat] STT chunk split error at ${start}s:`, errText.slice(0, 200));
      break;
    }
    start += CHUNK_SIZE_SECS - CHUNK_OVERLAP_SECS;
    idx++;
  }
  return chunks.length > 0 ? chunks : [wavPath];
}

/** Send one file (by path) to the STT endpoint. Returns transcript or null. */
export async function doSttRequest(filePath: string): Promise<string | null> {
  const fileBlob = Bun.file(filePath);
  const form = new FormData();
  form.append("file", fileBlob, filePath.split("/").pop() ?? "audio.wav");
  form.append("model", "default");
  const res = await fetch(STT_URL, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(STT_TIMEOUT_MS),
  });
  if (!res.ok) {
    console.error(`[chat] STT non-2xx: ${res.status}`);
    return null;
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim() || null;
}

/**
 * Best-effort STT: convert if needed, chunk long audio, transcribe each
 * chunk against the cluster STT service (parakeet), return joined transcript
 * or `null` if conversion or all chunks fail.
 *
 * Ported from signal-addon.py `_transcribe_audio` — keeps the same
 * non-fatal semantics: any error returns null so the caller can fall back to
 * the "(Datei: …)" placeholder.
 */
export async function transcribeAudio(file: File): Promise<string | null> {
  const ext = inferExtFromMime(file.type) || ".bin";
  console.log(`[chat] STT input: ${file.size}b mime=${file.type} ext=${ext}`);

  // Write incoming File to disk so ffmpeg/ffprobe can read it
  const inputPath = `/tmp/${crypto.randomUUID()}${ext}`;
  let wavPath: string | null = null;
  const chunkPaths: string[] = [];

  try {
    await Bun.write(inputPath, file);

    // Convert non-native formats to 16 kHz mono WAV
    let workPath = inputPath;
    if (!NATIVE_STT_FORMATS.has(ext)) {
      wavPath = `/tmp/${crypto.randomUUID()}.wav`;
      const ok = await convertToWav(inputPath, wavPath);
      if (!ok) {
        console.error("[chat] STT request failed: ffmpeg conversion returned non-zero");
        return null;
      }
      workPath = wavPath;
    }

    const duration = await getAudioDuration(workPath);

    if (duration <= CHUNK_THRESHOLD_SECS) {
      // Short audio — single request
      return await doSttRequest(workPath);
    }

    // Long audio — split and transcribe each chunk
    const nChunks = Math.ceil((duration - CHUNK_OVERLAP_SECS) / (CHUNK_SIZE_SECS - CHUNK_OVERLAP_SECS));
    console.log(`[chat] STT chunking: duration=${Math.round(duration)}s, splitting into ${nChunks} x ${CHUNK_SIZE_SECS}s chunks`);

    const splits = await splitWavChunks(workPath, duration);
    // If splitWavChunks returned the original (fallback), chunkPaths stays empty
    if (splits.length === 1 && splits[0] === workPath) {
      // Single-chunk fallback (split failed)
      return await doSttRequest(workPath);
    }
    chunkPaths.push(...splits);

    const transcriptions: string[] = [];
    for (let i = 0; i < chunkPaths.length; i++) {
      const t0 = Date.now();
      try {
        const text = await doSttRequest(chunkPaths[i]);
        const ms = Date.now() - t0;
        const words = text ? text.trim().split(/\s+/).length : 0;
        console.log(`[chat] STT chunk ${i + 1}/${chunkPaths.length}: ${ms}ms, ${words}w`);
        if (text) transcriptions.push(text);
      } catch (err) {
        console.error(`[chat] STT chunk ${i + 1} failed:`, err);
        // continue — return whatever we have from successful chunks
      }
    }
    return transcriptions.length > 0 ? transcriptions.join(" ").trim() : null;

  } catch (err) {
    console.error("[chat] STT request failed:", err);
    return null;
  } finally {
    // Clean up temp files
    for (const p of [inputPath, wavPath, ...chunkPaths]) {
      if (!p) continue;
      try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

/** Indirection so tests can stub STT (no ffmpeg or STT service needed). */
export const sttDeps: { transcribe: (file: File) => Promise<string | null> } = { transcribe: transcribeAudio };
