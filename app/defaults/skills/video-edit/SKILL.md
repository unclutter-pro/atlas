---
name: video-edit
description: "Use this skill to CUT, TRIM, CLEAN, EDIT existing video footage. Triggers: 'schneide das Video', 'edit/cut/trim this video', 'remove silence/fillers', 'concat videos', 'add subtitles', 'edit these into a launch video', 'make a recap from these clips', any task that takes existing video file(s) as input and produces a polished edited output. Audio-first approach: transcribe → identify cuts on word boundaries → FFmpeg-based EDL render → self-evaluate cut points. Do NOT use for: (1) creating animated videos from scratch — use the `video` skill (Remotion). (2) understanding/classifying video content (describe scenes, extract timestamps for visual events, classify) — use a multimodal LLM directly. (3) raw single-command FFmpeg ops where you already know the exact filter chain — just run FFmpeg directly."
---

# Video Editing Skill

Audio-first AI-driven editing of existing video footage. Inspired by [browser-use/video-use](https://github.com/browser-use/video-use). The premise: **read transcripts, don't dump frames** — keeps token cost manageable and lets the LLM reason on speech boundaries, fillers, and silence.

## When to use

- You have one or more raw video files and want a clean cut version.
- Remove "umm / uh / false starts" or long pauses.
- Concat multiple takes into a single narrative.
- Add subtitles burned in or as SRT sidecar.
- Light color correction per segment.
- Generate B-roll-inserts at silence gaps from existing clip pool.

## Core workflow

### 1. Inventory + transcribe

```bash
# Inventory: list each source clip with duration, fps, codec
for f in *.mp4 *.mov; do
  ffprobe -v error -show_format -show_streams "$f" -of json
done > inventory.json

# Transcribe with word-level timestamps. Options:
#   - The Atlas built-in `stt` skill (CPU-based, no API key needed)
#   - ElevenLabs Scribe (best-in-class for diarization + word timestamps)
#   - OpenAI Whisper API (cheap, word-level via verbose_json format)
stt --language de input.mp4 > transcript.txt
```

The choice depends on what you need:
- **Just text + rough timing**: `stt` skill (free, runs locally).
- **Per-word timestamps + diarization**: ElevenLabs Scribe API.
- **Per-word timestamps, no diarization**: OpenAI Whisper with `response_format=verbose_json` and `timestamp_granularities=["word"]`.

### 2. Pack transcripts to `takes_packed.md`

Combine all transcripts into a single human-readable markdown file (~5–15 KB). Schema:

```markdown
# clip_01.mp4  (12.4 s, 1080p30, h264)
[00:00.00] Hallo, mein Name ist Max,  ◀ speaker 1
[00:01.34]   (umm)                    ◀ filler
[00:01.89] und ich zeige euch heute,  ◀ speaker 1
...
```

Why pack into markdown? The LLM reads this file as primary source of truth — frames are too expensive (1080p30 × 60s = 1800 frames × ~258 tokens each ≈ 460k tokens). Markdown is ~5k.

### 3. LLM proposes EDL (Edit Decision List)

Prompt the LLM with `takes_packed.md` + user goal ("edit these into a 60-second launch video"). Expected output:

```json
[
  {"src": "clip_01.mp4", "in": 0.00, "out": 1.30,  "fade_in_ms": 0,  "fade_out_ms": 30},
  {"src": "clip_01.mp4", "in": 1.89, "out": 12.40, "fade_in_ms": 30, "fade_out_ms": 30},
  {"src": "clip_03.mp4", "in": 2.10, "out": 8.50,  "fade_in_ms": 30, "fade_out_ms": 30, "subtitle": "Was wir gebaut haben"}
]
```

EDL cuts MUST land on word-boundaries from the transcript — never mid-word.

### 4. Render EDL via FFmpeg

```bash
ffmpeg -f concat -safe 0 -i playlist.txt \
       -vf "subtitles=subs.srt:force_style='FontSize=20'" \
       -c:v libx264 -preset slow -crf 18 \
       -c:a aac -b:a 192k \
       final.mp4
```

For per-segment color grade or 30ms audio fades at every cut, see [references/ffmpeg-edl-render.md](references/ffmpeg-edl-render.md).

### 5. Self-evaluate

After render, the LLM should visually + auditively check each cut point. Generate small composite (3 frames before + 3 frames after the cut):

```bash
# 6 frames around timestamp $t
ffmpeg -ss $((t-0.1)) -i final.mp4 -vframes 6 -vf "fps=30" cut_check_$t_%d.png
```

If a cut looks visually jarring (large jump-cut without B-roll cover) or audio pops, adjust the EDL and re-render. Cap at 3 self-eval iterations.

## Environment

Required:
- `ffmpeg` ≥ 6.0
- A transcription path (built-in `stt` skill, or ElevenLabs/OpenAI API key)

Optional:
- `yt-dlp` for online video sources

## Output convention

Put edits in `<source_dir>/edit/`:

```
<source_dir>/
├── clip_01.mp4
├── clip_02.mp4
└── edit/
    ├── takes_packed.md       # transcripts
    ├── edl.json              # cut decisions
    ├── playlist.txt          # FFmpeg concat-demuxer input
    ├── subs.srt              # subtitles
    └── final.mp4             # the deliverable
```

## Common pitfalls

1. **Mid-word cuts** — audio sounds clipped, fix EDL to use only `word_end` timestamps.
2. **Frame-dump anti-pattern** — extracting all frames for the LLM blows token budget. Read transcript instead.
3. **Subtitle font collision** — use `force_style='FontName=Arial'` to override system defaults.
4. **Concat demuxer needs same codec** — re-encode mismatched clips first with `-c:v libx264 -c:a aac`.
5. **30ms fades on every cut** mask micro-pops. Standard for production cuts.

## See also

- `video` skill — to CREATE animated content from scratch (Remotion)
- `stt` skill — for raw transcription
- [references/ffmpeg-edl-render.md](references/ffmpeg-edl-render.md) — full FFmpeg EDL-render recipes
- [browser-use/video-use](https://github.com/browser-use/video-use) — reference implementation, MIT license
