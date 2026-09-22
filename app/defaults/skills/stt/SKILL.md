---
name: stt
description: Transcribe audio files to text. Use when you need to convert speech/audio to text.
---

# Speech-to-Text (STT)

Transcribe audio files to text using the `stt` CLI.

## Usage

```bash
# Transcribe an audio file
stt /path/to/audio.wav

# Transcribe with language hint
stt --language de /path/to/audio.ogg

# Transcribe from a URL (downloads first)
stt https://example.com/recording.mp3
```

## Supported Formats

wav, mp3, ogg, m4a, aac, flac, webm, mp4 (audio track)

Output is plain text only: no segment times, word timestamps or speaker labels. For cuts/subtitles that need timestamps, use the `video-edit` transcription workflow.

## Direct API Usage

The STT endpoint is Whisper-compatible (OpenAI `/v1/audio/transcriptions` format):

```bash
curl -X POST "$STT_URL" \
  -F "file=@/path/to/audio.wav" \
  -F "response_format=json" \
  -F "language=de"
```

Response: `{"text": "transcribed text here"}`

The URL is resolved from: `ATLAS_STT_URL` env → `STT_URL` env → `config.yml` (`stt.url`) → default.

## Limitations

- Long files (>2 min) are split into 120s chunks with 5s overlap — minor artifacts at chunk boundaries are possible
- Accuracy depends on audio quality; background noise reduces quality significantly
- Model, precision and latency depend on the configured endpoint. The bundled sidecar uses FP16 Parakeet on CPU.
- Single-speaker optimized; multi-speaker conversations may lose speaker attribution
- No diarization (speaker identification) — only raw text output

## Signal Integration

Audio messages received via Signal are **automatically transcribed** before reaching the agent — no manual action needed.
