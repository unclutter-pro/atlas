---
name: video-edit
description: "Edit existing footage into a finished video: choose takes, cut speech or silence, grade, add overlays and subtitles. Uses timestamped transcripts and bundled FFmpeg helpers. Use video for Remotion animation authoring."
license: MIT. See LICENSE.txt for the bundled browser-use/video-use helpers.
---

# Video editing

Use the bundled scripts instead of rebuilding transcription, timeline previews or EDL rendering. Resolve `scripts/` from this skill's directory. Keep original footage unchanged and all generated files under `<footage>/edit/`.

The helpers come from [browser-use/video-use](https://github.com/browser-use/video-use), not Remotion. See [upstream.md](references/upstream.md) for the pinned revision and Atlas adaptations.

## Setup

FFmpeg and ffprobe are installed in Atlas. Create a Python environment in the workspace using `dependencies`, then install this skill's `scripts/requirements.txt`. Use that environment's Python for the examples below.

Word-level transcription uses ElevenLabs Scribe. The helper reads `ELEVENLABS_API_KEY` or `ELEVENLABS_API_KEY_FILE`, without printing the credential. Use an authorized, configured provider; if none is available, explain that word-level editing needs timestamped transcripts. Existing compatible transcripts can be used without uploading footage. The built-in `stt` command returns plain text only and cannot supply cut positions or subtitles.

## Workflow

1. Inspect source duration, dimensions, frame rate, orientation and audio tracks with `ffprobe`. Use the user's target and existing project context to choose the edit. Ask only for missing choices that materially change it.
2. Transcribe speech-bearing sources and read the packed transcript:

   ```bash
   python /absolute/skill/scripts/transcribe.py /footage/take.mp4 --language de
   python /absolute/skill/scripts/pack_transcripts.py --edit-dir /footage/edit
   ```

   For multiple takes use `transcribe_batch.py /footage`. Use `--audio-track 1` when the microphone is on the second audio track. Cached transcripts are reused only when the source bytes and transcription options match.
3. Write `edit/edl.json` using the schema in [ffmpeg-edl-render.md](references/ffmpeg-edl-render.md). Choose speech cuts from actual word boundaries, with enough padding to avoid clipped syllables. For silent footage, choose cuts from visual events; do not invent speech timestamps.
4. Render and inspect a draft:

   ```bash
   python /absolute/skill/scripts/render.py /footage/edit/edl.json -o /footage/edit/preview.mp4 --draft
   python /absolute/skill/scripts/timeline_view.py /footage/edit/preview.mp4 0 3 -o /footage/edit/opening.png
   ```

5. Check the rendered cut boundaries, opening, ending and representative middle sections. Inspect subtitle timing, overlay alignment, orientation, audio continuity and expected duration. Correct observed defects and rerender, up to three passes; report any remaining limitation.
6. Render the final output without `--draft`. Use `--build-subtitles` only when compatible word transcripts exist. Deliver the video and retain the EDL/transcripts for revisions.

## Rendering constraints

- Audio/video must stay synchronized. The renderer extracts and normalizes segments, concatenates them, composites overlays, then burns subtitles last.
- Captions use output-timeline offsets after cuts, not source timestamps.
- The renderer preserves the first source's frame rate unless `--fps` is supplied. It handles rotation metadata and HDR-to-SDR conversion.
- The bundled renderer expects audio-bearing clips and a consistent output orientation. Normalize mixed orientations or silent sources explicitly with FFmpeg before using it, or use a custom composition with `video`. Do not silently add crops or change the aspect ratio.
- For a simple known trim or format conversion, direct FFmpeg is sufficient. Load `video` only when authoring a Remotion composition or overlay.
