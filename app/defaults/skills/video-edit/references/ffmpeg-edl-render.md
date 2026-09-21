# EDL rendering

Use `scripts/render.py` for the supported pipeline. All paths in the EDL are relative to the EDL directory unless absolute. Source IDs must match transcript filenames, without `.json`.

```json
{
  "version": 1,
  "sources": {"take": "../take.mp4"},
  "ranges": [
    {"source": "take", "start": 0.5, "end": 2.0},
    {"source": "take", "start": 3.0, "end": 5.0}
  ],
  "overlays": [],
  "subtitles": "master.srt"
}
```

Omit `subtitles` when none are requested. For an alternate microphone track, use the matching transcript ID such as `take.track1` and normalize the source audio to the same track before rendering. Transcript words have `text`, `start`, `end`, and `type: "word"`, with times in seconds. Keep the full provider response in `edit/transcripts/<source-id>.json`.

```bash
python /absolute/skill/scripts/render.py edit/edl.json -o edit/preview.mp4 --draft
python /absolute/skill/scripts/render.py edit/edl.json -o edit/final.mp4 --build-subtitles
```

`--draft` renders at 720p for cut inspection. `--preview` uses 1080p with faster encoding settings; the default final render is also 1080p. Use `--fps 30000/1001` to choose a common rate across sources. Inspect `--help` for other supported flags. Custom dimensions, speed changes and per-clip grading need an adapted renderer or composition; they are not supported EDL fields.

The helper adds short audio fades to cut boundaries, concatenates normalized segments without another encode, and performs overlays and subtitles in a final pass if needed. It applies loudness normalization unless `--no-loudnorm` is set. An overlay has `file`, `start_in_output` and `duration` in seconds; its animation starts at that output offset.

Use `timeline_view.py <render> <start> <end> -o <image.png>` for a filmstrip and waveform around a questionable cut. Review the rendered output rather than only the original footage.
